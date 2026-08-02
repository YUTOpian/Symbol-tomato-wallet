// offline.js
// オフライントランザクション機能
//
// 【オフライン環境で行う部分(ログイン中のみ)】
//   送金内容を作成 → 秘密鍵で署名 → 署名済みデータ(JSON)を生成
//   ※ 署名(signTxOnly)自体はネットワーク通信を一切行わない。
//     アナウンス(ノードへの送信)は行わないため、
//     この画面を使う端末はオフラインのままで完結できる。
//
// 【オンライン環境で行う部分(ログイン不要)】
//   JSONファイルを読み込む → 内容を確認 → ノードへアナウンスのみ実行
//   ※ 秘密鍵は一切扱わない。

import { appState, NetworkType } from "./config.js";
import { signTxOnly } from "./auth.js";

export const OFFLINE_TX_TYPE = "KASANE_OFFLINE_TX";
export const OFFLINE_TX_VERSION = 1;

/* ============================================================
   送金トランザクションを作成し、その場で署名する(アナウンスはしない)
   ログイン中のアカウント(SSS/ローカルどちらでも可)で署名される。
============================================================ */
export async function composeAndSignOfflineTransfer({ recipientAddress, mosaicIdHex, amount, message }) {
  const { descriptors, models } = appState.sdkSymbol;

  const divisibility = appState.mosaicInfo?.[mosaicIdHex.toUpperCase()]?.divisibility ?? 6;

  const mosaics =
    amount > 0
      ? [
          new descriptors.UnresolvedMosaicDescriptor(
            new models.UnresolvedMosaicId(BigInt("0x" + mosaicIdHex.toUpperCase())),
            new models.Amount(BigInt(Math.round(amount * 10 ** divisibility)))
          ),
        ]
      : [];

  const messageBytes = new Uint8Array([0x00, ...new TextEncoder().encode(message || "")]);

  const transferDescriptor = new descriptors.TransferTransactionV1Descriptor(
    new appState.sdkSymbol.Address(recipientAddress),
    mosaics,
    messageBytes
  );

  const tx = appState.facade.createTransactionFromTypedDescriptor(
    transferDescriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  const { jsonPayload, signedBytes } = await signTxOnly(tx);
  const payloadHex = JSON.parse(jsonPayload).payload;

  const signedTx = appState.facade.transactionFactory.static.deserialize(signedBytes);
  const hash = appState.facade.hashTransaction(signedTx).toString();

  return {
    type: OFFLINE_TX_TYPE,
    version: OFFLINE_TX_VERSION,
    chain: "Symbol",
    network: appState.networkType === NetworkType.TESTNET ? "TEST_NET" : "MAIN_NET",
    transactionType: "TRANSFER",
    payload: payloadHex,
    signature: signedTx.signature.toString(),
    signerPublicKey: signedTx.signerPublicKey.toString(),
    hash,
  };
}

/* ============================================================
   JSONファイルとしてダウンロードさせる
============================================================ */
export function downloadOfflineTxJson(offlineTxObject, filename = "offline-tx.json") {
  const blob = new Blob([JSON.stringify(offlineTxObject, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ============================================================
   署名済みJSONを検証(形式チェックのみ。秘密鍵は一切不要)
============================================================ */
export function validateOfflineTxJson(json) {
  if (!json || json.type !== OFFLINE_TX_TYPE) {
    throw new Error("このファイルはオフライントランザクション形式（KASANE_OFFLINE_TX）ではありません。");
  }
  if (!json.payload) {
    throw new Error("payloadが含まれていません。");
  }
  return json;
}

/* ============================================================
   既にブロックチェーンへ送信・承認済みかどうかを確認する
   (二重ブロードキャスト防止)
   戻り値: "confirmed" | "unconfirmed" | "failed" | null(未提出)
============================================================ */
export async function checkAlreadyBroadcastStatus(hash, nodeUrl) {
  try {
    const res = await fetch(new URL(`/transactionStatus/${hash}`, nodeUrl));
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const json = await res.json();
    return json.group ?? null;
  } catch (e) {
    console.warn("checkAlreadyBroadcastStatus error:", e);
    return null;
  }
}

/* ============================================================
   ノードへアナウンス(ブロードキャスト)のみ実行。
   ログインやSDK初期化は一切不要(署名済みpayloadをそのまま送るだけ)。
============================================================ */
export async function broadcastOfflineTx(json, nodeUrl) {
  validateOfflineTxJson(json);

  const res = await fetch(new URL("/transactions", nodeUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: json.payload }),
  });

  const result = await res.json();
  if (!res.ok) {
    throw new Error(result.message ?? "アナウンスに失敗しました");
  }
  return result;
}
