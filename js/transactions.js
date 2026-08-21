(function () {
"use strict";

// transactions.js

const {appState, NetworkType, getXymMosaicIdHex} = W.config;
const {addCallback, getBlockTimestamp} = W.ws;
const {hexToBytes} = W.utils;

const txMap = {};

// トランザクションに登場したモザイクのネームスペース名キャッシュ
// (保有していないモザイクでも名前を表示できるようにするため)
const mosaicNameCache = {};

/* ============================================================
   Symbol timestamp → 人間時間
============================================================ */
function formatTimestamp(symbolTimestamp) {
  if (!symbolTimestamp || !appState.epochAdjustment) return "";

  const unixMs = Number(appState.epochAdjustment) * 1000 + Number(symbolTimestamp);
  return new Date(unixMs).toLocaleString("ja-JP", { hour12: false });
}

/* ============================================================
   v3 Message Decode
   0x00 PlainMessage, 0x01 EncryptedMessage, 0xFF RawMessage, 0xFE Harvesting Delegation
============================================================ */
function decodeMessage(payload) {
  if (!payload) return "(no message)";

  try {
    const bytes = new Uint8Array(
      payload.match(/.{1,2}/g).map(byte => parseInt(byte, 16))
    );
    const type = bytes[0];

    switch(type) {
      case 0x00:
        return new TextDecoder().decode(bytes.slice(1));
      case 0x01:
        return "🔐 暗号化メッセージ";
      case 0xff:
        return "RawMessage: " + Buffer.from(bytes.slice(1)).toString("hex");
      case 0xfe:
        return "🌱 ハーベスト委任メッセージ";
      default:
        return "Unknown Message (" + type + ")";
    }
  } catch(e) {
    console.error("message decode error", e);
    return "(decode error)";
  }
}

/* ============================================================
   Address
   REST APIから来るアドレスは16進エンコード(48文字)の場合と
   既にbase32(39文字)の場合があるため、両方に対応してbase32に統一する
   ※ Address は sdkCore ではなく sdkSymbol 側のクラス。
     v3 SDKに fromDecodedAddressHexString のような静的メソッドは無いため、
     16進文字列→バイト列に変換してコンストラクタに渡す。
============================================================ */
function formatAddress(address) {
  if (!address) return "---";

  if (typeof address !== "string") {
    try {
      return address.plain ? address.plain() : String(address);
    } catch {
      return String(address);
    }
  }

  // 既にbase32アドレス(39文字)ならそのまま
  if (address.length === 39) return address;

  // 16進エンコードされたアドレス(48文字)ならデコードしてbase32に変換
  if (address.length === 48 && /^[0-9A-Fa-f]+$/.test(address) && appState.sdkSymbol) {
    try {
      const bytes = hexToBytes(address);
      return new appState.sdkSymbol.Address(bytes).toString();
    } catch (e) {
      console.warn("address decode failed", e);
      return address;
    }
  }

  return address;
}

/**
 * 送信者の公開鍵からアドレス(base32)を導出する
 * (受信トランザクションの送金元表示で使用)
 */
function publicKeyToAddress(pubKeyHex) {
  if (!pubKeyHex) return "---";
  try {
    const pub = new appState.sdkCore.PublicKey(pubKeyHex);
    return appState.facade.createPublicAccount(pub).address.toString();
  } catch (e) {
    console.warn("publicKey→address変換失敗", e);
    return pubKeyHex;
  }
}

/* ============================================================
   モザイク名(ネームスペース)解決
   保有していないモザイクでも名前を表示できるように、
   トランザクションに登場したモザイクIDをまとめてノードに問い合わせる
============================================================ */
async function resolveMosaicNames(mosaicIds) {
  const xymId = getXymMosaicIdHex();

  const unknown = [...new Set(mosaicIds.map(id => id?.toUpperCase()))].filter(id =>
    id &&
    id !== xymId &&
    !appState.mosaicInfo?.[id] &&
    !mosaicNameCache[id]
  );

  if (unknown.length === 0 || !appState.NODE) return;

  try {
    const res = await fetch(`${appState.NODE}/namespaces/mosaic/names`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mosaicIds: unknown })
    });
    const json = await res.json();

    for (const item of json.mosaicNames || []) {
      const mosaicId = item.mosaicId.toUpperCase();
      if (item.names && item.names.length > 0) {
        const first = item.names[0];
        // names[] の各要素は文字列の場合とオブジェクト({name, parentId, ...})の場合がある
        const resolvedName = typeof first === "string" ? first : first?.name;
        if (resolvedName) {
          mosaicNameCache[mosaicId] = resolvedName;
        }
      }
    }
  } catch (e) {
    console.warn("モザイク名の解決に失敗しました", e);
  }
}

