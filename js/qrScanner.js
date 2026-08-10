(function () {
"use strict";

// qrScanner.js
// PCのカメラでQRコードを読み取り、Symbolアドレスを抽出する。
//
// 対応形式:
//   - Symbol Wallet形式(symbol-qr-library の AddressQR。type=7、data.address)
//   - EXYM Wallet形式(symbol-qr-library の ContactQR。type=1、data.publicKey。
//     公開鍵とQR内のnetwork_idからアドレスを導出する)
//   - EXYM Wallet形式(受取リクエストQR。type=3、data.payload に埋め込まれた
//     未署名送金トランザクションのrecipientAddressを復元する。上記と
//     見た目のtypeが異なる別画面向けなので、念のため両方に対応しておく)
//   - NFTDrive形式("{symbol:アドレス}" というプレーンテキスト)
//   - 上記のいずれでもない場合、テキスト中にSymbolアドレスがそのまま
//     含まれていれば拾う(保険的なフォールバック)
//
// アドレスQR(type=7)・受取リクエストQR(type=3)は、index.js の「受取」画面
// (generateReceiveQR / generateReceiveTransactionQR / generateNftDriveExQR)が
// 生成しているQRコードと同じ形式に合わせてある。

const {hexToBytes} = W.utils;
const {NetworkType} = W.config;

let jsQR = null;
// 公開鍵からのアドレス導出・EXYM Wallet受取リクエストQRのpayload解析のための、
// 一時的なSDK参照。ここでのfacadeはネットワーク(mainnet/testnet)を
// QR内のnetwork_idから都度組み立てて使う。
let cachedParserSdk = null;

async function ensureJsQRLoaded() {
  if (!jsQR) {
    ({ default: jsQR } = await import("https://esm.sh/jsqr"));
  }
  return jsQR;
}

async function ensureParserSdk() {
  if (!cachedParserSdk) {
    const sdk = await import("https://unpkg.com/symbol-sdk@3.3.0/dist/bundle.web.js");
    cachedParserSdk = { core: sdk.core, symbol: sdk.symbol };
  }
  return cachedParserSdk;
}

function networkIdToFacadeName(networkId) {
  return Number(networkId) === NetworkType.TESTNET ? "testnet" : "mainnet";
}

function normalizeAddressText(raw) {
  return (raw || "").toString().trim().toUpperCase().replace(/[\s-]/g, "");
}

function isValidAddressShape(addr) {
  return /^[NT][A-Z2-7]{38}$/.test(addr);
}

/* ============================================================
   EXYM Wallet形式(受取リクエストQR): data.payload は「宛先=自分・
   数量0」の未署名TransferTransactionのシリアライズ済みバイト列(16進)。
   これをデシリアライズしてrecipientAddressだけを取り出す。
   (deserializeはバイト列そのものから判別するため、facadeの
   ネットワークがどちらでも結果は変わらない)
============================================================ */
async function extractAddressFromExymPayload(payloadHex) {
  const sdk = await ensureParserSdk();
  const facade = new sdk.symbol.SymbolFacade("mainnet");
  const bytes = hexToBytes(payloadHex);
  const tx = facade.transactionFactory.static.deserialize(bytes);
  return normalizeAddressText(tx.recipientAddress?.toString());
}

/* ============================================================
   EXYM Wallet形式(アカウントQR/ContactQR): data.publicKey とQR内の
   network_idから、そのアカウントのアドレスを導出する。
============================================================ */
async function extractAddressFromPublicKey(publicKeyHex, networkId) {
  const sdk = await ensureParserSdk();
  const facade = new sdk.symbol.SymbolFacade(networkIdToFacadeName(networkId));
  const pub = new sdk.core.PublicKey(publicKeyHex);
  const publicAccount = facade.createPublicAccount(pub);
  return normalizeAddressText(publicAccount.address?.toString());
}

/* ============================================================
   QRコードから読み取った生テキストからSymbolアドレスを抽出する。
   見つからなければ null を返す。
============================================================ */
async function parseAddressFromQrText(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;

  // 1. JSON形式(Symbol Wallet形式 / EXYM Wallet形式)
  try {
    const json = JSON.parse(trimmed);
    if (json && typeof json === "object" && json.data) {
      if (typeof json.data.address === "string") {
        const addr = normalizeAddressText(json.data.address);
        if (isValidAddressShape(addr)) return addr;
      }
      if (typeof json.data.publicKey === "string") {
        try {
          const addr = await extractAddressFromPublicKey(json.data.publicKey, json.network_id);
          if (isValidAddressShape(addr)) return addr;
        } catch (e) {
          console.warn("公開鍵からのアドレス導出に失敗しました:", e);
        }
      }
      if (typeof json.data.payload === "string") {
        try {
          const addr = await extractAddressFromExymPayload(json.data.payload);
          if (isValidAddressShape(addr)) return addr;
        } catch (e) {
          console.warn("EXYM Wallet形式のpayload解析に失敗しました:", e);
        }
      }
    }
  } catch {
    // JSONではない → 他の形式を試す
  }

  // 2. NFTDrive形式: "{symbol:アドレス}"
  const nftDriveMatch = trimmed.match(/\{\s*symbol\s*:\s*([^}]+)\}/i);
  if (nftDriveMatch) {
    const addr = normalizeAddressText(nftDriveMatch[1]);
    if (isValidAddressShape(addr)) return addr;
  }

  // 3. プレーンなアドレス文字列がそのまま入っている場合(ハイフン区切り含む)
  const plain = normalizeAddressText(trimmed);
  if (isValidAddressShape(plain)) return plain;

  // 4. 上記いずれでもない場合、テキスト中にアドレスらしきパターンが
  //    埋め込まれていないか探す(未知の形式への保険)
  const looseMatch = normalizeAddressText(trimmed).match(/[NT][A-Z2-7]{38}/);
  if (looseMatch) return looseMatch[0];

  return null;
}

/* ============================================================
   カメラでQRコードをスキャンするモーダルを開く。
   index.html 側に用意した #qr-scan-dialog / #qr-scan-video /
   #qr-scan-status / #qr-scan-cancel-btn を利用する。
   有効なアドレスが見つかったら onAddress(address) を呼び、
   モーダルを自動的に閉じてカメラを停止する。
============================================================ */
let activeStream = null;
let scanLoopRunning = false;

function stopCamera() {
  scanLoopRunning = false;
  if (activeStream) {
    activeStream.getTracks().forEach((t) => t.stop());
    activeStream = null;
  }
}

async function openQrScanModal({ onAddress, onError } = {}) {
  const dialog = document.getElementById("qr-scan-dialog");
  const video = document.getElementById("qr-scan-video");
  const statusEl = document.getElementById("qr-scan-status");
  const cancelBtn = document.getElementById("qr-scan-cancel-btn");

  if (!dialog || typeof dialog.showModal !== "function" || !video) {
    onError?.(new Error("QRスキャン用のUIが見つかりません"));
    return;
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  if (statusEl) statusEl.textContent = "カメラを起動しています...";

  const cleanup = () => {
    stopCamera();
    video.srcObject = null;
    cancelBtn?.removeEventListener("click", onCancel);
    dialog.removeEventListener("cancel", onDialogCancel);
    if (dialog.open) dialog.close();
  };

  const onCancel = () => cleanup();
  const onDialogCancel = (e) => {
    e.preventDefault();
    cleanup();
  };

  cancelBtn?.addEventListener("click", onCancel);
  dialog.addEventListener("cancel", onDialogCancel);

  dialog.showModal();

  try {
    await ensureJsQRLoaded();

    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    video.srcObject = activeStream;
    await video.play();

    scanLoopRunning = true;
    if (statusEl) statusEl.textContent = "カメラにQRコードを映してください...";

    const loop = async () => {
      if (!scanLoopRunning) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);

        if (code && code.data) {
          if (statusEl) statusEl.textContent = "解析中...";
          try {
            const address = await parseAddressFromQrText(code.data);
            if (address) {
              cleanup();
              onAddress?.(address);
              return;
            }
            if (statusEl) {
              statusEl.textContent = "対応形式のアドレスQRコードが見つかりませんでした。読み取りを続けます...";
            }
          } catch (e) {
            console.warn("QR解析エラー:", e);
          }
        }
      }

      if (scanLoopRunning) requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  } catch (e) {
    console.error("カメラの起動に失敗しました:", e);
    if (statusEl) statusEl.textContent = "カメラを起動できませんでした。カメラへのアクセスを許可してください。";
    onError?.(e);
  }
}

window.W.qrScanner = {
  parseAddressFromQrText,
  openQrScanModal,
  stopCamera,
};

})();
