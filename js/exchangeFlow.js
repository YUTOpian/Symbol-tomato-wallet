(function () {
"use strict";

// exchangeFlow.js
// 主要取引所アドレスのXYM流入(デポジット)・流出(出金)を集計する。
//
// onchainAnalysis.js がブロック高範囲を丸ごと走査するのに対し、こちらは
// REST APIの address フィルタ(そのアドレスが送信者 or 受信者のトランザクション
// のみを返す)を使うため、対象アドレスが少数の場合ずっと軽量に集計できる。
//
// 判定方法:
//   recipientAddress が対象アドレスと一致          → 流入(取引所への入金)
//   一致しない(=そのトランザクションの送信者側)     → 流出(取引所からの出金)
//
// 対象取引所アドレスは固定リスト(EXCHANGES)で管理する。
// 「データ」画面の一覧行をクリックすると、その取引所の個別取引履歴を
// 表示する詳細画面(exchange-flow-detail-page)へ遷移する。履歴は直近の
// 集計結果をメモリ上に保持しておき(lastResultsByExchangeId)、詳細画面では
// 再取得せずそのまま描画する。

const {appState, getXymMosaicIdHex, NetworkType} = W.config;
const {formatMosaicAmount} = W.utils;
const {computeHeightRange, formatUtcJstFromMs, validateSpecificDate} = W.onchainAnalysis;

const TRANSFER_TYPE = 16724; // Transfer Transaction
const AGGREGATE_COMPLETE_TYPE = 16705;
const AGGREGATE_BONDED_TYPE = 16961;
const SCAN_PAGE_SIZE = 100;
const SCAN_MAX_PAGES = 200; // 安全のための上限(アドレス1件あたり最大 20,000 件)

// 送金でモザイクを「symbol.xym」というネームスペース名義で指定した場合、
// REST APIは解決済みの実モザイクID(6BED913FA20223F8等)ではなく、
// ネームスペース自体のID(解決前のID)をそのまま返す。取引所はこの
// ネームスペース経由の指定を使うことが多いため、両方を「XYM」として
// 認識できるようにしておく。値はSDKで動的計算し、失敗時のみ既知の
// 定数値(ネットワークに依存しない固定値)にフォールバックする。
const SYMBOL_XYM_NAMESPACE_ID_HEX_FALLBACK = "E74B99BA41F4AFEE";

// 個別取引の強調表示しきい値(XYM)
const MID_AMOUNT_THRESHOLD_XYM = 100000; // これ以上は黄色
const HIGH_AMOUNT_THRESHOLD_XYM = 1000000; // これ以上は赤色

// 詳細画面に表示する取引の最大件数(新しい順)
const DETAIL_MAX_SHOW = 300;

// 各取引所は1つ以上のアドレスをグループとして持つ(例: 入金用/出金用が
// 分かれている取引所)。同じグループ内アドレス同士のXYM移動(社内での
// 資金移動)は、外部との流入・流出としてはカウントしない(scanExchangeGroup参照)。
const EXCHANGES = [
  {
    id: "bitbank",
    label: "Bitbank",
    addresses: [
      { label: "入金用 (deposits)", address: "NDURU3U7Y7KKTPC2VVVF6U3VJIU5HDWSHQZCS4Q" },
      { label: "出金用 (withdrawals)", address: "NAIJUACP6BKCMFV7C7IDSZSAD7UNBMAE3TM7JKY" },
    ],
  },
  {
    id: "zaif",
    label: "Zaif",
    addresses: [
      { label: "出金用 (withdrawals)", address: "NA2NFUHQWYIASA5BHFJBM6OBQDEZDI34RUMNDHA" },
      { label: "入金用 (deposits)", address: "NBVU44NKAED5MLPEY4Y7Z5OMUAUXLYI7HOIKNSY" },
    ],
  },
  { id: "bitflyer", label: "bitFlyer", addresses: [{ label: null, address: "NDLSY2ZHQO5BR7SYC6I3YCGAW4WYZCFUCX6PIZY" }] },
  { id: "mexc", label: "MEXC", addresses: [{ label: null, address: "NABGDANLKUZ3D2SQOUEKPGYI6OAUFHEDW233FKY" }] },
  { id: "gateio", label: "Gate.io", addresses: [{ label: null, address: "NBWKVE7QG7TNNPSHRKUP2BYQWMOGJBHI3DO4OTY" }] },
];

// 追跡対象の全取引所アドレス(グループをまたいで横断的に持つ)。
// 「全取引所合計」の計算で、追跡対象取引所同士の移動(例: MEXC→bitbank)を
// 「外部との流入・流出」から除外するために使う(scanExchangeGroup内の
// ownAddressSetは「同じ取引所グループ内」だけが対象なので、これとは別物)。
const ALL_EXCHANGE_ADDRESSES = new Set(
  EXCHANGES.flatMap((ex) => ex.addresses.map((a) => a.address.toUpperCase()))
);


const RANGE_LABELS = {
  "24h": "過去24時間",
  "7d": "過去7日間",
  "30d": "過去30日間",
};
const RANGE_HOURS = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

// 直近の集計結果(詳細画面表示用)。 exId → { rangeLabel, result }
const lastResultsByExchangeId = {};
// 直近の集計結果一式(CSV出力用)。 { rangeLabel, results: [{ex, result}] }
let lastExchangeFlowSummary = null;

/* ============================================================
   REST APIのアドレス表現(16進 or base32)を統一する
   (recipientInfo.js / onchainAnalysis.js と同じ考え方)
============================================================ */
function normalizeMaybeHexAddress(addr) {
  if (!addr || typeof addr !== "string") return null;
  if (addr.length === 39) return addr.toUpperCase();
  if (addr.length === 48 && /^[0-9A-Fa-f]+$/.test(addr) && appState.sdkSymbol) {
    try {
      const bytes = [];
      for (let c = 0; c < addr.length; c += 2) bytes.push(parseInt(addr.substr(c, 2), 16));
      return new appState.sdkSymbol.Address(new Uint8Array(bytes)).toString();
    } catch {
      return addr.toUpperCase();
    }
  }
  return addr.toUpperCase();
}

function publicKeyToAddress(publicKeyHex) {
  const pub = new appState.sdkCore.PublicKey(publicKeyHex);
  const account = appState.facade.createPublicAccount(pub);
  return account.address.toString();
}

function getExplorerUrl(hash) {
  return appState.networkType === NetworkType.TESTNET
    ? `https://testnet.symbol.fyi/transactions/${hash}`
    : `https://symbol.fyi/transactions/${hash}`;
}

/* ============================================================
   「symbol.xym」ネームスペースのID(16進)を計算する。
   モザイクを直接IDでなくネームスペース名義で指定した送金では、
   REST APIがこのIDを(解決前の)モザイクIDとして返してくるため、
   XYM判定にはこの値も含める必要がある。
   (multisend.jsのresolveUnresolvedMosaicIdValueと同じ計算方法)
============================================================ */
function computeSymbolXymNamespaceIdHex() {
  try {
    const path = appState.sdkSymbol.generateNamespacePath("symbol.xym");
    const idValue = path[path.length - 1];
    return idValue.toString(16).toUpperCase().padStart(16, "0");
  } catch (e) {
    console.warn("exchangeFlow: symbol.xym 名前空間IDの計算に失敗しました:", e);
    return null;
  }
}

/* ============================================================
   「これはXYMか」の判定に使う、許容するモザイクID一式を組み立てる。
   - ネットワークの実モザイクID(6BED913FA20223F8 等)
   - symbol.xymネームスペースのID(SDKで計算。失敗時は既知の固定値)
============================================================ */
function buildXymMosaicIdSet() {
  const ids = new Set();
  ids.add(getXymMosaicIdHex());

  const namespaceIdHex = computeSymbolXymNamespaceIdHex();
  ids.add(namespaceIdHex || SYMBOL_XYM_NAMESPACE_ID_HEX_FALLBACK);

  return ids;
}

/* ============================================================
   1つの取引所アドレスについて、指定ブロック高範囲のXYM流入/流出を集計する。
   個々の取引(方向・金額・相手アドレス・高さ・ハッシュ)も
   transactions配列にすべて記録し、詳細画面でそのまま表示できるようにする。
============================================================ */
// アグリゲート詳細取得の並列数(multisendRecipientCheck.jsのCONCURRENCYと同じ考え方。
// ノードへの負荷と速度のバランスを見てこの値にしている)
const AGGREGATE_DETAIL_CONCURRENCY = 8;

/* ============================================================
   アグリゲートトランザクションの詳細を取得し、中の埋め込みトランザクション
   一覧を返す(取得失敗時は error:true)
============================================================ */
async function fetchAggregateInnerTxs(hash) {
  try {
    const res = await fetch(`${appState.NODE}/transactions/confirmed/${hash}`);
    if (!res.ok) return { hash, error: true, innerTxs: [] };
    const detail = await res.json();
    return { hash, error: false, innerTxs: detail.transaction?.transactions ?? [] };
  } catch (e) {
    console.warn(`exchangeFlow: アグリゲート詳細の取得に失敗しました (${hash}):`, e);
    return { hash, error: true, innerTxs: [] };
  }
}

/* ============================================================
   複数のアグリゲート詳細を、並列数を抑えつつまとめて取得する
   (multisendRecipientCheck.jsのcheckAddressesPooledと同じパターン)
============================================================ */
async function fetchAggregateInnerTxsPooled(hashes) {
  const results = new Array(hashes.length);
  let cursor = 0;

  async function worker() {
    while (cursor < hashes.length) {
      const i = cursor++;
      results[i] = await fetchAggregateInnerTxs(hashes[i]);
    }
  }

  const workers = Array.from({ length: Math.min(AGGREGATE_DETAIL_CONCURRENCY, hashes.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function scanExchangeAddress(address, fromHeight, toHeight, xymMosaicIds, ownAddressSet, onProgress) {
  let pageNumber = 1;
  let inflowAmount = 0n;
  let outflowAmount = 0n;
  let inflowCount = 0;
  let outflowCount = 0;
  let truncated = false;
  let errored = false;
  let errorDetail = null;
  let rawItemCount = 0; // APIから返ってきた生の件数(原因切り分け用)
  // 種別ごとの内訳・除外理由(原因切り分け用)
  const debug = {
    transferTopLevelCount: 0, // トップレベルの通常送金
    aggregateCount: 0, // アグリゲート(展開対象)
    otherTypeCount: 0, // それ以外の種別
    aggregateDetailFailCount: 0, // アグリゲート詳細取得に失敗した件数
    innerTransferCount: 0, // アグリゲート内から見つかった埋め込み送金
    noXymMosaicCount: 0, // 送金だったがXYMモザイクが見つからず除外された件数
    internalGroupCount: 0, // 同じ取引所グループ内アドレス同士の移動として除外した件数
    firstSampleMosaicIds: [], // 実際に見つかったモザイクIDのサンプル(最大5件、原因切り分け用)
  };
  const transactions = [];

  // 送金(Transfer)1件分を分類して集計に反映する。
  // 単純送金(トップレベル)・アグリゲート内の埋め込み送金の両方から呼ばれる。
  function recordTransfer(tx, hash, height, timestampRaw) {
    const mosaics = tx.mosaics || [];
    const xymEntry = mosaics.find((m) => xymMosaicIds.has(String(m.id).toUpperCase()));
    if (!xymEntry) {
      debug.noXymMosaicCount++;
      if (debug.firstSampleMosaicIds.length < 5) {
        const ids = mosaics.map((m) => String(m.id).toUpperCase());
        debug.firstSampleMosaicIds.push(ids.length ? ids.join(",") : "(モザイクなし)");
      }
      return; // XYMを含まない送金(他モザイクのみ)は対象外
    }

    const amount = BigInt(xymEntry.amount);
    const recipientAddr = normalizeMaybeHexAddress(tx.recipientAddress);
    const isInflow = recipientAddr === address;

    let counterpartyAddress = null;
    if (isInflow) {
      try {
        counterpartyAddress = tx.signerPublicKey ? publicKeyToAddress(tx.signerPublicKey) : null;
      } catch {
        counterpartyAddress = null;
      }
    } else {
      counterpartyAddress = recipientAddr;
    }

    // 相手が同じ取引所グループ内の別アドレス(例: 入金用⇔出金用)の場合、
    // それは取引所内部での資金移動であり、外部との流入・流出ではないため
    // カウントしない(件数・金額どちらも対象外)。
    if (counterpartyAddress && ownAddressSet.has(counterpartyAddress)) {
      debug.internalGroupCount++;
      return;
    }

    if (isInflow) {
      inflowAmount += amount;
      inflowCount++;
    } else {
      outflowAmount += amount;
      outflowCount++;
    }

    transactions.push({ direction: isInflow ? "in" : "out", amount, counterpartyAddress, hash, height, timestampRaw });
  }

  while (pageNumber <= SCAN_MAX_PAGES) {
    // typeによるサーバー側フィルタは指定しない。取引所の入出金はアグリゲート
    // トランザクション(種別: AggregateComplete/Bonded)経由のことが多く、
    // typeで絞ると中に埋め込まれた送金ごと丸ごと除外されてしまうため。
    // 種別判定・アグリゲートの展開はすべてクライアント側で行う。
    const params = new URLSearchParams({
      address,
      fromHeight: String(fromHeight),
      toHeight: String(toHeight),
      pageSize: String(SCAN_PAGE_SIZE),
      pageNumber: String(pageNumber),
      order: "asc",
    });

    const url = `${appState.NODE}/transactions/confirmed?${params}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      console.warn(`exchangeFlow: ${address} への通信に失敗しました:`, e);
      errored = true;
      errorDetail = `通信エラー: ${e.message || e}`;
      break;
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      console.warn(`exchangeFlow: ${address} の取得に失敗しました (HTTP ${res.status}):`, bodyText);
      errored = true;
      errorDetail = `HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`;
      break;
    }

    const json = await res.json();
    const items = json.data ?? [];
    if (items.length === 0) break;

    rawItemCount += items.length;

    const aggregateItems = []; // { hash, height } のリスト(このページ分)

    for (const item of items) {
      const tx = item.transaction;
      const hash = item.meta?.hash;
      const height = item.meta?.height;
      const timestampRaw = item.meta?.timestamp;
      const type = Number(tx.type);

      if (type === TRANSFER_TYPE) {
        // 単純な送金(アグリゲートに包まれていない)
        debug.transferTopLevelCount++;
        recordTransfer(tx, hash, height, timestampRaw);
        continue;
      }

      if (type === AGGREGATE_COMPLETE_TYPE || type === AGGREGATE_BONDED_TYPE) {
        debug.aggregateCount++;
        aggregateItems.push({ hash, height, timestampRaw });
        continue;
      }

      debug.otherTypeCount++;
    }

    // 取引所の入出金は複数操作をまとめたアグリゲートで行われることが多いため、
    // このページ分のアグリゲートをまとめて並列取得し、中の埋め込み送金を展開する
    // (apostille.jsのアポスティーユ検索と同じ考え方。詳細取得だけ並列化して高速化している)
    if (aggregateItems.length > 0) {
      const detailResults = await fetchAggregateInnerTxsPooled(aggregateItems.map((a) => a.hash));

      detailResults.forEach((detailResult, i) => {
        if (detailResult.error) {
          debug.aggregateDetailFailCount++;
          return;
        }
        const { height, timestampRaw } = aggregateItems[i];
        for (const inner of detailResult.innerTxs) {
          const innerTx = inner.transaction;
          if (innerTx && Number(innerTx.type) === TRANSFER_TYPE) {
            debug.innerTransferCount++;
            recordTransfer(innerTx, detailResult.hash, height, timestampRaw);
          }
        }
      });
    }

    onProgress?.(pageNumber);

    // 新しいcatapult-restではpagination.totalPagesが廃止されているため、
    // 「フルページ未満が返ってきたら最終ページ」という判定で継続/終了を決める
    if (items.length < SCAN_PAGE_SIZE) break;
    pageNumber++;
  }

  if (pageNumber > SCAN_MAX_PAGES) truncated = true;

  return {
    inflowAmount,
    outflowAmount,
    inflowCount,
    outflowCount,
    truncated,
    errored,
    errorDetail,
    rawItemCount,
    debug,
    transactions,
  };
}

/* ============================================================
   取引所グループ(1つ以上のアドレス)をまとめてスキャンし、結果を合算する。
   グループ内アドレス同士(例: 入金用⇔出金用)の移動は、各アドレスの
   scanExchangeAddress側で自動的に除外されるため、ここでは単純に
   各アドレスの結果を足し合わせるだけでよい。
============================================================ */
async function scanExchangeGroup(addressEntries, fromHeight, toHeight, xymMosaicIds, onProgress) {
  const ownAddressSet = new Set(addressEntries.map((a) => a.address.toUpperCase()));

  let inflowAmount = 0n;
  let outflowAmount = 0n;
  let inflowCount = 0;
  let outflowCount = 0;
  let truncated = false;
  let errored = false;
  const errorDetails = [];
  let rawItemCount = 0;
  const transactions = [];
  const debug = {
    transferTopLevelCount: 0,
    aggregateCount: 0,
    otherTypeCount: 0,
    aggregateDetailFailCount: 0,
    innerTransferCount: 0,
    noXymMosaicCount: 0,
    internalGroupCount: 0,
    firstSampleMosaicIds: [],
  };

  for (const entry of addressEntries) {
    const r = await scanExchangeAddress(entry.address.toUpperCase(), fromHeight, toHeight, xymMosaicIds, ownAddressSet, onProgress);

    inflowAmount += r.inflowAmount;
    outflowAmount += r.outflowAmount;
    inflowCount += r.inflowCount;
    outflowCount += r.outflowCount;
    truncated = truncated || r.truncated;
    rawItemCount += r.rawItemCount;
    transactions.push(...r.transactions);

    if (r.errored) {
      errored = true;
      errorDetails.push(`${entry.label ? entry.label + ": " : ""}${r.errorDetail ?? "不明なエラー"}`);
    }

    for (const key of Object.keys(debug)) {
      if (key === "firstSampleMosaicIds") continue;
      debug[key] += r.debug[key] ?? 0;
    }
    if (debug.firstSampleMosaicIds.length < 5) {
      debug.firstSampleMosaicIds.push(...r.debug.firstSampleMosaicIds.slice(0, 5 - debug.firstSampleMosaicIds.length));
    }
  }

  return {
    inflowAmount,
    outflowAmount,
    inflowCount,
    outflowCount,
    truncated,
    errored,
    errorDetail: errorDetails.length > 0 ? errorDetails.join(" / ") : null,
    rawItemCount,
    debug,
    transactions,
  };
}

function netColorOf(net) {
  if (net > 0n) return "#4ade80";
  if (net < 0n) return "#f87171";
  return "#94a3b8";
}

/* ============================================================
   「全取引所合計」を、追跡対象取引所同士の移動を除外して正しく計算する。
   ・各取引所ごとの流入・流出をそのまま合算すると、例えば MEXC→bitbank の
     移動が「bitbankの流入」と「MEXCの流出」の両方でカウントされ、
     実際の外部(未追跡のアドレス)との出入りより大きい数字になってしまう
     (二重計上)。
   ・そのため、各取引について相手方アドレス(counterpartyAddress)が
     ALL_EXCHANGE_ADDRESSES(追跡対象の全取引所アドレス)に含まれる場合は、
     「追跡対象同士の内部移動」とみなし、合計からは除外する
     (個別の取引所ごとの流入・流出には引き続き反映される。これは
     それぞれの取引所単体で見れば実際に増減しているため正しい)。
============================================================ */
function computeCombinedExternalTotals(okResults) {
  let inflow = 0n;
  let outflow = 0n;
  let inflowCount = 0;
  let outflowCount = 0;
  let interExchangeAmount = 0n;
  let interExchangeCount = 0;

  for (const { result } of okResults) {
    for (const tx of result.transactions) {
      const counterparty = tx.counterpartyAddress ? tx.counterpartyAddress.toUpperCase() : null;
      const isInterExchange = counterparty != null && ALL_EXCHANGE_ADDRESSES.has(counterparty);

      if (isInterExchange) {
        interExchangeAmount += tx.amount;
        interExchangeCount++;
        continue;
      }

      if (tx.direction === "in") {
        inflow += tx.amount;
        inflowCount++;
      } else {
        outflow += tx.amount;
        outflowCount++;
      }
    }
  }

  return { inflow, outflow, inflowCount, outflowCount, interExchangeAmount, interExchangeCount };
}

/* ============================================================
   個別取引の金額に応じた強調色
   100万XYM以上: 赤 / 10万XYM以上: 黄 / それ未満: 通常色
============================================================ */
function amountHighlightColor(amount) {
  const xymValue = Number(amount) / 1_000_000;
  if (xymValue >= HIGH_AMOUNT_THRESHOLD_XYM) return "#f87171";
  if (xymValue >= MID_AMOUNT_THRESHOLD_XYM) return "#facc15";
  return "#e5e7eb";
}

function debugHtml(debug) {
  if (!debug) return "";
  const sampleText = debug.firstSampleMosaicIds.length > 0
    ? `<div>モザイクID不一致の例: ${debug.firstSampleMosaicIds.join(" / ")}</div>`
    : "";
  return `
    <div style="font-size:11px;color:#64748b;margin-top:4px;border-top:1px dashed #334155;padding-top:4px;">
      <div>内訳(デバッグ): 通常送金 ${debug.transferTopLevelCount}件 / アグリゲート ${debug.aggregateCount}件（展開失敗 ${debug.aggregateDetailFailCount}件） / その他種別 ${debug.otherTypeCount}件</div>
      <div>アグリゲート内から見つかった送金: ${debug.innerTransferCount}件</div>
      <div>送金だがXYMモザイクなしで除外: ${debug.noXymMosaicCount}件</div>
      <div>同一取引所グループ内の移動として除外: ${debug.internalGroupCount}件</div>
      ${sampleText}
    </div>
  `;
}

function addressListHtml(ex) {
  return ex.addresses
    .map((a) => `<div>${a.label ? `${a.label}: ` : ""}${a.address}</div>`)
    .join("");
}

function rowHtml(ex, result) {
  if (result.errored) {
    return `
      <div class="harvest-history-item exchange-flow-row" data-exchange-id="${ex.id}" style="cursor:pointer;">
        <div style="font-weight:bold;">${ex.label}</div>
        <div style="font-size:12px;color:#94a3b8;word-break:break-all;">${addressListHtml(ex)}</div>
        <div style="color:#f97316;">⚠️ 取得に失敗しました(ノードへの問い合わせエラー)</div>
        ${result.errorDetail ? `<div style="font-size:11px;color:#fbbf24;word-break:break-all;">詳細: ${result.errorDetail}</div>` : ""}
      </div>
    `;
  }

  const net = result.inflowAmount - result.outflowAmount;
  const netText = (net > 0n ? "+" : "") + formatMosaicAmount(net, 6) + " XYM";
  const suffix = result.truncated ? " 以上(件数が多いため打ち切り)" : "";

  return `
    <div class="harvest-history-item exchange-flow-row" data-exchange-id="${ex.id}" style="cursor:pointer;">
      <div style="font-weight:bold;">${ex.label}</div>
      <div style="font-size:12px;color:#94a3b8;word-break:break-all;">${addressListHtml(ex)}</div>
      <div>流入: <b style="color:#4ade80;">${formatMosaicAmount(result.inflowAmount, 6)} XYM</b>（${result.inflowCount.toLocaleString("ja-JP")}件）${suffix}</div>
      <div>流出: <b style="color:#f87171;">${formatMosaicAmount(result.outflowAmount, 6)} XYM</b>（${result.outflowCount.toLocaleString("ja-JP")}件）${suffix}</div>
      <div>純増減: <b style="color:${netColorOf(net)};">${netText}</b></div>
      <div style="font-size:11px;color:#60a5fa;margin-top:4px;">クリックで取引履歴を見る →</div>
    </div>
  `;
}

function renderSummary(results, combinedTotals) {
  const el = document.getElementById("exchange-flow-summary");
  if (!el) return;

  const okResults = results.filter((r) => !r.result.errored);
  const erroredExchanges = results.filter((r) => r.result.errored).map((r) => r.ex.label);

  const totalNet = combinedTotals.inflow - combinedTotals.outflow;
  const totalTruncated = okResults.some((r) => r.result.truncated);
  const netText = (totalNet > 0n ? "+" : "") + formatMosaicAmount(totalNet, 6) + " XYM";

  el.innerHTML = `
    <div class="harvest-history-item">
      <div style="font-weight:bold;">全取引所合計(追跡対象取引所同士の移動は除く)${erroredExchanges.length > 0 ? "（取得失敗分を除く）" : ""}</div>
      <div>合計流入: <b style="color:#4ade80;">${formatMosaicAmount(combinedTotals.inflow, 6)} XYM</b>（${combinedTotals.inflowCount.toLocaleString("ja-JP")}件）</div>
      <div>合計流出: <b style="color:#f87171;">${formatMosaicAmount(combinedTotals.outflow, 6)} XYM</b>（${combinedTotals.outflowCount.toLocaleString("ja-JP")}件）</div>
      <div>合計純増減: <b style="color:${netColorOf(totalNet)};">${netText}</b></div>
      ${combinedTotals.interExchangeCount > 0 ? `<div style="font-size:12px;color:#94a3b8;margin-top:4px;">うち、追跡対象取引所間の移動(合計から除外済み): ${formatMosaicAmount(combinedTotals.interExchangeAmount, 6)} XYM（${combinedTotals.interExchangeCount.toLocaleString("ja-JP")}件）</div>` : ""}
      ${totalTruncated ? `<div style="color:#f97316;font-size:12px;margin-top:4px;">一部のアドレスで件数が多いため集計が打ち切られています</div>` : ""}
      ${erroredExchanges.length > 0 ? `<div style="color:#f97316;font-size:12px;margin-top:4px;">⚠️ 取得に失敗しました: ${erroredExchanges.join("、")}</div>` : ""}
    </div>
  `;
}

/* ============================================================
   分析本体。「データ」画面の「取引所フロー分析」カードから呼ばれる。
   mode: "24h" | "7d" | "30d"
============================================================ */
async function loadExchangeFlowAnalysis(mode, customRange) {
  const statusEl = document.getElementById("exchange-flow-status");
  const listEl = document.getElementById("exchange-flow-list");
  const titleEl = document.getElementById("exchange-flow-range-title");
  const summaryEl = document.getElementById("exchange-flow-summary");
  const customErrorEl = document.getElementById("exchange-flow-custom-range-error");
  const runBtns = [
    document.getElementById("exchange-flow-run-24h-btn"),
    document.getElementById("exchange-flow-run-7d-btn"),
    document.getElementById("exchange-flow-run-30d-btn"),
    document.getElementById("exchange-flow-run-custom-btn"),
  ];

  if (customErrorEl) customErrorEl.textContent = "";

  if (!appState.NODE || !appState.epochAdjustment || !appState.facade) {
    if (statusEl) statusEl.textContent = "接続完了後にご利用いただけます。";
    return;
  }

  // 「指定日」の場合は、通信を始める前に入力値を検証する
  // (ジェネシスブロック生成前/未来日でないかの確認にノードへの問い合わせが必要なため非同期)
  let customMs = null;
  if (mode === "custom") {
    runBtns.forEach((b) => { if (b) b.disabled = true; });
    if (statusEl) statusEl.textContent = "日付を確認しています...";

    const validation = await validateSpecificDate(customRange?.dateStr, customRange?.timezone);
    if (!validation.ok) {
      runBtns.forEach((b) => { if (b) b.disabled = false; });
      if (customErrorEl) customErrorEl.textContent = validation.error;
      if (statusEl) statusEl.textContent = "";
      return;
    }
    customMs = { fromMs: validation.fromMs, toMs: validation.toMs };
    customRange = { ...customRange, timezone: validation.timezone };
  }

  const hours = RANGE_HOURS[mode] ?? 24;
  const rangeLabelBase =
    mode === "custom"
      ? `指定日（${customRange.dateStr}, ${customRange.timezone}基準 0:00〜24:00）`
      : RANGE_LABELS[mode] ?? "過去24時間";
  if (titleEl) titleEl.textContent = rangeLabelBase;

  runBtns.forEach((b) => { if (b) b.disabled = true; });
  if (listEl) listEl.innerHTML = `<div style="color:#94a3b8;">読み込み中...</div>`;
  if (summaryEl) summaryEl.innerHTML = "";
  if (statusEl) statusEl.textContent = "集計対象のブロック範囲を特定しています...";

  try {
    const { fromHeight, toHeight, fromTimestampMs, toTimestampMs, toIsNow } =
      mode === "custom"
        ? await computeHeightRange(mode, undefined, customMs)
        : await computeHeightRange("rollingHours", hours);
    const xymMosaicIds = buildXymMosaicIdSet();

    const fromText = formatUtcJstFromMs(fromTimestampMs);
    const toText = formatUtcJstFromMs(toTimestampMs);
    const rangeLabel = toIsNow
      ? `${rangeLabelBase}（${fromText} 〜 現在）`
      : `${rangeLabelBase}（${fromText} 〜 ${toText}）`;

    // 各取引所は互いに独立した(別アドレスへの)問い合わせのため、
    // 順番に待つのではなくまとめて並列実行して待ち時間を短縮する。
    if (statusEl) statusEl.textContent = `${EXCHANGES.length}取引所を集計中...`;

    const results = await Promise.all(
      EXCHANGES.map(async (ex) => {
        let result;
        try {
          result = await scanExchangeGroup(ex.addresses, fromHeight, toHeight, xymMosaicIds, () => {
            // 複数取引所を並列に集計しているため、ページ番号ベースの
            // 詳細な進捗表示はせず、全体としてのステータスのみ更新する
          });
        } catch (e) {
          console.error(`exchangeFlow: ${ex.label} の集計中にエラーが発生しました:`, e);
          result = {
            inflowAmount: 0n,
            outflowAmount: 0n,
            inflowCount: 0,
            outflowCount: 0,
            truncated: false,
            errored: true,
            errorDetail: `例外: ${e.message || e}`,
            rawItemCount: 0,
            transactions: [],
          };
        }
        return { ex, result };
      })
    );

    for (const { ex, result } of results) {
      lastResultsByExchangeId[ex.id] = { rangeLabel, result };
    }

    if (listEl) {
      listEl.innerHTML = results.map(({ ex, result }) => rowHtml(ex, result)).join("");
    }

    // 「全取引所合計」は、追跡対象取引所同士の移動を除外して計算する
    // (renderSummary/CSV出力の両方でこの1回の計算結果を使い回す)
    const combinedTotals = computeCombinedExternalTotals(results.filter((r) => !r.result.errored));
    renderSummary(results, combinedTotals);

    // CSV出力用に、詳細な取引履歴(transactions)は含めずに保存する
    // (取引所フロー分析の詳細=流入・流出履歴はCSV出力の対象外とするため)
    lastExchangeFlowSummary = {
      rangeLabel,
      combinedTotals,
      results: results.map(({ ex, result }) => ({
        ex,
        result: {
          inflowAmount: result.inflowAmount,
          outflowAmount: result.outflowAmount,
          inflowCount: result.inflowCount,
          outflowCount: result.outflowCount,
          truncated: result.truncated,
          errored: result.errored,
          errorDetail: result.errorDetail,
        },
      })),
    };

    if (statusEl) {
      statusEl.textContent =
        `集計範囲: 高さ ${fromHeight.toLocaleString("ja-JP")} 〜 ${toHeight.toLocaleString("ja-JP")}（${rangeLabel}）`;
    }
  } catch (e) {
    console.error("loadExchangeFlowAnalysis error:", e);
    if (statusEl) statusEl.textContent = "取引所フロー分析の取得に失敗しました。";
  } finally {
    runBtns.forEach((b) => { if (b) b.disabled = false; });
  }
}

/* ============================================================
   取引履歴1件分のHTML(詳細画面用)
============================================================ */
function txRowHtml(tx) {
  const color = amountHighlightColor(tx.amount);
  const dirLabel = tx.direction === "in" ? "↙ 流入" : "↗ 流出";
  const dirColor = tx.direction === "in" ? "#4ade80" : "#f87171";
  const counterpartyLabel = tx.direction === "in" ? "送信元" : "送信先";
  const timeText =
    tx.timestampRaw != null && appState.epochAdjustment
      ? formatUtcJstFromMs(Number(appState.epochAdjustment) * 1000 + Number(tx.timestampRaw))
      : null;
  const explorerLink = tx.hash
    ? `<a href="${getExplorerUrl(tx.hash)}" target="_blank" rel="noopener" style="font-size:12px;color:#93c5fd;">Explorerで見る ↗</a>`
    : "";

  return `
    <div class="harvest-history-item">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="color:${dirColor};font-weight:bold;">${dirLabel}</span>
        <span style="color:${color};font-weight:bold;">${formatMosaicAmount(tx.amount, 6)} XYM</span>
      </div>
      <div style="font-size:12px;color:#94a3b8;word-break:break-all;">${counterpartyLabel}: ${tx.counterpartyAddress ?? "---"}</div>
      <div style="font-size:12px;color:#94a3b8;">高さ: ${tx.height ?? "---"}</div>
      ${timeText ? `<div style="font-size:12px;color:#94a3b8;">日付: ${timeText}</div>` : ""}
      ${explorerLink}
    </div>
  `;
}

/* ============================================================
   詳細画面(exchange-flow-detail-page)を描画する
============================================================ */
function renderExchangeDetail(exId) {
  const ex = EXCHANGES.find((e) => e.id === exId);
  const titleEl = document.getElementById("exchange-flow-detail-title");
  const addressEl = document.getElementById("exchange-flow-detail-address");
  const rangeEl = document.getElementById("exchange-flow-detail-range");
  const summaryEl = document.getElementById("exchange-flow-detail-summary");
  const listEl = document.getElementById("exchange-flow-detail-list");

  if (!ex) return;

  if (titleEl) titleEl.textContent = `${ex.label} の流入・流出履歴`;
  if (addressEl) addressEl.innerHTML = addressListHtml(ex);

  const entry = lastResultsByExchangeId[exId];

  if (!entry) {
    if (rangeEl) rangeEl.textContent = "";
    if (summaryEl) summaryEl.innerHTML = "";
    if (listEl) {
      listEl.innerHTML = `<div style="color:#94a3b8;">先に「データ」画面の「取引所フロー分析」で集計を実行してください</div>`;
    }
    return;
  }

  const { rangeLabel, result } = entry;
  if (rangeEl) rangeEl.textContent = rangeLabel;

  if (result.errored) {
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div style="color:#f97316;">⚠️ 取得に失敗しました(ノードへの問い合わせエラー)。「データ」画面に戻って再度集計を実行してください。</div>
        ${result.errorDetail ? `<div style="font-size:12px;color:#fbbf24;word-break:break-all;margin-top:4px;">詳細: ${result.errorDetail}</div>` : ""}
      `;
    }
    if (listEl) {
      listEl.innerHTML = `<div style="color:#94a3b8;">取得に失敗したため、この取引所の履歴は表示できません。</div>`;
    }
    return;
  }

  const net = result.inflowAmount - result.outflowAmount;
  const netText = (net > 0n ? "+" : "") + formatMosaicAmount(net, 6) + " XYM";

  if (summaryEl) {
    summaryEl.innerHTML = `
      <div>流入合計: <b style="color:#4ade80;">${formatMosaicAmount(result.inflowAmount, 6)} XYM</b>（${result.inflowCount.toLocaleString("ja-JP")}件）</div>
      <div>流出合計: <b style="color:#f87171;">${formatMosaicAmount(result.outflowAmount, 6)} XYM</b>（${result.outflowCount.toLocaleString("ja-JP")}件）</div>
      <div>純増減: <b style="color:${netColorOf(net)};">${netText}</b></div>
      ${result.truncated ? `<div style="color:#f97316;font-size:12px;margin-top:4px;">件数が多いため集計が打ち切られています</div>` : ""}
    `;
  }

  if (listEl) {
    const sorted = [...result.transactions].sort((a, b) => Number(b.height ?? 0) - Number(a.height ?? 0));

    if (sorted.length === 0) {
      listEl.innerHTML = `<div style="color:#94a3b8;">この期間の取引はありませんでした</div>`;
      return;
    }

    const visible = sorted.slice(0, DETAIL_MAX_SHOW);
    let html = visible.map((tx) => txRowHtml(tx)).join("");
    if (sorted.length > DETAIL_MAX_SHOW) {
      html += `<div style="color:#94a3b8;font-size:12px;margin-top:6px;">他 ${sorted.length - DETAIL_MAX_SHOW} 件（新しい順に${DETAIL_MAX_SHOW}件のみ表示）</div>`;
    }
    listEl.innerHTML = html;
  }
}

/* ============================================================
   画面切り替え(index.jsのshowPageと同じロジックをここでも使う。
   このモジュール単体でページ遷移を完結させるため)
============================================================ */
function showPageEl(pageEl) {
  if (!pageEl) return;
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  pageEl.classList.add("active");
}

function showExchangeDetail(exId) {
  renderExchangeDetail(exId);
  showPageEl(document.getElementById("exchange-flow-detail-page"));
}

/* ============================================================
   取引所フロー分析の結果をCSVとして書き出す。
   ・全取引所合計(合計流入・合計流出・合計純増減)
   ・取引所別内訳(流入・流出・純増減・件数)
   のみを対象とし、個別の取引履歴(流入・流出履歴)は含めない。
============================================================ */
function exportExchangeFlowCsv() {
  const statusEl = document.getElementById("exchange-flow-status");

  try {
    if (!lastExchangeFlowSummary) {
      if (statusEl) statusEl.textContent = "先に集計を実行してください。";
      return;
    }

    const { rangeLabel, results, combinedTotals } = lastExchangeFlowSummary;

    // 「全取引所合計」は、追跡対象取引所同士の移動を除外した正しい値
    // (集計実行時に計算済みのcombinedTotals)をそのまま使う。
    // 各取引所ごとの流入・流出をここで単純合算すると、取引所間の移動が
    // 二重計上されてしまうため使わない。
    const totalInflow = combinedTotals.inflow;
    const totalOutflow = combinedTotals.outflow;
    const totalNet = totalInflow - totalOutflow;

    const toXym = (atomic) => Number(atomic) / 1_000_000;

    const rows = [
      ["取引所フロー分析 集計結果"],
      ["集計範囲", rangeLabel],
      [],
      ["全取引所合計(追跡対象取引所間の移動は除く)"],
      ["合計流入(XYM)", toXym(totalInflow)],
      ["合計流入件数", combinedTotals.inflowCount],
      ["合計流出(XYM)", toXym(totalOutflow)],
      ["合計流出件数", combinedTotals.outflowCount],
      ["合計純増減(XYM)", toXym(totalNet)],
      ["除外した取引所間移動(XYM)", toXym(combinedTotals.interExchangeAmount)],
      ["除外した取引所間移動 件数", combinedTotals.interExchangeCount],
      [],
      ["取引所別内訳(参考: 各取引所単体で見た場合の流入・流出。取引所間の移動も含む)"],
      ["取引所", "アドレス", "流入(XYM)", "流入件数", "流出(XYM)", "流出件数", "純増減(XYM)", "打ち切り", "取得エラー"],
    ];

    for (const { ex, result } of results) {
      const addressText = ex.addresses.map((a) => (a.label ? `${a.label}: ${a.address}` : a.address)).join(" / ");

      if (result.errored) {
        rows.push([ex.label, addressText, "", "", "", "", "", "", result.errorDetail || "取得に失敗しました"]);
        continue;
      }

      const net = result.inflowAmount - result.outflowAmount;
      rows.push([
        ex.label,
        addressText,
        toXym(result.inflowAmount),
        result.inflowCount,
        toXym(result.outflowAmount),
        result.outflowCount,
        toXym(net),
        result.truncated ? "はい" : "いいえ",
        "",
      ]);
    }

    const dateStamp = new Date().toISOString().slice(0, 10);
    W.utils.downloadCsv(`exchange-flow-analysis-${dateStamp}.csv`, rows);
    if (statusEl) statusEl.textContent = "CSVファイルをダウンロードしました。";
  } catch (e) {
    console.error("exportExchangeFlowCsv error:", e);
    if (statusEl) statusEl.textContent = "CSVの生成に失敗しました: " + (e.message || e);
  }
}

/* ============================================================
   初期化: 一覧行のクリック / 詳細画面の戻るボタン
============================================================ */
function initExchangeFlowInteractions() {
  const listEl = document.getElementById("exchange-flow-list");
  listEl?.addEventListener("click", (e) => {
    const row = e.target.closest("[data-exchange-id]");
    if (!row) return;
    showExchangeDetail(row.getAttribute("data-exchange-id"));
  });

  document.getElementById("back-exchange-flow-detail")?.addEventListener("click", () => {
    showPageEl(document.getElementById("data-page"));
  });

  document.getElementById("exchange-flow-export-csv-btn")?.addEventListener("click", () => {
    exportExchangeFlowCsv();
  });
}

initExchangeFlowInteractions();

window.W.exchangeFlow = {
  loadExchangeFlowAnalysis,
};

})();
