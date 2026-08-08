// index.js

const {appState, NetworkType, getXymMosaicIdHex} = W.config;
const {sendTx} = W.transfer;
const {loadRecentTx, initLiveTx} = W.transactions;
const {initWebSocket} = W.ws;
const {selectNode} = W.nodeSelector;
const {showPopup} = W.utils;
const {setStatus} = W.ui;
const {checkHarvestStatus, startHarvest, stopHarvest, loadHarvestNodeCandidates, loadHarvestHistory, loadHarvestRewards} = W.harvest;
const {showCurrentNode,
  loadNodeSettingsCandidates,
  applyNodeChange,
  loadFeeSettings,
  selectFeeOption,
  applyFeeSettings,} = W.settings;
const {connectWithSSS,
  loginWithMnemonic,
  loginWithPrivateKey,
  loginAsReadOnly,
  getVaultMode,
  restorePlainVault,
  unlockVault,
  saveVault,
  clearVault,
  logout,
  lockSession,
  generateNewMnemonic,
  deriveFromMnemonic,
  switchToAccount,
  setAccountHidden,
  addAccountFromMnemonic,
  addAccountFromPrivateKey,
  addNextAccountFromCurrentMnemonic,
  hasCurrentMnemonic,
  switchNetwork,
  canUseBackupFeature,
  verifyVaultPassword,
  getPrivateKeyForAccount,
  getVerifiedMnemonicForAccount,} = W.auth;
const {updateSwitcherVisibility,
  renderAccountSwitcherList,
  renderHiddenAccountList,
  nextMnemonicAccountIndex,} = W.accountSwitcher;
const {loadOwnedNamespaces,
  populateParentNamespaceSelect,
  registerRootNamespace,
  registerSubNamespace,
  fetchOwnedNamespaceOptions,
  setAddressAlias,
  estimateRootNamespaceFee,
  estimateSubNamespaceFee,
  estimateAddressAliasFee,
  estimateRootNamespaceRentalFee,
  estimateSubNamespaceRentalFee,} = W.namespace;
const {loadOwnedMosaicsWithAlias,
  populateMosaicNamespaceSelect,
  createMosaic,
  setMosaicAlias,
  fetchOwnedMosaicIds,
  estimateMosaicCreationFee,
  estimateMosaicAliasFee,
  changeMosaicSupply,
  fetchMosaicDetail,
  estimateMosaicRentalFee,} = W.mosaic;
const {setMetadata, loadOwnMetadataList} = W.metadata;
const {loadMultisigInfo,
  fetchCosignatoryOfAddresses,
  updateMultisigSettings,
  sendFromMultisig,
  loadPendingPartialTransactions,
  cosignPending,} = W.multisig;
const {parseCsv, sendMultiTransfer} = W.multisend;
const {checkMultisendRows} = W.multisendRecipientCheck;
const {trackOutgoingTransaction} = W.txStatusTracker;
const {loadDataPage} = W.dataPage;
const {computeFileHash, createApostille, searchApostilleTransactions} = W.apostille;
const {loadAccountRestrictions,
  setAddressRestriction,
  setMosaicRestriction,
  setOperationRestriction,
  setMosaicGlobalRestriction,
  setMosaicAddressRestriction,
  OPERATION_TYPE_OPTIONS,
  MOSAIC_RESTRICTION_TYPE_OPTIONS,} = W.restriction;
const {composeAndSignOfflineTransfer,
  downloadOfflineTxJson,
  validateOfflineTxJson,
  broadcastOfflineTx,
  checkAlreadyBroadcastStatus,} = W.offline;

let QRCode, QRCodeGenerator, firstValueFrom;