function getMosaicName(id) {
  if (id === getXymMosaicIdHex()) return "XYM";
  const upperId = id?.toUpperCase();
  return appState.mosaicInfo?.[upperId]?.name ?? mosaicNameCache[upperId] ?? id;
}

/* ============================================================
   送金(Transfer)以外のトランザクション種別の表示名
   マルチシグの連署対象になったトランザクションなど、recipientAddressや
   mosaicsを持たない種別が「アクティビティ」に混ざってくることがあるため、
   それらは種別名だけを表示する(送金として誤表示しない)
============================================================ */
const TRANSACTION_TYPE_LABELS = {
  16705: "アグリゲート(即時)",
  16708: "メタデータ(アカウント)",
  16712: "ハッシュロック",
  16716: "アカウント鍵リンク",
  16717: "モザイク定義",
  16718: "ネームスペース登録",
  16720: "アカウント制限(アドレス)",
  16721: "モザイクグローバル制限",
  16722: "シークレットロック",
  16724: "送金",
  16725: "マルチシグ設定変更",
  16961: "アグリゲート(ボンデッド)",
  16963: "VRF鍵リンク",
  16964: "メタデータ(モザイク)",
  16972: "ノード鍵リンク",
  16973: "モザイク供給量変更",
  16974: "アドレスエイリアス",
  16976: "アカウント制限(モザイク)",
  16977: "モザイクアドレス制限",
  16978: "シークレットプルーフ",
  17220: "メタデータ(ネームスペース)",
  17229: "モザイク供給量強制回収",
  17230: "モザイクエイリアス",
  17232: "アカウント制限(操作)",
};

function getTransactionTypeLabel(type) {
  const num = Number(type);
  if (TRANSACTION_TYPE_LABELS[num]) return TRANSACTION_TYPE_LABELS[num];
  return Number.isFinite(num) ? `その他のトランザクション (type: ${num})` : "その他のトランザクション";
}


// アグリゲート(即時/ボンデッド)のトランザクションタイプ
const AGGREGATE_TYPES = new Set([16705, 16961]);

function isAggregateType(type) {
  return AGGREGATE_TYPES.has(Number(type));
}

/* ============================================================
   単発の送金(Transfer)、またはアグリゲート内の1つの埋め込み送金から
   表示用の詳細情報(送金元・送金先・モザイク・メッセージ・方向)を作る
   ※ appState.currentPubKey は読み取り専用モード(アドレス照会)では
     常にnullになるため、公開鍵同士の比較ではなく、常に取得できる
     アドレス同士で送受信方向を判定する(公開鍵で比較すると、
     読み取り専用モードでは自分が送ったトランザクションまですべて
     「受信」判定になってしまうバグがあった)
============================================================ */
function buildTransferDetail(tx, myAddress) {
  const signerAddress = publicKeyToAddress(tx.signerPublicKey);
  const direction = signerAddress && signerAddress === myAddress ? "send" : "receive";

  const mosaics = (tx.mosaics || []).map(mosaic => {
    const id = mosaic.id?.toUpperCase();
    const info = appState.mosaicInfo?.[id];
    const divisibility = info?.divisibility ?? 0;
    const name = getMosaicName(id);

    return {
      id,
      name,
      amount: Number(mosaic.amount) / (10 ** divisibility)
    };
  });

  return {
    direction,
    sender: direction === "send" ? myAddress : signerAddress,
    recipient: formatAddress(tx.recipientAddress),
    mosaics,
    msg: decodeMessage(tx.message)
  };
}

