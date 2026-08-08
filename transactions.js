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
   Mosaic取得
============================================================ */
function extractAmount(tx) {
  if (!tx.mosaics || tx.mosaics.length === 0) return null;

  const signer = (tx.signerPublicKey || "").toUpperCase();
  const myPub = (appState.currentPubKey || "").toUpperCase();
  const direction = signer === myPub ? "send" : "receive";

  const mosaics = tx.mosaics.map(mosaic => {
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

  return { mosaics, direction };
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
  const { hash, msg, state, timestamp, mosaics, direction, sender, recipient } = txInfo;
  const explorer = getExplorerUrl(hash);
  const isSend = direction === "send";
  const label = isSend ? "送信" : "受信";
  const labelClass = isSend ? "tx-label-send" : "tx-label-receive";
  const amountClass = isSend ? "tx-amount-send" : "tx-amount-receive";
  const sign = isSend ? "-" : "+";

  let mosaicHtml = "";
  if (mosaics && mosaics.length) {
    mosaicHtml = mosaics.map(mosaic => `
      <div class="tx-mosaic">
        <span class="tx-mosaic-name">${mosaic.name}</span>
        <span class="tx-mosaic-amount ${amountClass}">${sign}${mosaic.amount}</span>
      </div>
    `).join("");
  }

  return `
    <div class="tx-item ${state === "unconfirmed" ? "unconfirmed" : "confirmed"}" id="tx-${hash}" onclick="window.open('${explorer}','_blank')">
      <div class="tx-body">
        <div class="tx-title ${labelClass}">${label}</div>
        <div class="tx-status">${state.toUpperCase()}</div>
        <div class="tx-address"><span class="tx-address-label">送金元</span><span class="tx-address-value">${sender ?? "---"}</span></div>
        <div class="tx-address"><span class="tx-address-label">送金先</span><span class="tx-address-value">${recipient ?? "---"}</span></div>
        ${mosaicHtml}
        <div class="tx-message"><span class="tx-message-label">メッセージ</span><span class="tx-message-value">${msg}</span></div>
        ${state === "confirmed" && timestamp ? `<div class="tx-time">🕒 ${formatTimestamp(timestamp)}</div>` : ""}
      </div>
    </div>
  `;
}

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
async function loadRecentTx(elId = "tx-list") {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = "読み込み中…";

  const address = appState.currentAddress.toString();
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

    // 事前に全モザイクのネームスペース名をまとめて解決しておく
    const allMosaicIds = json.data.flatMap(item => (item.transaction.mosaics || []).map(m => m.id));
    await resolveMosaicNames(allMosaicIds);

    el.innerHTML = json.data.map(item => {
      const tx = item.transaction;
      const meta = item.meta;
      const amountInfo = extractAmount(tx);

      const txInfo = {
        hash: meta.hash,
        sender: amountInfo?.direction === "send" ? address : publicKeyToAddress(tx.signerPublicKey),
        recipient: formatAddress(tx.recipientAddress),
        msg: decodeMessage(tx.message),
        state: "confirmed",
        timestamp: meta.timestamp,
        mosaics: amountInfo?.mosaics ?? [],
        direction: amountInfo?.direction ?? null
      };

      txMap[meta.hash] = txInfo;
      return createTxCard(txInfo);
    }).join("");
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
    const tx = payload.data;
    const hash = tx.meta.hash;
    if (txMap[hash]) return;

    await resolveMosaicNames((tx.transaction.mosaics || []).map(m => m.id));

    const amountInfo = extractAmount(tx.transaction);
    const txInfo = {
      hash,
      sender: amountInfo?.direction === "send" ? address : publicKeyToAddress(tx.transaction.signerPublicKey),
      recipient: formatAddress(tx.transaction.recipientAddress),
      msg: decodeMessage(tx.transaction.message),
      state: "unconfirmed",
      timestamp: null,
      mosaics: amountInfo?.mosaics ?? [],
      direction: amountInfo?.direction ?? null
    };

    txMap[hash] = txInfo;
    appendTx(txInfo);
  });

  /* 承認済み */
  addCallback(`confirmedAdded/${address}`, async payload => {
    const tx = payload.data;
    const hash = tx.meta.hash;

    await resolveMosaicNames((tx.transaction.mosaics || []).map(m => m.id));

    const blockTs = await getBlockTimestamp(tx.meta.height);
    const amountInfo = extractAmount(tx.transaction);
    const txInfo = {
      hash,
      sender: amountInfo?.direction === "send" ? address : publicKeyToAddress(tx.transaction.signerPublicKey),
      recipient: formatAddress(tx.transaction.recipientAddress),
      msg: decodeMessage(tx.transaction.message),
      state: "confirmed",
      timestamp: blockTs,
      mosaics: amountInfo?.mosaics ?? [],
      direction: amountInfo?.direction ?? null
    };

    txMap[hash] = txInfo;
    appendTx(txInfo);
  });
}

window.W.transactions = {
  createTxCard,
  loadRecentTx,
  initLiveTx
};
