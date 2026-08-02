// sdk.js
// Symbol SDK v3 の読み込みと Facade 初期化

import { appState } from "./config.js";

const SDK_VERSION = "3.3.0";

/**
 * SDK 初期化
 */
export async function initSdk() {

  if (!appState.NODE) {
    throw new Error("NODE が未設定です");
  }

  // ================================
  //   Symbol SDK 読み込み
  // ================================
  const sdk = await import(
    `https://unpkg.com/symbol-sdk@${SDK_VERSION}/dist/bundle.web.js`
  );

  appState.sdkCore = sdk.core;
  appState.sdkSymbol = sdk.symbol;

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
  const identifier = props.network.identifier;
  appState.facade = new appState.sdkSymbol.SymbolFacade(identifier);

  appState.isSdkReady = true;
}

/**
 * 外部アクセス用
 */
export const facade = () => appState.facade;
export const sdkCore = () => appState.sdkCore;
export const sdkSymbol = () => appState.sdkSymbol;
export const scopedMetadataKey = () => appState.scopedMetadataKey;