/* ============================================================
   アグリゲート内に含まれる埋め込みトランザクションの実体(生データ)を集める。
   1) REST一覧検索(embedded=true)では、埋め込み分も別要素としてフラットに
      返ってくるため、事前に集約しておいたマップ(aggregateHash単位)を使う。
   2) WebSocketや単発hash取得など、tx自身が tx.transactions として
      埋め込み内容をネストで持っている場合はそちらを使う。
   ※ 上記いずれも無い場合はここでは何もしない(呼び出し側で
      fetchAggregateDetail() によるフォールバックを行う)。
============================================================ */
function getEmbeddedTxBodies(tx, aggregateHash, embeddedByAggregateHash) {
  if (embeddedByAggregateHash && embeddedByAggregateHash[aggregateHash]) {
    return embeddedByAggregateHash[aggregateHash];
  }
  if (Array.isArray(tx.transactions)) {
    return tx.transactions.map(inner => inner.transaction).filter(Boolean);
  }
  return [];
}

/* ============================================================
   アグリゲート本体をhash指定で個別に取得し直し、埋め込み内容を得る。
   ※ Symbol RESTには既知の制限があり、address指定 + embedded=true の
      一覧検索では埋め込みトランザクションが結果に含まれないことがある
      (https://github.com/symbol/explorer/issues/905)。
      その場合のフォールバックとして、確定済みなら /transactions/confirmed/{hash}、
      未承認なら /transactions/unconfirmed/{hash} を個別に取得し、
      レスポンスに含まれる transaction.transactions (埋め込み分のネスト)を使う。
      (apostille.js の searchApostilleTransactions と同じ手法)
============================================================ */
async function fetchAggregateDetail(hash, state) {
  if (!appState.NODE) return [];

  const endpoint = state === "unconfirmed" ? "unconfirmed" : "confirmed";

  try {
    const res = await fetch(`${appState.NODE}/transactions/${endpoint}/${hash}`);
    if (!res.ok) return [];

    const json = await res.json();
    const innerTxs = json.transaction?.transactions ?? [];
    return innerTxs.map(inner => inner.transaction).filter(Boolean);
  } catch (e) {
    console.warn("アグリゲート詳細の取得に失敗しました:", hash, e);
    return [];
  }
}

/* ============================================================
   アグリゲートに含まれる埋め込み送金(Transfer)から、
   このアカウントに関係する送金情報をまとめて取り出す。
   送金を1件も含まないアグリゲート(ネームスペース登録のみ等)はnullを返す。
============================================================ */
function buildAggregateTransferInfo(embeddedTxs, myAddress) {
  const transferTxs = (embeddedTxs || []).filter(
    (t) => t && t.recipientAddress !== undefined && t.recipientAddress !== null
  );
  if (transferTxs.length === 0) return null;

  const transfers = transferTxs.map((t) => buildTransferDetail(t, myAddress));

  // 代表方向: 自分が送信者になっている送金が1件でもあれば「送信」、
  // 無ければ(すべて自分宛の受信)「受信」として扱う
  const direction = transfers.some((t) => t.direction === "send") ? "send" : "receive";

  return { transfers, direction };
}

/* ============================================================
   表示用txInfoの組み立て(通常のトランザクション / アグリゲート共通)
============================================================ */
async function buildTxInfo({ tx, hash, address, state, timestamp, embeddedByAggregateHash }) {
  const signerAddress = publicKeyToAddress(tx.signerPublicKey);
  const aggregate = isAggregateType(tx.type);

  if (aggregate) {
    let embeddedTxs = getEmbeddedTxBodies(tx, hash, embeddedByAggregateHash);

    // 一覧検索・ペイロードのどちらからも埋め込み内容が得られなかった場合、
    // アグリゲート本体をhash指定で取得し直して補う
    if (embeddedTxs.length === 0) {
      embeddedTxs = await fetchAggregateDetail(hash, state);
    }

    if (embeddedTxs.length > 0) {
      await resolveMosaicNames(embeddedTxs.flatMap(t => (t.mosaics || []).map(m => m.id)));
    }

    const info = buildAggregateTransferInfo(embeddedTxs, address);

    if (info) {
      return {
        hash,
        isTransfer: true,
        isAggregate: true,
        typeLabel: getTransactionTypeLabel(tx.type),
        signerAddress,
        myAddress: address,
        direction: info.direction,
        transfers: info.transfers,
        state,
        timestamp
      };
    }

    // 送金を含まないアグリゲート(ネームスペース登録・メタデータのみ等)
    return {
      hash,
      isTransfer: false,
      isAggregate: true,
      typeLabel: getTransactionTypeLabel(tx.type),
      signerAddress,
      state,
      timestamp
    };
  }

  // アグリゲートでない通常のトランザクション
  // recipientAddressフィールドの有無でTransferTransactionかどうかを判定する
  const isTransfer = tx.recipientAddress !== undefined && tx.recipientAddress !== null;

  if (!isTransfer) {
    return {
      hash,
      isTransfer: false,
      isAggregate: false,
      typeLabel: getTransactionTypeLabel(tx.type),
      signerAddress,
      state,
      timestamp
    };
  }

  await resolveMosaicNames((tx.mosaics || []).map(m => m.id));
  const detail = buildTransferDetail(tx, address);

  return {
    hash,
    isTransfer: true,
    isAggregate: false,
    typeLabel: getTransactionTypeLabel(tx.type),
    signerAddress,
    direction: detail.direction,
    transfers: [detail],
    state,
    timestamp
  };
}

