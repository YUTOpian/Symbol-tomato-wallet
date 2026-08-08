// recipientInfo.js
// 送金先アドレス入力時に、その場でアドレスの状態を表示する。
//
// 目的:
//   「XEMBookで送金先を事前に確認してから送る」という運用を、
//   ウォレット単体で完結できるようにする。
//   銀行振込で相手名義が表示されるのと同じ感覚で、
//   宛先の「見覚えのある情報」を送信前に確認できるようにする。
//
// 表示する内容:
//   - アドレス形式が正しいか / 自分自身への送金でないか
//   - チェーン上に存在するアカウントか(受信履歴があるか)
//   - 存在する場合:
//       - 紐づくネームスペース名(あれば。銀行の「口座名義」に相当)
//       - 保有XYM残高 / 保有モザイク数
//       - 最終アクティビティ日時
//       - 直近の送受信履歴(簡易プレビュー)

const {appState} = W.config;
const {formatMosaicAmount, hexToBytes} = W.utils;
const {subscribe, addCallback} = W.ws;

const DEBOUNCE_MS = 500;
const XYM_IDS = ["72C0212E67A08BCE", "6BED913FA20223F8"];
const HISTORY_LIMIT = 4;
const SILENT_REFRESH_MS = 20000; // WSが効かない場合のフォールバック間隔

let debounceTimer = null;
let currentRequestId = 0;
let silentRefreshTimer = null;
const liveSubscribedAddresses = new Set();

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
  stopSilentRefresh();
}

function stopSilentRefresh() {
  if (silentRefreshTimer) {
    clearInterval(silentRefreshTimer);
    silentRefreshTimer = null;
  }
}

function startSilentRefresh(address) {
  stopSilentRefresh();
  silentRefreshTimer = setInterval(() => {
    const input = document.getElementById("tx-recipient");
    if (input && normalizeAddress(input.value) === address) {
      lookup(address, { silent: true });
    } else {
      stopSilentRefresh();
    }
  }, SILENT_REFRESH_MS);
}

/* ============================================================
   このアドレス宛の着金をWebSocketで検知したら、その場で再取得する
   (ページを開いたまま、相手の残高・履歴の変化にすぐ気付けるように)
============================================================ */
function subscribeForLiveUpdates(address) {
  if (liveSubscribedAddresses.has(address)) return;
  liveSubscribedAddresses.add(address);

  subscribe(`confirmedAdded/${address}`);
  addCallback(`confirmedAdded/${address}`, () => {
    const input = document.getElementById("tx-recipient");
    if (input && normalizeAddress(input.value) === address) {
      lookup(address, { silent: true });
    }
  });
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

// REST APIのアドレス表現は 16進(48文字) と base32(39文字) が混在するため統一する
function normalizeMaybeHexAddress(addr) {
  if (!addr || typeof addr !== "string") return null;
  if (addr.length === 39) return addr.toUpperCase();
  if (addr.length === 48 && /^[0-9A-Fa-f]+$/.test(addr) && appState.sdkSymbol) {
    try {
      return new appState.sdkSymbol.Address(hexToBytes(addr)).toString();
    } catch {
      return addr;
    }
  }
  return addr;
}

/* ============================================================
   宛先に紐づくネームスペース名を取得する(銀行の「口座名義」相当)
   → その住所を所有し、かつ自分自身にアドレスエイリアスを設定している
     ネームスペースだけを対象にする(いわゆる「〇〇.symbol」名義表示)
============================================================ */
async function fetchLinkedNamespaceNames(address, signal) {
  try {
    const params = new URLSearchParams({ ownerAddress: address, pageSize: 100 });
    const res = await fetch(`${appState.NODE}/namespaces?${params}`, { signal });
    if (!res.ok) return [];
    const json = await res.json();
    const items = json.data ?? [];

    const ownIdOf = (ns) => (ns.depth === 1 ? ns.level0 : ns.depth === 2 ? ns.level1 : ns.level2);

    const aliased = items.filter((item) => {
      const alias = item.namespace?.alias;
      if (!alias || alias.type !== 2) return false; // 2 = Address Alias
      return normalizeMaybeHexAddress(alias.address) === address;
    });

    if (aliased.length === 0) return [];

    const ids = aliased.map((item) => ownIdOf(item.namespace));
    const namesRes = await fetch(`${appState.NODE}/namespaces/names`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespaceIds: ids }),
      signal,
    });
    const namesJson = await namesRes.json();
    return (namesJson || []).map((n) => n.name).filter(Boolean);
  } catch {
    return [];
  }
}

