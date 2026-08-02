// auth.js
// 認証方式の管理: SSS Extension接続 / ニーモニックインポート・秘密鍵インポート(ローカル署名)
// マルチアカウント対応。パスワードを設定した場合のみ、暗号化してlocalStorageに保存する

import { appState, NetworkType } from "./config.js";
import { selectNode } from "./nodeSelector.js";
import { initSdk } from "./sdk.js";
import { refreshAccount } from "./account.js";
import { loadRecentTx, initLiveTx } from "./transactions.js";
import { initWebSocket, closeWebSocket } from "./ws.js";
import { setText } from "./ui.js";
import { requestTxConfirmation, formatTxDeadline, TxCancelledError } from "./txConfirm.js";

const VAULT_KEY = "walletVault";

// 現在ログインに使ったニーモニック(セッション中のみメモリ保持、保存はしない)
// これがあれば「アカウント追加」時に毎回ニーモニックを打ち直さずに済む
let currentMnemonicPhrase = null;

export function hasCurrentMnemonic() {
  return !!currentMnemonicPhrase;
}

/* ============================================================
   新規ニーモニック生成(24語, Symbol公式ウォレットと同じ強度)
============================================================ */
export async function generateNewMnemonic() {
  const [bip39, wordlistModule] = await Promise.all([
    import("https://esm.sh/@scure/bip39@2.2.0"),
    import("https://esm.sh/@scure/bip39@2.2.0/wordlists/english"),
  ]);
  const { wordlist } = wordlistModule;
  return bip39.generateMnemonic(wordlist, 256);
}

/* ============================================================
   ニーモニック → 秘密鍵 (BIP39 + SLIP-10)
   @scure/bip39 と micro-ed25519-hdkey はどちらもNode.jsのBufferに
   依存しない監査済みの純粋なJS実装で、ブラウザでの動作実績が多いため採用。
   導出パスはSymbol公式ウォレットと同じ m/44'/4343'/{account}'/0'/0'
   ({account}を変えることで同じニーモニックから複数アカウントを導出できる)
============================================================ */
async function deriveFromMnemonic(mnemonicPhrase, accountIndex = 0) {
  const [bip39, wordlistModule, hdkeyModule] = await Promise.all([
    import("https://esm.sh/@scure/bip39@2.2.0"),
    import("https://esm.sh/@scure/bip39@2.2.0/wordlists/english"),
    import("https://esm.sh/micro-ed25519-hdkey@0.1.2"),
  ]);
  const { wordlist } = wordlistModule;
  const { HDKey } = hdkeyModule;

  // 貼り付け時の改行・連続スペース・全角スペースを単一の半角スペースに正規化
  const normalized = mnemonicPhrase
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ");

  const wordCount = normalized.split(" ").filter(Boolean).length;
  console.log("mnemonic word count:", wordCount);

  if (!bip39.validateMnemonic(normalized, wordlist)) {
    throw new Error("ニーモニックの形式が正しくありません（単語数やスペルを確認してください）");
  }

  const idx = Number.isInteger(accountIndex) && accountIndex >= 0 ? accountIndex : 0;
  const path = `m/44'/4343'/${idx}'/0'/0'`;

  const seed = bip39.mnemonicToSeedSync(normalized);
  const hdkey = HDKey.fromMasterSeed(seed);
  const child = hdkey.derive(path);

  const privateKeyHex = Array.from(child.privateKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

  return privateKeyHex;
}

/* ============================================================
   バックアップ(ニーモニック / 秘密鍵のエクスポート)

   ⚠ セキュリティ上重要な設計:
   - 秘密鍵は各アカウントの privateKeyHex にそのまま保存されているため
     常に取得できる。
   - ニーモニックは "保存していない"。セッション中に実際にログイン/
     アカウント追加で入力したものだけが currentMnemonicPhrase として
     メモリ上に一時的に残る。ページ再読み込み後は失われ、復元できない
     (BIP39の性質上、秘密鍵からニーモニックへ逆算することもできない)。
   - 複数のニーモニックを扱った場合に誤ったアカウントへ表示してしまう
     ことがないよう、表示前に必ず再導出して実際のアカウントの
     privateKeyHex と一致するか検証する。
============================================================ */

// バックアップ機能を使うには、なりすまし防止のためパスワード確認を
// 必須にする。パスワード未設定(平文保存のまま)の場合は、先に
// 「設定」からパスワードを設定してもらう。
export function canUseBackupFeature() {
  return getVaultMode() === "encrypted";
}

/*
  入力されたパスワードが、現在保存されている暗号化ボールトのものと
  一致するか検証する。unlockVault() と異なり、アカウントの復元や
  ログイン状態の変更は一切行わない「確認専用」の関数。
*/
export async function verifyVaultPassword(password) {
  const raw = localStorage.getItem(VAULT_KEY);
  if (!raw) {
    throw new Error("保存されたアカウントがありません。");
  }

  let vault;
  try {
    vault = JSON.parse(raw);
  } catch {
    throw new Error("保存データの読み込みに失敗しました。");
  }
  if (!vault.encrypted) {
    throw new Error("パスワードが設定されていません。");
  }

  const salt = base64ToBytes(vault.salt);
  const iv = base64ToBytes(vault.iv);
  const key = await deriveKeyFromPassword(password, salt);

  try {
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, base64ToBytes(vault.cipher));
  } catch {
    throw new Error("パスワードが正しくありません。");
  }
  return true;
}