/* ============================================================
   Explorer
============================================================ */
function getExplorerUrl(hash) {
  return appState.networkType === NetworkType.TESTNET
    ? `https://testnet.symbol.fyi/transactions/${hash}`
    : `https://symbol.fyi/transactions/${hash}`;
}

/* ============================================================
   Txカード
============================================================ */
function createTxCard(txInfo) {
  const { hash, state, timestamp } = txInfo;
  const explorer = getExplorerUrl(hash);

  // 送金情報を持たない場合(recipientAddressを持たない通常のトランザクション、
  // または送金を含まないアグリゲート(ネームスペース登録・メタデータのみ等))は
  // 種別名のみのカードにする。
  // (マルチシグの連署対象になった設定変更トランザクションなどもここに該当する。
  //  これを送金として扱うと、無関係な「送金元」表示や実在しない
  //  「送金先」("---")が出てしまうため。)
  if (!txInfo.isTransfer) {
    return `
      <div class="tx-item ${state === "unconfirmed" ? "unconfirmed" : "confirmed"}" id="tx-${hash}" onclick="window.open('${explorer}','_blank')">
        <div class="tx-body">
          <div class="tx-title">${txInfo.typeLabel}</div>
          <div class="tx-status">${state.toUpperCase()}</div>
          <div class="tx-address"><span class="tx-address-label">実行アカウント</span><span class="tx-address-value">${txInfo.signerAddress ?? "---"}</span></div>
          ${state === "confirmed" && timestamp ? `<div class="tx-time">🕒 ${formatTimestamp(timestamp)}</div>` : ""}
        </div>
      </div>
    `;
  }

  // 送金(単発 or アグリゲートに含まれる送金)を持つ場合。
  // アグリゲート(コンプリート/ボンデッド問わず)の場合は「送信(アグリゲート)」
  // 「受信(アグリゲート)」というラベルにする。
  const { direction, transfers = [], isAggregate, myAddress } = txInfo;
  const isSend = direction === "send";
  const baseLabel = isSend ? "送信" : "受信";
  const label = isAggregate ? `${baseLabel}(アグリゲート)` : baseLabel;
  const labelClass = isSend ? "tx-label-send" : "tx-label-receive";

  // アグリゲートは複数の送金(例: 複数送信)を含むことがあるため、
  // 送金ごとに「送金元・送金先・モザイク・メッセージ」のブロックを
  // 並べて表示する(単発送金の場合はブロックは1つだけになる)。
  const transfersHtml = transfers
    .map((t, i) => {
      const tIsSend = t.direction === "send";
      const tAmountClass = tIsSend ? "tx-amount-send" : "tx-amount-receive";
      const tSign = tIsSend ? "-" : "+";

      let mosaicHtml = "";
      if (t.mosaics && t.mosaics.length) {
        mosaicHtml = t.mosaics.map(mosaic => `
          <div class="tx-mosaic">
            <span class="tx-mosaic-name">${mosaic.name}</span>
            <span class="tx-mosaic-amount ${tAmountClass}">${tSign}${mosaic.amount}</span>
          </div>
        `).join("");
      }

      const dividerStyle = i > 0 ? ' style="margin-top:8px;padding-top:8px;border-top:1px dashed #374151;"' : "";

      return `
        <div${dividerStyle}>
          <div class="tx-address"><span class="tx-address-label">送金元</span><span class="tx-address-value">${t.sender ?? "---"}</span></div>
          <div class="tx-address"><span class="tx-address-label">送金先</span><span class="tx-address-value">${t.recipient ?? "---"}</span></div>
          ${mosaicHtml}
          <div class="tx-message"><span class="tx-message-label">メッセージ</span><span class="tx-message-value">${t.msg}</span></div>
        </div>
      `;
    })
    .join("");

  // アグリゲートの場合、いきなり関係する全アドレス(複数送信などで多数になりうる)を
  // 表示すると見づらいため、まずは「自分のアドレスのみ」のコンパクト表示にする。
  // 受信の場合は、実際に自分が受け取ったモザイク(XYM含む)もあわせて表示する
  // (送金元が複数あっても、自分が受け取った分の合計だけがここでは重要なため)。
  // カードをクリックすると全件の一覧(transfersHtml)を展開表示し、
  // 展開後に表示される「Explorerで見る」をクリックしたときだけExplorerへ遷移する。
  if (isAggregate) {
    const summaryLabel = isSend ? "送金元" : "受信先";
    const summaryValue = myAddress ?? "---";

    let summaryMosaicHtml = "";
    if (!isSend) {
      // 「自分が送信者でない」ではなく「受信先アドレスが自分自身」で絞り込む。
      // (例: 複数送信アグリゲートに自分以外の受取人も含まれる場合、
      //  direction==="receive"だけで判定すると他人宛のモザイクまで
      //  混ざって表示されてしまうため)
      const receivedMosaics = transfers
        .filter((t) => t.recipient === myAddress)
        .flatMap((t) => t.mosaics || []);

      // 同じモザイクを複数の埋め込み送金で受け取っていた場合は合算する
      const mergedMosaics = [];
      const indexById = new Map();
      for (const m of receivedMosaics) {
        if (indexById.has(m.id)) {
          mergedMosaics[indexById.get(m.id)].amount += m.amount;
        } else {
          indexById.set(m.id, mergedMosaics.length);
          mergedMosaics.push({ ...m });
        }
      }

      if (mergedMosaics.length > 0) {
        summaryMosaicHtml = mergedMosaics
          .map(
            (mosaic) => `
          <div class="tx-mosaic">
            <span class="tx-mosaic-name">${mosaic.name}</span>
            <span class="tx-mosaic-amount tx-amount-receive">+${mosaic.amount}</span>
          </div>
        `
          )
          .join("");
      }
    }

    return `
      <div class="tx-item ${state === "unconfirmed" ? "unconfirmed" : "confirmed"}" id="tx-${hash}">
        <div class="tx-body" data-action="toggle-tx-detail" style="cursor:pointer;">
          <div class="tx-title ${labelClass}">${label}</div>
          <div class="tx-status">${state.toUpperCase()}</div>
          <div class="tx-address"><span class="tx-address-label">${summaryLabel}</span><span class="tx-address-value">${summaryValue}</span></div>
          ${summaryMosaicHtml}
          ${state === "confirmed" && timestamp ? `<div class="tx-time">🕒 ${formatTimestamp(timestamp)}</div>` : ""}
          <div class="tx-expand-hint" style="font-size:11px;color:#6b7280;margin-top:4px;">タップして詳細を表示 ▾</div>
        </div>
        <div class="tx-detail-expand" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid #374151;">
          ${transfersHtml}
          <div class="tx-explorer-open" data-action="open-tx-explorer" data-url="${explorer}" style="cursor:pointer;color:#93c5fd;text-align:right;font-size:13px;margin-top:8px;">Explorerで見る ↗</div>
        </div>
      </div>
    `;
  }

  // アグリゲートでない単発の送金は、これまで通りクリックで直接Explorerへ
  return `
    <div class="tx-item ${state === "unconfirmed" ? "unconfirmed" : "confirmed"}" id="tx-${hash}" onclick="window.open('${explorer}','_blank')">
      <div class="tx-body">
        <div class="tx-title ${labelClass}">${label}</div>
        <div class="tx-status">${state.toUpperCase()}</div>
        ${transfersHtml}
        ${state === "confirmed" && timestamp ? `<div class="tx-time">🕒 ${formatTimestamp(timestamp)}</div>` : ""}
      </div>
    </div>
  `;
}

