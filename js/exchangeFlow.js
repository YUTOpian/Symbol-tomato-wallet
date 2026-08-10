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
const {computeHeightRange} = W.onchainAnalysis;

const TRANSFER_TYPE = 16724; // Transfer Transaction
const SCAN_PAGE_SIZE = 100;
const SCAN_MAX_PAGES = 200; // 安全のための上限(アドレス1件あたり最大 20,000 件)

// 個別取引の強調表示しきい値(XYM)
const MID_AMOUNT_THRESHOLD_XYM = 100000; // これ以上は黄色
const HIGH_AMOUNT_THRESHOLD_XYM = 1000000; // これ以上は赤色

// 詳細画面に表示する取引の最大件数(新しい順)
const DETAIL_MAX_SHOW = 300;

const EXCHANGES = [
  { id: "bitbank", label: "Bitbank", address: "NDURU3U7Y7KKTPC2VVVF6U3VJIU5HDWSHQZCS4Q" },
  { id: "zaif", label: "Zaif", address: "NBVU44NKAED5MLPEY4Y7Z5OMUAUXLYI7HOIKNSY" },
  { id: "bitflyer", label: "bitFlyer", address: "NDLSY2ZHQO5BR7SYC6I3YCGAW4WYZCFUCX6PIZY" },
  { id: "mexc", label: "MEXC", address: "NABGDANLKUZ3D2SQOUEKPGYI6OAUFHEDW233FKY" },
  { id: "gateio", label: "Gate.io", address: "NBWKVE7QG7TNNPSHRKUP2BYQWMOGJBHI3DO4OTY" },
];

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
   1つの取引所アドレスについて、指定ブロック高範囲のXYM流入/流出を集計する。
   個々の取引(方向・金額・相手アドレス・高さ・ハッシュ)も
   transactions配列にすべて記録し、詳細画面でそのまま表示できるようにする。
============================================================ */
async function scanExchangeAddress(address, fromHeight, toHeight, xymMosaicIdHex, onProgress) {
  let pageNumber = 1;
  let inflowAmount = 0n;
  let outflowAmount = 0n;
  let inflowCount = 0;
  let outflowCount = 0;
  let truncated = false;
  const transactions = [];

  while (pageNumber <= SCAN_MAX_PAGES) {
    const params = new URLSearchParams({
      address,
      type: String(TRANSFER_TYPE),
      fromHeight: String(fromHeight),
      toHeight: String(toHeight),
      embedded: "true",
      pageSize: String(SCAN_PAGE_SIZE),
      pageNumber: String(pageNumber),
      order: "asc",
    });

    const res = await fetch(`${appState.NODE}/transactions/confirmed?${params}`);
    const json = await res.json();
    const items = json.data ?? [];
    if (items.length === 0) break;

    for (const item of items) {
      const tx = item.transaction;
      const mosaics = tx.mosaics || [];
      const xymEntry = mosaics.find((m) => String(m.id).toUpperCase() === xymMosaicIdHex);
      if (!xymEntry) continue; // XYMを含まない送金(他モザイクのみ)は対象外

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

      if (isInflow) {
        inflowAmount += amount;
        inflowCount++;
      } else {
        outflowAmount += amount;
        outflowCount++;
      }

      transactions.push({
        direction: isInflow ? "in" : "out",
        amount,
        counterpartyAddress,
        hash: item.meta?.hash,
        height: item.meta?.height,
      });
    }

    onProgress?.(pageNumber);

    // 新しいcatapult-restではpagination.totalPagesが廃止されているため、
    // 「フルページ未満が返ってきたら最終ページ」という判定で継続/終了を決める
    if (items.length < SCAN_PAGE_SIZE) break;
    pageNumber++;
  }

  if (pageNumber > SCAN_MAX_PAGES) truncated = true;

  return { inflowAmount, outflowAmount, inflowCount, outflowCount, truncated, transactions };
}