/*
  秘密鍵の取得。SSS Extension由来のアカウントは秘密鍵をこのアプリが
  一切扱わない設計のため、対象外。
*/
export function getPrivateKeyForAccount(account) {
  if (!account || account.source === "sss") {
    throw new Error("SSS Extension由来のアカウントは、このアプリから秘密鍵を取得できません。");
  }
  if (!account.privateKeyHex) {
    throw new Error("このアカウントには秘密鍵の情報がありません。");
  }
  return account.privateKeyHex;
}

/*
  ニーモニックの取得。以下のいずれかを満たす場合のみ返すことができる:
    ① このアカウントが「取り出せるモード」(exportable: true)で作成されて
       おり、account.mnemonicPhrase が保存されている
       → 再起動後・別セッションでも常に取得できる
    ② 「取り出せないモード」の場合、今のセッション中にメモリへ残っている
       もの(currentMnemonicPhrase)だけが対象。再導出して一致を検証する
  いずれも満たさない場合は、理由を含むエラーを投げる。
*/
export async function getVerifiedMnemonicForAccount(account) {
  if (!account || account.source !== "mnemonic") {
    throw new Error("このアカウントはニーモニック由来ではないため、ニーモニックは存在しません(秘密鍵のみインポートされたアカウントです)。");
  }

  // ① 「取り出せるモード」で作成済み → 保存されているものをそのまま返す
  if (account.mnemonicPhrase) {
    return account.mnemonicPhrase;
  }

  // ② 「取り出せないモード」 → 今のセッションのメモリ上にあるものだけが対象
  if (!currentMnemonicPhrase) {
    throw new Error(
      "このアカウントは「取り出せないモード」で作成されているため、ニーモニックは保存されていません。" +
      "今のセッション中にログインまたはアカウント追加の際に入力したものだけが一時的にメモリ上に残る" +
      "仕組みのため、ページを再読み込みすると失われ、二度と復元できません。表示するには、" +
      "このアカウントの作成に使ったニーモニックを使って、もう一度ログインし直してから" +
      "改めてお試しください。"
    );
  }

  const rederivedKey = await deriveFromMnemonic(currentMnemonicPhrase, account.accountIndex ?? 0);
  if (rederivedKey.toUpperCase() !== (account.privateKeyHex || "").toUpperCase()) {
    throw new Error(
      "現在メモリ上にあるニーモニックは、このアカウントの作成に使われたものと" +
      "一致しません(別のニーモニックやアカウントを扱った可能性があります)。" +
      "表示するには、このアカウントの作成に使ったニーモニックでもう一度" +
      "ログインし直してください。"
    );
  }

  return currentMnemonicPhrase;
}

/* ============================================================
   アカウント一覧への追加/更新
============================================================ */
function upsertAccount(entry) {
  const idx = appState.accounts.findIndex((a) => a.id === entry.id);
  if (idx >= 0) {
    appState.accounts[idx] = { ...appState.accounts[idx], ...entry };
  } else {
    appState.accounts.push(entry);
  }
}

