// settings.js
// 設定メニュー: 接続先ノードの変更 / 送金手数料の設定

const {appState,
  NetworkType,
  MAINNET_NODEWATCH_URL,
  TESTNET_NODEWATCH_URL,} = W.config;
const {setStatus, setText} = W.ui;
const {initSdk} = W.sdk;
const {refreshAccount, initLiveBalanceRefresh} = W.account;
const {initLiveHarvestStatusRefresh} = W.harvest;
const {loadRecentTx, initLiveTx} = W.transactions;
const {initWebSocket, closeWebSocket} = W.ws;
const {renderNodeInfoHtml} = W.utils;

/* ============================================================
   接続先ノードの変更
============================================================ */

function showCurrentNode() {
  const el = document.getElementById("current-node-display");
  if (el) el.textContent = appState.NODE ?? "---";
}

async function loadNodeSettingsCandidates() {
  const select = document.getElementById("node-settings-select");
  if (!select) return;

  select.innerHTML = `<option value="">-- 候補を読み込み中... --</option>`;

  const isTestnet = appState.networkType === NetworkType.TESTNET;
  const url = isTestnet ? TESTNET_NODEWATCH_URL : MAINNET_NODEWATCH_URL;

  try {
    const res = await fetch(url);
    const nodes = await res.json();

    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new Error("empty");
    }

    nodes.sort((a, b) => b.height - a.height);

    select.innerHTML =
      `<option value="">-- ノードを選択 --</option>` +
      nodes
        .slice(0, 30)
        .map((n) => {
          const label = `${n.endpoint}（高さ:${n.height}）`;
          return `<option value="${n.endpoint}">${label}</option>`;
        })
        .join("");
  } catch (e) {
    console.warn("ノード候補の取得に失敗しました", e);
    select.innerHTML = `<option value="">-- 候補の取得に失敗（下に直接URLを入力してください）--</option>`;
  }
}

function getSelectedNodeUrl() {
  const manual = document.getElementById("node-settings-input")?.value?.trim();
  if (manual) return manual;

  const selected = document.getElementById("node-settings-select")?.value?.trim();
  if (selected) return selected;

  return "";
}

async function applyNodeChange() {
  const targetRaw = getSelectedNodeUrl();

  if (!targetRaw) {
    setStatus("node-settings-status", "ノードを選択するかURLを入力してください。", "error");
    return;
  }

  let targetOrigin;
  try {
    const u = new URL(targetRaw);
    u.protocol = "https:";
    targetOrigin = u.origin;
  } catch {
    setStatus("node-settings-status", "ノードURLの形式が正しくありません。", "error");
    return;
  }

  setStatus("node-settings-status", `接続確認中... (${targetOrigin})`);

  try {
    // ネットワーク種別(メインネット/テストネット)が現在接続中のものと
    // 一致するか確認してから切り替える
    const props = await fetch(new URL("/network/properties", targetOrigin)).then((r) => r.json());
    const identifier = props.network.identifier;
    const targetNetworkType = identifier === "testnet" ? NetworkType.TESTNET : NetworkType.MAINNET;

    if (appState.networkType && targetNetworkType !== appState.networkType) {
      setStatus(
        "node-settings-status",
        "現在接続中のネットワークと異なるため切り替えられません(メインネット/テストネットの混在不可)。",
        "error"
      );
      return;
    }

    // 接続先を切り替え
    closeWebSocket();
    appState.NODE = targetOrigin;

    await initSdk();
    await refreshAccount();
    await loadRecentTx();

    if (appState.currentAddress) {
      const address = appState.currentAddress.toString();
      initWebSocket(address);
      initLiveTx(address);
      initLiveBalanceRefresh(address);
      initLiveHarvestStatusRefresh(address);
    }

    const infoEl = document.getElementById("node-info");
    if (infoEl) {
      infoEl.innerHTML = renderNodeInfoHtml({
        isTestnet: targetNetworkType === NetworkType.TESTNET,
        nodeOrigin: targetOrigin
      });
    }
    showCurrentNode();

    setStatus("node-settings-status", "✅ ノードを切り替えました。", "success");
  } catch (e) {
    console.error("applyNodeChange error:", e);
    setStatus("node-settings-status", "ノードへの接続に失敗しました。", "error");
  }
}

/* ============================================================
   送金手数料の設定
============================================================ */

// 目安表示用の参考トランザクションサイズ(byte)
// メッセージなしの単純なXYM送金トランザクション相当
const REF_TX_SIZE = 176;

function estimateFeeXym(multiplier) {
  return ((multiplier * REF_TX_SIZE) / 1_000_000).toLocaleString("ja-JP", {
    maximumFractionDigits: 6,
  });
}

function renderFeeOption(elId, multiplier) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = `feeMultiplier: ${multiplier} （目安 約${estimateFeeXym(multiplier)} XYM）`;
  el.closest(".fee-option")?.setAttribute("data-multiplier", String(multiplier));
}

async function loadFeeSettings() {
  setStatus("fee-settings-status", "手数料情報を取得中...");

  const customInput = document.getElementById("fee-custom-input");
  if (customInput) customInput.value = appState.feeMultiplier ?? 100;

  try {
    const res = await fetch(new URL("/network/fees/transaction", appState.NODE));
    const data = await res.json();

    const minMultiplier = Number(data.minFeeMultiplier) || 0;
    const average = Math.max(Number(data.medianFeeMultiplier) || Number(data.averageFeeMultiplier) || 0, minMultiplier);
    const fast = Math.max(Number(data.highestFeeMultiplier) || 0, average * 2, minMultiplier);
    const slow = Math.max(minMultiplier, 0);

    renderFeeOption("fee-slow-value", slow);
    renderFeeOption("fee-average-value", average);
    renderFeeOption("fee-fast-value", fast);

    setStatus("fee-settings-status", "", "default");
  } catch (e) {
    console.error("loadFeeSettings error:", e);
    setStatus("fee-settings-status", "手数料情報の取得に失敗しました。手動で入力してください。", "error");
  }
}

function selectFeeOption(optionEl) {
  const multiplier = optionEl?.getAttribute("data-multiplier");
  if (multiplier == null) return;

  document.querySelectorAll(".fee-option").forEach((el) => el.classList.remove("selected"));
  optionEl.classList.add("selected");

  const customInput = document.getElementById("fee-custom-input");
  if (customInput) customInput.value = multiplier;
}

function applyFeeSettings() {
  const raw = document.getElementById("fee-custom-input")?.value;
  const multiplier = Number(raw);

  if (!Number.isFinite(multiplier) || multiplier < 0) {
    setStatus("fee-settings-status", "手数料の値が不正です。", "error");
    return;
  }

  appState.feeMultiplier = Math.floor(multiplier);

  try {
    localStorage.setItem("feeMultiplier", String(appState.feeMultiplier));
  } catch (e) {
    console.warn("feeMultiplierの保存に失敗しました", e);
  }

  setStatus("fee-settings-status", `✅ 送金手数料をfeeMultiplier: ${appState.feeMultiplier} に設定しました。`, "success");
}

window.W.settings = {
  showCurrentNode,
  loadNodeSettingsCandidates,
  applyNodeChange,
  loadFeeSettings,
  selectFeeOption,
  applyFeeSettings
};
