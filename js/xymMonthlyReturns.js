(function () {
"use strict";

// xymMonthlyReturns.js
// 「XYM 月次のリターン (%)」表示機能
// coinglassの「ビットコイン 月次のリターン (%)」表と同様の見た目で、
// XYMの月次リターンを年×月のヒートマップテーブルで表示する。
// 円建て/ドル建てはこの画面上のボタンで切り替えられる(いずれもCoinGeckoから取得)。
//
// XYMは2021年3月17日にローンチしたため、2021年3月分からを表示対象とする。
//
// 月次リターンの計算方法:
//   ・ローンチ月(2021年3月)は「月内で最初に取得できた価格」を基準にする
//     (ローンチ前のデータは存在しないため)
//   ・それ以降の月は「前月の最終価格」を基準にする(前月末比の連鎖)
//   ・各月の終値は、その月でCoinGeckoから取得できた最後(最新)の価格を使う
//     (進行中の月は、直近の取得時点までの暫定リターンになる)

const COINGECKO_ID = "symbol";
const LAUNCH_DATE_MS = Date.UTC(2021, 2, 17); // 2021-03-17 (月は0始まり)

// currency ("jpy" | "usd") → CoinGeckoから取得した日次価格配列([[unixMs, price], ...])
// をキャッシュする(画面を開き直すたびに問い合わせないようにするため)
const priceCache = {};

// キャッシュの有効期限。この時間が経過するまでは、同じセッション内はもちろん
// ページを再読み込みしてもCoinGeckoへ再取得しにいかない(localStorageに保存)。
// 月次リターンの過去分はほぼ変化しないが、進行中の月(今日の価格)は
// 変わり得るため、あまり長すぎない値にしている。
const CACHE_TTL_MS = 60 * 60 * 1000; // 1時間
const CACHE_STORAGE_PREFIX = "xymMonthlyReturnsCache:";

function loadCachedPricesFromStorage(currency) {
  try {
    const raw = localStorage.getItem(CACHE_STORAGE_PREFIX + currency);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.prices) || typeof parsed.ts !== "number") return null;
    if (Date.now() - parsed.ts > CACHE_TTL_MS) return null; // 期限切れ

    return parsed.prices;
  } catch (e) {
    console.warn("XYM月次リターン: キャッシュの読み込みに失敗しました", e);
    return null;
  }
}

function saveCachedPricesToStorage(currency, prices) {
  try {
    localStorage.setItem(CACHE_STORAGE_PREFIX + currency, JSON.stringify({ ts: Date.now(), prices }));
  } catch (e) {
    console.warn("XYM月次リターン: キャッシュの保存に失敗しました", e);
  }
}

/* ============================================================
   CoinGeckoから日次価格を取得(ローンチ日〜現在)
   https://api.coingecko.com/api/v3/coins/symbol/market_chart/range
============================================================ */
async function fetchDailyPrices(currency) {
  if (priceCache[currency]) return priceCache[currency];

  const cachedFromStorage = loadCachedPricesFromStorage(currency);
  if (cachedFromStorage) {
    priceCache[currency] = cachedFromStorage;
    return cachedFromStorage;
  }

  const fromSec = Math.floor(LAUNCH_DATE_MS / 1000);
  const toSec = Math.floor(Date.now() / 1000);

  const url =
    `https://api.coingecko.com/api/v3/coins/${COINGECKO_ID}/market_chart/range` +
    `?vs_currency=${currency}&from=${fromSec}&to=${toSec}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CoinGeckoからの価格取得に失敗しました(HTTP ${res.status})。`);
  }

  const json = await res.json();
  const prices = Array.isArray(json?.prices) ? json.prices : [];

  if (prices.length === 0) {
    throw new Error("CoinGeckoから価格データを取得できませんでした。");
  }

  priceCache[currency] = prices;
  saveCachedPricesToStorage(currency, prices);
  return prices;
}

/* ============================================================
   ローンチ月〜現在月までの年月シーケンスを作る(昇順)
============================================================ */
function buildMonthSequence() {
  const months = [];
  const start = new Date(LAUNCH_DATE_MS);
  const now = new Date();

  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + 1; // 1-12

  while (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth() + 1)) {
    months.push({ year: y, month: m });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }

  return months;
}

/* ============================================================
   日次価格配列 → 「年月ごとの、その月最後に取得できた価格」マップを作る
   キー: "YYYY-M"(月は1始まり)
============================================================ */
function buildMonthEndPriceMap(prices) {
  const map = new Map();

  for (const [ts, price] of prices) {
    const d = new Date(ts);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
    const existing = map.get(key);
    if (!existing || ts > existing.timestampMs) {
      map.set(key, { price, timestampMs: ts });
    }
  }

  return map;
}