export function getAccounts() {
  return appState.accounts;
}

/* ============================================================
   アカウント切替（SSS / ニーモニック由来 / 秘密鍵由来 共通）
============================================================ */
export async function switchToAccount(id) {
  const acc = appState.accounts.find((a) => a.id === id);
  if (!acc) {
    throw new Error("アカウントが見つかりません");
  }

  closeWebSocket();

  // ノード/SDKがまだ準備できていなければここで準備する
  // (アカウント追加・切替時は既に準備済みのことが多いので再選択しない)
  if (!appState.isSdkReady) {
    const isTestnet = appState.networkType === NetworkType.TESTNET;
    appState.NODE = await selectNode(isTestnet);
    await initSdk();
  }

  if (acc.source === "sss") {
    if (!window.SSS || !window.SSS.activePublicKey) {
      throw new Error("SSS Extensionが接続されていません");
    }
    appState.authMode = "sss";
    appState.currentPubKey = window.SSS.activePublicKey;
    appState.localPrivateKeyHex = null;
    appState.localKeyPair = null;

    const pub = new appState.sdkCore.PublicKey(appState.currentPubKey);
    appState.currentAddress = appState.facade.createPublicAccount(pub).address;
  } else {
    appState.authMode = "local";
    appState.localPrivateKeyHex = acc.privateKeyHex;

    const keyPair = new appState.facade.static.KeyPair(
      new appState.sdkCore.PrivateKey(acc.privateKeyHex)
    );
    appState.localKeyPair = keyPair;
    appState.currentPubKey = keyPair.publicKey.toString();
    appState.currentAddress = appState.facade.network.publicKeyToAddress(keyPair.publicKey);
  }

  appState.activeAccountId = id;
  acc.address = appState.currentAddress.toString();

  setText("network-label", appState.networkType === NetworkType.TESTNET ? "Testnet" : "Mainnet");
  const addressEl = document.getElementById("account-address");
  if (addressEl) addressEl.textContent = appState.currentAddress.toString();

  await refreshAccount();
  await loadRecentTx();

  const address = appState.currentAddress.toString();
  initWebSocket(address);
  initLiveTx(address);

  await persistAccounts();
}

/* ============================================================
   ネットワーク切り替え(Mainnet ⇔ Testnet)
   SSS Extension接続アカウントでは使えない(SSSの署名対象ネットワークは
   拡張機能側で固定されているため)。ローカル署名(ニーモニック/秘密鍵)
   のアカウントのみ対応。同じ秘密鍵でも、ネットワークが変わると
   アドレスの見え方(先頭の"N"/"T"等)が変わる。
============================================================ */
export async function switchNetwork(networkType) {
  if (appState.authMode === "sss") {
    throw new Error("SSS Extension接続アカウントではネットワークを切り替えられません");
  }
  if (!appState.localPrivateKeyHex) {
    throw new Error("アカウントが未接続です");
  }
  if (appState.networkType === networkType) {
    return; // 既に同じネットワーク
  }

  closeWebSocket();

  appState.networkType = networkType;
  const isTestnet = networkType === NetworkType.TESTNET;
  appState.NODE = await selectNode(isTestnet);
  await initSdk();

  const keyPair = new appState.facade.static.KeyPair(
    new appState.sdkCore.PrivateKey(appState.localPrivateKeyHex)
  );
  appState.localKeyPair = keyPair;
  appState.currentPubKey = keyPair.publicKey.toString();
  appState.currentAddress = appState.facade.network.publicKeyToAddress(keyPair.publicKey);

  // 他アカウントのキャッシュ済みアドレスは別ネットワークのものになって
  // しまうため無効化する(次に切り替えた時に再計算される)
  appState.accounts.forEach((a) => {
    if (a.source !== "sss") delete a.address;
  });

  const activeAcc = appState.accounts.find((a) => a.id === appState.activeAccountId);
  if (activeAcc) activeAcc.address = appState.currentAddress.toString();

  setText("network-label", isTestnet ? "Testnet" : "Mainnet");
  const addressEl = document.getElementById("account-address");
  if (addressEl) addressEl.textContent = appState.currentAddress.toString();

  await refreshAccount();
  await loadRecentTx();

  const address2 = appState.currentAddress.toString();
  initWebSocket(address2);
  initLiveTx(address2);

  await persistAccounts();
}

