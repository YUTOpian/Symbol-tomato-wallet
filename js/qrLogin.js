(function () {
"use strict";

// qrLogin.js
// 「QRコードでログイン」機能: 秘密鍵 または ニーモニック(シードフレーズ)を
// パスワードで暗号化してQRコード化する/QRコードから読み取って復号する。
//
// 暗号化方式は auth.js の暗号化ボールト(walletVault)と完全に同じ
// (PBKDF2-SHA256 210,000回 + AES-GCM)にしてある。同じアプリ内で
// 一貫した強度・実装にするため、鍵導出関数(deriveKeyFromPassword)や
// base64ヘルパーもauth.jsのものをそのまま再利用する。
//
// QRコードのペイロード形式:
//   {
//     version: 1,
//     kind: "privateKey" | "mnemonic",  // 省略時は"privateKey"扱い
//                                        // (kindフィールド追加前の旧QRとの互換用)
//     address: "N..." | "T...",  // 平文。ログイン前にどのアカウント/
//                                  // ネットワーク向けかを判別するために使う
//                                  // (秘密鍵・ニーモニックそのものではないため、
//                                  //  これ単体が見えても資産への影響はない)
//     accountIndex: 0,            // kind==="mnemonic"の場合のみ意味を持つ。
//                                  // どのアカウント番号(m/44'/4343'/{n}'/0'/0')を
//                                  // 使っていたかを記録し、同じ秘密鍵を再現するため
//     salt: "base64",             // 16byte (PBKDF2用ソルト)
//     iv: "base64",               // 12byte (AES-GCM用IV)
//     ciphertext: "base64",       // 秘密鍵(64桁hex) または ニーモニック文文字列
//                                  // (いずれもUTF-8)をAES-GCMで暗号化した結果
//                                  // (GCM認証タグ16byteを含む)
//   }
//
// パスワードを間違えるとAES-GCMの認証タグ検証で復号自体が失敗するため、
// 「間違ったパスワードで別の(それっぽい)秘密鍵/ニーモニックが出てくる」
// ことはない。
//
// ⚠ セキュリティ上の注意:
//   - このQRコード画像は「パスワードとセットで初めて秘密鍵/ニーモニックになる」
//     ものであり、画像単体が流出しても直ちに資産が危険になるわけではないが、
//     ニーモニックや秘密鍵そのものと同様、安全な場所に保管するべきもの。
//   - ニーモニック版は、この1枚から複数アカウントすべてを復元できてしまう
//     ため、秘密鍵版よりも扱いに注意が必要(1アカウント分の秘密鍵版より
//     影響範囲が大きい)。
//   - パスワードを忘れると、このQRコードからは二度と秘密鍵/ニーモニックを
//     復元できない(PBKDF2は意図的に逆算困難な設計のため)。

const {deriveKeyFromPassword, bufToBase64, base64ToBytes} = W.auth;

const QR_LOGIN_VERSION = 1;

/* ============================================================
   秘密鍵 または ニーモニックをパスワードで暗号化し、QRコード化用の
   ペイロード(オブジェクト)を作る。呼び出し側で JSON.stringify() して
   QRコード生成ライブラリに渡す。
   kind: "privateKey" | "mnemonic"
   accountIndex: kind==="mnemonic"のときのみ指定(省略時0)
============================================================ */
async function buildQrLoginPayload(secretText, address, password, kind = "privateKey", { accountIndex = 0 } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKeyFromPassword(password, salt);

  const plainBytes = new TextEncoder().encode(
    kind === "mnemonic" ? secretText.trim() : secretText.trim().toUpperCase()
  );
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBytes);

  return {
    version: QR_LOGIN_VERSION,
    kind,
    address,
    ...(kind === "mnemonic" ? { accountIndex } : {}),
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
   ペイロードをパスワードで復号し、秘密鍵 または ニーモニックを取り出す。
   パスワードが誤っている場合やデータが壊れている場合はエラーを投げる。
   戻り値:
     kind==="mnemonic" の場合: { kind, mnemonicPhrase, accountIndex, address }
     それ以外(privateKey / kind未指定の旧QR)の場合: { kind, privateKeyHex, address }
   復号後、実際にそこから導出されるアドレスがペイロード内のaddressと
   一致するかどうかまではこのモジュールでは検証しない(SDKに依存させない
   ため)。呼び出し側(index.js。SDKにアクセスできるスコープ)で照合すること。
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

  const address = (payload.address || "").trim().toUpperCase();
  const kind = payload.kind === "mnemonic" ? "mnemonic" : "privateKey"; // 未指定は旧形式(秘密鍵)として扱う

  if (kind === "mnemonic") {
    const mnemonicPhrase = new TextDecoder().decode(plainBuf).trim();
    if (!mnemonicPhrase || mnemonicPhrase.split(/\s+/).length < 12) {
      throw new Error("QRコードの内容がニーモニックの形式ではありません。");
    }
    const accountIndex = Number.isInteger(payload.accountIndex) && payload.accountIndex >= 0 ? payload.accountIndex : 0;
    return { kind, mnemonicPhrase, accountIndex, address };
  }

  const privateKeyHex = new TextDecoder().decode(plainBuf).trim().toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(privateKeyHex)) {
    throw new Error("QRコードの内容が秘密鍵の形式ではありません。");
  }

  return { kind, privateKeyHex, address };
}

window.W.qrLogin = {
  buildQrLoginPayload,
  parseQrLoginPayloadText,
  decryptQrLoginPayload
};

})();
