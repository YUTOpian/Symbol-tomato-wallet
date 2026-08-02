//utils.js
export function hexToBytes(hex) {
  const bytes = [];
  for (let c = 0; c < hex.length; c += 2)
    bytes.push(parseInt(hex.substr(c, 2), 16));
  return new Uint8Array(bytes);
}


// ★ 2秒で自動消えるポップアップ表示

export function showPopup(message, isError = false) {
  let popup = document.getElementById("copy-popup");

  if (!popup) {
    popup = document.createElement("div");
    popup.id = "copy-popup";
    popup.className = "popup-card";
    popup.style.position = "fixed";

    // ▼▼ 中央配置 ▼▼
    popup.style.left = "50%";
    popup.style.top = "50%";
    popup.style.transform = "translate(-50%, -50%)";

    popup.style.zIndex = "9999";
    document.body.appendChild(popup);
  }

  popup.innerHTML = `
    <div>${message}</div>
  `;

  popup.style.display = "block";
  popup.style.opacity = "1";
  popup.style.transition = "opacity .4s";

  // ★ 2秒後フェードアウト
  setTimeout(() => {
    popup.style.opacity = "0";

    setTimeout(() => {
      popup.style.display = "none";
    }, 400);
  }, 3000);
}


let soundQueue = Promise.resolve();

export function playSoundOnce(file) {
  soundQueue = soundQueue
    .then(() => {
      return new Promise((resolve) => {
        const audio = new Audio(file);
        audio.volume = 1.0;

        // 再生開始。エラーでも resolve する
        audio.play().catch(() => {}).finally(() => {
          setTimeout(resolve, 100); // 音再生は別スレッド扱いに
        });
      });
    });
}

// ============================================================
// モザイク数量表示フォーマット
// ============================================================

export function formatMosaicAmount(amount, divisibility = 0) {

  const value =
    Number(amount) /
    (10 ** divisibility);


  return value.toLocaleString(
    "ja-JP",
    {
      maximumFractionDigits: divisibility
    }
  );

}

export function hexToUint8Array(hex) {
  const bytes = [];

  for(let i = 0; i < hex.length; i += 2){
    bytes.push(
      parseInt(hex.substring(i, i + 2), 16)
    );
  }

  return new Uint8Array(bytes);
}

// ============================================================
// SSS Extension 連携状態
// ============================================================

import { appState } from "./config.js";

export function isSSSConnected() {
  return !!(window.SSS && window.SSS.activePublicKey);
}

export function getSSSStatusHtml() {
  return isSSSConnected()
    ? `<span style="color:#4ade80;">🟢 SSS Extensionと連携中</span>`
    : `<span style="color:#f87171;">🔴 SSS Extensionと未連携</span>`;
}

// ============================================================
// #node-info 表示用 共通HTML生成
// ネットワーク表記（Mainnet/Testnet）＋使用ノード＋SSS連携状態を
// 常にまとめて表示するための共通関数
// （ノード切替時にも表記が消えないようにする）
// ニーモニックログイン中(authMode === "local")はSSSと無関係なので
// SSS連携状態は表示しない
// ============================================================

export function renderNodeInfoHtml({ isTestnet, nodeOrigin, note = "" }) {
  return (
    `<div style="font-size: 20px; font-weight: bold; color: #8ab4f8;">` +
    `${isTestnet ? "🟡 Testnet" : "🟢 Mainnet"}` +
    `</div>` +
    `使用ノード：<b>${nodeOrigin}</b><br>` +
    (note ? `${note}<br>` : "") +
    (appState.authMode === "local" ? "" : getSSSStatusHtml())
  );
}