/* ============================================================
   SSS Extension 接続
============================================================ */
export async function connectWithSSS() {
  if (!window.SSS || !window.SSS.activePublicKey) {
    throw new Error("SSS Extension とリンクしてください");
  }

  const pubKey = window.SSS.activePublicKey;
  const networkType = Number(window.SSS.activeNetworkType);

  if (!pubKey || ![NetworkType.MAINNET, NetworkType.TESTNET].includes(networkType)) {
    throw new Error("SSSでアカウントを選択してください");
  }

  appState.networkType = networkType;

  const id = "sss:" + pubKey.toUpperCase();
  upsertAccount({ id, label: "SSS Extension", source: "sss", hidden: false });

  await switchToAccount(id);
}

/*
  ニーモニックでログイン（初回ログイン用。デフォルトでアカウント0を使う）

  exportable:
    true  … 「取り出せるモード」。ニーモニック自体をこのアカウントの
             エントリに保存する(vaultの暗号化対象に含まれるため、
             パスワードが正しければ後からいつでも「バックアップ」画面
             から取り出せる)。
    false … 「取り出せないモード」(デフォルト、より安全)。ニーモニック
             は一切保存せず、今のセッション中のみメモリに残る
             (currentMnemonicPhrase)。ページ再読み込み後は復元できない。
*/
export async function loginWithMnemonic(mnemonicPhrase, networkType, accountIndex = 0, exportable = false) {
  const privateKeyHex = await deriveFromMnemonic(mnemonicPhrase, accountIndex);
  currentMnemonicPhrase = mnemonicPhrase;

  appState.networkType = networkType;

  const id = crypto.randomUUID();
  upsertAccount({
    id,
    label: `アカウント ${accountIndex + 1}`,
    source: "mnemonic",
    privateKeyHex,
    accountIndex,
    hidden: false,
    ...(exportable ? { mnemonicPhrase } : {}),
  });

  await switchToAccount(id);
}

/* ============================================================
   アカウント追加（ログイン済みの状態で使う。SSS利用中でも呼べる）
============================================================ */
function isDuplicatePrivateKey(privateKeyHex) {
  return appState.accounts.some(
    (a) => a.privateKeyHex && a.privateKeyHex.toUpperCase() === privateKeyHex.toUpperCase()
  );
}

export async function addAccountFromMnemonic(mnemonicPhrase, accountIndex, label) {
  const privateKeyHex = await deriveFromMnemonic(mnemonicPhrase, accountIndex);

  if (isDuplicatePrivateKey(privateKeyHex)) {
    throw new Error("このアカウントはすでにインポートされています");
  }

  currentMnemonicPhrase = mnemonicPhrase;

  const id = crypto.randomUUID();
  const entry = {
    id,
    label: label?.trim() || `アカウント ${accountIndex + 1}`,
    source: "mnemonic",
    privateKeyHex,
    accountIndex,
    hidden: false,
  };
  upsertAccount(entry);
  await switchToAccount(id);
  return entry;
}

/* ============================================================
   ニーモニックログイン中、既にメモリにあるニーモニックを使って
   次のアカウントをワンクリックで追加する（再入力不要）
============================================================ */
export async function addNextAccountFromCurrentMnemonic(label) {
  if (!currentMnemonicPhrase) {
    throw new Error("ニーモニックがメモリ上にありません（ログインし直すか、秘密鍵で追加してください）");
  }

  const used = appState.accounts
    .filter((a) => a.source === "mnemonic")
    .map((a) => a.accountIndex ?? 0);
  const nextIndex = used.length === 0 ? 0 : Math.max(...used) + 1;

  return await addAccountFromMnemonic(currentMnemonicPhrase, nextIndex, label);
}

