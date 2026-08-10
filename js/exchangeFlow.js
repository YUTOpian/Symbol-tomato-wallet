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
// 同一取引所が用途別に複数アドレスを使っている場合(Zaifのデポジット/出金分離など)は
// 別ラベルの行として個別に集計・表示する。

const {appState, getXymMosaicIdHex} = W.config;
const {formatMosaicAmount} = W.utils;
const {computeHeightRange} = W.onchainAnalysis;

const TRANSFER_TYPE = 16724; // Transfer Transaction
const SCAN_PAGE_SIZE = 100;
const SCAN_MAX_PAGES = 200; // 安全のための上限(アドレス1件あたり最大 20,000 件)

const EXCHANGES = [
  { id: "bitbank", label: "Bitbank", address: "NDURU3U7Y7KKTPC2VVVF6U3VJIU5HDWSHQZCS4Q" },
  { id: "zaif-deposit", label: "Zaif（デポジット）", address: "NBVU44NKAED5MLPEY4Y7Z5OMUAUXLYI7HOIKNSY" },
  { id: "zaif-withdrawal", label: "Zaif（出金）", address: "NA2NFUHQWYIASA5BHFJBM6OBQDEZDI34RUMNDHA" },
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

/* ============================================================
   1つの取引所アドレスについて、指定ブロック高範囲のXYM流入/流出を集計する
============================================================ */
async function scanExchangeAddress(address, fromHeight, toHeight, xymMosaicIdHex, onProgress) {
  let pageNumber = 1;
  let inflowAmount = 0n;
  let outflowAmount = 0n;
  let inflowCount = 0;
  let outflowCount = 0;
  let truncated = false;

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

      if (recipientAddr === address) {
        inflowAmount += amount;
        inflowCount++;
      } else {
        outflowAmount += amount;
        outflowCount++;
      }
    }

    onProgress?.(pageNumber);

    // 新しいcatapult-restではpagination.totalPagesが廃止されているため、
    // 「フルページ未満が返ってきたら最終ページ」という判定で継続/終了を決める
    if (items.length < SCAN_PAGE_SIZE) break;
    pageNumber++;
  }

  if (pageNumber > SCAN_MAX_PAGES) truncated = true;

  return { inflowAmount, outflowAmount, inflowCount, outflowCount, truncated };
}

function netColorOf(net) {
  if (net > 0n) return "#4ade80";
  if (net < 0n) return "#f87171";
  return "#94a3b8";
}

function rowHtml(ex, result) {
  const net = result.inflowAmount - result.outflowAmount;
  const netText = (net > 0n ? "+" : "") + formatMosaicAmount(net, 6) + " XYM";
  const suffix = result.truncated ? " 以上(件数が多いため打ち切り)" : "";

  return `
    <div class="harvest-history-item">
      <div style="font-weight:bold;">${ex.label}</div>
      <div style="font-size:12px;color:#94a3b8;word-break:break-all;">${ex.address}</div>
      <div>流入: <b style="color:#4ade80;">${formatMosaicAmount(result.inflowAmount, 6)} XYM</b>（${result.inflowCount.toLocaleString("ja-JP")}件）${suffix}</div>
      <div>流出: <b style="color:#f87171;">${formatMosaicAmount(result.outflowAmount, 6)} XYM</b>（${result.outflowCount.toLocaleString("ja-JP")}件）${suffix}</div>
      <div>純増減: <b style="color:${netColorOf(net)};">${netText}</b></div>
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
  if (titleEl) titleEl.textContent = RANGE_LABELS[mode] ?? "過去24時間";

  runBtns.forEach((b) => { if (b) b.disabled = true; });
  if (listEl) listEl.innerHTML = `<div style="color:#94a3b8;">読み込み中...</div>`;
  if (summaryEl) summaryEl.innerHTML = "";
  if (statusEl) statusEl.textContent = "集計対象のブロック範囲を特定しています...";

  try {
    const { fromHeight, toHeight, fromTimestampMs, toTimestampMs } = await computeHeightRange("rollingHours", hours);
    const xymId = getXymMosaicIdHex();

    const results = [];
    for (const ex of EXCHANGES) {
      if (statusEl) statusEl.textContent = `${ex.label} を集計中...`;
      const result = await scanExchangeAddress(ex.address, fromHeight, toHeight, xymId, (page) => {
        if (statusEl) statusEl.textContent = `${ex.label} を集計中...(${page}ページ目)`;
      });
      results.push({ ex, result });
    }

    if (listEl) {
      listEl.innerHTML = results.map(({ ex, result }) => rowHtml(ex, result)).join("");
    }
    renderSummary(results);

    const fromDate = new Date(fromTimestampMs);
    const toDate = new Date(toTimestampMs);
    if (statusEl) {
      statusEl.textContent =
        `集計範囲: 高さ ${fromHeight.toLocaleString("ja-JP")} 〜 ${toHeight.toLocaleString("ja-JP")}` +
        `（${fromDate.toISOString().replace("T", " ").slice(0, 19)} 〜 ${toDate.toISOString().replace("T", " ").slice(0, 19)} UTC）`;
    }
  } catch (e) {
    console.error("loadExchangeFlowAnalysis error:", e);
    if (statusEl) statusEl.textContent = "取引所フロー分析の取得に失敗しました。";
  } finally {
    runBtns.forEach((b) => { if (b) b.disabled = false; });
  }
}

window.W.exchangeFlow = {
  loadExchangeFlowAnalysis,
};

})();