/* ============================================================
   アグリゲートカードのクリック挙動(委任):
     1回目のクリック: 詳細(全送金の一覧)を展開/折りたたみ
     展開後に表示される「Explorerで見る」のクリック: Explorerへ遷移
   #tx-list に限らず、将来どのコンテナに描画されても効くようdocument委任にする。
============================================================ */
document.addEventListener("click", (e) => {
  const explorerBtn = e.target.closest('[data-action="open-tx-explorer"]');
  if (explorerBtn) {
    e.stopPropagation();
    const url = explorerBtn.dataset.url;
    if (url) window.open(url, "_blank");
    return;
  }

  const toggleEl = e.target.closest('[data-action="toggle-tx-detail"]');
  if (toggleEl) {
    const item = toggleEl.closest(".tx-item");
    const detailEl = item?.querySelector(".tx-detail-expand");
    if (!detailEl) return;

    const willShow = detailEl.style.display === "none" || !detailEl.style.display;
    detailEl.style.display = willShow ? "block" : "none";

    const hintEl = toggleEl.querySelector(".tx-expand-hint");
    if (hintEl) hintEl.textContent = willShow ? "タップして閉じる ▴" : "タップして詳細を表示 ▾";
  }
});

/* ============================================================
   DOM追加
============================================================ */
function appendTx(txInfo) {
  const list = document.getElementById("tx-list");
  list.insertAdjacentHTML("afterbegin", createTxCard(txInfo));
}

