(function () {
"use strict";

// addressBook.js
// アドレス帳機能: よく使うアドレスをラベル付きで端末に保存する。
//
// アドレスとラベルはいずれも公開情報であり(秘密鍵・ニーモニックとは異なり)、
// 見られても資産への影響はないため、暗号化ボールト(walletVault)とは別に、
// 常にlocalStorageへ平文のまま保存する。パスワード設定の有無やログイン方式
// (ローカル/SSS/読み取り専用)を問わず、この端末上で共通して使える。
//
// 「アカウントの状態をセーブ」機能(index.js)からは、
//   exportAddressBookPlain() : QRコードに埋め込むための配列を取得
//   replaceAddressBook()     : QRコードから復元した内容で丸ごと置き換え
// の2つを呼び出す形で連携する。

const {appState} = W.config;

const STORAGE_KEY = "addressBookV1";

/* ============================================================
   保存/読み込み(生データ)
============================================================ */
function loadRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn("アドレス帳の読み込みに失敗しました:", e);
    return [];
  }
}

function saveRaw(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    console.warn("アドレス帳の保存に失敗しました:", e);
  }
}

function getAddressBook() {
  return loadRaw();
}

/* ============================================================
   アドレス正規化・簡易バリデーション
   (チェックサムまで含めた完全な検証はSDK初期化後のみ可能なため、
    appState.sdkSymbolが準備できている場合のみ追加で行う)
============================================================ */
function normalizeAddress(raw) {
  return (raw || "").toString().trim().toUpperCase().replace(/[\s-]/g, "");
}

function isValidAddressShape(addr) {
  if (!/^[NT][A-Z2-7]{38}$/.test(addr)) return false;

  if (appState.sdkSymbol) {
    try {
      // eslint-disable-next-line no-new
      new appState.sdkSymbol.Address(addr);
    } catch {
      return false;
    }
  }

  return true;
}

/* ============================================================
   追加/更新(id指定時は更新、未指定時は新規追加)
============================================================ */
function upsertAddressBookEntry({ id, label, address }) {
  const trimmedLabel = (label || "").trim();
  const normalizedAddress = normalizeAddress(address);

  if (!trimmedLabel) {
    throw new Error("ラベルを入力してください。");
  }
  if (!normalizedAddress) {
    throw new Error("アドレスを入力してください。");
  }
  if (!isValidAddressShape(normalizedAddress)) {
    throw new Error("アドレスの形式が正しくありません。");
  }

  const list = loadRaw();
  const entryId = id || crypto.randomUUID();
  const idx = list.findIndex((e) => e.id === entryId);
  const entry = { id: entryId, label: trimmedLabel, address: normalizedAddress };

  if (idx >= 0) {
    list[idx] = entry;
  } else {
    list.push(entry);
  }

  saveRaw(list);
  return entry;
}

/* ============================================================
   削除
============================================================ */
function deleteAddressBookEntry(id) {
  const list = loadRaw().filter((e) => e.id !== id);
  saveRaw(list);
}

/* ============================================================
   「アカウントの状態をセーブ」QR用のエクスポート/復元
   ・エクスポート: idは含めず {label, address} の配列だけを返す
     (別端末で読み込んだ際は新しいidを振り直すため)
   ・復元: 渡された配列の各要素を検証し、不正なものはスキップしたうえで、
     現在のアドレス帳を丸ごと置き換える(上書き)
============================================================ */
function exportAddressBookPlain() {
  return loadRaw().map((e) => ({ label: e.label, address: e.address }));
}

function replaceAddressBook(entries) {
  if (!Array.isArray(entries)) return;

  const list = [];
  for (const e of entries) {
    const label = (e?.label ?? "").toString().trim();
    const address = normalizeAddress(e?.address);
    if (!label || !isValidAddressShape(address)) continue; // 不正なエントリはスキップ
    list.push({ id: crypto.randomUUID(), label, address });
  }

  saveRaw(list);
}

/* ============================================================
   表示
============================================================ */
function shortAddr(addr) {
  if (!addr) return "---";
  return addr.length > 16 ? `${addr.slice(0, 6)}...${addr.slice(-6)}` : addr;
}

function renderAddressBookList() {
  const el = document.getElementById("address-book-list");
  if (!el) return;

  const list = loadRaw();

  if (list.length === 0) {
    el.innerHTML = `<div style="color:#94a3b8;">登録されているアドレスはありません</div>`;
    return;
  }

  el.innerHTML = list
    .map(
      (e) => `
    <div class="account-row">
      <div class="account-row-main">
        <div class="account-row-label">${e.label}</div>
        <div class="account-row-sub">${shortAddr(e.address)}</div>
      </div>
      <div class="account-row-actions">
        <button class="copy-btn" data-action="copy" data-id="${e.id}" title="アドレスをコピー">🗒️</button>
        <button class="account-hide-btn" data-action="edit" data-id="${e.id}">✏️ 編集</button>
        <button class="account-hide-btn" data-action="delete" data-id="${e.id}">🗑 削除</button>
      </div>
    </div>
  `
    )
    .join("");
}

window.W.addressBook = {
  getAddressBook,
  upsertAddressBookEntry,
  deleteAddressBookEntry,
  exportAddressBookPlain,
  replaceAddressBook,
  renderAddressBookList,
  normalizeAddress,
  isValidAddressShape
};

})();
