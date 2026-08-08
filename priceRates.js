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

window.W.priceRates = {
  getXymJpyRate,
  getXymUsdRate
};
