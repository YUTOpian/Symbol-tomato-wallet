(function () {
"use strict";

// onchainAnalysis.js
// データ画面「Symbolについて」に表示する、簡易オンチェーン分析。
// バックエンドを持たず、都度接続中のノードへ問い合わせるだけの構成のため、
// 「今」の状態を集計できるものだけを対象にしている(過去の残高推移や、
// 取引所アドレス一覧が前提になるような指標は対象外)。
//
// 集計対象:
//   - 24時間トランザクション数(本日UTC 0:00〜現在。全トランザクション種別)
//   - アクティブアカウント数(本日、XYMの送受信をしたアドレスの延べ数。※送金以外の
//     操作(モザイク作成等)のみを行ったアカウントは含まない概算値)
//   - 平均ブロック生成間隔(本日分の実測値)
//   - 24時間のXYM移動量(総移動量・送金件数・送金元/送金先アドレス数)
//   - 大口送金一覧(閾値以上のXYM送金)
//
// 集計はブロック高の範囲(今日のUTC 0:00に対応する高さ 〜 最新高さ)を
// 二分探索で特定したうえで、/transactions/confirmed に fromHeight/toHeight
// を指定して取得する。件数はpagination.totalEntriesを使うことで、
// 全件取得せずに済む部分は極力軽量に済ませている。

const {appState} = W.config;
const {getXymMosaicIdHex} = W.config;
const {formatMosaicAmount} = W.utils;

const TRANSFER_TYPE = 16724; // Transfer Transaction
const WHALE_THRESHOLD_XYM = 10000; // 大口送金とみなす閾値
const SCAN_PAGE_SIZE = 100;
const SCAN_MAX_PAGES = 200; // 安全のための上限(最大 20,000 件)
const DETAIL_SCAN_LIMIT = 20000; // これを超える送金件数の日は詳細集計(合計量・送金元/先等)を省略する

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
   総移動量・送金元/先アドレス集合・大口送金一覧を集計する
============================================================ */
async function scanXymTransfers(fromHeight, toHeight, xymMosaicIdHex, onProgress) {
  const whaleThresholdAtomic = BigInt(WHALE_THRESHOLD_XYM) * 1_000_000n;

  let pageNumber = 1;
  let totalAmount = 0n;
  let transferCount = 0;
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

    const totalPages = json.pagination?.totalPages ?? pageNumber;
    if (pageNumber >= totalPages) break;
    pageNumber++;
  }

  if (pageNumber > SCAN_MAX_PAGES) truncated = true;

  return { totalAmount, transferCount, senderPublicKeys, recipientAddresses, whales, truncated };
}

function renderWhaleList(whales) {
  const el = document.getElementById("onchain-whale-list");
  if (!el) return;

  if (whales.length === 0) {
    el.innerHTML = `<div style="color:#94a3b8;">該当する大口送金はありませんでした</div>`;
    return;
  }

  const sorted = [...whales].sort((a, b) => Number(b.height) - Number(a.height));
  const MAX_SHOW = 30;
  const visible = sorted.slice(0, MAX_SHOW);

  el.innerHTML = visible
    .map((w) => {
      let senderAddr = "---";
      try {
        senderAddr = w.senderPublicKey ? publicKeyToAddress(w.senderPublicKey) : "---";
      } catch {
        senderAddr = "---";
      }
      return `
        <div class="harvest-history-item">
          <div><b>${formatMosaicAmount(w.amount, 6)} XYM</b></div>
          <div style="font-size:12px;color:#94a3b8;">送信元: ${senderAddr}</div>
          <div style="font-size:12px;color:#94a3b8;">送信先: ${w.recipientAddress ?? "---"}</div>
          <div style="font-size:12px;color:#94a3b8;">高さ: ${w.height}</div>
        </div>
      `;
    })
    .join("");

  if (sorted.length > MAX_SHOW) {
    el.innerHTML += `<div style="color:#94a3b8;font-size:12px;margin-top:6px;">他 ${sorted.length - MAX_SHOW} 件</div>`;
  }
}

/* ============================================================
   分析本体。「データ」画面の「オンチェーン分析」カードから呼ばれる。
============================================================ */
async function loadOnchainAnalysis() {
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  const statusEl = document.getElementById("onchain-analysis-status");
  const runBtn = document.getElementById("onchain-analysis-run-btn");

  if (!appState.NODE || !appState.epochAdjustment || !appState.facade) {
    if (statusEl) statusEl.textContent = "接続完了後にご利用いただけます。";
    return;
  }

  if (runBtn) runBtn.disabled = true;
  if (statusEl) statusEl.textContent = "集計対象のブロック範囲を特定しています...";

  const whaleListEl = document.getElementById("onchain-whale-list");
  if (whaleListEl) whaleListEl.innerHTML = `<div style="color:#94a3b8;">読み込み中...</div>`;

  try {
    const chainInfo = await fetch(new URL("/chain/info", appState.NODE)).then((r) => r.json());
    const currentHeight = Number(chainInfo.height);
    const currentTimestampMs = await fetchBlockTimestampMs(currentHeight);

    const now = new Date();
    const startOfDayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);

    const fromHeight = await findHeightForTimestamp(startOfDayMs, currentHeight, currentTimestampMs);
    const toHeight = currentHeight;
    const fromTimestampMs = await fetchBlockTimestampMs(fromHeight);

    // 平均ブロック生成間隔
    const blockCount = toHeight - fromHeight;
    const avgBlockIntervalSec = blockCount > 0 ? (currentTimestampMs - fromTimestampMs) / 1000 / blockCount : null;
    setText("onchain-avg-block-time", avgBlockIntervalSec != null ? `${avgBlockIntervalSec.toFixed(1)} 秒` : "---");

    // 24時間トランザクション数(全種別。埋め込みトランザクションも含む)
    if (statusEl) statusEl.textContent = "トランザクション総数を確認中...";
    const totalTxParams = new URLSearchParams({
      fromHeight: String(fromHeight),
      toHeight: String(toHeight),
      embedded: "true",
      pageSize: "1",
      pageNumber: "1",
    });
    const totalTxJson = await fetch(`${appState.NODE}/transactions/confirmed?${totalTxParams}`).then((r) => r.json());
    const totalTxCount = totalTxJson.pagination?.totalEntries;
    setText("onchain-tx-count", totalTxCount != null ? totalTxCount.toLocaleString("ja-JP") + " 件" : "取得失敗");

    // XYM送金の件数をまず軽量に確認する
    const xymId = getXymMosaicIdHex();
    const transferCountParams = new URLSearchParams({
      type: String(TRANSFER_TYPE),
      fromHeight: String(fromHeight),
      toHeight: String(toHeight),
      embedded: "true",
      pageSize: "1",
      pageNumber: "1",
    });
    const transferCountJson = await fetch(`${appState.NODE}/transactions/confirmed?${transferCountParams}`).then((r) =>
      r.json()
    );
    const totalTransferCount = transferCountJson.pagination?.totalEntries ?? 0;

    if (totalTransferCount > DETAIL_SCAN_LIMIT) {
      setText("onchain-transfer-count", `${totalTransferCount.toLocaleString("ja-JP")} 件(送金取引に限らない可能性あり)`);
      setText("onchain-xym-volume", "件数が多いため省略");
      setText("onchain-sender-count", "省略");
      setText("onchain-recipient-count", "省略");
      setText("onchain-active-accounts", "省略");
      if (whaleListEl) {
        whaleListEl.innerHTML = `<div style="color:#94a3b8;">送金件数が多いため、大口送金の集計は省略しました</div>`;
      }
    } else {
      if (statusEl) statusEl.textContent = "XYM送金トランザクションを集計中...";
      const result = await scanXymTransfers(fromHeight, toHeight, xymId, (page) => {
        if (statusEl) statusEl.textContent = `XYM送金トランザクションを集計中...(${page}ページ目)`;
      });

      const suffix = result.truncated ? " 以上(件数が多いため打ち切り)" : "";

      setText("onchain-transfer-count", result.transferCount.toLocaleString("ja-JP") + " 件" + suffix);
      setText("onchain-xym-volume", formatMosaicAmount(result.totalAmount, 6) + " XYM" + suffix);

      let senderAddresses;
      try {
        senderAddresses = new Set([...result.senderPublicKeys].map(publicKeyToAddress));
      } catch (e) {
        console.warn("送金元アドレス変換に失敗しました:", e);
        senderAddresses = result.senderPublicKeys;
      }

      setText("onchain-sender-count", senderAddresses.size.toLocaleString("ja-JP") + " アドレス" + suffix);
      setText("onchain-recipient-count", result.recipientAddresses.size.toLocaleString("ja-JP") + " アドレス" + suffix);

      const activeAccounts = new Set([...senderAddresses, ...result.recipientAddresses]);
      setText("onchain-active-accounts", activeAccounts.size.toLocaleString("ja-JP") + " アドレス(送金ベースの概算)" + suffix);

      renderWhaleList(result.whales);
    }

    const fromDate = new Date(fromTimestampMs);
    if (statusEl) {
      statusEl.textContent = `集計範囲: 高さ ${fromHeight.toLocaleString("ja-JP")} 〜 ${toHeight.toLocaleString("ja-JP")}（${fromDate.toISOString().replace("T", " ").slice(0, 19)} UTC 〜 現在）`;
    }
  } catch (e) {
    console.error("loadOnchainAnalysis error:", e);
    if (statusEl) statusEl.textContent = "オンチェーン分析の取得に失敗しました。";
  } finally {
    if (runBtn) runBtn.disabled = false;
  }
}

window.W.onchainAnalysis = {
  loadOnchainAnalysis,
};

})();
