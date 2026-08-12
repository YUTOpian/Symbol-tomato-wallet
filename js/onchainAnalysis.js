(function () {
"use strict";

// onchainAnalysis.js
// データ画面「Symbolについて」に表示する、簡易オンチェーン分析。
// バックエンドを持たず、都度接続中のノードへ問い合わせるだけの構成のため、
// 「今」の状態を集計できるものだけを対象にしている(過去の残高推移や、
// 取引所アドレス一覧が前提になるような指標は対象外)。
//
// 集計期間は2種類から選べる:
//   - 過去24時間(rolling24h): 現在時刻から遡って24時間
//   - 昨日(yesterday): UTCでの昨日 0:00〜24:00 の固定1日分
//
// 集計対象:
//   - アクティブアドレス数(期間中、何らかのトランザクション(全種別・埋め込み含む)を
//     「送信元」として出したアドレスの延べ数)
//   - 新規アドレス作成数(上記のうち、REST APIで遡れる範囲でこの期間より前に
//     一度もトランザクションを出した履歴がないアドレスの数。近似値)
//   - 平均ブロック生成間隔(期間中の実測値)
//   - XYM移動量(総移動量・XYM送金件数・送金元/送金先アドレス数)
//   - モザイク送信件数(XYMを含む、何らかのモザイクを伴う送金の件数)
//   - 大口送金一覧(閾値以上のXYM送金)
//
// 集計はブロック高の範囲を二分探索で特定したうえで、/transactions/confirmed に
// fromHeight/toHeight を指定して取得する。件数はpagination.totalEntriesを
// 使うことで、全件取得せずに済む部分は極力軽量に済ませている。

const {appState, NetworkType} = W.config;
const {getXymMosaicIdHex} = W.config;
const {formatMosaicAmount} = W.utils;

const TRANSFER_TYPE = 16724; // Transfer Transaction
const WHALE_THRESHOLD_XYM = 10000; // 大口送金とみなす閾値(この金額以上を一覧に含める)
const WHALE_MID_THRESHOLD_XYM = 100000; // 一覧内での強調表示: これ以上は黄色
const WHALE_HIGH_THRESHOLD_XYM = 1000000; // 一覧内での強調表示: これ以上は赤色
const SCAN_PAGE_SIZE = 100;
const SCAN_MAX_PAGES = 200; // 安全のための上限(最大 20,000 件 / 20,000 ブロック)
const NEW_ADDRESS_CHECK_CONCURRENCY = 10; // 新規アドレス判定(初回トランザクション確認)の並列数

// 直近の集計結果(大口一覧の詳細画面表示用)
let lastWhaleResult = null; // { whales, rangeLabel }

/* ============================================================
   REST APIのアドレス表現(16進 or base32)を統一する
   (recipientInfo.js / apostille.js と同じ考え方)
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
   指定した高さのブロックタイムスタンプ(UnixMs)を取得する
============================================================ */
async function fetchBlockTimestampMs(height) {
  const res = await fetch(new URL("/blocks/" + height, appState.NODE));
  const json = await res.json();
  return Number(appState.epochAdjustment) * 1000 + Number(json.block.timestamp);
}

/* ============================================================
   指定したUnix時刻(ms)以降で最初のブロック高を二分探索で特定する
============================================================ */
async function findHeightForTimestamp(targetMs, currentHeight, currentTimestampMs) {
  // 平均30秒/ブロックと仮定して、まず探索範囲の下限を大まかに見積もる
  const estimatedBlocksAgo = Math.max(0, Math.round((currentTimestampMs - targetMs) / 30000));
  let lo = Math.max(1, currentHeight - estimatedBlocksAgo - 500);
  let hi = currentHeight;

  // 見積もりがズレて対象時刻を含んでいない場合に備え、範囲を広げる
  let safetyCounter = 0;
  while (lo > 1 && safetyCounter < 10) {
    const loTs = await fetchBlockTimestampMs(lo);
    if (loTs <= targetMs) break;
    hi = lo;
    lo = Math.max(1, lo - (hi - lo || 1000) * 2);
    safetyCounter++;
  }

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const ts = await fetchBlockTimestampMs(mid);
    if (ts < targetMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/* ============================================================
   指定した高さ範囲内のXYM送金トランザクションを走査し、
   総移動量・送金元/先アドレス集合・大口送金一覧を集計する。
   あわせて、XYMに限らずモザイクを1つ以上含む送金(モザイク送信)の
   件数もここで集計する(いずれもTransferTransactionが対象のため、
   同じスキャンで済ませられる)。
============================================================ */
async function scanXymTransfers(fromHeight, toHeight, xymMosaicIdHex, onProgress) {
  const whaleThresholdAtomic = BigInt(WHALE_THRESHOLD_XYM) * 1_000_000n;

  let pageNumber = 1;
  let totalAmount = 0n;
  let transferCount = 0;
  let mosaicTransferCount = 0;
  const senderPublicKeys = new Set();
  const recipientAddresses = new Set();
  const whales = [];
  let truncated = false;

  while (pageNumber <= SCAN_MAX_PAGES) {
    const params = new URLSearchParams({
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

      // モザイク送信件数(XYM含む。何らかのモザイクを1つ以上含む送金)
      if (mosaics.length > 0) mosaicTransferCount++;

      const xymEntry = mosaics.find((m) => String(m.id).toUpperCase() === xymMosaicIdHex);
      if (!xymEntry) continue; // XYMを含まない送金(他モザイクのみ)は対象外

      const amount = BigInt(xymEntry.amount);
      totalAmount += amount;
      transferCount++;

      if (tx.signerPublicKey) senderPublicKeys.add(tx.signerPublicKey);
      const recipientAddr = normalizeMaybeHexAddress(tx.recipientAddress);
      if (recipientAddr) recipientAddresses.add(recipientAddr);

      if (amount >= whaleThresholdAtomic) {
        whales.push({
          senderPublicKey: tx.signerPublicKey,
          recipientAddress: recipientAddr,
          amount,
          hash: item.meta?.hash,
          height: item.meta?.height,
        });
      }
    }

    onProgress?.(pageNumber);

    // 新しいcatapult-restではpagination.totalPagesが廃止されているため、
    // 「フルページ未満が返ってきたら最終ページ」という判定で継続/終了を決める
    if (items.length < SCAN_PAGE_SIZE) break;
    pageNumber++;
  }

  if (pageNumber > SCAN_MAX_PAGES) truncated = true;

  return { totalAmount, transferCount, mosaicTransferCount, senderPublicKeys, recipientAddresses, whales, truncated };
}

/* ============================================================
   指定した高さ範囲内の、全トランザクション種別(埋め込み含む)を対象に、
   「送信元」となったアドレスの延べ集合を集計する(アクティブアドレス数用)。
   /transactions/confirmed は type を指定しなければ全種別が対象になり、
   fromHeight/toHeightで絞り込めるため、/blocksを高さ1件ずつ取得するより
   大幅に軽量に済む。
============================================================ */
async function scanActiveAddresses(fromHeight, toHeight, onProgress) {
  let pageNumber = 1;
  const signerPublicKeys = new Set();
  let truncated = false;

  while (pageNumber <= SCAN_MAX_PAGES) {
    const params = new URLSearchParams({
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
      const signerPublicKey = item.transaction?.signerPublicKey;
      if (signerPublicKey) signerPublicKeys.add(signerPublicKey);
    }

    onProgress?.(pageNumber);

    if (items.length < SCAN_PAGE_SIZE) break;
    pageNumber++;
  }

  if (pageNumber > SCAN_MAX_PAGES) truncated = true;

  return { signerPublicKeys, truncated };
}

/* ============================================================
   アクティブアドレス(期間中に何らかのトランザクションを出したアドレス)
   のうち、「新規アドレス」(この期間より前にトランザクションを出した
   履歴がない=初めてトランザクションを出した)の数を数える。
   各アドレス(公開鍵)ごとに、そのアドレスが署名したトランザクションを
   古い順に1件だけ取得し、その高さがfromHeight以降であれば
   「この期間が初回」とみなす。
   件数に上限は設けず、対象アドレス全件を確認する(並列数のみ制限)。
============================================================ */
async function countNewAddresses(signerPublicKeys, fromHeight, onProgress) {
  const targets = [...signerPublicKeys];

  let newCount = 0;
  let failCount = 0;
  let doneCount = 0;

  async function checkOne(publicKeyHex) {
    try {
      const params = new URLSearchParams({
        signerPublicKey: publicKeyHex,
        order: "asc",
        pageSize: "1",
      });
      const res = await fetch(`${appState.NODE}/transactions/confirmed?${params}`);
      if (!res.ok) {
        failCount++;
        return;
      }
      const json = await res.json();
      const first = (json.data ?? [])[0];
      const firstHeight = Number(first?.meta?.height ?? 0);
      if (firstHeight >= fromHeight) newCount++;
    } catch (e) {
      console.warn("countNewAddresses: 初回トランザクション確認に失敗しました:", publicKeyHex, e);
      failCount++;
    } finally {
      doneCount++;
      onProgress?.(doneCount, targets.length);
    }
  }

  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const i = cursor++;
      await checkOne(targets[i]);
    }
  }

  const workers = Array.from({ length: Math.min(NEW_ADDRESS_CHECK_CONCURRENCY, targets.length) }, worker);
  await Promise.all(workers);

  return { newCount, failCount, checkedCount: targets.length };
}

/* ============================================================
   大口移動1件分の金額に応じた強調色
   100万XYM以上: 赤 / 10万XYM以上: 黄 / それ未満(10,000以上): 通常色
============================================================ */
function whaleAmountColor(amount) {
  const xymValue = Number(amount) / 1_000_000;
  if (xymValue >= WHALE_HIGH_THRESHOLD_XYM) return "#f87171";
  if (xymValue >= WHALE_MID_THRESHOLD_XYM) return "#facc15";
  return "#e5e7eb";
}

function whaleRowHtml(w) {
  let senderAddr = "---";
  try {
    senderAddr = w.senderPublicKey ? publicKeyToAddress(w.senderPublicKey) : "---";
  } catch {
    senderAddr = "---";
  }
  const color = whaleAmountColor(w.amount);
  const explorerLink = w.hash
    ? `<a href="${getExplorerUrl(w.hash)}" target="_blank" rel="noopener" style="font-size:12px;color:#93c5fd;">Explorerで見る ↗</a>`
    : "";

  return `
    <div class="harvest-history-item">
      <div><b style="color:${color};">${formatMosaicAmount(w.amount, 6)} XYM</b></div>
      <div style="font-size:12px;color:#94a3b8;word-break:break-all;">送信元: ${senderAddr}</div>
      <div style="font-size:12px;color:#94a3b8;word-break:break-all;">送信先: ${w.recipientAddress ?? "---"}</div>
      <div style="font-size:12px;color:#94a3b8;">高さ: ${w.height}</div>
      ${explorerLink}
    </div>
  `;
}

/* ============================================================
   大口XYM移動 詳細画面(onchain-whale-detail-page)を描画する
============================================================ */
function renderWhaleDetail() {
  const rangeEl = document.getElementById("onchain-whale-detail-range");
  const summaryEl = document.getElementById("onchain-whale-detail-summary");
  const listEl = document.getElementById("onchain-whale-detail-list");

  if (!lastWhaleResult) {
    if (rangeEl) rangeEl.textContent = "";
    if (summaryEl) summaryEl.innerHTML = "";
    if (listEl) {
      listEl.innerHTML = `<div style="color:#94a3b8;">先に「データ」画面の「オンチェーン分析」で集計を実行してください</div>`;
    }
    return;
  }

  const { whales, rangeLabel, truncated } = lastWhaleResult;
  if (rangeEl) rangeEl.textContent = rangeLabel;
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div>大口XYM移動件数(${WHALE_THRESHOLD_XYM.toLocaleString("ja-JP")} XYM以上): <b>${whales.length.toLocaleString("ja-JP")} 件</b></div>
      ${truncated ? `<div style="color:#f97316;font-size:12px;margin-top:4px;">件数が多いため集計が打ち切られています</div>` : ""}
    `;
  }

  if (listEl) {
    if (whales.length === 0) {
      listEl.innerHTML = `<div style="color:#94a3b8;">該当する大口移動はありませんでした</div>`;
      return;
    }
    const sorted = [...whales].sort((a, b) => Number(b.height) - Number(a.height));
    listEl.innerHTML = sorted.map(whaleRowHtml).join("");
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

function showWhaleDetail() {
  renderWhaleDetail();
  showPageEl(document.getElementById("onchain-whale-detail-page"));
}

function initOnchainAnalysisInteractions() {
  document.getElementById("onchain-whale-count-card")?.addEventListener("click", showWhaleDetail);
  document.getElementById("back-onchain-whale-detail")?.addEventListener("click", () => {
    showPageEl(document.getElementById("data-page"));
  });
}

initOnchainAnalysisInteractions();

/* ============================================================
   集計対象のブロック高範囲を決定する
   mode: "rolling24h"(現在時刻から過去24時間) | "yesterday"(UTC昨日 0:00〜24:00)
         | "rollingHours"(現在時刻から過去 hours 時間。exchangeFlow.js等の
            他モジュールから任意の期間で呼び出すために用意)
============================================================ */
async function computeHeightRange(mode, hours) {
  const chainInfo = await fetch(new URL("/chain/info", appState.NODE)).then((r) => r.json());
  const currentHeight = Number(chainInfo.height);
  const currentTimestampMs = await fetchBlockTimestampMs(currentHeight);

  const now = new Date();
  const todayMidnightMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);

  let fromMs, toHeight;

  if (mode === "yesterday") {
    fromMs = todayMidnightMs - 24 * 60 * 60 * 1000;
    const boundaryHeight = await findHeightForTimestamp(todayMidnightMs, currentHeight, currentTimestampMs);
    toHeight = Math.max(1, boundaryHeight - 1); // 今日0:00より前の最後の高さまでを「昨日」とする
  } else if (mode === "rollingHours") {
    fromMs = now.getTime() - (Number(hours) || 24) * 60 * 60 * 1000;
    toHeight = currentHeight;
  } else {
    fromMs = now.getTime() - 24 * 60 * 60 * 1000;
    toHeight = currentHeight;
  }

  const fromHeight = await findHeightForTimestamp(fromMs, currentHeight, currentTimestampMs);
  const fromTimestampMs = await fetchBlockTimestampMs(fromHeight);
  const toTimestampMs = toHeight === currentHeight ? currentTimestampMs : await fetchBlockTimestampMs(toHeight);

  return { fromHeight, toHeight, fromTimestampMs, toTimestampMs };
}

/* ============================================================
   分析本体。「データ」画面の「オンチェーン分析」カードから呼ばれる。
   mode: "rolling24h" | "yesterday"
============================================================ */
async function loadOnchainAnalysis(mode) {
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  const statusEl = document.getElementById("onchain-analysis-status");
  const runBtns = [
    document.getElementById("onchain-analysis-run-rolling-btn"),
    document.getElementById("onchain-analysis-run-yesterday-btn"),
  ];

  if (!appState.NODE || !appState.epochAdjustment || !appState.facade) {
    if (statusEl) statusEl.textContent = "接続完了後にご利用いただけます。";
    return;
  }

  runBtns.forEach((b) => { if (b) b.disabled = true; });
  if (statusEl) {
    statusEl.textContent =
      (mode === "yesterday" ? "昨日(UTC)の" : "過去24時間の") + "集計対象のブロック範囲を特定しています...";
  }

  const titleEl = document.getElementById("onchain-analysis-range-title");
  if (titleEl) {
    titleEl.textContent = mode === "yesterday" ? "昨日(UTC 0:00〜24:00)" : "過去24時間(現在時刻基準)";
  }

  try {
    const { fromHeight, toHeight, fromTimestampMs, toTimestampMs } = await computeHeightRange(mode);

    // 平均ブロック生成間隔
    const blockCount = toHeight - fromHeight;
    const avgBlockIntervalSec = blockCount > 0 ? (toTimestampMs - fromTimestampMs) / 1000 / blockCount : null;
    setText("onchain-avg-block-time", avgBlockIntervalSec != null ? `${avgBlockIntervalSec.toFixed(1)} 秒` : "---");

    const xymId = getXymMosaicIdHex();

    if (statusEl) statusEl.textContent = "XYM送金トランザクションを集計中...";
    const result = await scanXymTransfers(fromHeight, toHeight, xymId, (page) => {
      if (statusEl) statusEl.textContent = `XYM送金トランザクションを集計中...(${page}ページ目)`;
    });

    const suffix = result.truncated ? " 以上(件数が多いため打ち切り)" : "";

    setText("onchain-transfer-count", result.transferCount.toLocaleString("ja-JP") + " 件" + suffix);
    setText("onchain-xym-volume", formatMosaicAmount(result.totalAmount, 6) + " XYM" + suffix);
    setText("onchain-mosaic-transfer-count", result.mosaicTransferCount.toLocaleString("ja-JP") + " 件" + suffix);
    setText("onchain-whale-count", result.whales.length.toLocaleString("ja-JP") + " 件" + suffix);

    // アクティブアドレス数(全トランザクション種別・埋め込み含む、送信元ベース)
    if (statusEl) statusEl.textContent = "アクティブアドレスを集計中...";
    const activeResult = await scanActiveAddresses(fromHeight, toHeight, (page) => {
      if (statusEl) statusEl.textContent = `アクティブアドレスを集計中...(${page}ページ目)`;
    });
    const activeSuffix = activeResult.truncated ? " 以上(件数が多いため打ち切り)" : "";
    setText(
      "onchain-active-address-count",
      activeResult.signerPublicKeys.size.toLocaleString("ja-JP") + " アドレス" + activeSuffix
    );

    // 新規アドレス作成数(アクティブアドレスのうち、この期間が初回のもの)
    if (activeResult.signerPublicKeys.size === 0) {
      setText("onchain-new-address-count", "0 アドレス");
    } else {
      const newAddrResult = await countNewAddresses(activeResult.signerPublicKeys, fromHeight, (done, total) => {
        if (statusEl) statusEl.textContent = `新規アドレスを確認中...(${done.toLocaleString("ja-JP")} / ${total.toLocaleString("ja-JP")} アドレス)`;
      });
      setText(
        "onchain-new-address-count",
        newAddrResult.newCount.toLocaleString("ja-JP") + " アドレス" + activeSuffix +
        (newAddrResult.failCount > 0 ? `（${newAddrResult.failCount}件確認失敗）` : "")
      );
    }

    const fromDate = new Date(fromTimestampMs);
    const toDate = new Date(toTimestampMs);
    const rangeLabel =
      mode === "yesterday"
        ? `${fromDate.toISOString().replace("T", " ").slice(0, 19)} 〜 ${toDate.toISOString().replace("T", " ").slice(0, 19)} UTC`
        : `${fromDate.toISOString().replace("T", " ").slice(0, 19)} UTC 〜 現在`;

    // 大口XYM移動 詳細画面用に保存(クリックされたときに再取得せず表示するため)
    lastWhaleResult = { whales: result.whales, rangeLabel, truncated: result.truncated };

    if (statusEl) {
      statusEl.textContent = `集計範囲: 高さ ${fromHeight.toLocaleString("ja-JP")} 〜 ${toHeight.toLocaleString("ja-JP")}（${rangeLabel}）`;
    }
  } catch (e) {
    console.error("loadOnchainAnalysis error:", e);
    if (statusEl) statusEl.textContent = "オンチェーン分析の取得に失敗しました。";
  } finally {
    runBtns.forEach((b) => { if (b) b.disabled = false; });
  }
}

window.W.onchainAnalysis = {
  loadOnchainAnalysis,
  computeHeightRange,
  fetchBlockTimestampMs,
};

})();
