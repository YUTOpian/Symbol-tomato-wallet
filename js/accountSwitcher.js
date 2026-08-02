// accountSwitcher.js
// アカウント切替・非表示リストの描画

import { appState } from "./config.js";

function shortAddr(addr) {
  if (!addr) return "---";
  return addr.length > 16 ? `${addr.slice(0, 6)}...${addr.slice(-6)}` : addr;
}

function sourceLabel(source) {
  if (source === "sss") return "SSS Extension";
  if (source === "mnemonic") return "ニーモニック由来";
  if (source === "privateKey") return "秘密鍵インポート";
  return source;
}

export function updateSwitcherVisibility() {
  const btn = document.getElementById("account-switch-btn");
  if (!btn) return;
  const show = appState.accounts.length > 0 && appState.authMode !== "sss";
  btn.style.display = show ? "inline-flex" : "none";
}

/* ============================================================
   アカウント切替画面の一覧(非表示のものは出さない)
============================================================ */
export function renderAccountSwitcherList() {
  const el = document.getElementById("account-switcher-list");
  if (!el) return;

  const visible = appState.accounts.filter((a) => !a.hidden);

  if (visible.length === 0) {
    el.innerHTML = `<div style="color:#94a3b8;">表示できるアカウントがありません（非表示のアカウントを管理から確認できます）</div>`;
    return;
  }

  el.innerHTML = visible
    .map(
      (a) => `
    <div class="account-row ${a.id === appState.activeAccountId ? "active" : ""}">
      <div class="account-row-main" data-action="switch" data-id="${a.id}">
        <div class="account-row-label">${a.label}${a.id === appState.activeAccountId ? " ✅" : ""}</div>
        <div class="account-row-sub">${sourceLabel(a.source)} ・ ${shortAddr(a.address)}</div>
      </div>
      <button class="account-hide-btn" data-action="hide" data-id="${a.id}">非表示</button>
    </div>
  `
    )
    .join("");
}

/* ============================================================
   非表示アカウント一覧(再表示ボタン付き)
============================================================ */
export function renderHiddenAccountList() {
  const el = document.getElementById("hidden-account-list");
  if (!el) return;

  const hidden = appState.accounts.filter((a) => a.hidden);

  if (hidden.length === 0) {
    el.innerHTML = `<div style="color:#94a3b8;">非表示のアカウントはありません</div>`;
    return;
  }

  el.innerHTML = hidden
    .map(
      (a) => `
    <div class="account-row">
      <div class="account-row-main">
        <div class="account-row-label">${a.label}</div>
        <div class="account-row-sub">${sourceLabel(a.source)} ・ ${shortAddr(a.address)}</div>
      </div>
      <button class="account-hide-btn" data-action="unhide" data-id="${a.id}">再表示</button>
    </div>
  `
    )
    .join("");
}

/* ============================================================
   ニーモニックで追加する際の、未使用アカウントインデックス候補
============================================================ */
export function nextMnemonicAccountIndex() {
  const used = appState.accounts
    .filter((a) => a.source === "mnemonic")
    .map((a) => a.accountIndex ?? 0);
  if (used.length === 0) return 0;
  return Math.max(...used) + 1;
}
