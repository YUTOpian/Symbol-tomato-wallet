(function () {
"use strict";

// priceRates.js
// XYMの円換算(bitbank) / ドル換算(Gate.io) レートを取得する。
//
// どちらも取引所の公開API(認証不要)を直接ブラウザから叩く。
// 残高のライブ更新のたびに毎回問い合わせると取引所側に負荷をかけて
// しまうため、短時間キャッシュする。取得に失敗しても残高表示自体は
// 妨げないよう、呼び出し側は null を「今回は換算表示しない」として
// 扱うこと。

const CACHE_MS = 60 * 1000; // 60秒キャッシュ

let jpyCache = { rate: null, ts: 0 };
let usdCache = { rate: null, ts: 0, source: null };

/* ============================================================
   XYM/JPY (bitbank)
   https://public.bitbank.cc/xym_jpy/ticker
============================================================ */
async function getXymJpyRate() {
  if (jpyCache.rate != null && Date.now() - jpyCache.ts < CACHE_MS) {
    return jpyCache.rate;
  }

  try {
    const res = await fetch("https://public.bitbank.cc/xym_jpy/ticker");
    const json = await res.json();
    const last = Number(json?.data?.last);
    if (!Number.isFinite(last) || last <= 0) throw new Error("invalid rate");

    jpyCache = { rate: last, ts: Date.now() };
    return last;
  } catch (e) {
    console.warn("bitbank XYM/JPYレート取得失敗:", e);
    return jpyCache.rate; // 直近キャッシュがあればそれを使う。無ければnull
  }
}

/* ============================================================
   XYM/USD
   まずGate.io(XYM_USDTペア)を試す。Gate.ioはブラウザからの
   直接アクセスをCORSで許可していないことがあるため、失敗した場合は
   CoinGecko(ブラウザ向けCORS対応済み)にフォールバックする。
   戻り値: { rate: number|null, source: "Gate.io" | "CoinGecko" | null }
============================================================ */
async function getXymUsdRate() {
  if (usdCache.rate != null && Date.now() - usdCache.ts < CACHE_MS) {
    return { rate: usdCache.rate, source: usdCache.source };
  }

  try {
    const res = await fetch("https://api.gateio.ws/api/v4/spot/tickers?currency_pair=XYM_USDT");
    const json = await res.json();
    const last = Number(json?.[0]?.last);
    if (!Number.isFinite(last) || last <= 0) throw new Error("invalid rate");

    usdCache = { rate: last, ts: Date.now(), source: "Gate.io" };
    return { rate: last, source: "Gate.io" };
  } catch (e) {
    console.warn("Gate.io XYM/USDTレート取得失敗(CORSでブロックされている可能性)。CoinGeckoにフォールバックします:", e);
  }

  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=symbol&vs_currencies=usd");
    const json = await res.json();
    const last = Number(json?.symbol?.usd);
    if (!Number.isFinite(last) || last <= 0) throw new Error("invalid rate");

    usdCache = { rate: last, ts: Date.now(), source: "CoinGecko" };
    return { rate: last, source: "CoinGecko" };
  } catch (e) {
    console.warn("CoinGecko XYM/USDレート取得も失敗:", e);
    return { rate: usdCache.rate, source: usdCache.source };
  }
}

/* ============================================================
   過去の特定時点のXYM/JPY・XYM/USDレート(日足の終値ベース)
   ・大口移動一覧や取引所フロー履歴など、個々のトランザクションの
     「その時点でのおおよその金額」を表示するために使う。
   ・取引所のリアルタイムAPIは過去の特定時刻のレートを返さないため、
     日足(1日単位)の終値を近似値として用いる。日中の変動までは
     反映されない点に注意。
   ・日付(UTC基準の暦日)単位でキャッシュする。同じ日の複数の
     トランザクションで問い合わせが重複しないようにするため。
============================================================ */

// dateStr("YYYY-MM-DD", UTC) → rate|null
const jpyHistoricalCache = new Map();
// dateStr("YYYY-MM-DD", UTC) → { rate, source }|null
const usdHistoricalCache = new Map();
// year(number) → Map(dateStr → closeRate) | null(取得失敗)
const bitbankYearCandleCache = new Map();

function utcDateStrFromMs(unixMs) {
  const d = new Date(unixMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/* ============================================================
   bitbankの日足ローソク足データ(年単位でまとめて返ってくる)を取得し、
   「その年の日付 → 終値」のマップを作ってキャッシュする。
   https://public.bitbank.cc/xym_jpy/candlestick/1day/{year}
============================================================ */
async function ensureBitbankYearCandles(year) {
  if (bitbankYearCandleCache.has(year)) {
    return bitbankYearCandleCache.get(year);
  }

  try {
    const res = await fetch(`https://public.bitbank.cc/xym_jpy/candlestick/1day/${year}`);
    const json = await res.json();
    const ohlcv = json?.data?.candlestick?.[0]?.ohlcv ?? [];

    const map = new Map();
    for (const c of ohlcv) {
      // c: [open, high, low, close, volume, timestampMs]
      const closeRate = Number(c[3]);
      const tsMs = Number(c[5]);
      if (Number.isFinite(closeRate) && closeRate > 0 && Number.isFinite(tsMs)) {
        map.set(utcDateStrFromMs(tsMs), closeRate);
      }
    }

    bitbankYearCandleCache.set(year, map);
    return map;
  } catch (e) {
    console.warn(`bitbank 日足データ取得失敗(${year}年):`, e);
    bitbankYearCandleCache.set(year, null);
    return null;
  }
}

/* ============================================================
   指定時刻(unixMs)が属するUTC暦日の、XYM/JPY終値を返す(bitbank日足)
   取得できなければ null
============================================================ */
async function getHistoricalXymJpyRate(unixMs) {
  const dateStr = utcDateStrFromMs(unixMs);
  if (jpyHistoricalCache.has(dateStr)) {
    return jpyHistoricalCache.get(dateStr);
  }

  const year = new Date(unixMs).getUTCFullYear();
  const yearMap = await ensureBitbankYearCandles(year);
  const rate = yearMap ? yearMap.get(dateStr) ?? null : null;

  jpyHistoricalCache.set(dateStr, rate);
  return rate;
}

/* ============================================================
   指定時刻(unixMs)が属するUTC暦日の、XYM/USDレートを返す(CoinGecko)
   https://api.coingecko.com/api/v3/coins/symbol/history?date=DD-MM-YYYY
   戻り値: { rate: number, source: "CoinGecko" } | null
============================================================ */
async function getHistoricalXymUsdRate(unixMs) {
  const dateStr = utcDateStrFromMs(unixMs);
  if (usdHistoricalCache.has(dateStr)) {
    return usdHistoricalCache.get(dateStr);
  }

  const [y, m, d] = dateStr.split("-");
  const coingeckoDate = `${d}-${m}-${y}`; // CoinGeckoは DD-MM-YYYY 形式

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/symbol/history?date=${coingeckoDate}&localization=false`
    );
    const json = await res.json();
    const rate = Number(json?.market_data?.current_price?.usd);
    const result = Number.isFinite(rate) && rate > 0 ? { rate, source: "CoinGecko" } : null;

    usdHistoricalCache.set(dateStr, result);
    return result;
  } catch (e) {
    console.warn(`CoinGecko 過去レート取得失敗(${dateStr}):`, e);
    usdHistoricalCache.set(dateStr, null);
    return null;
  }
}

window.W.priceRates = {
  getXymJpyRate,
  getXymUsdRate,
  getHistoricalXymJpyRate,
  getHistoricalXymUsdRate
};

})();
