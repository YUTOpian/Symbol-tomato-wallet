// sss.js
// SSS Extension との接続
// Node / SDK 初期化
// トランザクション署名処理

const {appState, NetworkType} = W.config;
const {selectNode} = W.nodeSelector;
const {initSdk} = W.sdk;
const {setStatus, setText} = W.ui;
const {refreshAccount, initLiveBalanceRefresh} = W.account;
const {initLiveHarvestStatusRefresh} = W.harvest;
const {loadRecentTx, initLiveTx} = W.transactions;
const {initWebSocket} = W.ws;
const {getSSSStatusHtml} = W.utils;

/* ------------------------------------------------------
   ネットワーク名表示
------------------------------------------------------ */
function networkLabel(nt) {
  return nt === NetworkType.TESTNET ? "Testnet" : "Mainnet";
}

/* ------------------------------------------------------
   接続制御
------------------------------------------------------ */
let isConnecting = false;
let lockedNetworkType = null;

/* ------------------------------------------------------
   SSS接続本体
------------------------------------------------------ */
async function internalConnect(isAuto) {
  if (isConnecting) return;
  isConnecting = true;

  try {
    if (!window.SSS) {
      if (!isAuto) {
        setStatus("sss-status", "SSS Extension が見つかりません。", "error");
      }
      const infoEl = document.getElementById("node-info");
      if (infoEl) infoEl.innerHTML = getSSSStatusHtml();
      return;
    }

    const pubKey = window.SSS.activePublicKey;
    const detectedNetworkType = Number(window.SSS.activeNetworkType);

    console.log("SSS pubKey:", pubKey);
    console.log("Network:", detectedNetworkType);

    if (!pubKey || ![NetworkType.MAINNET, NetworkType.TESTNET].includes(detectedNetworkType)) {
      if (!isAuto) {
        setStatus("sss-status", "SSSでアカウントを選択してください。", "error");
      }
      const infoEl = document.getElementById("node-info");
      if (infoEl) infoEl.innerHTML = getSSSStatusHtml();
      return;
    }

    /*
      ネットワーク固定
    */
    if (!lockedNetworkType) {
      lockedNetworkType = detectedNetworkType;
    }

    const networkType = lockedNetworkType;
    appState.currentPubKey = pubKey;
    appState.networkType = networkType;

    setText("network-label", networkLabel(networkType));

    /*
      Node取得
    */
    const isTestnet = networkType === NetworkType.TESTNET;
    appState.NODE = await selectNode(isTestnet);
    console.log("Selected NODE:", appState.NODE);

    /*
      SDK初期化
    */
    await initSdk();

    /*
      Account生成
    */
    const pub = new appState.sdkCore.PublicKey(pubKey);
    const publicAccount = appState.facade.createPublicAccount(pub);
    appState.currentAddress = publicAccount.address;

    setText("account-address", publicAccount.address.toString());
    setStatus("sss-status", "SSS と接続済み", "success");

    /*
      ボタン有効化
    */
    ["btn-transfer", "btn-update-meta"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = false;
    });

    await refreshAccount();
    await loadRecentTx();

    const currentAddress = appState.currentAddress.toString();
    initWebSocket(currentAddress);
    initLiveTx(currentAddress);
    initLiveBalanceRefresh(currentAddress);
    initLiveHarvestStatusRefresh(currentAddress);
  } catch(e) {
    console.error("internalConnect error:", e);
  } finally {
    isConnecting = false;
  }
}

/* ------------------------------------------------------
   自動接続
------------------------------------------------------ */
async function autoConnectSSS() {
  await internalConnect(true);
}

/* ======================================================
   SSS署名処理
====================================================== */
/*
  作成したTransactionをSSS Extensionで署名する
  harvest.js, transfer.js, metadata.js から利用
*/
async function signTransaction(transaction) {
  if (!window.SSS) {
    throw new Error("SSS Extension がありません");
  }

  if (!transaction) {
    throw new Error("署名対象Transactionがありません");
  }

  console.log("SSS署名開始", transaction);
  const signedTransaction = await window.SSS.signTransaction(transaction);
  console.log("署名完了", signedTransaction);

  return signedTransaction;
}

window.W.sss = {
  autoConnectSSS,
  signTransaction
};