export async function addAccountFromPrivateKey(privateKeyHex, label) {
  const normalized = privateKeyHex.trim().toUpperCase().replace(/^0X/, "");
  if (!/^[0-9A-F]{64}$/.test(normalized)) {
    throw new Error("秘密鍵の形式が正しくありません（64桁の16進数を入力してください）");
  }

  if (isDuplicatePrivateKey(normalized)) {
    throw new Error("このアカウントはすでにインポートされています");
  }

  const id = crypto.randomUUID();
  const entry = {
    id,
    label: label?.trim() || "インポートした鍵",
    source: "privateKey",
    privateKeyHex: normalized,
    hidden: false,
  };
  upsertAccount(entry);
  await switchToAccount(id);
  return entry;
}

/* ============================================================
   アカウントの表示/非表示
   非表示は削除ではなく一覧から隠すだけ(秘密鍵は保持されたまま)
============================================================ */
export async function setAccountHidden(id, hidden) {
  const acc = appState.accounts.find((a) => a.id === id);
  if (!acc) return;
  acc.hidden = hidden;
  await persistAccounts();
}

/* ============================================================
   暗号化ボールト (パスワード設定時のみ使用)
   AES-GCM + PBKDF2(210,000回)でアカウント一覧を暗号化してlocalStorageへ
   (SSS由来のアカウントは秘密鍵を持たないため保存対象外)
============================================================ */
async function deriveKeyFromPassword(password, saltBytes) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: 210000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// パスワードから導出した鍵はセッション中だけメモリに保持し、
// アカウント追加や非表示操作のたびにパスワード再入力を求めずに
// 再暗号化・再保存できるようにする(平文パスワードは保持しない)
let sessionSalt = null;
let sessionKey = null;

/*
  ボールトの状態:
    "none"      … 何も保存されていない(ログアウト直後・SSSのみ利用等)
    "plain"     … パスワード未設定。ログアウトするまでは平文でこの端末に保存し、
                   次回リロード時は確認なしで自動ログインする
    "encrypted" … パスワード設定済み。次回はパスワード入力が必要
*/
/*
  ボールトの状態:
    "none"      … 何も保存されていない(ログアウト直後・SSSのみ利用等)
    "plain"     … パスワード未設定。sessionStorageに平文保存。
                   リロードでは復帰するが、タブ/ウィンドウを閉じると消える
    "encrypted" … パスワード設定済み。localStorageに暗号化保存。
                   ブラウザを閉じても残り、次回はパスワード入力が必要
*/
export function getVaultMode() {
  const encRaw = localStorage.getItem(VAULT_KEY);
  if (encRaw) {
    try {
      if (JSON.parse(encRaw).encrypted) return "encrypted";
    } catch {
      /* ignore */
    }
  }

  const plainRaw = sessionStorage.getItem(VAULT_KEY);
  if (plainRaw) return "plain";

  return "none";
}

export function hasVault() {
  return getVaultMode() !== "none";
}

export function clearVault() {
  localStorage.removeItem(VAULT_KEY);
  sessionStorage.removeItem(VAULT_KEY);
  sessionSalt = null;
  sessionKey = null;
}

/*
  アカウント一覧の永続化。
  ログアウトするまでは常に保存する:
    - パスワード設定済み(sessionKey あり) → localStorageに暗号化して保存
      (ブラウザを閉じても残る)
    - 未設定 → sessionStorageに平文のまま保存
      (タブ内でのリロードでは復帰するが、タブ/ウィンドウを閉じると消える。
       秘密鍵を暗号化せずlocalStorageに残さないための措置)
  持つべきアカウントが1つもなければ何も保存しない(削除もしない。SSSのみ利用中で
  ローカルアカウントを一つも追加していない場合はこの状態のまま)。
*/
async function persistAccounts() {
  const persistable = appState.accounts.filter((a) => a.source !== "sss");
  if (persistable.length === 0) return;

  const payload = {
    accounts: persistable,
    networkType: appState.networkType,
    activeAccountId: appState.activeAccountId,
  };

  if (sessionKey && sessionSalt) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(payload));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sessionKey, plain);

    localStorage.setItem(
      VAULT_KEY,
      JSON.stringify({
        encrypted: true,
        salt: bufToBase64(sessionSalt),
        iv: bufToBase64(iv),
        cipher: bufToBase64(cipher),
      })
    );
    // 平文版が残っていたら削除(パスワードを後から設定したケース)
    sessionStorage.removeItem(VAULT_KEY);
  } else {
    sessionStorage.setItem(VAULT_KEY, JSON.stringify(payload));
  }
}