function netColorOf(net) {
  if (net > 0n) return "#4ade80";
  if (net < 0n) return "#f87171";
  return "#94a3b8";
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

function rowHtml(ex, result) {
  const net = result.inflowAmount - result.outflowAmount;
  const netText = (net > 0n ? "+" : "") + formatMosaicAmount(net, 6) + " XYM";
  const suffix = result.truncated ? " 以上(件数が多いため打ち切り)" : "";

  return `
    <div class="harvest-history-item exchange-flow-row" data-exchange-id="${ex.id}" style="cursor:pointer;">
      <div style="font-weight:bold;">${ex.label}</div>
      <div style="font-size:12px;color:#94a3b8;word-break:break-all;">${ex.address}</div>
      <div>流入: <b style="color:#4ade80;">${formatMosaicAmount(result.inflowAmount, 6)} XYM</b>（${result.inflowCount.toLocaleString("ja-JP")}件）${suffix}</div>
      <div>流出: <b style="color:#f87171;">${formatMosaicAmount(result.outflowAmount, 6)} XYM</b>（${result.outflowCount.toLocaleString("ja-JP")}件）${suffix}</div>
      <div>純増減: <b style="color:${netColorOf(net)};">${netText}</b></div>
      <div style="font-size:11px;color:#60a5fa;margin-top:4px;">クリックで取引履歴を見る →</div>
    </div>
  `;
}

function renderSummary(results) {
  const el = document.getElementById("exchange-flow-summary");
  if (!el) return;

  const totalInflow = results.reduce((s, r) => s + r.result.inflowAmount, 0n);
  const totalOutflow = results.reduce((s, r) => s + r.result.outflowAmount, 0n);
  const totalNet = totalInflow - totalOutflow;
  const totalTruncated = results.some((r) => r.result.truncated);
  const netText = (totalNet > 0n ? "+" : "") + formatMosaicAmount(totalNet, 6) + " XYM";

  el.innerHTML = `
    <div class="harvest-history-item">
      <div style="font-weight:bold;">全取引所合計</div>
      <div>合計流入: <b style="color:#4ade80;">${formatMosaicAmount(totalInflow, 6)} XYM</b></div>
      <div>合計流出: <b style="color:#f87171;">${formatMosaicAmount(totalOutflow, 6)} XYM</b></div>
      <div>合計純増減: <b style="color:${netColorOf(totalNet)};">${netText}</b></div>
      ${totalTruncated ? `<div style="color:#f97316;font-size:12px;margin-top:4px;">一部のアドレスで件数が多いため集計が打ち切られています</div>` : ""}
    </div>
  `;
}

/* ============================================================
   分析本体。「データ」画面の「取引所フロー分析」カードから呼ばれる。
   mode: "24h" | "7d" | "30d"
============================================================ */
async function loadExchangeFlowAnalysis(mode) {
  const statusEl = document.getElementById("exchange-flow-status");
  const listEl = document.getElementById("exchange-flow-list");
  const titleEl = document.getElementById("exchange-flow-range-title");
  const summaryEl = document.getElementById("exchange-flow-summary");
  const runBtns = [
    document.getElementById("exchange-flow-run-24h-btn"),
    document.getElementById("exchange-flow-run-7d-btn"),
    document.getElementById("exchange-flow-run-30d-btn"),
  ];

  if (!appState.NODE || !appState.epochAdjustment || !appState.facade) {
    if (statusEl) statusEl.textContent = "接続完了後にご利用いただけます。";
    return;
  }

  const hours = RANGE_HOURS[mode] ?? 24;
  const rangeLabelBase = RANGE_LABELS[mode] ?? "過去24時間";
  if (titleEl) titleEl.textContent = rangeLabelBase;

  runBtns.forEach((b) => { if (b) b.disabled = true; });
  if (listEl) listEl.innerHTML = `<div style="color:#94a3b8;">読み込み中...</div>`;
  if (summaryEl) summaryEl.innerHTML = "";
  if (statusEl) statusEl.textContent = "集計対象のブロック範囲を特定しています...";

  try {
    const { fromHeight, toHeight, fromTimestampMs, toTimestampMs } = await computeHeightRange("rollingHours", hours);
    const xymId = getXymMosaicIdHex();

    const fromDate = new Date(fromTimestampMs);
    const toDate = new Date(toTimestampMs);
    const rangeLabel =
      `${rangeLabelBase}（${fromDate.toISOString().replace("T", " ").slice(0, 19)} 〜 ` +
      `${toDate.toISOString().replace("T", " ").slice(0, 19)} UTC）`;

    const results = [];
    for (const ex of EXCHANGES) {
      if (statusEl) statusEl.textContent = `${ex.label} を集計中...`;
      const result = await scanExchangeAddress(ex.address, fromHeight, toHeight, xymId, (page) => {
        if (statusEl) statusEl.textContent = `${ex.label} を集計中...(${page}ページ目)`;
      });
      results.push({ ex, result });
      lastResultsByExchangeId[ex.id] = { rangeLabel, result };
    }

    if (listEl) {
      listEl.innerHTML = results.map(({ ex, result }) => rowHtml(ex, result)).join("");
    }
    renderSummary(results);

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
  if (addressEl) addressEl.textContent = ex.address;

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
    let html = visible.map(txRowHtml).join("");
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
}

initExchangeFlowInteractions();

window.W.exchangeFlow = {
  loadExchangeFlowAnalysis,
};

})();
