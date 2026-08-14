(function () {
"use strict";

// sdk.js
// Symbol SDK v3 の読み込みと Facade 初期化
//
// 「SDKモジュールの読み込み・Facade作成(オフラインで可能)」と
// 「ノードから最新のネットワークパラメータを取得する初期化(オンライン必須)」
// を分離してある。
//   - initFacadeOffline(networkType): ノード通信なし。mainnet/testnetの
//     区別だけでFacadeを作る。アドレス導出・署名には十分なので、
//     ニーモニック作成〜ログイン〜ホーム画面までをオフラインで完結させる
//     ために使う。
//   - initSdk(): 従来通り。選択済みのappState.NODEへ問い合わせて
//     epochAdjustment/generationHashSeed等を取得し、正式なFacadeを作る。
//     トランザクションの作成(有効期限の計算に epochAdjustment が必要)や
//     残高取得などにはこちらが必要。

const {appState, NetworkType} = W.config;

const SDK_VERSION = "3.3.0";

/* ============================================================
   Symbol SDKモジュール本体の読み込み(まだなら)。
   これ自体はノードへの通信ではなく、アプリ自身の依存ライブラリの
   読み込みなので、initFacadeOffline/initSdk 両方から共通で使う。
============================================================ */
async function ensureSdkModuleLoaded() {
  if (appState.sdkCore && appState.sdkSymbol) return;

  const sdk = await import(
    `https://unpkg.com/symbol-sdk@${SDK_VERSION}/dist/bundle.web.js`
  );

  appState.sdkCore = sdk.core;
  appState.sdkSymbol = sdk.symbol;
}

/**
 * オフラインでのFacade初期化。
 * ノードへは一切通信しない。mainnet/testnetの文字列だけでFacadeを作るため、
 * ニーモニック生成・アカウント作成・ログイン(アドレス導出・署名の準備)までは
 * これだけで完結できる。
 *
 * epochAdjustment/generationHashはここでは設定しない
 * (未設定のままなので、トランザクションの作成・送信・QRコードのchain_id
 *  生成などノードのデータが必要な操作は、initSdk()でのオンライン初期化が
 *  完了するまで行えない。isSdkReadyもここではtrueにしない)。
 */
async function initFacadeOffline(networkType) {
  await ensureSdkModuleLoaded();

  const identifier = networkType === NetworkType.TESTNET ? "testnet" : "mainnet";
  appState.facade = new appState.sdkSymbol.SymbolFacade(identifier);
  appState.networkType = networkType;
}

/**
 * SDK 初期化(オンライン)
 * appState.NODE への通信が必要。
 */
async function initSdk() {

  if (!appState.NODE) {
    throw new Error("NODE が未設定です");
  }

  // ================================
  //   Symbol SDK 読み込み
  // ================================
  await ensureSdkModuleLoaded();

  // ================================
  //   ネットワークプロパティ取得
  // ================================
  const props = await fetch(new URL("/network/properties", appState.NODE)).then(
    (r) => r.json()
  );

  //
  const epochRaw = props.network.epochAdjustment;
  appState.epochAdjustment = Number(epochRaw.replace("s", ""));

  // QRコード生成(chain_id)に必要なネットワーク世代ハッシュ
  appState.generationHash = props.network.generationHashSeed;

  // ネットワーク識別子を取得し Facade 初期化
  // (オフライン初期化時のFacadeがあっても、ノードから得た正式な識別子で
  //  作り直す。mainnet/testnet以外の私設ネットワークに接続する場合にも対応)
  const identifier = props.network.identifier;
  appState.facade = new appState.sdkSymbol.SymbolFacade(identifier);
  appState.networkType = identifier === "testnet" ? NetworkType.TESTNET : NetworkType.MAINNET;

  appState.isSdkReady = true;
}

/**
 * 外部アクセス用
 */
const facade = () => appState.facade;
const sdkCore = () => appState.sdkCore;
const sdkSymbol = () => appState.sdkSymbol;
const scopedMetadataKey = () => appState.scopedMetadataKey;

window.W.sdk = {
  initFacadeOffline,
  initSdk,
  facade,
  sdkCore,
  sdkSymbol,
  scopedMetadataKey
};

})();