function restoreAccountsPayload(payload) {
  appState.accounts = payload.accounts || [];
  appState.networkType = payload.networkType;

  const targetId =
    payload.activeAccountId && appState.accounts.some((a) => a.id === payload.activeAccountId)
      ? payload.activeAccountId
      : appState.accounts[0]?.id;

  if (!targetId) {
    throw new Error("保存されたアカウントがありません");
  }
  return targetId;
}

/*
  パスワード未設定(平文・sessionStorage)のボールトを、確認なしでそのまま復元する。
  ページ読み込み時、getVaultMode() === "plain" のときに呼ぶ。
*/
export async function restorePlainVault() {
  const raw = sessionStorage.getItem(VAULT_KEY);
  if (!raw) throw new Error("保存されたアカウントがありません");

  const payload = JSON.parse(raw);
  const targetId = restoreAccountsPayload(payload);
  await switchToAccount(targetId);
}

export async function saveVault(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKeyFromPassword(password, salt);
  sessionSalt = salt;
  sessionKey = key;
  await persistAccounts();
}

export async function unlockVault(password) {
  const raw = localStorage.getItem(VAULT_KEY);
  if (!raw) {
    throw new Error("保存されたアカウントがありません");
  }

  const vault = JSON.parse(raw);
  const salt = base64ToBytes(vault.salt);
  const iv = base64ToBytes(vault.iv);
  const key = await deriveKeyFromPassword(password, salt);

  let plainBuf;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, base64ToBytes(vault.cipher));
  } catch {
    throw new Error("パスワードが正しくありません");
  }

  const payload = JSON.parse(new TextDecoder().decode(plainBuf));

  sessionSalt = salt;
  sessionKey = key;

  const targetId = restoreAccountsPayload(payload);
  await switchToAccount(targetId);
}

/* ============================================================
   ローカル署名 (ニーモニック/秘密鍵ログイン時、SSS Extensionを使わない署名)
============================================================ */
export function signPayloadLocally(tx) {
  const signature = appState.facade.signTransaction(appState.localKeyPair, tx);
  // attachSignatureはアナウンス用のJSON文字列(payload)をそのまま返す
  return appState.facade.transactionFactory.static.attachSignature(tx, signature);
}

export function encryptMessageLocally(recipientPubKeyHex, plainText) {
  const encoder = new appState.sdkSymbol.MessageEncoder(appState.localKeyPair);
  const recipientPub = new appState.sdkCore.PublicKey(recipientPubKeyHex);
  return encoder.encode(recipientPub, new TextEncoder().encode(plainText));
}

/* ============================================================
   署名 → アナウンス（共通処理）
   SSS Extension / ローカル署名の両方に対応。
   ネームスペース登録・モザイク作成など、送金・ハーベスト以外の
   機能からも共通で使う。
============================================================ */
/* ============================================================
   署名のみ行い、アナウンスはしない(マルチシグのアグリゲートボンデッド等、
   ハッシュロックを挟む多段階フローで使う)
============================================================ */
export async function signTxOnly(tx) {
  let jsonPayload;
  let signedBytes;

  if (appState.authMode === "local") {
    jsonPayload = signPayloadLocally(tx);
    signedBytes = appState.sdkCore.utils.hexToUint8(JSON.parse(jsonPayload).payload);
  } else {
    const payload = appState.sdkCore.utils.uint8ToHex(tx.serialize());

    window.SSS.setTransactionByPayload(payload);
    const signed = await window.SSS.requestSign();
    if (!signed?.payload) {
      throw new Error("SSS署名に失敗しました");
    }

    jsonPayload = JSON.stringify({ payload: signed.payload });
    signedBytes = appState.sdkCore.utils.hexToUint8(signed.payload);
  }

  return { jsonPayload, signedBytes };
}