/* ============================================================
   直近の送受信履歴(簡易プレビュー)を取得する
============================================================ */
async function fetchHistoryPreview(address, signal) {
  try {
    const params = new URLSearchParams({
      address,
      order: "desc",
      pageSize: HISTORY_LIMIT,
    });
    const res = await fetch(`${appState.NODE}/transactions/confirmed?${params}`, { signal });
    if (!res.ok) return [];
    const json = await res.json();
    const items = json.data ?? [];

    return items.map((item) => {
      const tx = item.transaction;
      const meta = item.meta;
      const recipientAddr = normalizeMaybeHexAddress(tx.recipientAddress);
      const isReceive = recipientAddr === address;

      const mosaics = tx.mosaics || [];
      const xymEntry = mosaics.find((m) => XYM_IDS.includes(String(m.id).toUpperCase()));
      let amountText;
      if (xymEntry) {
        amountText = formatMosaicAmount(xymEntry.amount, 6) + " XYM";
      } else if (mosaics.length > 0) {
        amountText = `モザイク ${mosaics.length}種`;
      } else {
        amountText = "取引(モザイク移動なし)";
      }

      const ts = meta?.timestamp;
      const timeMs = ts && appState.epochAdjustment ? Number(appState.epochAdjustment) * 1000 + Number(ts) : null;

      return { isReceive, amountText, timeMs };
    });
  } catch {
    return [];
  }
}

function renderHistoryHtml(history) {
  if (history.length === 0) {
    return `<div class="recipient-info-history-empty">まだ取引履歴がありません</div>`;
  }
  return history
    .map((h) => {
      const dirLabel = h.isReceive ? "↙ 受信" : "↗ 送信";
      const dirClass = h.isReceive ? "recipient-info-history-in" : "recipient-info-history-out";
      const timeText = formatRelativeTime(h.timeMs) ?? "---";
      return `<div class="recipient-info-history-row ${dirClass}"><span>${dirLabel}</span><span>${h.amountText}</span><span class="recipient-info-time">${timeText}</span></div>`;
    })
    .join("");
}

async function lookup(rawAddress, { silent = false } = {}) {
  const requestId = ++currentRequestId;
  const address = normalizeAddress(rawAddress);

  if (!address) {
    clear();
    return;
  }

  if (!isValidLength(address)) {
    stopSilentRefresh();
    render(
      `<div class="recipient-info-row">⚠️ アドレスの形式が正しくありません（39文字）</div>`,
      "warn"
    );
    return;
  }

  if (appState.currentAddress && address === appState.currentAddress.toString()) {
    stopSilentRefresh();
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
    stopSilentRefresh();
    render(`<div class="recipient-info-row">⚠️ アドレスのチェックサムが正しくありません</div>`, "warn");
    return;
  }

  if (!silent) {
    stopSilentRefresh();
    render(`<div class="recipient-info-row recipient-info-loading">🔎 送金先を確認しています…</div>`, "loading");
  }

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

    // ネームスペース名と履歴は並行して取得する
    const [namespaceNames, history] = await Promise.all([
      fetchLinkedNamespaceNames(address, controller.signal),
      fetchHistoryPreview(address, controller.signal),
    ]);

    if (requestId !== currentRequestId) return;

    const lastActivityMs = history[0]?.timeMs ?? null;
    const activityText = lastActivityMs
      ? `最終アクティビティ: ${formatRelativeTime(lastActivityMs)}`
      : "最終アクティビティ: 不明";

    const namespaceHtml = namespaceNames.length
      ? `<div class="recipient-info-namespace">🏷 ネームスペース: <b>${namespaceNames.join(", ")}</b></div>`
      : "";

    render(
      `<div class="recipient-info-row recipient-info-title">🍅 有効なアカウントです</div>` +
      namespaceHtml +
      `<div class="recipient-info-sub">保有残高: <b>${xymText}</b>${otherMosaicCount ? ` ／ 他モザイク ${otherMosaicCount}種` : ""}</div>` +
      `<div class="recipient-info-sub">${activityText}</div>` +
      `<div class="recipient-info-history">` +
      `<div class="recipient-info-history-title">直近の送受信</div>` +
      renderHistoryHtml(history) +
      `</div>`,
      "ok"
    );

    // 表示中に着金があったらその場で更新されるようにしておく
    subscribeForLiveUpdates(address);
    startSilentRefresh(address);
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
function initRecipientInfoWatcher() {
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

window.W.recipientInfo = {
  initRecipientInfoWatcher
};