/* ============================================================
   直近10件取得 (Symbol v3 REST API)
============================================================ */
async function loadRecentTx(elId = "tx-list", targetAddress) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = "読み込み中…";

  const address = targetAddress || appState.currentAddress.toString();
  const params = new URLSearchParams({
    address,
    embedded: true,
    order: "desc",
    limit: 10
  });
  const url = `${appState.NODE}/transactions/confirmed?${params}`;

  try {
    const res = await fetch(url);
    const json = await res.json();

    // 事前に全モザイクのネームスペース名をまとめて解決しておく(埋め込み分も含む)
    const allMosaicIds = json.data.flatMap(item => (item.transaction.mosaics || []).map(m => m.id));
    await resolveMosaicNames(allMosaicIds);

    // embedded=true により、アグリゲートに埋め込まれたトランザクションも
    // 別要素としてフラットに返ってくる。これらは親アグリゲートのハッシュ
    // (meta.aggregateHash)ごとにまとめておき、アグリゲート本体のカードに
    // まとめて表示する(個別の重複カードにはしない)。
    const embeddedByAggregateHash = {};
    for (const item of json.data) {
      const aggHash = item.meta?.aggregateHash;
      if (!aggHash) continue;
      if (!embeddedByAggregateHash[aggHash]) embeddedByAggregateHash[aggHash] = [];
      embeddedByAggregateHash[aggHash].push(item.transaction);
    }

    // トップレベル(埋め込みでない)のトランザクションのみをカード表示する
    const topLevelItems = json.data.filter(item => !item.meta?.aggregateHash);

    const cards = await Promise.all(topLevelItems.map(async item => {
      const tx = item.transaction;
      const meta = item.meta;

      const txInfo = await buildTxInfo({
        tx,
        hash: meta.hash,
        address,
        state: "confirmed",
        timestamp: meta.timestamp,
        embeddedByAggregateHash
      });

      txMap[meta.hash] = txInfo;
      return createTxCard(txInfo);
    }));

    el.innerHTML = cards.join("");
  } catch(e) {
    console.error(e);
    el.textContent = "読み込みエラー";
  }
}

/* ============================================================
   WebSocket Live Tx
============================================================ */
function initLiveTx(address) {
  /* 未承認 */
  addCallback(`unconfirmedAdded/${address}`, async payload => {
    const item = payload.data;
    const hash = item.meta.hash;
    if (txMap[hash]) return;

    const tx = item.transaction;

    const txInfo = await buildTxInfo({
      tx,
      hash,
      address,
      state: "unconfirmed",
      timestamp: null,
      embeddedByAggregateHash: null
    });

    txMap[hash] = txInfo;
    appendTx(txInfo);
  });

  /* 承認済み */
  addCallback(`confirmedAdded/${address}`, async payload => {
    const item = payload.data;
    const hash = item.meta.hash;

    const tx = item.transaction;
    const blockTs = await getBlockTimestamp(item.meta.height);

    const txInfo = await buildTxInfo({
      tx,
      hash,
      address,
      state: "confirmed",
      timestamp: blockTs,
      embeddedByAggregateHash: null
    });

    txMap[hash] = txInfo;
    appendTx(txInfo);
  });
}

window.W.transactions = {
  createTxCard,
  loadRecentTx,
  initLiveTx
};

})();