/* ============================================================
   署名 → アナウンス（共通処理）
   SSS Extension / ローカル署名の両方に対応。
   ネームスペース登録・モザイク作成など、送金・ハーベスト以外の
   機能からも共通で使う。
============================================================ */
/* ============================================================
   未署名のTxオブジェクトから推定手数料(XYM)を計算する共通ヘルパー
============================================================ */
export function estimateFeeFromTx(tx) {
  const feeMicroXym = tx.size * (appState.feeMultiplier ?? 100);
  return (feeMicroXym / 1_000_000).toLocaleString("ja-JP", { maximumFractionDigits: 6 });
}

/* ============================================================
   confirmInfo が渡された場合、署名の前に確認ダイアログを表示する。
   confirmInfo:
     { typeLabel, sender?, recipient?, details? }
   ユーザーがキャンセルした場合は TxCancelledError を投げる。
   (confirmInfo を渡さない呼び出しは従来通り確認なしで実行される)
============================================================ */
export async function signAndAnnounceTx(tx, confirmInfo) {
  if (confirmInfo) {
    const confirmed = await requestTxConfirmation({
      typeLabel: confirmInfo.typeLabel,
      sender: confirmInfo.sender ?? appState.currentAddress?.toString(),
      recipient: confirmInfo.recipient,
      fee: estimateFeeFromTx(tx),
      deadlineText: formatTxDeadline(tx),
      details: confirmInfo.details,
    });
    if (!confirmed) {
      throw new TxCancelledError();
    }
  }

  const { jsonPayload: announceBody, signedBytes } = await signTxOnly(tx);

  const res = await fetch(new URL("/transactions", appState.NODE), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: announceBody,
  });

  const result = await res.json();
  console.log("announce result:", result);

  if (!res.ok) {
    throw new Error(result.message ?? "アナウンス失敗");
  }

  const signedTx = appState.facade.transactionFactory.static.deserialize(signedBytes);
  return appState.facade.hashTransaction(signedTx).toString();
}

/* ============================================================
   セッション状態のリセット(共通処理)
============================================================ */
function resetSessionState() {
  closeWebSocket();
  currentMnemonicPhrase = null;

  appState.authMode = null;
  appState.currentPubKey = null;
  appState.currentAddress = null;
  appState.localPrivateKeyHex = null;
  appState.localKeyPair = null;
  appState.NODE = null;
  appState.isSdkReady = false;
  appState.networkType = null;
  appState.accounts = [];
  appState.activeAccountId = null;
}

/* ============================================================
   ログアウト
   保存済みアカウント(パスワード付きボールト)も削除するため、
   次回は自動ログインできず、必ずSSS接続かニーモニック/秘密鍵の
   再入力が必要になる
============================================================ */
export function logout() {
  clearVault();
  resetSessionState();
}

/* ============================================================
   ロック
   ログアウトと違い、保存済みボールト(localStorage)は削除しない。
   次回はパスワード入力(ロック解除画面)だけで復帰できる。
   新規作成 / ニーモニックインポートでログインした場合(authMode==="local")
   のみ使う想定。
============================================================ */
export function lockSession() {
  sessionSalt = null;
  sessionKey = null;
  resetSessionState();
}

/* ============================================================
   保留中のアグリゲートボンデッドTxへの連署(マルチシグ署名)
   Symbol の連署は「トランザクションハッシュへの署名」のみで完結する。
   ※ SSS Extensionにはハッシュへの署名を依頼する公開APIが無いため、
     現状はローカル署名(ニーモニック/秘密鍵ログイン)のみ対応。
============================================================ */
export function cosignTransactionHash(transactionHashHex) {
  if (appState.authMode !== "local") {
    throw new Error("SSS Extensionでは連署に対応していません（ニーモニック/秘密鍵ログインでご利用ください）");
  }

  const hashBytes = appState.sdkCore.utils.hexToUint8(transactionHashHex);
  const signature = appState.localKeyPair.sign(hashBytes);

  return {
    parentHash: transactionHashHex,
    signature: appState.sdkCore.utils.uint8ToHex(signature.bytes ?? signature),
    signerPublicKey: appState.currentPubKey,
    version: "0",
  };
}
