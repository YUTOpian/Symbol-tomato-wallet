//utils.js
function hexToBytes(hex) {
  const bytes = [];
  for (let c = 0; c < hex.length; c += 2)
    bytes.push(parseInt(hex.substr(c, 2), 16));
  return new Uint8Array(bytes);
}


// ★ 2秒で自動消えるポップアップ表示

function showPopup(message, isError = false) {
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

function playSoundOnce(file) {
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

function formatMosaicAmount(amount, divisibility = 0) {

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

function hexToUint8Array(hex) {
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

const {appState} = W.config;
const {getXymJpyRate, getXymUsdRate} = W.priceRates;

function isSSSConnected() {
  return !!(window.SSS && window.SSS.activePublicKey);
}

function getSSSStatusHtml() {
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

const NODE_INFO_PRICE_ELEMENT_ID = "node-info-price";

function renderNodeInfoHtml({ isTestnet, nodeOrigin, note = "" }) {
  const html = (
    `<div style="font-size: 20px; font-weight: bold; color: #8ab4f8;">` +
    `${isTestnet ? "🟡 Testnet" : "🟢 Mainnet"}` +
    `</div>` +
    (note ? `${note}<br>` : "") +
    (appState.authMode === "local" ? "" : getSSSStatusHtml()) +
    `<div id="${NODE_INFO_PRICE_ELEMENT_ID}" style="font-size:13px;margin-top:4px;color:#cbd5e1;">価格取得中...</div>`
  );

  updateNodeInfoPriceDisplay();

  return html;
}

/* ============================================================
   #node-info-price に、現在のXYM単価(円・ドル)をあとから差し込む
   (bitbank / Gate.io は取得に時間がかかる・失敗することがあるため、
   node-infoの表示自体は先に済ませ、価格だけ非同期で更新する)
============================================================ */
async function updateNodeInfoPriceDisplay() {
  const [jpyRate, usdResult] = await Promise.all([getXymJpyRate(), getXymUsdRate()]);

  const el = document.getElementById(NODE_INFO_PRICE_ELEMENT_ID);
  if (!el) return; // 別画面に移動済みなどで要素が無ければ何もしない

  const lines = [];

  if (jpyRate != null) {
    const jpyText = jpyRate.toLocaleString("ja-JP", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    lines.push(
      `${jpyText}円 / XYM (` +
      `<a href="https://app.bitbank.cc/trade/xym_jpy" target="_blank" rel="noopener" style="color:#93c5fd;">bitbank</a>)`
    );
  }

  if (usdResult.rate != null) {
    const usdText = usdResult.rate.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    lines.push(`${usdText}ドル / XYM (${usdResult.source})`);
  }

  el.innerHTML = lines.length > 0 ? lines.join("<br>") : "価格の取得に失敗しました";
}

window.W.utils = {
  hexToBytes,
  showPopup,
  playSoundOnce,
  formatMosaicAmount,
  hexToUint8Array,
  isSSSConnected,
  getSSSStatusHtml,
  renderNodeInfoHtml
};