window.addEventListener("load", async () => {
  // 外部CDNライブラリ(ESモジュール)は動的importで読み込む
  // (このスクリプト自体は通常の<script>なので静的importは使えないため)
  ({ default: QRCode } = await import("https://esm.sh/qrcode"));
  ({ QRCodeGenerator } = await import("https://esm.sh/symbol-qr-library"));
  ({ firstValueFrom } = await import("https://esm.sh/rxjs"));

  // ============================
  // ページ取得
  // ============================
  const welcomePage = document.getElementById("welcome-page");
  const addressLookupPage = document.getElementById("address-lookup-page");
  const createNewPage = document.getElementById("create-new-page");
  const mnemonicImportPage = document.getElementById("mnemonic-import-page");
  const privatekeyImportPage = document.getElementById("privatekey-import-page");
  const passwordSetupPage = document.getElementById("password-setup-page");
  const unlockPage = document.getElementById("unlock-page");
  const accountPage = document.getElementById("account-page");
  const sendPage = document.getElementById("send-page");
  const transferPage = document.getElementById("transfer-page");
  const receivePage = document.getElementById("receive-page");
  const harvestPage = document.getElementById("harvest-page");
  const settingsPage = document.getElementById("settings-page");
  const backupPage = document.getElementById("backup-page");
  const nodeSettingsPage = document.getElementById("node-settings-page");
  const feeSettingsPage = document.getElementById("fee-settings-page");
  const networkSwitchPage = document.getElementById("network-switch-page");
  const accountSwitcherPage = document.getElementById("account-switcher-page");
  const hiddenAccountsPage = document.getElementById("hidden-accounts-page");
  const addAccountMenuPage = document.getElementById("add-account-menu-page");
  const addAccountMnemonicPage = document.getElementById("add-account-mnemonic-page");
  const addAccountPrivatekeyPage = document.getElementById("add-account-privatekey-page");
  const advancedPage = document.getElementById("advanced-page");
  const dataPage = document.getElementById("data-page");
  const namespacePage = document.getElementById("namespace-page");
  const mosaicPage = document.getElementById("mosaic-page");
  const metadataPage = document.getElementById("metadata-page");
  const multisigPage = document.getElementById("multisig-page");
  const multisendListPage = document.getElementById("multisend-list-page");
  const apostillePage = document.getElementById("apostille-page");
  const restrictionMenuPage = document.getElementById("restriction-menu-page");
  const restrictionAccountPage = document.getElementById("restriction-account-page");
  const restrictionMosaicdefPage = document.getElementById("restriction-mosaicdef-page");
  const offlineTxCreatePage = document.getElementById("offline-tx-create-page");
  const offlineBroadcastPage = document.getElementById("offline-broadcast-page");

  // ============================
  // ページ切替
  // ============================
  function showPage(page) {
    document.querySelectorAll(".page").forEach(p => {
      p.classList.remove("active");
    });
    page.classList.add("active");
  }

  function updateReadOnlyUiVisibility() {
    const sendBtn = document.getElementById("send-btn");
    const advancedBtn = document.getElementById("advanced-btn");
    if (sendBtn) sendBtn.style.display = appState.isReadOnly ? "none" : "";
    if (advancedBtn) advancedBtn.style.display = appState.isReadOnly ? "none" : "";
  }

  function goHome() {
    updateSwitcherVisibility();
    updateReadOnlyUiVisibility();
    showPage(accountPage);
  }

  // ============================
  // 起動時の初期画面判定
  // - パスワード設定済み(暗号化保存) → ロック解除画面
  // - パスワード未設定だが保存あり(平文保存) → 確認なしでそのまま自動ログイン
  // - 何も保存されていない → ログイン方法選択画面
  // ============================
  const vaultMode = getVaultMode();
  if (vaultMode === "encrypted") {
    showPage(unlockPage);
  } else if (vaultMode === "plain") {
    try {
      await restorePlainVault();
      goHome();
    } catch (e) {
      console.error("restorePlainVault error:", e);
      showPage(welcomePage);
    }
  } else {
    showPage(welcomePage);
  }

  // ============================
  // SSS Extensionと接続
  // ============================
  document.getElementById("choose-sss")?.addEventListener("click", async () => {
    setStatus("welcome-status", "SSS Extensionに接続中...");
    try {
      await connectWithSSS();
      goHome();
    } catch (e) {
      console.error("connectWithSSS error:", e);
      setStatus("welcome-status", e.message || "SSS Extensionとの接続に失敗しました。", "error");
    }
  });

  // ============================
  // 新規作成
  // ============================
  document.getElementById("choose-create-new")?.addEventListener("click", async () => {
    showPage(createNewPage);
    setStatus("create-new-status", "", "default");
    const mnemonicEl = document.getElementById("create-new-mnemonic");
    const privateKeyEl = document.getElementById("create-new-privatekey");
    mnemonicEl.innerHTML = "生成中...";
    privateKeyEl.textContent = "生成中...";
    delete privateKeyEl.dataset.privatekey;
    try {
      const mnemonic = await generateNewMnemonic();
      mnemonicEl.dataset.mnemonic = mnemonic;
      mnemonicEl.innerHTML = mnemonic
        .trim()
        .split(/\s+/)
        .map((word, i) => `<span class="mnemonic-word"><b>${i + 1}.</b>${word}</span>`)
        .join("");

      const privateKeyHex = await deriveFromMnemonic(mnemonic, 0);
      privateKeyEl.textContent = privateKeyHex;
      privateKeyEl.dataset.privatekey = privateKeyHex;
    } catch (e) {
      console.error("generateNewMnemonic error:", e);
      mnemonicEl.innerHTML = "生成に失敗しました。";
      privateKeyEl.textContent = "---";
    }
  });

  document.getElementById("create-new-mnemonic-copy-btn")?.addEventListener("click", async () => {
    const phrase = document.getElementById("create-new-mnemonic")?.dataset.mnemonic;
    if (!phrase) return;
    try {
      await navigator.clipboard.writeText(phrase);
      showPopup("ニーモニックをコピーしました");
    } catch (e) {
      console.error("clipboard error:", e);
      showPopup("コピーに失敗しました", true);
    }
  });

  document.getElementById("create-new-privatekey-copy-btn")?.addEventListener("click", async () => {
    const key = document.getElementById("create-new-privatekey")?.dataset.privatekey;
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      showPopup("秘密鍵をコピーしました");
    } catch (e) {
      console.error("clipboard error:", e);
      showPopup("コピーに失敗しました", true);
    }
  });

  document.getElementById("back-welcome-create-new")?.addEventListener("click", () => showPage(welcomePage));

  document.getElementById("create-new-next-btn")?.addEventListener("click", async () => {
    const mnemonicPhrase = document.getElementById("create-new-mnemonic").dataset.mnemonic;
    const networkChoice = document.getElementById("create-new-network-select").value;
    const networkType = networkChoice === "testnet" ? NetworkType.TESTNET : NetworkType.MAINNET;
    const exportable = !!document.getElementById("create-new-exportable-toggle")?.checked;

    if (!mnemonicPhrase) {
      setStatus("create-new-status", "ニーモニックの生成が完了していません。", "error");
      return;
    }

    if (!confirm("ニーモニックを記録しましたか？\n\n記録していない場合、このアカウントには二度とアクセスできなくなります。")) {
      return;
    }

    setStatus("create-new-status", "作成中...");
    try {
      await loginWithMnemonic(mnemonicPhrase, networkType, 0, exportable);
      setStatus("create-new-status", "", "default");
      showPage(passwordSetupPage);
    } catch (e) {
      console.error("loginWithMnemonic(create-new) error:", e);
      setStatus("create-new-status", e.message || "作成に失敗しました。", "error");
    }
  });

  // ============================
  // ニーモニック入力マス(1単語ずつ, 6列) - 複数画面で共通利用
  // ============================
  const DEFAULT_MNEMONIC_WORD_COUNT = 24;

  function buildMnemonicInputGrid(gridId, count) {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const cell = document.createElement("div");
      cell.className = "mnemonic-word-cell";
      cell.innerHTML = `<span class="mnemonic-word-num">${i + 1}.</span>`;
      const input = document.createElement("input");
      input.className = "mnemonic-word-input";
      input.type = "text";
      input.autocomplete = "off";
      input.autocapitalize = "off";
      input.spellcheck = false;
      input.dataset.idx = String(i);
      cell.appendChild(input);
      grid.appendChild(cell);
    }
  }

  function getMnemonicWordInputs(gridId) {
    return Array.from(document.querySelectorAll(`#${gridId} .mnemonic-word-input`));
  }

  function focusMnemonicWordInput(gridId, idx) {
    const inputs = getMnemonicWordInputs(gridId);
    if (inputs[idx]) {
      inputs[idx].focus();
      inputs[idx].select();
    }
  }

  // フレーズ全体をどこかのマスに貼り付けたら、単語数に合わせてマス目を
  // 作り直し、全マスへ一斉に振り分ける
  function distributeMnemonicPaste(gridId, text) {
    const words = text.trim().split(/[\s\u3000]+/).filter(Boolean);
    if (words.length === 0) return false;

    buildMnemonicInputGrid(gridId, words.length);
    const inputs = getMnemonicWordInputs(gridId);
    words.forEach((w, i) => {
      if (inputs[i]) inputs[i].value = w;
    });
    wireMnemonicWordInputEvents(gridId);
    focusMnemonicWordInput(gridId, Math.min(words.length, inputs.length) - 1);
    return true;
  }

  function wireMnemonicWordInputEvents(gridId) {
    getMnemonicWordInputs(gridId).forEach((input, idx) => {
      input.onpaste = (e) => {
        const text = e.clipboardData?.getData("text") ?? "";
        // 複数単語(=フレーズ全体)の貼り付けだけ横取りして一斉に振り分ける。
        // 単語1つだけの貼り付けは、そのマスへの通常の貼り付けに任せる。
        if (text.trim().split(/[\s\u3000]+/).filter(Boolean).length > 1) {
          e.preventDefault();
          distributeMnemonicPaste(gridId, text);
        }
      };

      input.onkeydown = (e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          focusMnemonicWordInput(gridId, idx + 1);
        } else if (e.key === "Backspace" && input.value === "" && idx > 0) {
          e.preventDefault();
          focusMnemonicWordInput(gridId, idx - 1);
        } else if (e.key === "ArrowRight" && input.selectionStart === input.value.length) {
          focusMnemonicWordInput(gridId, idx + 1);
        } else if (e.key === "ArrowLeft" && input.selectionStart === 0) {
          focusMnemonicWordInput(gridId, idx - 1);
        }
      };
    });
  }

  function readMnemonicFromGrid(gridId) {
    return getMnemonicWordInputs(gridId)
      .map((input) => input.value.trim())
      .filter(Boolean)
      .join(" ");
  }

  function resetMnemonicInputGrid(gridId) {
    buildMnemonicInputGrid(gridId, DEFAULT_MNEMONIC_WORD_COUNT);
    wireMnemonicWordInputEvents(gridId);
  }

  // 保険: 何らかの理由でグリッドを作らずにページが表示されてしまった場合でも、
  // そのページが表示状態(active)になった時点で自動的にマス目を用意する
  function ensureMnemonicGridPopulated(pageId, gridId) {
    const page = document.getElementById(pageId);
    const grid = document.getElementById(gridId);
    if (!page || !grid) return;

    const check = () => {
      if (page.classList.contains("active") && grid.children.length === 0) {
        resetMnemonicInputGrid(gridId);
      }
    };
    new MutationObserver(check).observe(page, { attributes: true, attributeFilter: ["class"] });
    check();
  }

  ensureMnemonicGridPopulated("mnemonic-import-page", "mnemonic-input-grid");
  ensureMnemonicGridPopulated("add-account-mnemonic-page", "add-mnemonic-input-grid");

  // ============================
  // ニーモニックインポート画面(ようこそ画面から)
  // ============================
  document.getElementById("choose-mnemonic")?.addEventListener("click", () => {
    resetMnemonicInputGrid("mnemonic-input-grid");
    showPage(mnemonicImportPage);
  });

  document.getElementById("back-welcome-mnemonic")?.addEventListener("click", () => showPage(welcomePage));

  document.getElementById("import-mnemonic-btn")?.addEventListener("click", async () => {
    const mnemonicPhrase = readMnemonicFromGrid("mnemonic-input-grid");
    const networkChoice = document.getElementById("mnemonic-network-select").value;
    const networkType = networkChoice === "testnet" ? NetworkType.TESTNET : NetworkType.MAINNET;
    const exportable = !!document.getElementById("mnemonic-import-exportable-toggle")?.checked;

    if (!mnemonicPhrase) {
      setStatus("mnemonic-import-status", "ニーモニックを入力してください。", "error");
      return;
    }

    setStatus("mnemonic-import-status", "インポート中...");
    try {
      await loginWithMnemonic(mnemonicPhrase, networkType, 0, exportable);
      resetMnemonicInputGrid("mnemonic-input-grid");
      setStatus("mnemonic-import-status", "", "default");
      showPage(passwordSetupPage);
    } catch (e) {
      console.error("loginWithMnemonic error:", e);
      setStatus("mnemonic-import-status", e.message || "インポートに失敗しました。", "error");
    }
  });

  // ============================
  // 秘密鍵インポート画面へ
  // ============================
  document.getElementById("choose-privatekey")?.addEventListener("click", () => {
    showPage(privatekeyImportPage);
  });

  document.getElementById("back-welcome-privatekey")?.addEventListener("click", () => showPage(welcomePage));

  document.getElementById("import-privatekey-btn")?.addEventListener("click", async () => {
    const privateKeyHex = document.getElementById("privatekey-import-input").value.trim();
    const networkChoice = document.getElementById("privatekey-import-network-select").value;
    const networkType = networkChoice === "testnet" ? NetworkType.TESTNET : NetworkType.MAINNET;

    if (!privateKeyHex) {
      setStatus("privatekey-import-status", "秘密鍵を入力してください。", "error");
      return;
    }

    setStatus("privatekey-import-status", "インポート中...");
    try {
      await loginWithPrivateKey(privateKeyHex, networkType);
      document.getElementById("privatekey-import-input").value = "";
      setStatus("privatekey-import-status", "", "default");
      showPage(passwordSetupPage);
    } catch (e) {
      console.error("loginWithPrivateKey error:", e);
      setStatus("privatekey-import-status", e.message || "インポートに失敗しました。", "error");
    }
  });

  // ============================
  // アドレス照会(閲覧専用・秘密鍵不要・パスワード不要)
  // ============================
  let addressLookupOrigin = "welcome"; // "welcome" | "login" - 戻る先とSettings表示の出し分けに使う

  document.getElementById("welcome-address-lookup-btn")?.addEventListener("click", () => {
    addressLookupOrigin = "welcome";
    setStatus("address-lookup-status", "", "default");
    showPage(addressLookupPage);
  });

  document.getElementById("unlock-address-lookup-btn")?.addEventListener("click", () => {
    addressLookupOrigin = "login";
    setStatus("address-lookup-status", "", "default");
    showPage(addressLookupPage);
  });

  document.getElementById("back-welcome-address-lookup")?.addEventListener("click", () => {
    showPage(addressLookupOrigin === "login" ? unlockPage : welcomePage);
  });

  document.getElementById("address-lookup-submit-btn")?.addEventListener("click", async () => {
    const addressInput = document.getElementById("address-lookup-input").value.trim();

    if (!addressInput) {
      setStatus("address-lookup-status", "アドレスを入力してください。", "error");
      return;
    }

    setStatus("address-lookup-status", "照会中...");
    try {
      await loginAsReadOnly(addressInput);
      appState.readOnlyFromLogin = addressLookupOrigin === "login";
      document.getElementById("address-lookup-input").value = "";
      setStatus("address-lookup-status", "", "default");
      goHome();
    } catch (e) {
      console.error("loginAsReadOnly error:", e);
      setStatus("address-lookup-status", e.message || "照会に失敗しました。", "error");
    }
  });

  // ============================
  // パスワード設定(任意)
  // この時点でアカウントは既にappState.accountsに追加済みなので、
  // saveVaultはパスワードだけ受け取って現在のアカウント一覧を暗号化保存する
  // ============================
  document.getElementById("save-password-btn")?.addEventListener("click", async () => {
    const pw = document.getElementById("setup-password-input").value;
    const pwConfirm = document.getElementById("setup-password-confirm").value;

    if (!pw || pw.length < 8) {
      setStatus("password-setup-status", "8文字以上のパスワードを入力してください。", "error");
      return;
    }
    if (pw !== pwConfirm) {
      setStatus("password-setup-status", "パスワードが一致しません。", "error");
      return;
    }

    try {
      await saveVault(pw);
      document.getElementById("setup-password-input").value = "";
      document.getElementById("setup-password-confirm").value = "";
      goHome();
    } catch (e) {
      console.error("saveVault error:", e);
      setStatus("password-setup-status", "保存に失敗しました。", "error");
    }
  });

  // ============================
  // ロック解除(保存済みアカウントでログイン)
  // ============================
  document.getElementById("unlock-btn")?.addEventListener("click", async () => {
    const pw = document.getElementById("unlock-password-input").value;
    if (!pw) {
      setStatus("unlock-status", "パスワードを入力してください。", "error");
      return;
    }
    setStatus("unlock-status", "ログイン中...");
    try {
      await unlockVault(pw);
      document.getElementById("unlock-password-input").value = "";
      goHome();
    } catch (e) {
      console.error("unlockVault error:", e);
      setStatus("unlock-status", e.message || "ログインに失敗しました。", "error");
    }
  });

  document.getElementById("unlock-sss-btn")?.addEventListener("click", async () => {
    setStatus("unlock-status", "SSS Extensionに接続中...");
    try {
      await connectWithSSS();
      goHome();
    } catch (e) {
      console.error("connectWithSSS error:", e);
      setStatus("unlock-status", e.message || "SSS Extensionとの接続に失敗しました。", "error");
    }
  });

  document.getElementById("forget-account-btn")?.addEventListener("click", () => {
    if (!confirm(
      "この端末に保存されているアカウント情報を削除します。\n" +
      "（ニーモニックや秘密鍵をメモ・保管していれば、資産自体がなくなることはありません。このアプリからのログイン情報が消えるだけです）\n\n" +
      "削除してよろしいですか？"
    )) return;
    clearVault();
    showPage(welcomePage);
  });

  // 送金画面に「保有モザイク一覧」から直接入ったかどうか
  let cameFromMosaicList = false;
  const backSendBtn = document.getElementById("back-send");

  // ============================
  // 送金画面
  // ============================
  document.getElementById("send-btn")?.addEventListener("click", () => {
    showPage(sendPage);
    const sendList = document.getElementById("send-mosaic-list");
    const mosaicList = document.getElementById("mosaic-list");

    if (sendList && mosaicList) {
      sendList.innerHTML = mosaicList.innerHTML;
    }
  });

  // ============================
  // モザイク選択
  // ============================
  document.getElementById("send-mosaic-list")?.addEventListener("click", e => {
    const item = e.target.closest(".mosaic-item");
    if (!item) return;

    document.getElementById("selected-mosaic-name").textContent = 
      item.querySelector(".mosaic-name")?.textContent;

    document.getElementById("selected-mosaic-id").value = 
      item.querySelector(".mosaic-id")?.textContent;

    document.getElementById("selected-mosaic-balance").textContent =
      item.querySelector(".mosaic-amount")?.textContent ?? "---";

    cameFromMosaicList = false;
    if (backSendBtn) backSendBtn.textContent = "← モザイク選択へ戻る";
    showPage(transferPage);
  });

  // ============================
  // 保有モザイク一覧から直接送金画面へ
  // ============================
  document.getElementById("mosaic-list")?.addEventListener("click", e => {
    const item = e.target.closest(".mosaic-item");
    if (!item) return;
    if (appState.isReadOnly) return; // 読み取り専用モードでは送金画面へは行かせない

    // 選択情報(selected-mosaic-id / name / balance)は
    // account.js 側の item.onclick で既にセット済み
    cameFromMosaicList = true;
    if (backSendBtn) backSendBtn.textContent = "← 戻る";
    showPage(transferPage);
  });

  // ============================
  // 送金実行
  // ============================
  document.getElementById("btn-transfer")?.addEventListener("click", sendTx);

  // ============================
  // 受取画面
  // ============================
  async function generateReceiveQR(walletName, address, elId) {
    const qr = document.getElementById(elId);
    if (!qr) return;
    qr.innerHTML = "読み込み中...";

    try {
      if (!appState.generationHash || !appState.networkType) {
        throw new Error("ネットワーク情報が未取得です");
      }

      // 他のSymbolウォレット(公式モバイルウォレット等)が読み込める
      // 形式(symbol-qr-library の AddressQR)でQRコードを生成する
      const addressQR = QRCodeGenerator.createExportAddress(
        walletName,
        address,
        appState.networkType,
        appState.generationHash
      );

      const dataUrl = await firstValueFrom(addressQR.toBase64());
      qr.innerHTML = `<img src="${dataUrl}" alt="QR Code">`;
    } catch (e) {
      console.error(`AddressQR生成失敗(${walletName})、通常QRにフォールバック`, e);
      const dataUrl = await QRCode.toDataURL(address, {
        width: 180,
        margin: 1
      });
      qr.innerHTML = `<img src="${dataUrl}" alt="QR Code">`;
    }
  }

  /*
    EXYM Wallet形式: type=3 (未署名トランザクションのリクエストQR)
    受取用として、宛先=自分・モザイク=XYM・数量=0(相手が入力する)・
    メッセージなし・maxFee=0・signerPublicKeyは全ゼロ(スキャンした側の
    ウォレットが自分の鍵で組み直して署名する前提のテンプレート)にした
    未署名TransferTransactionのpayloadを、そのままJSONに埋め込む。
  */
  function buildReceiveRequestPayloadHex(address) {
    const { descriptors, models } = appState.sdkSymbol;

    const mosaic = new descriptors.UnresolvedMosaicDescriptor(
      new models.UnresolvedMosaicId(BigInt("0x" + getXymMosaicIdHex())),
      new models.Amount(0n)
    );

    const transferDescriptor = new descriptors.TransferTransactionV1Descriptor(
      new appState.sdkSymbol.Address(address),
      [mosaic],
      new Uint8Array(0) // メッセージなし(サイズ0。プレーンメッセージの識別バイトも付けない)
    );

    const zeroPublicKey = new appState.sdkCore.PublicKey("0".repeat(64));

    const tx = appState.facade.createTransactionFromTypedDescriptor(
      transferDescriptor,
      zeroPublicKey,
      0,       // feeMultiplier=0 → maxFeeも0(実際に支払う側が組み直す時に設定する)
      60 * 60  // 有効期限1時間(テンプレートなので目安)
    );

    return appState.sdkCore.utils.uint8ToHex(tx.serialize()).toUpperCase();
  }

  async function generateReceiveTransactionQR(address, elId) {
    const qr = document.getElementById(elId);
    if (!qr) return;
    qr.innerHTML = "読み込み中...";

    try {
      if (!appState.generationHash || !appState.networkType || !appState.facade) {
        throw new Error("ネットワーク情報が未取得です");
      }

      const payloadHex = buildReceiveRequestPayloadHex(address);
      const qrJson = {
        v: 3,
        type: 3,
        network_id: appState.networkType,
        chain_id: appState.generationHash,
        data: { payload: payloadHex },
      };

      const dataUrl = await QRCode.toDataURL(JSON.stringify(qrJson), {
        width: 180,
        margin: 1,
      });
      qr.innerHTML = `<img src="${dataUrl}" alt="QR Code">`;
    } catch (e) {
      console.error("EXYM Wallet用QR生成失敗", e);
      qr.innerHTML = "QR生成に失敗しました";
    }
  }

  // NFTDriveEX形式: "{symbol:アドレス}" というプレーンテキストをそのままQR化する
  async function generateNftDriveExQR(address, elId) {
    const qr = document.getElementById(elId);
    if (!qr) return;
    qr.innerHTML = "読み込み中...";

    try {
      const content = `{symbol:${address}}`;
      const dataUrl = await QRCode.toDataURL(content, {
        width: 180,
        margin: 1,
      });
      qr.innerHTML = `<img src="${dataUrl}" alt="QR Code">`;
    } catch (e) {
      console.error("NFTDriveEX用QR生成失敗", e);
      qr.innerHTML = "QR生成に失敗しました";
    }
  }

  document.getElementById("receive-btn")?.addEventListener("click", async () => {
    showPage(receivePage);
    const address = appState.currentAddress.toString();

    document.getElementById("receive-address").textContent = address;

    await Promise.all([
      generateReceiveQR("Symbol Simple Wallet", address, "receive-qrcode-symbol"),
      generateReceiveTransactionQR(address, "receive-qrcode-exym"),
      generateNftDriveExQR(address, "receive-qrcode-nftdriveex"),
    ]);
  });

  // ============================
  // 受け取りアドレスコピー
  // ============================
  document.getElementById("copy-receive-address")?.addEventListener("click", () => {
    navigator.clipboard.writeText(appState.currentAddress.toString());
    showPopup("アドレスをコピーしました");
  });

  // ============================
  // ハーベスト画面
  // ============================
  document.getElementById("menu-harvest")?.addEventListener("click", async () => {
    showPage(harvestPage);
    const address = appState.currentAddress.toString();
    document.getElementById("harvest-address").textContent = address;

    await checkHarvestStatus();
    await loadHarvestNodeCandidates();
    await loadHarvestHistory();
  });

  // ============================
  // ハーベスト開始
  // ============================
  document.getElementById("start-harvest-btn")?.addEventListener("click", startHarvest);
  document.getElementById("stop-harvest-btn")?.addEventListener("click", stopHarvest);

  // ============================
  // 高度機能
  // ============================
  document.getElementById("advanced-btn")?.addEventListener("click", () => {
    showPage(advancedPage);
  });

  // ============================
  // データ(アカウント詳細 / Symbolネットワーク統計)
  // ============================
  document.getElementById("data-btn")?.addEventListener("click", () => {
    showPage(dataPage);
    loadDataPage();
  });

  document.getElementById("back-account-data")?.addEventListener("click", () => showPage(accountPage));

  document.getElementById("menu-namespace")?.addEventListener("click", async () => {
    showPage(namespacePage);
    await loadOwnedNamespaces();
    await populateParentNamespaceSelect();
    await populateNamespaceAliasSelects();
    await populateNsLinkMosaicSelect();
  });

  document.getElementById("menu-mosaic")?.addEventListener("click", async () => {
    showPage(mosaicPage);
    await loadOwnedMosaicsWithAlias();
    await populateMosaicNamespaceSelect();
    updateMosaicFeeEstimate();
  });

  // ============================
  // メタデータ
  // ============================
  document.getElementById("menu-metadata")?.addEventListener("click", async () => {
    showPage(metadataPage);
    await loadOwnMetadataList();
  });

  const metadataTargetType = document.getElementById("metadata-target-type");
  const metadataNamespaceRow = document.getElementById("metadata-target-namespace-row");
  const metadataMosaicRow = document.getElementById("metadata-target-mosaic-row");

  async function refreshMetadataTargetRows() {
    const type = metadataTargetType.value;
    metadataNamespaceRow.style.display = type === "namespace" ? "block" : "none";
    metadataMosaicRow.style.display = type === "mosaic" ? "block" : "none";

    if (type === "namespace") {
      const select = document.getElementById("metadata-target-namespace-select");
      select.innerHTML = `<option value="">-- 読み込み中... --</option>`;
      try {
        const options = await fetchOwnedNamespaceOptions();
        select.innerHTML = options.length
          ? options.map(ns => `<option value="${ns.id}">${ns.name}</option>`).join("")
          : `<option value="">-- 保有ネームスペースがありません --</option>`;
      } catch {
        select.innerHTML = `<option value="">-- 取得に失敗しました --</option>`;
      }
    } else if (type === "mosaic") {
      const select = document.getElementById("metadata-target-mosaic-select");
      select.innerHTML = `<option value="">-- 読み込み中... --</option>`;
      try {
        const ids = await fetchOwnedMosaicIds();
        select.innerHTML = ids.length
          ? ids.map(id => `<option value="${id}">${id}</option>`).join("")
          : `<option value="">-- 作成したモザイクがありません --</option>`;
      } catch {
        select.innerHTML = `<option value="">-- 取得に失敗しました --</option>`;
      }
    }
  }

  metadataTargetType?.addEventListener("change", refreshMetadataTargetRows);

  document.getElementById("submit-metadata-btn")?.addEventListener("click", async () => {
    const type = metadataTargetType.value;
    const key = document.getElementById("metadata-key-input").value.trim();
    const value = document.getElementById("metadata-value-input").value;

    if (!key) {
      setStatus("metadata-status", "メタデータキーを入力してください。", "error");
      return;
    }

    let targetId = null;
    if (type === "namespace") {
      targetId = document.getElementById("metadata-target-namespace-select").value;
      if (!targetId) {
        setStatus("metadata-status", "対象のネームスペースを選択してください。", "error");
        return;
      }
    } else if (type === "mosaic") {
      targetId = document.getElementById("metadata-target-mosaic-select").value;
      if (!targetId) {
        setStatus("metadata-status", "対象のモザイクを選択してください。", "error");
        return;
      }
    }

    setStatus("metadata-status", "登録・更新中...");
    try {
      const hash = await setMetadata(type, targetId, key, value);
      setStatus("metadata-status", "", "default");
      trackOutgoingTransaction({
        hash,
        label: "メタデータ登録の追跡",
        recipient: key,
        targetLabel: "キー",
        mosaicLabel: `対象: ${type === "namespace" ? "ネームスペース" : type === "mosaic" ? "モザイク" : "アドレス"}`,
        containerId: "metadata-tracking",
      });
      await loadOwnMetadataList();
    } catch (e) {
      console.error("setMetadata error:", e);
      setStatus("metadata-status", e.message || "登録・更新に失敗しました。", "error");
    }
  });

  // ============================
  // マルチシグ
  // ============================
  document.getElementById("menu-multisig")?.addEventListener("click", () => {
    showPage(multisigPage);
    activateMultisigTab("send");
  });

  async function loadMultisigSendTab() {
    const select = document.getElementById("multisig-send-from-select");
    select.innerHTML = `<option value="">-- 読み込み中... --</option>`;
    try {
      const addresses = await fetchCosignatoryOfAddresses();
      select.innerHTML = addresses.length
        ? addresses.map(a => `<option value="${a}">${a}</option>`).join("")
        : `<option value="">-- 連署者になっているマルチシグアカウントがありません --</option>`;
    } catch (e) {
      console.error("fetchCosignatoryOfAddresses error:", e);
      select.innerHTML = `<option value="">-- 取得に失敗しました --</option>`;
    }
  }

  function activateMultisigTab(tab) {
    document.querySelectorAll("#multisig-page .tab-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.multisigTab === tab);
    });
    document.querySelectorAll("#multisig-page .tab-panel").forEach(panel => {
      panel.style.display = panel.dataset.multisigPanel === tab ? "" : "none";
    });

    if (tab === "send") loadMultisigSendTab();
    else if (tab === "sign") loadPendingPartialTransactions();
    else if (tab === "settings") loadMultisigInfo();
  }

  document.querySelectorAll("#multisig-page .tab-btn").forEach(btn => {
    btn.addEventListener("click", () => activateMultisigTab(btn.dataset.multisigTab));
  });

  document.getElementById("submit-multisig-settings-btn")?.addEventListener("click", async () => {
    const additionAddresses = document
      .getElementById("multisig-add-addresses").value
      .split("\n").map(s => s.trim()).filter(Boolean);
    const deletionAddresses = document
      .getElementById("multisig-remove-addresses").value
      .split("\n").map(s => s.trim()).filter(Boolean);
    const minApprovalDelta = parseInt(document.getElementById("multisig-min-approval-delta").value, 10) || 0;
    const minRemovalDelta = parseInt(document.getElementById("multisig-min-removal-delta").value, 10) || 0;

    if (additionAddresses.length === 0 && deletionAddresses.length === 0 && minApprovalDelta === 0 && minRemovalDelta === 0) {
      setStatus("multisig-settings-status", "変更内容を入力してください。", "error");
      return;
    }

    setStatus("multisig-settings-status", "提案中...（ハッシュロックの承認待ちを含むため数十秒かかります）");
    try {
      const hash = await updateMultisigSettings({
        minApprovalDelta,
        minRemovalDelta,
        additionAddresses,
        deletionAddresses,
      });
      setStatus(
        "multisig-settings-status",
        "追加した連署者は、それぞれ「署名」タブから承認してください。",
        "success"
      );
      trackOutgoingTransaction({
        hash,
        label: "マルチシグ設定の追跡",
        recipient: `追加${additionAddresses.length}件 / 削除${deletionAddresses.length}件`,
        targetLabel: "変更内容",
        containerId: "multisig-settings-tracking",
      });
      document.getElementById("multisig-add-addresses").value = "";
      document.getElementById("multisig-remove-addresses").value = "";
    } catch (e) {
      console.error("updateMultisigSettings error:", e);
      setStatus("multisig-settings-status", e.message || "提案に失敗しました。", "error");
    }
  });

  document.getElementById("submit-multisig-send-btn")?.addEventListener("click", async () => {
    const multisigAddress = document.getElementById("multisig-send-from-select").value;
    const recipientAddress = document.getElementById("multisig-send-recipient").value.trim();
    const amountXym = parseFloat(document.getElementById("multisig-send-amount").value) || 0;
    const message = document.getElementById("multisig-send-message").value;

    if (!multisigAddress) {
      setStatus("multisig-send-status", "送金元マルチシグアカウントを選択してください。", "error");
      return;
    }
    if (!recipientAddress) {
      setStatus("multisig-send-status", "宛先アドレスを入力してください。", "error");
      return;
    }

    setStatus("multisig-send-status", "提案中...（ハッシュロックの承認待ちを含むため数十秒かかります）");
    try {
      const hash = await sendFromMultisig({ multisigAddress, recipientAddress, amountXym, message });
      setStatus(
        "multisig-send-status",
        `✅ 送金を提案しました。Hash: ${hash}\n必要な承認数に応じて、他の連署者が「署名」タブから承認する必要があります。`,
        "success"
      );
    } catch (e) {
      console.error("sendFromMultisig error:", e);
      setStatus("multisig-send-status", e.message || "提案に失敗しました。", "error");
    }
  });

  document.getElementById("multisig-pending-list")?.addEventListener("click", async e => {
    const btn = e.target.closest('[data-action="cosign"]');
    if (!btn) return;

    const hash = btn.dataset.hash;
    btn.disabled = true;
    btn.textContent = "署名中...";
    try {
      await cosignPending(hash);
      alert("✅ 連署を送信しました。");
      await loadPendingPartialTransactions();
    } catch (e) {
      console.error("cosignPending error:", e);
      alert(e.message || "連署に失敗しました。");
      btn.disabled = false;
      btn.textContent = "署名する";
    }
  });

  // ============================
  // 複数送信
  // ============================
  function renderMultisendRow(data = { address: "", mosaic: "", amount: "", message: "" }) {
    const container = document.getElementById("multisend-rows");
    const row = document.createElement("div");
    row.className = "multisend-row";
    row.innerHTML = `
      <input class="input-box ms-address" placeholder="送金先アドレス" value="${data.address}">
      <input class="input-box ms-mosaic" placeholder="mosaic (例: symbol.xym)" value="${data.mosaic}">
      <input class="input-box ms-amount" type="number" min="0" step="any" placeholder="数量" value="${data.amount}">
      <input class="input-box ms-message" placeholder="メッセージ" value="${data.message}">
      <button class="account-hide-btn" data-action="remove-row">削除</button>
      <div class="ms-row-badge"></div>
    `;
    container.appendChild(row);

    // アドレスを編集したら、そのバッジは古い結果なのでクリアしておく
    row.querySelector(".ms-address")?.addEventListener("input", () => {
      const badge = row.querySelector(".ms-row-badge");
      if (badge) badge.innerHTML = "";
    });
  }

  function clearMultisendRows() {
    document.getElementById("multisend-rows").innerHTML = "";
  }

  function readMultisendRows() {
    return Array.from(document.querySelectorAll(".multisend-row")).map(row => ({
      address: row.querySelector(".ms-address").value,
      mosaic: row.querySelector(".ms-mosaic").value,
      amount: row.querySelector(".ms-amount").value,
      message: row.querySelector(".ms-message").value,
    }));
  }

  document.getElementById("menu-multisend")?.addEventListener("click", () => {
    clearMultisendRows();
    renderMultisendRow();
    setStatus("multisend-status", "", "default");
    setStatus("multisend-csv-status", "", "default");
    showPage(multisendListPage);
  });

  document.getElementById("multisend-csv-btn")?.addEventListener("click", () => {
    const fileInput = document.getElementById("multisend-csv-file");
    if (fileInput) {
      fileInput.value = "";
      fileInput.click();
    }
  });

  document.getElementById("multisend-csv-file")?.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const rows = parseCsv(text);

      if (rows.length === 0) {
        setStatus("multisend-csv-status", "CSVから送金先を読み取れませんでした。", "error");
        return;
      }

      clearMultisendRows();
      rows.forEach(r => renderMultisendRow(r));
      setStatus("multisend-csv-status", `CSVから${rows.length}件読み込みました。内容を確認してください。`, "success");
    } catch (err) {
      console.error("CSV parse error:", err);
      setStatus("multisend-csv-status", "CSVの読み込みに失敗しました。", "error");
    }
  });

  document.getElementById("multisend-add-row-btn")?.addEventListener("click", () => {
    if (document.querySelectorAll(".multisend-row").length >= 100) {
      alert("登録できる送金先は最大100件です。");
      return;
    }
    renderMultisendRow();
  });

  document.getElementById("multisend-rows")?.addEventListener("click", e => {
    const btn = e.target.closest('[data-action="remove-row"]');
    if (!btn) return;
    btn.closest(".multisend-row")?.remove();
  });

  document.getElementById("multisend-check-btn")?.addEventListener("click", async () => {
    const rows = readMultisendRows();
    if (rows.length === 0) {
      setStatus("multisend-status", "送金先を1件以上入力してください。", "error");
      return;
    }
    setStatus("multisend-status", "宛先を確認しています…");
    const summary = await checkMultisendRows();
    setStatus(
      "multisend-status",
      `確認完了: 正常 ${summary.okCount}件 ／ 未使用アドレス ${summary.newCount}件 ／ 要確認 ${summary.warnCount}件`,
      summary.newCount + summary.warnCount > 0 ? "error" : "success"
    );
  });

  document.getElementById("multisend-submit-btn")?.addEventListener("click", async () => {
    const rows = readMultisendRows();

    if (rows.length === 0) {
      setStatus("multisend-status", "送金先を1件以上入力してください。", "error");
      return;
    }

    setStatus("multisend-status", "送信前に宛先を確認しています…");
    const summary = await checkMultisendRows();

    let confirmMessage = `${rows.length}件の送金を1つのトランザクションとして送信します。よろしいですか？`;
    if (summary.newCount + summary.warnCount > 0) {
      confirmMessage =
        `⚠️ ${summary.newCount}件の未使用アドレス、${summary.warnCount}件の要確認の宛先が含まれています。\n` +
        `各行の確認結果をよくご確認のうえ、それでも送信しますか？`;
    }

    if (!confirm(confirmMessage)) {
      setStatus("multisend-status", "送信をキャンセルしました。", "default");
      return;
    }

    setStatus("multisend-status", "送信中...");
    try {
      const hash = await sendMultiTransfer(rows);
      setStatus("multisend-status", "", "default");

      trackOutgoingTransaction({
        hash,
        label: "複数送信の追跡",
        recipient: `${rows.length}件`,
        targetLabel: "送金先件数",
        containerId: "multisend-tracking",
      });
    } catch (e) {
      console.error("sendMultiTransfer error:", e);
      setStatus("multisend-status", e.message || "送信に失敗しました。", "error");
    }
  });

  // ============================
  // アポスティーユ
  // ============================
  document.getElementById("menu-apostille")?.addEventListener("click", () => {
    showPage(apostillePage);
    activateApostilleTab("create");
  });

  function resetApostilleCreateTab() {
    document.getElementById("apostille-create-file").value = "";
    document.getElementById("apostille-create-hash").textContent = "";
    document.getElementById("apostille-owner-address").value = "";
    document.getElementById("apostille-metadata-key").value = "";
    document.getElementById("apostille-metadata-value").value = "";
    setStatus("apostille-create-status", "", "default");
  }

  function resetApostilleVerifyTab() {
    document.getElementById("apostille-verify-file").value = "";
    document.getElementById("apostille-verify-hash").textContent = "";
    document.getElementById("apostille-verify-result").innerHTML = "";
    setStatus("apostille-verify-status", "", "default");
  }

  function resetApostilleHistoryTab() {
    document.getElementById("apostille-history-file").value = "";
    document.getElementById("apostille-history-hash").textContent = "";
    document.getElementById("apostille-history-list").innerHTML = "";
    setStatus("apostille-history-status", "", "default");
  }

  function activateApostilleTab(tab) {
    document.querySelectorAll("#apostille-page .tab-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.apostilleTab === tab);
    });
    document.querySelectorAll("#apostille-page .tab-panel").forEach(panel => {
      panel.style.display = panel.dataset.apostillePanel === tab ? "" : "none";
    });

    if (tab === "create") resetApostilleCreateTab();
    else if (tab === "verify") resetApostilleVerifyTab();
    else if (tab === "history") resetApostilleHistoryTab();
  }

  document.querySelectorAll("#apostille-page .tab-btn").forEach(btn => {
    btn.addEventListener("click", () => activateApostilleTab(btn.dataset.apostilleTab));
  });

  let apostilleCreateHash = null;
  document.getElementById("apostille-create-file")?.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    document.getElementById("apostille-create-hash").textContent = "ハッシュ計算中...";
    apostilleCreateHash = await computeFileHash(file);
    document.getElementById("apostille-create-hash").textContent = `SHA-256: ${apostilleCreateHash}`;
  });

  document.getElementById("apostille-create-btn")?.addEventListener("click", async () => {
    const file = document.getElementById("apostille-create-file").files?.[0];
    if (!file || !apostilleCreateHash) {
      setStatus("apostille-create-status", "ファイルを選択してください。", "error");
      return;
    }

    const ownerAddress = document.getElementById("apostille-owner-address").value.trim();
    const metadataKey = document.getElementById("apostille-metadata-key").value.trim();
    const metadataValue = document.getElementById("apostille-metadata-value").value.trim();

    setStatus("apostille-create-status", "作成中...");
    try {
      const hash = await createApostille({
        file,
        fileHashHex: apostilleCreateHash,
        ownerAddress,
        metadataKey,
        metadataValue,
      });
      setStatus("apostille-create-status", "", "default");
      trackOutgoingTransaction({
        hash,
        label: "アポスティーユ作成の追跡",
        recipient: file.name,
        targetLabel: "ファイル",
        containerId: "apostille-tracking",
      });
    } catch (e) {
      console.error("createApostille error:", e);
      setStatus("apostille-create-status", e.message || "作成に失敗しました。", "error");
    }
  });

  let apostilleVerifyHash = null;
  document.getElementById("apostille-verify-file")?.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    document.getElementById("apostille-verify-hash").textContent = "ハッシュ計算中...";
    apostilleVerifyHash = await computeFileHash(file);
    document.getElementById("apostille-verify-hash").textContent = `SHA-256: ${apostilleVerifyHash}`;
  });

  document.getElementById("apostille-verify-btn")?.addEventListener("click", async () => {
    if (!apostilleVerifyHash) {
      setStatus("apostille-verify-status", "ファイルを選択してください。", "error");
      return;
    }

    const address = document.getElementById("apostille-verify-address").value.trim();
    const resultEl = document.getElementById("apostille-verify-result");
    resultEl.innerHTML = "";

    setStatus("apostille-verify-status", "検索中...");
    try {
      const matches = await searchApostilleTransactions(apostilleVerifyHash, address);
      if (matches.length === 0) {
        setStatus("apostille-verify-status", "❌ 一致する証明が見つかりませんでした（直近の取引のみ検索対象です）。", "error");
        return;
      }

      setStatus("apostille-verify-status", `✅ ${matches.length}件の証明が見つかりました。`, "success");
      resultEl.innerHTML = matches
        .map(m => `
          <div class="harvest-history-item">
            <div>Hash: ${m.hash}</div>
            <div>高さ: ${m.height}</div>
            <div>ファイル名: ${m.cert.fileName || "---"}</div>
            <div>所有者: ${m.cert.owner}</div>
            <div>記録日時(証明書内): ${m.cert.timestamp}</div>
          </div>
        `)
        .join("");
    } catch (e) {
      console.error("searchApostilleTransactions error:", e);
      setStatus("apostille-verify-status", "検索に失敗しました。", "error");
    }
  });

  let apostilleHistoryHash = null;
  document.getElementById("apostille-history-file")?.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    document.getElementById("apostille-history-hash").textContent = "ハッシュ計算中...";
    apostilleHistoryHash = await computeFileHash(file);
    document.getElementById("apostille-history-hash").textContent = `SHA-256: ${apostilleHistoryHash}`;
  });

  document.getElementById("apostille-history-btn")?.addEventListener("click", async () => {
    if (!apostilleHistoryHash) {
      setStatus("apostille-history-status", "ファイルを選択してください。", "error");
      return;
    }

    const address = document.getElementById("apostille-history-address").value.trim();
    const listEl = document.getElementById("apostille-history-list");
    listEl.innerHTML = "";

    setStatus("apostille-history-status", "検索中...");
    try {
      const matches = await searchApostilleTransactions(apostilleHistoryHash, address);
      if (matches.length === 0) {
        setStatus("apostille-history-status", "この証明の履歴は見つかりませんでした（直近の取引のみ検索対象です）。", "error");
        return;
      }

      setStatus("apostille-history-status", `${matches.length}件の履歴が見つかりました（古い順）。`, "success");
      listEl.innerHTML = matches
        .map((m, i) => `
          <div class="harvest-history-item">
            <div>#${i + 1}</div>
            <div>Hash: ${m.hash}</div>
            <div>高さ: ${m.height}</div>
            <div>所有者: ${m.cert.owner}</div>
            <div>記録日時(証明書内): ${m.cert.timestamp}</div>
          </div>
        `)
        .join("");
    } catch (e) {
      console.error("searchApostilleTransactions error(history):", e);
      setStatus("apostille-history-status", "検索に失敗しました。", "error");
    }
  });

  // ============================
  // 制限機能
  // ============================
  function populateOperationSelects() {
    const addSelect = document.getElementById("restriction-operation-add");
    const removeSelect = document.getElementById("restriction-operation-remove");
    const optionsHtml = OPERATION_TYPE_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join("");
    addSelect.innerHTML = optionsHtml;
    removeSelect.innerHTML = optionsHtml;
  }

  function readSelectedOptions(selectId) {
    return Array.from(document.getElementById(selectId).selectedOptions).map(o => o.value);
  }

  document.getElementById("menu-restriction")?.addEventListener("click", () => {
    showPage(restrictionMenuPage);
  });

  function populateMosaicRestrictionTypeSelects() {
    const optionsHtml = MOSAIC_RESTRICTION_TYPE_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join("");
    const prevSelect = document.getElementById("mglobal-previous-type");
    const newSelect = document.getElementById("mglobal-new-type");
    prevSelect.innerHTML = optionsHtml;
    newSelect.innerHTML = optionsHtml;
    prevSelect.value = "NONE";
    newSelect.value = "EQ";
  }

  async function activateRestrictionAccountTab(tab) {
    document.querySelectorAll("#restriction-account-page .tab-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.restrictionAccountTab === tab);
    });
    document.querySelectorAll("#restriction-account-page .tab-panel").forEach(panel => {
      panel.style.display = panel.dataset.restrictionAccountPanel === tab ? "" : "none";
    });

    if (tab === "address") {
      await loadAccountRestrictions("restriction-current-address", "address");
    } else if (tab === "mosaic") {
      await loadAccountRestrictions("restriction-current-mosaic", "mosaic");
    } else if (tab === "operation") {
      populateOperationSelects();
      await loadAccountRestrictions("restriction-current-operation", "operation");
    }
  }

  document.getElementById("menu-restriction-account")?.addEventListener("click", () => {
    showPage(restrictionAccountPage);
    activateRestrictionAccountTab("address");
  });

  document.querySelectorAll("#restriction-account-page .tab-btn").forEach(btn => {
    btn.addEventListener("click", () => activateRestrictionAccountTab(btn.dataset.restrictionAccountTab));
  });

  function activateRestrictionMosaicdefTab(tab) {
    document.querySelectorAll("#restriction-mosaicdef-page .tab-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.restrictionMosaicdefTab === tab);
    });
    document.querySelectorAll("#restriction-mosaicdef-page .tab-panel").forEach(panel => {
      panel.style.display = panel.dataset.restrictionMosaicdefPanel === tab ? "" : "none";
    });

    if (tab === "global") {
      populateMosaicRestrictionTypeSelects();
      setStatus("mglobal-status", "", "default");
    } else if (tab === "address") {
      setStatus("maddress-status", "", "default");
    }
  }

  document.getElementById("menu-restriction-mosaic-top")?.addEventListener("click", () => {
    showPage(restrictionMosaicdefPage);
    activateRestrictionMosaicdefTab("global");
  });

  document.querySelectorAll("#restriction-mosaicdef-page .tab-btn").forEach(btn => {
    btn.addEventListener("click", () => activateRestrictionMosaicdefTab(btn.dataset.restrictionMosaicdefTab));
  });

  document.getElementById("mglobal-submit")?.addEventListener("click", async () => {
    const mosaicIdHex = document.getElementById("mglobal-mosaic-id").value.trim();
    const referenceMosaicIdHex = document.getElementById("mglobal-reference-mosaic-id").value.trim();
    const keyString = document.getElementById("mglobal-key").value.trim();
    const previousValue = document.getElementById("mglobal-previous-value").value || "0";
    const newValue = document.getElementById("mglobal-new-value").value || "0";
    const previousType = document.getElementById("mglobal-previous-type").value;
    const newType = document.getElementById("mglobal-new-type").value;

    if (!mosaicIdHex || !keyString) {
      setStatus("mglobal-status", "モザイクIDと制限キーを入力してください。", "error");
      return;
    }

    setStatus("mglobal-status", "設定中...");
    try {
      const hash = await setMosaicGlobalRestriction({
        mosaicIdHex,
        referenceMosaicIdHex,
        keyString,
        previousValue,
        newValue,
        previousType,
        newType,
      });
      setStatus("mglobal-status", `✅ 設定しました。Hash: ${hash}`, "success");
    } catch (e) {
      console.error("setMosaicGlobalRestriction error:", e);
      setStatus("mglobal-status", e.message || "設定に失敗しました。", "error");
    }
  });

  document.getElementById("maddress-submit")?.addEventListener("click", async () => {
    const mosaicIdHex = document.getElementById("maddress-mosaic-id").value.trim();
    const keyString = document.getElementById("maddress-key").value.trim();
    const targetAddress = document.getElementById("maddress-target").value.trim();
    const previousValueRaw = document.getElementById("maddress-previous-value").value.trim();
    const newValue = document.getElementById("maddress-new-value").value || "0";
    const previousValue = previousValueRaw || "0xFFFFFFFFFFFFFFFF";

    if (!mosaicIdHex || !keyString || !targetAddress) {
      setStatus("maddress-status", "モザイクID・制限キー・対象アドレスを入力してください。", "error");
      return;
    }

    setStatus("maddress-status", "設定中...");
    try {
      const hash = await setMosaicAddressRestriction({
        mosaicIdHex,
        keyString,
        previousValue,
        newValue,
        targetAddress,
      });
      setStatus("maddress-status", `✅ 設定しました。Hash: ${hash}`, "success");
    } catch (e) {
      console.error("setMosaicAddressRestriction error:", e);
      setStatus("maddress-status", e.message || "設定に失敗しました。", "error");
    }
  });

  document.getElementById("restriction-address-submit")?.addEventListener("click", async () => {
    const block = document.getElementById("restriction-address-block").checked;
    const outgoing = document.getElementById("restriction-address-outgoing").checked;
    const additions = document.getElementById("restriction-address-add").value.split("\n").map(s => s.trim()).filter(Boolean);
    const deletions = document.getElementById("restriction-address-remove").value.split("\n").map(s => s.trim()).filter(Boolean);

    if (additions.length === 0 && deletions.length === 0) {
      setStatus("restriction-address-status", "追加または削除するアドレスを入力してください。", "error");
      return;
    }

    setStatus("restriction-address-status", "設定中...");
    try {
      const hash = await setAddressRestriction({ block, outgoing, additions, deletions });
      setStatus("restriction-address-status", `✅ 設定しました。Hash: ${hash}`, "success");
      document.getElementById("restriction-address-add").value = "";
      document.getElementById("restriction-address-remove").value = "";
      await loadAccountRestrictions("restriction-current-address", "address");
    } catch (e) {
      console.error("setAddressRestriction error:", e);
      setStatus("restriction-address-status", e.message || "設定に失敗しました。", "error");
    }
  });

  document.getElementById("restriction-mosaic-submit")?.addEventListener("click", async () => {
    const block = document.getElementById("restriction-mosaic-block").checked;
    const outgoing = document.getElementById("restriction-mosaic-outgoing").checked;
    const additions = document.getElementById("restriction-mosaic-add").value.split("\n").map(s => s.trim()).filter(Boolean);
    const deletions = document.getElementById("restriction-mosaic-remove").value.split("\n").map(s => s.trim()).filter(Boolean);

    if (additions.length === 0 && deletions.length === 0) {
      setStatus("restriction-mosaic-status", "追加または削除するモザイクIDを入力してください。", "error");
      return;
    }

    setStatus("restriction-mosaic-status", "設定中...");
    try {
      const hash = await setMosaicRestriction({ block, outgoing, additions, deletions });
      setStatus("restriction-mosaic-status", `✅ 設定しました。Hash: ${hash}`, "success");
      document.getElementById("restriction-mosaic-add").value = "";
      document.getElementById("restriction-mosaic-remove").value = "";
      await loadAccountRestrictions("restriction-current-mosaic", "mosaic");
    } catch (e) {
      console.error("setMosaicRestriction error:", e);
      setStatus("restriction-mosaic-status", e.message || "設定に失敗しました。", "error");
    }
  });

  document.getElementById("restriction-operation-submit")?.addEventListener("click", async () => {
    const block = document.getElementById("restriction-operation-block").checked;
    const additions = readSelectedOptions("restriction-operation-add");
    const deletions = readSelectedOptions("restriction-operation-remove");

    if (additions.length === 0 && deletions.length === 0) {
      setStatus("restriction-operation-status", "追加または削除する種類を選択してください。", "error");
      return;
    }

    setStatus("restriction-operation-status", "設定中...");
    try {
      const hash = await setOperationRestriction({ block, outgoing: true, additions, deletions });
      setStatus("restriction-operation-status", `✅ 設定しました。Hash: ${hash}`, "success");
      await loadAccountRestrictions("restriction-current-operation", "operation");
    } catch (e) {
      console.error("setOperationRestriction error:", e);
      setStatus("restriction-operation-status", e.message || "設定に失敗しました。", "error");
    }
  });

  // ============================
  // オフライントランザクション(作成・署名 / ログイン中のみ)
  // ============================
  let offlineTxGenerated = null;

  document.getElementById("menu-offline-tx")?.addEventListener("click", () => {
    offlineTxGenerated = null;
    document.getElementById("offline-tx-recipient").value = "";
    document.getElementById("offline-tx-mosaic").value = "";
    document.getElementById("offline-tx-amount").value = "0";
    document.getElementById("offline-tx-message").value = "";
    document.getElementById("offline-tx-result").style.display = "none";
    setStatus("offline-tx-status", "", "default");
    showPage(offlineTxCreatePage);
  });

  document.getElementById("offline-tx-sign-btn")?.addEventListener("click", async () => {
    const recipientAddress = document.getElementById("offline-tx-recipient").value.trim();
    const mosaicInput = document.getElementById("offline-tx-mosaic").value.trim();
    const amount = Number(document.getElementById("offline-tx-amount").value);
    const message = document.getElementById("offline-tx-message").value;

    if (!recipientAddress) {
      setStatus("offline-tx-status", "宛先アドレスを入力してください。", "error");
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      setStatus("offline-tx-status", "数量が不正です。", "error");
      return;
    }

    const mosaicIdHex = mosaicInput || getXymMosaicIdHex();

    setStatus("offline-tx-status", "署名中...");
    try {
      offlineTxGenerated = await composeAndSignOfflineTransfer({
        recipientAddress,
        mosaicIdHex,
        amount,
        message,
      });
      document.getElementById("offline-tx-hash").textContent = offlineTxGenerated.hash;
      document.getElementById("offline-tx-result").style.display = "block";
      setStatus("offline-tx-status", "✅ 署名しました。ノードへはまだ送信されていません。ファイルをダウンロードしてください。", "success");
    } catch (e) {
      console.error("composeAndSignOfflineTransfer error:", e);
      setStatus("offline-tx-status", e.message || "署名に失敗しました。", "error");
    }
  });

  document.getElementById("offline-tx-download-btn")?.addEventListener("click", () => {
    if (!offlineTxGenerated) return;
    downloadOfflineTxJson(offlineTxGenerated, `offline-tx-${offlineTxGenerated.hash.slice(0, 8)}.json`);
  });

  // ============================
  // オフライン署名データの読み込み・ブロードキャスト(ログイン不要)
  // ============================
  let offlineBroadcastJson = null;

  function openOfflineBroadcastPage() {
    offlineBroadcastJson = null;
    document.getElementById("offline-broadcast-file").value = "";
    document.getElementById("offline-broadcast-preview").style.display = "none";
    setStatus("offline-broadcast-status", "", "default");
    showPage(offlineBroadcastPage);
  }

  document.getElementById("welcome-offline-broadcast-btn")?.addEventListener("click", openOfflineBroadcastPage);
  document.getElementById("unlock-offline-broadcast-btn")?.addEventListener("click", openOfflineBroadcastPage);

  document.getElementById("offline-broadcast-file")?.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    const nodeInput = document.getElementById("offline-broadcast-node");

    try {
      const text = await file.text();
      const json = JSON.parse(text);
      offlineBroadcastJson = validateOfflineTxJson(json);

      document.getElementById("offline-broadcast-network").textContent = json.network ?? "---";
      document.getElementById("offline-broadcast-type").textContent = json.transactionType ?? "---";
      document.getElementById("offline-broadcast-hash").textContent = json.hash ?? "---";
      document.getElementById("offline-broadcast-signer").textContent = json.signerPublicKey ?? "---";
      document.getElementById("offline-broadcast-preview").style.display = "block";
      setStatus("offline-broadcast-status", "ノードを自動選択中...", "default");

      const isTestnet = json.network === "TEST_NET";
      const submitBtn = document.getElementById("offline-broadcast-submit");
      if (submitBtn) submitBtn.disabled = false;

      try {
        nodeInput.value = await selectNode(isTestnet);
        setStatus("offline-broadcast-status", "既に送信済みでないか確認中...", "default");

        const existingStatus = await checkAlreadyBroadcastStatus(json.hash, nodeInput.value);
        if (existingStatus === "confirmed" || existingStatus === "unconfirmed") {
          alert("署名済みです。このトランザクションは既にブロックチェーンへ送信・承認済みのため読み込めません。");
          setStatus(
            "offline-broadcast-status",
            `❌ 既に送信済みです（状態: ${existingStatus}）。二重送信になるためブロードキャストできません。`,
            "error"
          );
          if (submitBtn) submitBtn.disabled = true;
        } else {
          setStatus("offline-broadcast-status", "ノードを自動選択しました。必要であれば変更できます。", "success");
        }
      } catch (nodeErr) {
        console.warn("ノード自動選択に失敗しました。手動で入力してください。", nodeErr);
        setStatus("offline-broadcast-status", "ノードの自動選択に失敗しました。手動で入力してください。", "error");
      }
    } catch (err) {
      console.error("offline broadcast file parse error:", err);
      offlineBroadcastJson = null;
      document.getElementById("offline-broadcast-preview").style.display = "none";
      setStatus("offline-broadcast-status", err.message || "ファイルの読み込みに失敗しました。", "error");
    }
  });

  document.getElementById("offline-broadcast-submit")?.addEventListener("click", async () => {
    const nodeUrl = document.getElementById("offline-broadcast-node").value.trim();

    if (!offlineBroadcastJson) {
      setStatus("offline-broadcast-status", "ファイルを選択してください。", "error");
      return;
    }
    if (!nodeUrl) {
      setStatus("offline-broadcast-status", "ノードURLを入力してください。", "error");
      return;
    }

    setStatus("offline-broadcast-status", "既に送信済みでないか再確認中...");
    try {
      const existingStatus = await checkAlreadyBroadcastStatus(offlineBroadcastJson.hash, nodeUrl);
      if (existingStatus === "confirmed" || existingStatus === "unconfirmed") {
        alert("署名済みです。このトランザクションは既にブロックチェーンへ送信・承認済みのため読み込めません。");
        setStatus(
          "offline-broadcast-status",
          `❌ 既に送信済みです（状態: ${existingStatus}）。二重送信になるためブロードキャストできません。`,
          "error"
        );
        return;
      }
    } catch (e) {
      console.warn("事前確認に失敗しました。続行します。", e);
    }

    setStatus("offline-broadcast-status", "アナウンス中...");
    try {
      await broadcastOfflineTx(offlineBroadcastJson, nodeUrl);
      setStatus("offline-broadcast-status", `✅ ノードへ送信しました。Hash: ${offlineBroadcastJson.hash}`, "success");
    } catch (e) {
      console.error("broadcastOfflineTx error:", e);
      setStatus("offline-broadcast-status", e.message || "アナウンスに失敗しました。", "error");
    }
  });


  async function updateRootNamespaceFeeEstimate() {
    const el = document.getElementById("root-namespace-fee-estimate");
    const rentalEl = document.getElementById("root-namespace-rental-fee-estimate");
    if (!el) return;
    const name = document.getElementById("root-namespace-name").value.trim();
    const duration = parseInt(document.getElementById("root-namespace-duration").value, 10);
    if (!name || !Number.isInteger(duration) || duration <= 0) {
      el.textContent = "---";
      if (rentalEl) rentalEl.textContent = "---";
      return;
    }
    try {
      el.textContent = `約 ${estimateRootNamespaceFee(name, duration)} XYM`;
    } catch {
      el.textContent = "---";
    }
    if (rentalEl) {
      try {
        rentalEl.textContent = `約 ${await estimateRootNamespaceRentalFee(duration)} XYM`;
      } catch {
        rentalEl.textContent = "---";
      }
    }
  }

  document.getElementById("root-namespace-name")?.addEventListener("input", updateRootNamespaceFeeEstimate);
  document.getElementById("root-namespace-duration")?.addEventListener("input", updateRootNamespaceFeeEstimate);

  document.getElementById("root-namespace-calc-btn")?.addEventListener("click", () => {
    const panel = document.getElementById("root-namespace-duration-presets");
    panel.style.display = panel.style.display === "none" ? "flex" : "none";
  });

  document.getElementById("root-namespace-duration-presets")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-days]");
    if (!btn) return;
    const days = parseInt(btn.dataset.days, 10);
    document.getElementById("root-namespace-duration").value = days * 2880;
    document.getElementById("root-namespace-duration-presets").style.display = "none";
    updateRootNamespaceFeeEstimate();
  });

  document.getElementById("register-root-namespace-btn")?.addEventListener("click", async () => {
    const name = document.getElementById("root-namespace-name").value.trim();
    const duration = parseInt(document.getElementById("root-namespace-duration").value, 10);

    if (!name) {
      setStatus("root-namespace-status", "ネームスペース名を入力してください。", "error");
      return;
    }
    if (!Number.isInteger(duration) || duration <= 0) {
      setStatus("root-namespace-status", "有効期間(ブロック数)を正しく入力してください。", "error");
      return;
    }

    setStatus("root-namespace-status", "登録中...");
    try {
      const hash = await registerRootNamespace(name, duration);
      setStatus("root-namespace-status", "", "default");
      trackOutgoingTransaction({
        hash,
        label: "ネームスペース登録の追跡（ルート）",
        recipient: name,
        targetLabel: "ネームスペース名",
        containerId: "namespace-tracking",
      });
      document.getElementById("root-namespace-name").value = "";
      document.getElementById("root-namespace-duration").value = "";
      updateRootNamespaceFeeEstimate();
      await loadOwnedNamespaces();
      await populateParentNamespaceSelect();
    } catch (e) {
      console.error("registerRootNamespace error:", e);
      setStatus("root-namespace-status", e.message || "登録に失敗しました。", "error");
    }
  });

  async function updateSubNamespaceFeeEstimate() {
    const el = document.getElementById("sub-namespace-fee-estimate");
    const rentalEl = document.getElementById("sub-namespace-rental-fee-estimate");
    if (!el) return;
    const parentId = document.getElementById("sub-namespace-parent-select").value;
    const subName = document.getElementById("sub-namespace-name").value.trim();
    if (!parentId || !subName) {
      el.textContent = "---";
      if (rentalEl) rentalEl.textContent = "---";
      return;
    }
    try {
      el.textContent = `約 ${estimateSubNamespaceFee(parentId, subName)} XYM`;
    } catch {
      el.textContent = "---";
    }
    if (rentalEl) {
      try {
        rentalEl.textContent = `約 ${await estimateSubNamespaceRentalFee()} XYM`;
      } catch {
        rentalEl.textContent = "---";
      }
    }
  }

  document.getElementById("sub-namespace-parent-select")?.addEventListener("change", updateSubNamespaceFeeEstimate);
  document.getElementById("sub-namespace-name")?.addEventListener("input", updateSubNamespaceFeeEstimate);

  document.getElementById("register-sub-namespace-btn")?.addEventListener("click", async () => {
    const parentId = document.getElementById("sub-namespace-parent-select").value;
    const subName = document.getElementById("sub-namespace-name").value.trim();

    if (!parentId) {
      setStatus("sub-namespace-status", "親ネームスペースを選択してください。", "error");
      return;
    }
    if (!subName) {
      setStatus("sub-namespace-status", "サブネームスペース名を入力してください。", "error");
      return;
    }

    setStatus("sub-namespace-status", "登録中...");
    try {
      const hash = await registerSubNamespace(parentId, subName);
      setStatus("sub-namespace-status", "", "default");
      trackOutgoingTransaction({
        hash,
        label: "ネームスペース登録の追跡（サブ）",
        recipient: subName,
        targetLabel: "ネームスペース名",
        containerId: "namespace-tracking",
      });
      document.getElementById("sub-namespace-name").value = "";
      updateSubNamespaceFeeEstimate();
      await loadOwnedNamespaces();
      await populateParentNamespaceSelect();
    } catch (e) {
      console.error("registerSubNamespace error:", e);
      setStatus("sub-namespace-status", e.message || "登録に失敗しました。", "error");
    }
  });

  async function populateNamespaceAliasSelects() {
    try {
      const options = await fetchOwnedNamespaceOptions();
      const optionsHtml = options.length
        ? options.map(ns => `<option value="${ns.id}">${ns.name}</option>`).join("")
        : `<option value="">-- 保有ネームスペースがありません --</option>`;
      document.getElementById("ns-link-mosaic-namespace-select").innerHTML = optionsHtml;
      document.getElementById("ns-link-address-namespace-select").innerHTML = optionsHtml;
    } catch (e) {
      console.warn("ネームスペース候補の取得に失敗しました", e);
    }
  }

  async function populateNsLinkMosaicSelect() {
    const select = document.getElementById("ns-link-mosaic-id-select");
    select.innerHTML = `<option value="">-- 読み込み中... --</option>`;
    try {
      const ids = await fetchOwnedMosaicIds();
      select.innerHTML = ids.length
        ? ids.map(id => `<option value="${id}">${id}</option>`).join("")
        : `<option value="">-- 作成したモザイクがありません --</option>`;
    } catch (e) {
      console.warn("モザイク候補の取得に失敗しました", e);
      select.innerHTML = `<option value="">-- 取得に失敗しました --</option>`;
    }
  }

  document.getElementById("ns-link-mosaic-btn")?.addEventListener("click", () => submitMosaicAliasFromNamespacePage("link"));
  document.getElementById("ns-unlink-mosaic-btn")?.addEventListener("click", () => submitMosaicAliasFromNamespacePage("unlink"));

  function updateNsLinkMosaicFeeEstimate() {
    const el = document.getElementById("ns-link-mosaic-fee-estimate");
    if (!el) return;
    const namespaceId = document.getElementById("ns-link-mosaic-namespace-select").value;
    const mosaicId = document.getElementById("ns-link-mosaic-id-select").value;
    if (!namespaceId || !mosaicId) {
      el.textContent = "---";
      return;
    }
    try {
      el.textContent = `約 ${estimateMosaicAliasFee(mosaicId, namespaceId, "link")} XYM`;
    } catch {
      el.textContent = "---";
    }
  }

  document.getElementById("ns-link-mosaic-namespace-select")?.addEventListener("change", updateNsLinkMosaicFeeEstimate);
  document.getElementById("ns-link-mosaic-id-select")?.addEventListener("change", updateNsLinkMosaicFeeEstimate);

  async function submitMosaicAliasFromNamespacePage(action) {
    const namespaceId = document.getElementById("ns-link-mosaic-namespace-select").value;
    const mosaicId = document.getElementById("ns-link-mosaic-id-select").value;

    if (!namespaceId || !mosaicId) {
      setStatus("ns-link-mosaic-status", "ネームスペースとモザイクを指定してください。", "error");
      return;
    }

    setStatus("ns-link-mosaic-status", action === "unlink" ? "解除中..." : "リンク中...");
    try {
      const hash = await setMosaicAlias(mosaicId, namespaceId, action);
      setStatus("ns-link-mosaic-status", `✅ 完了しました。Hash: ${hash}`, "success");
      await loadOwnedNamespaces();
    } catch (e) {
      console.error("setMosaicAlias error:", e);
      setStatus("ns-link-mosaic-status", e.message || "処理に失敗しました。", "error");
    }
  }

  document.getElementById("ns-link-address-btn")?.addEventListener("click", () => submitAddressAliasFromNamespacePage("link"));
  document.getElementById("ns-unlink-address-btn")?.addEventListener("click", () => submitAddressAliasFromNamespacePage("unlink"));

  function updateNsLinkAddressFeeEstimate() {
    const el = document.getElementById("ns-link-address-fee-estimate");
    if (!el) return;
    const namespaceId = document.getElementById("ns-link-address-namespace-select").value;
    const targetAddress = document.getElementById("ns-link-address-target").value.trim();
    if (!namespaceId || !targetAddress) {
      el.textContent = "---";
      return;
    }
    try {
      el.textContent = `約 ${estimateAddressAliasFee(namespaceId, targetAddress, "link")} XYM`;
    } catch {
      el.textContent = "---";
    }
  }

  document.getElementById("ns-link-address-namespace-select")?.addEventListener("change", updateNsLinkAddressFeeEstimate);
  document.getElementById("ns-link-address-target")?.addEventListener("input", updateNsLinkAddressFeeEstimate);

  async function submitAddressAliasFromNamespacePage(action) {
    const namespaceId = document.getElementById("ns-link-address-namespace-select").value;
    const targetAddress = document.getElementById("ns-link-address-target").value.trim();

    if (!namespaceId || !targetAddress) {
      setStatus("ns-link-address-status", "ネームスペースと対象アドレスを指定してください。", "error");
      return;
    }

    setStatus("ns-link-address-status", action === "unlink" ? "解除中..." : "リンク中...");
    try {
      const hash = await setAddressAlias(namespaceId, targetAddress, action);
      setStatus("ns-link-address-status", `✅ 完了しました。Hash: ${hash}`, "success");
      await loadOwnedNamespaces();
    } catch (e) {
      console.error("setAddressAlias error:", e);
      setStatus("ns-link-address-status", e.message || "処理に失敗しました。", "error");
    }
  }

  document.getElementById("owned-mosaic-list")?.addEventListener("click", async e => {
    const linkBtn = e.target.closest('[data-action="link-mosaic"]');
    const unlinkBtn = e.target.closest('[data-action="unlink-mosaic"]');

    if (linkBtn) {
      const mosaicId = linkBtn.dataset.mosaicId;
      const select = document.querySelector(`.mosaic-link-select[data-mosaic-id="${mosaicId}"]`);
      const namespaceId = select?.value;

      if (!namespaceId) {
        alert("ネームスペースを選択してください。");
        return;
      }

      linkBtn.disabled = true;
      linkBtn.textContent = "リンク中...";
      try {
        await setMosaicAlias(mosaicId, namespaceId, "link");
        alert("✅ リンクリクエストを送信しました。");
        await loadOwnedMosaicsWithAlias();
      } catch (e) {
        console.error("setMosaicAlias error:", e);
        alert(e.message || "リンクに失敗しました。");
        linkBtn.disabled = false;
        linkBtn.textContent = "リンクする";
      }
      return;
    }

    if (unlinkBtn) {
      const mosaicId = unlinkBtn.dataset.mosaicId;
      const namespaceId = unlinkBtn.dataset.namespaceId;

      unlinkBtn.disabled = true;
      unlinkBtn.textContent = "解除中...";
      try {
        await setMosaicAlias(mosaicId, namespaceId, "unlink");
        alert("✅ リンク解除リクエストを送信しました。");
        await loadOwnedMosaicsWithAlias();
      } catch (e) {
        console.error("setMosaicAlias(unlink) error:", e);
        alert(e.message || "リンク解除に失敗しました。");
        unlinkBtn.disabled = false;
        unlinkBtn.textContent = "リンク解除";
      }
    }
  });

  function readMosaicFormOptions() {
    const divisibility = parseInt(document.getElementById("mosaic-divisibility").value, 10) || 1;
    const isUnlimited = document.getElementById("mosaic-duration-mode").value === "unlimited";
    const durationBlocks = parseInt(document.getElementById("mosaic-duration").value, 10) || 0;
    const initialSupply = parseFloat(document.getElementById("mosaic-initial-supply").value) || 0;
    const supplyMutable = document.getElementById("mosaic-supply-mutable").checked;
    const transferable = document.getElementById("mosaic-transferable").checked;
    const restrictable = document.getElementById("mosaic-restrictable").checked;
    const revokable = document.getElementById("mosaic-revokable").checked;
    const linkNamespaceIdHex = document.getElementById("mosaic-link-namespace-select").value || null;

    return {
      divisibility,
      isUnlimited,
      durationBlocks,
      supplyMutable,
      transferable,
      restrictable,
      revokable,
      initialSupply,
      linkNamespaceIdHex,
    };
  }

  async function updateMosaicFeeEstimate() {
    const el = document.getElementById("mosaic-fee-estimate");
    const rentalEl = document.getElementById("mosaic-rental-fee-estimate");
    if (!el) return;
    try {
      const { feeXym } = estimateMosaicCreationFee(readMosaicFormOptions());
      el.textContent = `約 ${feeXym} XYM`;
    } catch (e) {
      el.textContent = "---";
    }
    if (rentalEl) {
      try {
        rentalEl.textContent = `約 ${await estimateMosaicRentalFee()} XYM`;
      } catch {
        rentalEl.textContent = "---";
      }
    }
  }

  document.getElementById("mosaic-duration-mode")?.addEventListener("change", e => {
    const row = document.getElementById("mosaic-duration-row");
    row.style.display = e.target.value === "limited" ? "block" : "none";
    updateMosaicFeeEstimate();
  });

  document.getElementById("mosaic-duration-calc-btn")?.addEventListener("click", () => {
    const panel = document.getElementById("mosaic-duration-presets");
    panel.style.display = panel.style.display === "none" ? "flex" : "none";
  });

  document.getElementById("mosaic-duration-presets")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-days]");
    if (!btn) return;
    const days = parseInt(btn.dataset.days, 10);
    document.getElementById("mosaic-duration").value = days * 2880;
    document.getElementById("mosaic-duration-presets").style.display = "none";
    updateMosaicFeeEstimate();
  });

  document.querySelector('#mosaic-page .card')?.addEventListener("input", updateMosaicFeeEstimate);
  document.querySelector('#mosaic-page .card')?.addEventListener("change", updateMosaicFeeEstimate);

  document.getElementById("create-mosaic-btn")?.addEventListener("click", async () => {
    setStatus("mosaic-create-status", "作成中...");
    try {
      const hash = await createMosaic(readMosaicFormOptions());
      setStatus("mosaic-create-status", "", "default");
      trackOutgoingTransaction({
        hash,
        label: "モザイク作成の追跡",
        containerId: "mosaic-tracking",
      });
      await loadOwnedMosaicsWithAlias();
    } catch (e) {
      console.error("createMosaic error:", e);
      setStatus("mosaic-create-status", e.message || "作成に失敗しました。", "error");
    }
  });

  // ============================
  // モザイク供給量変更
  // ============================
  async function populateMosaicSupplyTab() {
    setStatus("mosaic-supply-status", "", "default");
    document.getElementById("mosaic-supply-current").textContent = "---";
    document.getElementById("mosaic-supply-new").textContent = "---";
    document.getElementById("mosaic-supply-amount").value = "0";

    const select = document.getElementById("mosaic-supply-target-select");
    select.innerHTML = `<option value="">-- 読み込み中... --</option>`;
    try {
      const ids = await fetchOwnedMosaicIds();
      select.innerHTML = ids.length
        ? `<option value="">-- モザイクを選択 --</option>` + ids.map(id => `<option value="${id}">${id}</option>`).join("")
        : `<option value="">-- 作成したモザイクがありません --</option>`;
    } catch (e) {
      console.warn("モザイク候補の取得に失敗しました", e);
      select.innerHTML = `<option value="">-- 取得に失敗しました --</option>`;
    }
  }

  let mosaicSupplyDetail = null;

  function updateMosaicSupplyNewValue() {
    if (!mosaicSupplyDetail) return;
    const direction = document.getElementById("mosaic-supply-direction").value;
    const amount = parseFloat(document.getElementById("mosaic-supply-amount").value) || 0;
    const divisibility = Number(mosaicSupplyDetail.divisibility ?? 0);
    const currentSupply = Number(mosaicSupplyDetail.supply) / 10 ** divisibility;
    const newSupply = direction === "decrease" ? currentSupply - amount : currentSupply + amount;
    document.getElementById("mosaic-supply-new").textContent = newSupply.toLocaleString("ja-JP", {
      maximumFractionDigits: divisibility,
    });
  }

  document.getElementById("mosaic-supply-target-select")?.addEventListener("change", async e => {
    const mosaicIdHex = e.target.value;
    mosaicSupplyDetail = null;
    document.getElementById("mosaic-supply-current").textContent = "---";
    document.getElementById("mosaic-supply-new").textContent = "---";
    if (!mosaicIdHex) return;

    try {
      mosaicSupplyDetail = await fetchMosaicDetail(mosaicIdHex);
      const divisibility = Number(mosaicSupplyDetail.divisibility ?? 0);
      const currentSupply = Number(mosaicSupplyDetail.supply) / 10 ** divisibility;
      document.getElementById("mosaic-supply-current").textContent = currentSupply.toLocaleString("ja-JP", {
        maximumFractionDigits: divisibility,
      });
      updateMosaicSupplyNewValue();
    } catch (e) {
      console.error("fetchMosaicDetail error:", e);
      setStatus("mosaic-supply-status", "モザイク情報の取得に失敗しました。", "error");
    }
  });

  document.getElementById("mosaic-supply-direction")?.addEventListener("change", updateMosaicSupplyNewValue);
  document.getElementById("mosaic-supply-amount")?.addEventListener("input", updateMosaicSupplyNewValue);

  document.getElementById("mosaic-supply-save-btn")?.addEventListener("click", async () => {
    const mosaicIdHex = document.getElementById("mosaic-supply-target-select").value;
    const direction = document.getElementById("mosaic-supply-direction").value;
    const amount = parseFloat(document.getElementById("mosaic-supply-amount").value) || 0;

    if (!mosaicIdHex) {
      setStatus("mosaic-supply-status", "対象モザイクを選択してください。", "error");
      return;
    }
    if (!mosaicSupplyDetail) {
      setStatus("mosaic-supply-status", "モザイク情報の取得が完了していません。", "error");
      return;
    }
    if (amount <= 0) {
      setStatus("mosaic-supply-status", "供給量変更単位を入力してください。", "error");
      return;
    }

    setStatus("mosaic-supply-status", "保存中...");
    try {
      const hash = await changeMosaicSupply({
        mosaicIdHex,
        direction,
        amount,
        divisibility: Number(mosaicSupplyDetail.divisibility ?? 0),
      });
      setStatus("mosaic-supply-status", `✅ 供給量変更リクエストを送信しました。Hash: ${hash}`, "success");
    } catch (e) {
      console.error("changeMosaicSupply error:", e);
      setStatus("mosaic-supply-status", e.message || "保存に失敗しました。", "error");
    }
  });

  // ============================
  // 設定メニュー
  // ============================
  document.getElementById("settings-btn")?.addEventListener("click", () => {
    const isSss = appState.authMode === "sss";
    const isReadOnly = appState.isReadOnly;

    const mnemonicAddItem = document.getElementById("menu-add-mnemonic");
    const privatekeyAddItem = document.getElementById("menu-add-privatekey");
    if (mnemonicAddItem) mnemonicAddItem.style.display = (isSss || isReadOnly) ? "none" : "";
    if (privatekeyAddItem) privatekeyAddItem.style.display = (isSss || isReadOnly) ? "none" : "";

    // 読み取り専用モード: 送金手数料の設定は署名を伴う操作がないため不要
    const feeItem = document.getElementById("menu-fee-settings");
    if (feeItem) feeItem.style.display = isReadOnly ? "none" : "";

    const lockBtn = document.getElementById("lock-session-btn");
    const networkSwitchItem = document.getElementById("menu-network-switch");

    if (isReadOnly) {
      if (appState.readOnlyFromLogin) {
        // ログイン画面から入った場合: 戻る先の暗号化保存アカウントが実在するはず。
        // ネットワーク切替は対象アドレスと食い違ってしまうため出さない。
        if (lockBtn) lockBtn.style.display = getVaultMode() === "encrypted" ? "" : "none";
        if (networkSwitchItem) networkSwitchItem.style.display = "none";
      } else {
        // ようこそ画面から入った場合: 何もアカウントを作成していなければ
        // 「ログイン画面に戻る」の戻り先がないため隠す。
        if (lockBtn) lockBtn.style.display = appState.accounts.length > 0 ? "" : "none";
        if (networkSwitchItem) networkSwitchItem.style.display = "";
      }
    } else {
      if (lockBtn) lockBtn.style.display = getVaultMode() === "encrypted" ? "" : "none";
      if (networkSwitchItem) networkSwitchItem.style.display = isSss ? "none" : "";
    }

    // SSS Extension由来のアカウントは、そもそも秘密鍵・ニーモニックを
    // このアプリが一切扱わない(扱えない)ため、バックアップ機能自体を
    // メニューから隠す。読み取り専用モードも秘密鍵を持たないため同様。
    const backupItem = document.getElementById("menu-backup");
    if (backupItem) backupItem.style.display = (isSss || isReadOnly) ? "none" : "";

    showPage(settingsPage);
  });

  document.getElementById("lock-session-btn")?.addEventListener("click", () => {
    lockSession();
    setStatus("unlock-status", "", "default");
    showPage(unlockPage);
  });

  document.getElementById("menu-node-settings")?.addEventListener("click", async () => {
    showPage(nodeSettingsPage);
    showCurrentNode();
    await loadNodeSettingsCandidates();
  });

  document.getElementById("menu-fee-settings")?.addEventListener("click", async () => {
    showPage(feeSettingsPage);
    await loadFeeSettings();
  });

  document.getElementById("menu-network-switch")?.addEventListener("click", () => {
    document.getElementById("network-switch-current").textContent =
      appState.networkType === NetworkType.TESTNET ? "Testnet" : "Mainnet";
    setStatus("network-switch-status", "", "default");
    showPage(networkSwitchPage);
  });

  async function handleNetworkSwitch(networkType) {
    setStatus("network-switch-status", "切り替え中...");
    try {
      await switchNetwork(networkType);
      document.getElementById("network-switch-current").textContent =
        networkType === NetworkType.TESTNET ? "Testnet" : "Mainnet";
      setStatus("network-switch-status", "✅ 切り替えました。", "success");
    } catch (e) {
      console.error("switchNetwork error:", e);
      setStatus("network-switch-status", e.message || "切り替えに失敗しました。", "error");
    }
  }

  document.getElementById("network-switch-mainnet")?.addEventListener("click", () => handleNetworkSwitch(NetworkType.MAINNET));
  document.getElementById("network-switch-testnet")?.addEventListener("click", () => handleNetworkSwitch(NetworkType.TESTNET));

  document.getElementById("apply-node-btn")?.addEventListener("click", applyNodeChange);

  document.getElementById("fee-options")?.addEventListener("click", e => {
    const option = e.target.closest(".fee-option");
    if (!option) return;
    selectFeeOption(option);
  });

  document.getElementById("apply-fee-btn")?.addEventListener("click", applyFeeSettings);

  document.getElementById("logout-btn")?.addEventListener("click", () => {
    const confirmMsg = appState.isReadOnly
      ? "アドレスの照会を終了し、ようこそ画面に戻ります。よろしいですか？"
      : "ログアウトします。次回は再度ニーモニックの入力（またはSSS Extension接続）が必要になります。よろしいですか？";
    if (!confirm(confirmMsg)) return;
    logout();
    showPage(welcomePage);
  });

  // ============================
  // アカウント切替(▼マーク)
  // ============================
  document.getElementById("account-switch-btn")?.addEventListener("click", () => {
    renderAccountSwitcherList();
    showPage(accountSwitcherPage);
  });

  document.getElementById("account-switcher-list")?.addEventListener("click", async e => {
    const hideBtn = e.target.closest('[data-action="hide"]');
    if (hideBtn) {
      const id = hideBtn.dataset.id;
      await setAccountHidden(id, true);
      renderAccountSwitcherList();
      return;
    }

    const row = e.target.closest('[data-action="switch"]');
    if (row) {
      const id = row.dataset.id;
      if (id === appState.activeAccountId) return;
      try {
        await switchToAccount(id);
        updateSwitcherVisibility();
        goHome();
      } catch (err) {
        console.error("switchToAccount error:", err);
        alert(err.message || "アカウントの切替に失敗しました。");
      }
    }
  });

  document.getElementById("add-account-btn")?.addEventListener("click", async () => {
    if (hasCurrentMnemonic()) {
      try {
        await addNextAccountFromCurrentMnemonic();
        updateSwitcherVisibility();
        renderAccountSwitcherList();
        showPage(accountSwitcherPage);
      } catch (e) {
        console.error("addNextAccountFromCurrentMnemonic error:", e);
        alert(e.message || "アカウントの追加に失敗しました。");
      }
      return;
    }

    // ニーモニックがメモリ上にない場合(SSSのみ利用中など)は
    // 秘密鍵の直接入力で追加する
    showPage(addAccountPrivatekeyPage);
  });

  document.getElementById("manage-hidden-accounts-btn")?.addEventListener("click", () => {
    renderHiddenAccountList();
    showPage(hiddenAccountsPage);
  });

  document.getElementById("hidden-account-list")?.addEventListener("click", async e => {
    const btn = e.target.closest('[data-action="unhide"]');
    if (!btn) return;
    await setAccountHidden(btn.dataset.id, false);
    renderHiddenAccountList();
  });

  // ============================
  // アカウント追加(設定・アカウント切替の両方から使う共通画面)
  // ============================
  document.getElementById("menu-add-mnemonic")?.addEventListener("click", () => {
    document.getElementById("add-mnemonic-index").value = nextMnemonicAccountIndex();
    resetMnemonicInputGrid("add-mnemonic-input-grid");
    showPage(addAccountMnemonicPage);
  });

  document.getElementById("menu-add-privatekey")?.addEventListener("click", () => {
    showPage(addAccountPrivatekeyPage);
  });

  // ============================
  // バックアップ(ニーモニック・秘密鍵のエクスポート)
  // ============================
  let backupPendingAccount = null; // パスワード確認待ちのアカウント
  let backupPendingType = null;    // "privateKey" | "mnemonic"

  function populateBackupAccountSelect() {
    const select = document.getElementById("backup-account-select");
    if (!select) return;
    // SSS Extension由来のアカウントは秘密鍵をこのアプリが扱わないため対象外
    const candidates = appState.accounts.filter((a) => a.source !== "sss");
    if (candidates.length === 0) {
      select.innerHTML = `<option value="">-- エクスポート可能なアカウントがありません --</option>`;
      return;
    }
    select.innerHTML = candidates
      .map((a) => {
        let sourceLabel;
        if (a.source === "mnemonic") {
          sourceLabel = a.mnemonicPhrase ? "ニーモニック由来・取り出し可" : "ニーモニック由来・取り出し不可";
        } else {
          sourceLabel = "秘密鍵インポート";
        }
        return `<option value="${a.id}">${a.label}（${sourceLabel}）</option>`;
      })
      .join("");
  }

  // 選択中のアカウントが「取り出せるモード」(mnemonicPhraseを保存済み)の
  // 場合のみ「ニーモニックを表示」ボタンを出す。「取り出せないモード」で
  // 作成されたアカウントでは、そもそも表示できる見込みがないため
  // ボタン自体を隠す。
  function updateBackupMnemonicButtonVisibility() {
    const select = document.getElementById("backup-account-select");
    const mnemonicBtn = document.getElementById("backup-request-mnemonic-btn");
    if (!select || !mnemonicBtn) return;

    const account = appState.accounts.find((a) => a.id === select.value);
    const canShowMnemonic = !!(account && account.source === "mnemonic" && account.mnemonicPhrase);
    mnemonicBtn.style.display = canShowMnemonic ? "" : "none";
  }

  document.getElementById("backup-account-select")?.addEventListener("change", updateBackupMnemonicButtonVisibility);

  function resetBackupUI() {
    backupPendingAccount = null;
    backupPendingType = null;
    document.getElementById("backup-password-step").style.display = "none";
    document.getElementById("backup-password-input").value = "";
    setStatus("backup-password-status", "", "default");
    document.getElementById("backup-result").style.display = "none";
    document.getElementById("backup-result-value").value = "";
    setStatus("backup-select-status", "", "default");
  }

  document.getElementById("menu-backup")?.addEventListener("click", () => {
    resetBackupUI();
    const canUse = canUseBackupFeature();
    document.getElementById("backup-no-password-notice").style.display = canUse ? "none" : "block";
    document.getElementById("backup-main").style.display = canUse ? "block" : "none";
    if (canUse) {
      populateBackupAccountSelect();
      updateBackupMnemonicButtonVisibility();
    }
    showPage(backupPage);
  });

  document.getElementById("back-settings-backup")?.addEventListener("click", () => {
    resetBackupUI();
    showPage(settingsPage);
  });

  document.getElementById("backup-goto-password-setup-btn")?.addEventListener("click", () => {
    showPage(passwordSetupPage);
  });

  function requestBackupReveal(type) {
    const select = document.getElementById("backup-account-select");
    const accountId = select?.value;
    const account = appState.accounts.find((a) => a.id === accountId);

    if (!account) {
      setStatus("backup-select-status", "アカウントを選択してください。", "error");
      return;
    }
    if (type === "mnemonic" && account.source !== "mnemonic") {
      setStatus(
        "backup-select-status",
        "このアカウントは秘密鍵インポートのため、ニーモニックは存在しません。",
        "error"
      );
      return;
    }

    backupPendingAccount = account;
    backupPendingType = type;

    document.getElementById("backup-result").style.display = "none";
    document.getElementById("backup-password-input").value = "";
    setStatus("backup-password-status", "", "default");
    document.getElementById("backup-password-step").style.display = "block";
    document.getElementById("backup-password-input").focus();
  }

  document.getElementById("backup-request-privatekey-btn")?.addEventListener("click", () => requestBackupReveal("privateKey"));
  document.getElementById("backup-request-mnemonic-btn")?.addEventListener("click", () => requestBackupReveal("mnemonic"));

  document.getElementById("backup-password-cancel-btn")?.addEventListener("click", () => {
    document.getElementById("backup-password-step").style.display = "none";
    document.getElementById("backup-password-input").value = "";
    backupPendingAccount = null;
    backupPendingType = null;
  });

  document.getElementById("backup-password-confirm-btn")?.addEventListener("click", async () => {
    const pw = document.getElementById("backup-password-input").value;
    if (!pw) {
      setStatus("backup-password-status", "パスワードを入力してください。", "error");
      return;
    }
    if (!backupPendingAccount || !backupPendingType) {
      setStatus("backup-password-status", "アカウントが選択されていません。", "error");
      return;
    }

    setStatus("backup-password-status", "確認中...");
    try {
      // パスワードが正しいか確認(なりすまし防止。アカウントの切り替えや
      // ログイン状態には一切影響しない)
      await verifyVaultPassword(pw);

      let value;
      let label;
      if (backupPendingType === "privateKey") {
        value = getPrivateKeyForAccount(backupPendingAccount);
        label = `秘密鍵（${backupPendingAccount.label}）`;
      } else {
        // ニーモニックは保存されていないため、今のセッション中のものを
        // 再導出して検証したうえでのみ返る(詳細はauth.js参照)
        value = await getVerifiedMnemonicForAccount(backupPendingAccount);
        label = `ニーモニック（${backupPendingAccount.label}）`;
      }

      document.getElementById("backup-password-input").value = "";
      document.getElementById("backup-password-step").style.display = "none";
      document.getElementById("backup-result-label").textContent = label;
      document.getElementById("backup-result-value").value = value;
      document.getElementById("backup-result").style.display = "block";
      setStatus("backup-password-status", "", "default");
    } catch (e) {
      console.error("backup reveal error:", e);
      setStatus("backup-password-status", e.message || "表示に失敗しました。", "error");
    }
  });

  document.getElementById("backup-hide-result-btn")?.addEventListener("click", () => {
    document.getElementById("backup-result-value").value = "";
    document.getElementById("backup-result").style.display = "none";
    backupPendingAccount = null;
    backupPendingType = null;
  });

  document.getElementById("backup-copy-btn")?.addEventListener("click", async () => {
    const value = document.getElementById("backup-result-value").value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showPopup("コピーしました");
    } catch (e) {
      console.warn("clipboard error:", e);
      setStatus("backup-password-status", "コピーに失敗しました。", "error");
    }
  });

  document.getElementById("add-account-mnemonic-choice")?.addEventListener("click", () => {
    document.getElementById("add-mnemonic-index").value = nextMnemonicAccountIndex();
    resetMnemonicInputGrid("add-mnemonic-input-grid");
    showPage(addAccountMnemonicPage);
  });

  document.getElementById("add-account-privatekey-choice")?.addEventListener("click", () => {
    showPage(addAccountPrivatekeyPage);
  });

  document.getElementById("add-mnemonic-submit")?.addEventListener("click", async () => {
    const mnemonicPhrase = readMnemonicFromGrid("add-mnemonic-input-grid");
    const accountIndex = parseInt(document.getElementById("add-mnemonic-index").value, 10) || 0;
    const label = document.getElementById("add-mnemonic-label").value;

    if (!mnemonicPhrase) {
      setStatus("add-mnemonic-status", "ニーモニックを入力してください。", "error");
      return;
    }

    setStatus("add-mnemonic-status", "追加中...");
    try {
      await addAccountFromMnemonic(mnemonicPhrase, accountIndex, label);
      resetMnemonicInputGrid("add-mnemonic-input-grid");
      document.getElementById("add-mnemonic-label").value = "";
      updateSwitcherVisibility();
      goHome();
    } catch (e) {
      console.error("addAccountFromMnemonic error:", e);
      setStatus("add-mnemonic-status", e.message || "追加に失敗しました。", "error");
    }
  });

  document.getElementById("add-privatekey-submit")?.addEventListener("click", async () => {
    const privateKeyHex = document.getElementById("add-privatekey-input").value.trim();
    const label = document.getElementById("add-privatekey-label").value;

    if (!privateKeyHex) {
      setStatus("add-privatekey-status", "秘密鍵を入力してください。", "error");
      return;
    }

    setStatus("add-privatekey-status", "追加中...");
    try {
      await addAccountFromPrivateKey(privateKeyHex, label);
      document.getElementById("add-privatekey-input").value = "";
      document.getElementById("add-privatekey-label").value = "";
      updateSwitcherVisibility();
      goHome();
    } catch (e) {
      console.error("addAccountFromPrivateKey error:", e);
      setStatus("add-privatekey-status", e.message || "追加に失敗しました。", "error");
    }
  });

  // ============================
  // 戻る
  // ============================
  document.getElementById("back-account")?.addEventListener("click", () => showPage(accountPage));
  backSendBtn?.addEventListener("click", () => {
    showPage(cameFromMosaicList ? accountPage : sendPage);
  });
  document.getElementById("back-account-receive")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-account-harvest")?.addEventListener("click", () => showPage(advancedPage));
  document.getElementById("back-account-settings")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-settings-node")?.addEventListener("click", () => showPage(settingsPage));
  document.getElementById("back-settings-fee")?.addEventListener("click", () => showPage(settingsPage));
  document.getElementById("back-settings-network")?.addEventListener("click", () => showPage(settingsPage));
  document.getElementById("back-account-switcher")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-hidden-accounts")?.addEventListener("click", () => showPage(accountSwitcherPage));
  document.getElementById("back-add-account-menu")?.addEventListener("click", () => showPage(accountSwitcherPage));
  document.getElementById("back-add-account-mnemonic")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-add-account-privatekey")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-account-advanced")?.addEventListener("click", () => showPage(accountPage));
  document.getElementById("back-advanced-namespace")?.addEventListener("click", () => showPage(advancedPage));
  document.getElementById("back-advanced-mosaic")?.addEventListener("click", () => showPage(advancedPage));
  document.getElementById("back-advanced-metadata")?.addEventListener("click", () => showPage(advancedPage));
  document.getElementById("back-advanced-multisig-menu")?.addEventListener("click", () => showPage(advancedPage));
  document.getElementById("back-multisend-menu-list")?.addEventListener("click", () => showPage(advancedPage));
  document.getElementById("back-advanced-apostille-menu")?.addEventListener("click", () => showPage(advancedPage));
  document.getElementById("back-advanced-restriction-menu")?.addEventListener("click", () => showPage(advancedPage));
  document.getElementById("back-restriction-menu-account")?.addEventListener("click", () => showPage(restrictionMenuPage));
  document.getElementById("back-restriction-menu-mosaic-top")?.addEventListener("click", () => showPage(restrictionMenuPage));
  document.getElementById("back-advanced-offline-tx")?.addEventListener("click", () => showPage(advancedPage));
  document.getElementById("back-offline-broadcast")?.addEventListener("click", () => showPage(welcomePage));

  // ============================
  // タブ切替
  // ============================
  // 汎用タブ切替(モザイク・ネームスペース・メタデータ画面で使う)
  function setupTabGroup(tabIds, contentIds, onShow = []) {
    tabIds.forEach((tabId, i) => {
      document.getElementById(tabId)?.addEventListener("click", () => {
        tabIds.forEach((id, j) => {
          document.getElementById(id)?.classList.toggle("active", j === i);
          const content = document.getElementById(contentIds[j]);
          if (content) content.style.display = j === i ? "block" : "none";
        });
        onShow[i]?.();
      });
    });
  }

  setupTabGroup(
    ["tab-token", "tab-activity", "tab-harvest-reward"],
    ["token-content", "activity-content", "harvest-reward-content"],
    [null, null, () => loadHarvestRewards()]
  );

  setupTabGroup(
    ["mosaic-tab-owned", "mosaic-tab-create", "mosaic-tab-supply"],
    ["mosaic-content-owned", "mosaic-content-create", "mosaic-content-supply"],
    [
      () => loadOwnedMosaicsWithAlias(),
      () => updateMosaicFeeEstimate(),
      () => populateMosaicSupplyTab(),
    ]
  );

  setupTabGroup(
    ["ns-tab-owned", "ns-tab-create", "ns-tab-link"],
    ["ns-content-owned", "ns-content-create", "ns-content-link"],
    [
      () => loadOwnedNamespaces(),
      () => { updateRootNamespaceFeeEstimate(); updateSubNamespaceFeeEstimate(); },
      () => { updateNsLinkMosaicFeeEstimate(); updateNsLinkAddressFeeEstimate(); },
    ]
  );

  setupTabGroup(
    ["metadata-tab-owned", "metadata-tab-create"],
    ["metadata-content-owned", "metadata-content-create"],
    [() => loadOwnMetadataList(), null]
  );


  // ============================
  // アドレスコピー
  // ============================
  document.getElementById("copy-address-btn")?.addEventListener("click", () => {
    navigator.clipboard.writeText(appState.currentAddress.toString());
    showPopup("アドレスをコピーしました");
  });

  // ============================
  // 先頭に戻るボタン(下にスクロールすると表示)
  // ============================
  const scrollTopBtn = document.getElementById("scroll-to-top-btn");
  const SCROLL_TOP_SHOW_THRESHOLD = 400;

  function updateScrollTopBtnVisibility() {
    if (!scrollTopBtn) return;
    scrollTopBtn.style.display = window.scrollY > SCROLL_TOP_SHOW_THRESHOLD ? "flex" : "none";
  }

  window.addEventListener("scroll", updateScrollTopBtnVisibility, { passive: true });
  scrollTopBtn?.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  updateScrollTopBtnVisibility();
});
