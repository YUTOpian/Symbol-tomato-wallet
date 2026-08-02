// recipientInfo.js
// 送金先アドレス入力時に、その場でアドレスの状態を表示する。
//
// 目的:
//   「XEMBookで送金先を事前に確認してから送る」という運用を、
//   ウォレット単体で完結できるようにする。
//   入力ミス・宛先が未使用アドレスであることなどを、送信前に気付けるようにする。
//
// 表示する内容:
//   - アドレス形式が正しいか
//   - 自分自身への送金でないか
//   - チェーン上に存在するアカウントか(受信履歴があるか)
//   - 存在する場合: 保有XYM残高 / 保有モザイク数 / 最終アクティビティ日時

import { appState } from "./config.js";
import { formatMosaicAmount } from "./utils.js";

const DEBOUNCE_MS = 500;
const XYM_IDS = ["72C0212E67A08BCE", "6BED913FA20223F8"];

let debounceTimer = null;
let currentRequestId = 0;

function box() {
  return document.getElementById("recipient-info-box");
}

function render(html, stateClass) {
  const el = box();
  if (!el) return;
  el.innerHTML = html;
  el.className = "recipient-info-box" + (stateClass ? ` recipient-info-${stateClass}` : "");
}

function clear() {
  const el = box();
  if (!el) return;
  el.innerHTML = "";
  el.className = "recipient-info-box";
}

function normalizeAddress(raw) {
  return (raw || "").trim().toUpperCase().replace(/-/g, "");
}

function isValidLength(addr) {
  return addr.length === 39;
}

function formatRelativeTime(unixMs) {
  if (!unixMs) return null;
  const diffSec = Math.floor((Date.now() - unixMs) / 1000);
  if (diffSec < 60) return "たった今";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}時間前`;
  const days = Math.floor(diffSec / 86400);
  if (days < 365) return `${days}日前`;
  return `${Math.floor(days / 365)}年以上前`;
}

/* ============================================================
   最終アクティビティ(直近の確認済みトランザクション日時)を1件だけ取得
============================================================ */
async function fetchLastActivity(address, signal) {
  try {
    const params = new URLSearchParams({
      address,
      order: "desc",
      pageSize: 1,
    });
    const res = await fetch(`${appState.NODE}/transactions/confirmed?${params}`, { signal });
    const json = await res.json();
    const item = (json.data ?? [])[0];
    if (!item || !appState.epochAdjustment) return null;
    const ts = item.meta?.timestamp;
    if (!ts) return null;
    return Number(appState.epochAdjustment) * 1000 + Number(ts);
  } catch {
    return null;
  }
}

async function lookup(rawAddress) {
  const requestId = ++currentRequestId;
  const address = normalizeAddress(rawAddress);

  if (!address) {
    clear();
    return;
  }

  if (!isValidLength(address)) {
    render(
      `<div class="recipient-info-row">⚠️ アドレスの形式が正しくありません（39文字）</div>`,
      "warn"
    );
    return;
  }

  if (appState.currentAddress && address === appState.currentAddress.toString()) {
    render(
      `<div class="recipient-info-row">🍅 これは自分自身のアドレスです</div>`,
      "warn"
    );
    return;
  }

  if (!appState.NODE || !appState.sdkSymbol) {
    return;
  }

  // アドレスとしてSDKが受理できるか(チェックサム含む)確認
  try {
    // eslint-disable-next-line no-new
    new appState.sdkSymbol.Address(address);
  } catch {
    render(`<div class="recipient-info-row">⚠️ アドレスのチェックサムが正しくありません</div>`, "warn");
    return;
  }

  render(`<div class="recipient-info-row recipient-info-loading">🔎 送金先を確認しています…</div>`, "loading");

  const controller = new AbortController();

  try {
    const res = await fetch(new URL("/accounts/" + address, appState.NODE), {
      signal: controller.signal,
    });

    if (requestId !== currentRequestId) return; // 入力が変わった後の古いレスポンスは無視

    if (res.status === 404) {
      render(
        `<div class="recipient-info-row recipient-info-title">🌱 未使用のアドレスです</div>` +
        `<div class="recipient-info-sub">このアドレスはこれまで一度も取引履歴がありません。新規アカウント、または入力ミスの可能性があります。宛先をよくご確認ください。</div>`,
        "new"
      );
      return;
    }

    if (!res.ok) {
      render(`<div class="recipient-info-row">⚠️ 送金先情報の取得に失敗しました</div>`, "warn");
      return;
    }

    const json = await res.json();
    const account = json.account;
    const mosaics = account.mosaics || [];

    const xymEntry = mosaics.find((m) => XYM_IDS.includes(String(m.id).toUpperCase()));
    const xymText = xymEntry ? formatMosaicAmount(xymEntry.amount, 6) + " XYM" : "0 XYM";
    const otherMosaicCount = mosaics.filter((m) => !XYM_IDS.includes(String(m.id).toUpperCase())).length;

    const lastActivityMs = await fetchLastActivity(address, controller.signal);
    if (requestId !== currentRequestId) return;

    const activityText = lastActivityMs
      ? `最終アクティビティ: ${formatRelativeTime(lastActivityMs)}`
      : "最終アクティビティ: 不明";

    render(
      `<div class="recipient-info-row recipient-info-title">🍅 有効なアカウントです</div>` +
      `<div class="recipient-info-sub">保有残高: <b>${xymText}</b>${otherMosaicCount ? ` ／ 他モザイク ${otherMosaicCount}種` : ""}</div>` +
      `<div class="recipient-info-sub">${activityText}</div>`,
      "ok"
    );
  } catch (e) {
    if (e.name === "AbortError") return;
    console.warn("recipientInfo lookup error:", e);
    if (requestId === currentRequestId) {
      render(`<div class="recipient-info-row">⚠️ 送金先情報の取得に失敗しました</div>`, "warn");
    }
  }
}

function handleInput(e) {
  clearTimeout(debounceTimer);
  const value = e.target.value;
  debounceTimer = setTimeout(() => lookup(value), DEBOUNCE_MS);
}

/* ============================================================
   初期化: #tx-recipient への入力を監視する
============================================================ */
export function initRecipientInfoWatcher() {
  const input = document.getElementById("tx-recipient");
  if (!input) return;

  input.addEventListener("input", handleInput);

  // 送金画面を開き直した時に前回の表示が残らないようにする
  const observer = new MutationObserver(() => {
    const transferPage = document.getElementById("transfer-page");
    if (transferPage && transferPage.classList.contains("active") && !input.value) {
      clear();
    }
  });
  const transferPage = document.getElementById("transfer-page");
  if (transferPage) {
    observer.observe(transferPage, { attributes: true, attributeFilter: ["class", "style"] });
  }
}

initRecipientInfoWatcher();
