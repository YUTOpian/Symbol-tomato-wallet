(function () {
"use strict";

// qrLogin.js
// 「QRコードでログイン」機能: 秘密鍵をパスワードで暗号化してQRコード化する/
// QRコードから読み取って復号する。
//
// 暗号化方式は auth.js の暗号化ボールト(walletVault)と完全に同じ
// (PBKDF2-SHA256 210,000回 + AES-GCM)にしてある。同じアプリ内で
// 一貫した強度・実装にするため、鍵導出関数(deriveKeyFromPassword)や
// base64ヘルパーもauth.jsのものをそのまま再利用する。
//
// QRコードのペイロード形式:
//   {
//     version: 1,
//     address: "N..." | "T...",  // 平文。ログイン前にどのアカウント/
//                                  // ネットワーク向けかを判別するために使う
//                                  // (秘密鍵そのものではないため、これ単体が
//                                  // 見えても資産への影響はない)
//     salt: "base64",             // 16byte (PBKDF2用ソルト)
//     iv: "base64",               // 12byte (AES-GCM用IV)
//     ciphertext: "base64",       // 秘密鍵(64桁hex文字列, UTF-8)をAES-GCMで
//                                  // 暗号化した結果(GCM認証タグ16byteを含む)
//   }
//
// パスワードを間違えるとAES-GCMの認証タグ検証で復号自体が失敗するため、
// 「間違ったパスワードで別の(それっぽい)秘密鍵が出てくる」ことはない。
//
// ⚠ セキュリティ上の注意:
//   - このQRコード画像は「パスワードとセットで初めて秘密鍵になる」ものであり、
//     画像単体が流出しても直ちに資産が危険になるわけではないが、
//     ニーモニックや秘密鍵そのものと同様、安全な場所に保管するべきもの。
//   - パスワードを忘れると、このQRコードからは二度と秘密鍵を復元できない
//     (PBKDF2は意図的に逆算困難な設計のため)。ニーモニックのバックアップは
//     別途必ず取っておくこと。

const {deriveKeyFromPassword, bufToBase64, base64ToBytes} = W.auth;

const QR_LOGIN_VERSION = 1;

/* ============================================================
   秘密鍵をパスワードで暗号化し、QRコード化用のペイロード(オブジェクト)を作る。
   呼び出し側で JSON.stringify() してQRコード生成ライブラリに渡す。
============================================================ */
async function buildQrLoginPayload(privateKeyHex, address, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKeyFromPassword(password, salt);

  const plainBytes = new TextEncoder().encode(privateKeyHex.trim().toUpperCase());
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBytes);

  return {
    version: QR_LOGIN_VERSION,
    address,
    salt: bufToBase64(salt),
    iv: bufToBase64(iv),
    ciphertext: bufToBase64(cipherBuf),
  };
}

/* ============================================================
   QRコードから読み取った生テキストを、ペイロード形式として検証・パースする。
   形式が合わなければnullを返す(呼び出し側で「対応形式のQRコードでは
   ありません」等のエラー表示に使う)。
============================================================ */
function parseQrLoginPayloadText(text) {
  if (!text) return null;

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }

  if (
    !obj ||
    typeof obj !== "object" ||
    typeof obj.address !== "string" ||
    typeof obj.salt !== "string" ||
    typeof obj.iv !== "string" ||
    typeof obj.ciphertext !== "string"
  ) {
    return null;
  }

  return obj;
}

/* ============================================================
   ペイロードをパスワードで復号し、秘密鍵を取り出す。
   パスワードが誤っている場合やデータが壊れている場合はエラーを投げる。
   復号後、実際にそこから導出されるアドレスがペイロード内のaddressと
   一致するかどうかまではこのモジュールでは検証しない(SDKに依存させない
   ため)。呼び出し側(index.js。SDKにアクセスできるスコープ)で
   照合すること。
============================================================ */
async function decryptQrLoginPayload(payload, password) {
  let salt, iv, cipherBytes;
  try {
    salt = base64ToBytes(payload.salt);
    iv = base64ToBytes(payload.iv);
    cipherBytes = base64ToBytes(payload.ciphertext);
  } catch {
    throw new Error("QRコードのデータ形式が正しくありません。");
  }

  const key = await deriveKeyFromPassword(password, salt);

  let plainBuf;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
  } catch {
    throw new Error("パスワードが正しくないか、QRコードのデータが壊れています。");
  }

  const privateKeyHex = new TextDecoder().decode(plainBuf).trim().toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(privateKeyHex)) {
    throw new Error("QRコードの内容が秘密鍵の形式ではありません。");
  }

  return { privateKeyHex, address: (payload.address || "").trim().toUpperCase() };
}

window.W.qrLogin = {
  buildQrLoginPayload,
  parseQrLoginPayloadText,
  decryptQrLoginPayload
};

})();
