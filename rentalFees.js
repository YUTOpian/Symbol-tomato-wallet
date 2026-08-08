// rentalFees.js
// ネームスペース登録・モザイク作成時にネットワークへ支払う「レンタル手数料」の推定
// (トランザクション手数料 feeMultiplier×size とは別物。ネームスペース/モザイクの
//  レンタルシンクアカウント宛に、ブロック生成時のトランザクション内で自動的に
//  差し引かれる制度上の手数料)
//
// 参考: GET /network/fees/rental
//   effectiveRootNamespaceRentalFeePerBlock : ルートネームスペースの1ブロックあたりの手数料
//   effectiveChildNamespaceRentalFee        : サブ(子)ネームスペースの定額手数料
//   effectiveMosaicRentalFee                : モザイク作成の定額手数料
// いずれも絶対量(atomic unit, XYMの場合は10^-6単位)で返ってくる。

const {appState} = W.config;

let cached = null;
let cachedNodeUrl = null;

async function fetchRentalFeeMultipliers() {
  if (cached && cachedNodeUrl === appState.NODE) {
    return cached;
  }

  const res = await fetch(new URL("/network/fees/rental", appState.NODE));
  const json = await res.json();

  cached = {
    rootNamespacePerBlock: BigInt(json.effectiveRootNamespaceRentalFeePerBlock ?? 0),
    childNamespace: BigInt(json.effectiveChildNamespaceRentalFee ?? 0),
    mosaic: BigInt(json.effectiveMosaicRentalFee ?? 0),
  };
  cachedNodeUrl = appState.NODE;

  return cached;
}

function toXymString(atomicAmount) {
  return (Number(atomicAmount) / 1_000_000).toLocaleString("ja-JP", { maximumFractionDigits: 6 });
}

/* ============================================================
   ルートネームスペース登録・更新(延長)の推定レンタル手数料
   (1ブロックあたりの単価 × 有効期間)
============================================================ */
async function estimateRootNamespaceRentalFee(durationBlocks) {
  const { rootNamespacePerBlock } = await fetchRentalFeeMultipliers();
  const blocks = Number.isFinite(durationBlocks) ? Math.max(0, Math.floor(durationBlocks)) : 0;
  return toXymString(rootNamespacePerBlock * BigInt(blocks));
}

/* ============================================================
   サブ(子)ネームスペース登録の推定レンタル手数料(定額)
============================================================ */
async function estimateSubNamespaceRentalFee() {
  const { childNamespace } = await fetchRentalFeeMultipliers();
  return toXymString(childNamespace);
}

/* ============================================================
   モザイク作成の推定レンタル手数料(定額)
============================================================ */
async function estimateMosaicRentalFee() {
  const { mosaic } = await fetchRentalFeeMultipliers();
  return toXymString(mosaic);
}

window.W.rentalFees = {
  estimateRootNamespaceRentalFee,
  estimateSubNamespaceRentalFee,
  estimateMosaicRentalFee
};