/* ============================================================
   月次リターン(%)を計算する
   戻り値: Map<"YYYY-M", returnPercent(number)|null>
============================================================ */
function computeMonthlyReturns(prices) {
  const months = buildMonthSequence();
  const monthEndMap = buildMonthEndPriceMap(prices);
  const returns = new Map();

  if (months.length === 0) return returns;

  // ローンチ月の「月内で最初に取得できた価格」を求める(前月が存在しないため)
  let launchMonthFirstPrice = null;
  for (const [, price] of prices) {
    launchMonthFirstPrice = price;
    break;
  }

  let prevEndPrice = null;

  for (let i = 0; i < months.length; i++) {
    const { year, month } = months[i];
    const key = `${year}-${month}`;
    const entry = monthEndMap.get(key);

    if (!entry) {
      returns.set(key, null);
      continue;
    }

    const basePrice = i === 0 ? launchMonthFirstPrice : prevEndPrice;

    if (basePrice == null || basePrice === 0) {
      returns.set(key, null);
    } else {
      returns.set(key, (entry.price / basePrice - 1) * 100);
    }

    prevEndPrice = entry.price;
  }

  return returns;
}

/* ============================================================
   統計(平均値・中央値)
============================================================ */
function average(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ============================================================
   表示
============================================================ */
function formatPercent(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

// 値の大小に応じたセルの背景色・文字色(coinglassの配色に寄せた緑/赤)
function cellStyleForValue(value) {
  const base = "padding:6px 4px;text-align:center;border-radius:4px;font-size:12px;white-space:nowrap;";
  if (value == null || !Number.isFinite(value)) {
    return `${base}background:#1f2937;color:#6b7280;`;
  }
  return value >= 0
    ? `${base}background:#10b981;color:#052e1c;font-weight:600;`
    : `${base}background:#ef4444;color:#2c0a0a;font-weight:600;`;
}

const SUMMARY_CELL_STYLE =
  "padding:6px 4px;text-align:center;border-radius:4px;font-size:12px;white-space:nowrap;background:#4b5563;color:#f3f4f6;font-weight:600;";
const YEAR_CELL_STYLE =
  "padding:6px 8px;text-align:center;font-size:12px;font-weight:bold;color:#e5e7eb;white-space:nowrap;";

function renderTable(returns) {
  const wrap = document.getElementById("xym-monthly-returns-table-wrap");
  if (!wrap) return;

  const months = buildMonthSequence();
  if (months.length === 0) {
    wrap.innerHTML = "";
    return;
  }

  const years = [...new Set(months.map((m) => m.year))].sort((a, b) => b - a); // 新しい年が上
  const monthCols = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  let html =
    `<table style="border-collapse:separate;border-spacing:4px;width:100%;min-width:760px;">` +
    `<thead><tr>` +
    `<th style="font-size:12px;color:#94a3b8;padding:4px 8px;">年</th>` +
    monthCols.map((m) => `<th style="font-size:12px;color:#94a3b8;padding:4px;">${m}月</th>`).join("") +
    `</tr></thead><tbody>`;

  for (const year of years) {
    html += `<tr><td style="${YEAR_CELL_STYLE}">${year}</td>`;
    for (const m of monthCols) {
      const key = `${year}-${m}`;
      const value = returns.has(key) ? returns.get(key) : undefined;
      const displayValue = returns.has(key) ? value : null;
      html += `<td style="${cellStyleForValue(displayValue)}">${formatPercent(displayValue)}</td>`;
    }
    html += `</tr>`;
  }

  // 平均値・中央値(列=月ごとに、実際に値のある年だけで計算する)
  const avgCells = [];
  const medCells = [];
  for (const m of monthCols) {
    const values = [];
    for (const year of years) {
      const v = returns.get(`${year}-${m}`);
      if (v != null && Number.isFinite(v)) values.push(v);
    }
    avgCells.push(average(values));
    medCells.push(median(values));
  }

  html += `<tr><td style="${YEAR_CELL_STYLE}">平均値</td>`;
  html += avgCells.map((v) => `<td style="${SUMMARY_CELL_STYLE}">${formatPercent(v)}</td>`).join("");
  html += `</tr>`;

  html += `<tr><td style="${YEAR_CELL_STYLE}">中央値</td>`;
  html += medCells.map((v) => `<td style="${SUMMARY_CELL_STYLE}">${formatPercent(v)}</td>`).join("");
  html += `</tr>`;

  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

/* ============================================================
   読み込み〜描画までまとめて行う(呼び出し元用)
============================================================ */
async function loadXymMonthlyReturnsTable(currency) {
  const statusEl = document.getElementById("xym-monthly-returns-status");
  const wrap = document.getElementById("xym-monthly-returns-table-wrap");

  if (statusEl) statusEl.textContent = "読み込み中...";

  try {
    const prices = await fetchDailyPrices(currency);
    const returns = computeMonthlyReturns(prices);
    renderTable(returns);
    if (statusEl) statusEl.textContent = "";
  } catch (e) {
    console.error("XYM月次リターン取得失敗:", e);
    if (statusEl) statusEl.textContent = e.message || "取得に失敗しました。";
    if (wrap) wrap.innerHTML = "";
  }
}

window.W.xymMonthlyReturns = {
  loadXymMonthlyReturnsTable
};

})();
