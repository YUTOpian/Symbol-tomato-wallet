(function () {
"use strict";

// qrScanner.js
// PCのカメラ/画像ファイルでQRコードを読み取る。
//
// 1. アドレスQR(openQrScanModal): 送金先アドレス入力などで使う、
//    Symbolアドレスの抽出に特化した機能。対応形式:
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
//
// 2. 生テキストQR(openRawQrScanModal / decodeQrFromImageFile): QRログイン
//    (qrLogin.js)のように、アドレス以外の形式(JSON)を読み取りたい場面向け。
//    デコードした文字列をそのまま呼び出し側に渡す(中身の解釈はしない)。
//    decodeQrFromImageFileはカメラを使わず、選択された画像ファイルから
//    直接デコードする(QRコードを印字/保存したファイルの読み込み用)。

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
   カメラでQRコードをスキャンするモーダルの共通処理。
   openQrScanModal(アドレス専用) と openRawQrScanModal(生テキストのまま
   渡す。QRログイン等、アドレス以外の形式を扱う場面向け)の両方から使う。

   options:
     dialog / video / statusEl / cancelBtn : 使うダイアログ要素一式
     onDecoded(text)  : QRを検出するたびに呼ばれる。真偽値っぽい戻り値
                        (Promise可)を返し、trueなら読み取り成功として
                        モーダルを閉じる。falseなら読み取りを継続する。
     onError(e)       : カメラ起動失敗時に呼ばれる
     scanningMessage / notFoundMessage : 状況に応じた案内文言
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

async function runCameraScanModal({
  dialog,
  video,
  statusEl,
  cancelBtn,
  onDecoded,
  onError,
  scanningMessage = "カメラにQRコードを映してください...",
  notFoundMessage = "対応形式のQRコードが見つかりませんでした。読み取りを続けます...",
}) {
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
    if (statusEl) statusEl.textContent = scanningMessage;

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
            const handled = await onDecoded?.(code.data);
            if (handled) {
              cleanup();
              return;
            }
            if (statusEl) statusEl.textContent = notFoundMessage;
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

/* ============================================================
   カメラでQRコードをスキャンするモーダルを開く(アドレス専用)。
   index.html 側に用意した #qr-scan-dialog / #qr-scan-video /
   #qr-scan-status / #qr-scan-cancel-btn を利用する。
   有効なアドレスが見つかったら onAddress(address) を呼び、
   モーダルを自動的に閉じてカメラを停止する。
============================================================ */
async function openQrScanModal({ onAddress, onError } = {}) {
  await runCameraScanModal({
    dialog: document.getElementById("qr-scan-dialog"),
    video: document.getElementById("qr-scan-video"),
    statusEl: document.getElementById("qr-scan-status"),
    cancelBtn: document.getElementById("qr-scan-cancel-btn"),
    notFoundMessage: "対応形式のアドレスQRコードが見つかりませんでした。読み取りを続けます...",
    onError,
    onDecoded: async (text) => {
      const address = await parseAddressFromQrText(text);
      if (!address) return false;
      onAddress?.(address);
      return true;
    },
  });
}

/* ============================================================
   カメラでQRコードをスキャンするモーダルを開く(生テキストのまま渡す版)。
   QRログイン用の暗号化ペイロードなど、アドレス以外の形式を読み取る場面で使う。
   同じダイアログ要素(#qr-scan-dialog等)を共用する(同時に2つ開くことはないため)。
   デコードできたQRのテキストをそのまま onText(text) に渡す
   (中身の妥当性チェックは呼び出し側で行う)。
============================================================ */
async function openRawQrScanModal({ onText, onError, scanningMessage, notFoundMessage } = {}) {
  await runCameraScanModal({
    dialog: document.getElementById("qr-scan-dialog"),
    video: document.getElementById("qr-scan-video"),
    statusEl: document.getElementById("qr-scan-status"),
    cancelBtn: document.getElementById("qr-scan-cancel-btn"),
    scanningMessage,
    notFoundMessage,
    onError,
    onDecoded: async (text) => {
      onText?.(text);
      return true;
    },
  });
}

/* ============================================================
   画像ファイル(アップロードされたQRコードの画像)からQRコードを読み取り、
   デコードされた生テキストを返す。見つからなければnullを返す。
============================================================ */
async function decodeQrFromImageFile(file) {
  await ensureJsQRLoaded();

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました"));
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画像の読み込みに失敗しました(対応形式の画像ファイルかご確認ください)"));
    image.src = dataUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, imageData.width, imageData.height);

  return code?.data ?? null;
}

window.W.qrScanner = {
  parseAddressFromQrText,
  openQrScanModal,
  openRawQrScanModal,
  decodeQrFromImageFile,
  stopCamera,
};

})();
