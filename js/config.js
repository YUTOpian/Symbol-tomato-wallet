// config.js
// Symbol SDK v3 用 設定値とアプリ全体で共有する状態

// ============================================================
// NodeWatch エンドポイント
// ============================================================
export const MAINNET_NODEWATCH_URL =
  "https://nodewatch.symbol.tools/api/symbol/nodes/peer?only_ssl=true&limit=10&order=random";

export const TESTNET_NODEWATCH_URL =
  "https://nodewatch.symbol.tools/testnet/api/symbol/nodes/peer?only_ssl=true&limit=10&order=random";

// ============================================================
// NodeWatch停止時 fallback ノード
// ============================================================
export const MAINNET_FALLBACK_NODES = [
  "https://sym-main-01.opening-line.jp:3001",
  "https://sym-main-02.opening-line.jp:3001",
  "https://sym-main-03.opening-line.jp:3001",
  "https://symbol-mikun.net:3001",
];

export const TESTNET_FALLBACK_NODES = [
  "https://401-sai-dual.symboltest.net:3001",
  "https://201-sai-dual.symboltest.net:3001",
  "https://2.dusanjp.com:3001",
  "https://vmi831828.contaboserver.net:3001",
  "https://testnet1.symbol-mikun.net:3001",
  "https://testnet2.symbol-mikun.net:3001",
  "https://sym-test-01.opening-line.jp:3001",
  "https://sym-test-03.opening-line.jp:3001",
  "https://symbol-azure.0009.co:3001",
  "https://t.sakia.harvestasya.com:3001",
];

// ============================================================
// XYM Mosaic ID
// ============================================================
export const XYM_MOSAIC_ID = {
  MAINNET: "6BED913FA20223F8",
  TESTNET: "72C0212E67A08BCE",
};

// ============================================================
// Network Type
// Symbol SDK v3でもREST APIでは104 / 152 の識別値を利用するため保持
// ============================================================
export const NetworkType = {
  MAINNET: 104,
  TESTNET: 152,
};

// ============================================================
// Application State
// quick_learning_symbol_v3 の表現に合わせる
// ============================================================
export const appState = {
  // 現在利用中Node
  NODE: null,

  // Transaction用
  epochAdjustment: 0,

  // QRコード生成(chain_id)やTransaction検証に必要なネットワーク世代ハッシュ
  generationHash: null,

  // 送金手数料 (feeMultiplier)。設定画面で変更可能。未設定時は100。
  feeMultiplier: (() => {
    try {
      const saved = Number(localStorage.getItem("feeMultiplier"));
      return Number.isFinite(saved) && saved > 0 ? saved : 100;
    } catch {
      return 100;
    }
  })(),

  // ========================================================
  // 認証方式
  // ========================================================
  // "sss" | "local"
  authMode: null,

  // ローカル(ニーモニック)ログイン時のみ使用。メモリ上にのみ保持し、
  // 平文のままlocalStorageに保存することはない。
  localPrivateKeyHex: null,
  localKeyPair: null,

  // ========================================================
  // アカウント一覧（マルチアカウント切替）
  // ========================================================
  // { id, label, source: "sss"|"mnemonic"|"privateKey", privateKeyHex?,
  //   accountIndex?, address, hidden }
  accounts: [],
  activeAccountId: null,

  // Symbol SDK v3
  facade: null,
  sdkCore: null,
  sdkSymbol: null,

  // SDK準備状態
  isSdkReady: false,

  // ========================================================
  // Account
  // ========================================================
  // REST API取得結果
  // { address, publicKey, mosaics }
  accountInfo: null,

  // 現在Account PublicKey (sdkSymbol.PublicKey)
  currentPubKey: null,

  // 現在Account Address (sdkSymbol.Address)
  currentAddress: null,

  // 104 MAINNET / 152 TESTNET
  networkType: null,

  // ========================================================
  // Mosaic
  // ========================================================
  // accountInfo.mosaics 保存用
  mosaicList: [],

  // 表示用Mosaic情報
  /*
    {
      mosaicId: {
        mosaicName,
        amount,
        divisibility
      }
    }
  */
  mosaicInfo: {},
};

// ============================================================
// 現在NetworkのXYM Mosaic ID取得
// ============================================================
export function getXymMosaicIdHex() {
  return appState.networkType === NetworkType.TESTNET
    ? XYM_MOSAIC_ID.TESTNET
    : XYM_MOSAIC_ID.MAINNET;
}
