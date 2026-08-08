// multisendRecipientCheck.js
// 複数送信(手動 / CSV)向けの、送信前まとめアドレスチェック。
//
// 単発送金の recipientInfo.js と同じ考え方(宛先を送信前に確認する)を、
// 行数が多い複数送信でも成立させるためのモジュール。
// 1件ずつ入力のたびに問い合わせると件数分だけノードへ負荷がかかるため、
// 「内容を確認する」タイミングでまとめて・並列数を抑えて確認する方式にしている。

const {appState} = W.config;
const {formatMosaicAmount} = W.utils;

const XYM_IDS = ["72C0212E67A08BCE", "6BED913FA20223F8"];
const CONCURRENCY = 5;

function normalizeAddress(raw) {
  return (raw || "").trim().toUpperCase().replace(/-/g, "");
}

async function checkOneAddress(rawAddress) {
  const address = normalizeAddress(rawAddress);

  if (!address) {
    return { status: "empty" };
  }
  if (address.length !== 39) {
    return { status: "invalid" };
  }
  if (appState.currentAddress && address === appState.currentAddress.toString()) {
    return { status: "self" };
  }

  try {
    // eslint-disable-next-line no-new
    new appState.sdkSymbol.Address(address);
  } catch {
    return { status: "invalid" };
  }

  try {
    const res = await fetch(new URL("/accounts/" + address, appState.NODE));

    if (res.status === 404) {
      return { status: "new" };
    }
    if (!res.ok) {
      return { status: "error" };
    }

    const json = await res.json();
    const mosaics = json.account?.mosaics || [];
    const xymEntry = mosaics.find((m) => XYM_IDS.includes(String(m.id).toUpperCase()));
    const xymText = xymEntry ? formatMosaicAmount(xymEntry.amount, 6) + " XYM" : "0 XYM";

    return { status: "ok", xymText };
  } catch (e) {
    console.warn("multisend recipient check error:", address, e);
    return { status: "error" };
  }
}

/* ============================================================
   並列数を抑えつつ、複数アドレスをチェックする
============================================================ */
async function checkAddressesPooled(addresses) {
  const results = new Array(addresses.length);
  let cursor = 0;

  async function worker() {
    while (cursor < addresses.length) {
      const i = cursor++;
      results[i] = await checkOneAddress(addresses[i]);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, worker);
  await Promise.all(workers);
  return results;
}

function badgeHtml(result) {
  switch (result.status) {
    case "ok":
      return `<div class="ms-row-badge ms-badge-ok">🍅 有効なアカウント（残高: ${result.xymText}）</div>`;
    case "new":
      return `<div class="ms-row-badge ms-badge-new">🌱 未使用アドレス（取引履歴なし。入力ミスにご注意）</div>`;
    case "self":
      return `<div class="ms-row-badge ms-badge-warn">🍅 自分自身のアドレスです</div>`;
    case "invalid":
      return `<div class="ms-row-badge ms-badge-warn">⚠️ アドレスの形式が正しくありません</div>`;
    case "empty":
      return `<div class="ms-row-badge ms-badge-warn">⚠️ アドレスが未入力です</div>`;
    default:
      return `<div class="ms-row-badge ms-badge-warn">⚠️ 確認に失敗しました（ネットワークエラー）</div>`;
  }
}

/* ============================================================
   画面上の .multisend-row をすべて読み取り、まとめてチェックして
   各行に結果バッジを表示する。
   戻り値: { total, okCount, newCount, warnCount }
============================================================ */
async function checkMultisendRows() {
  const rowEls = Array.from(document.querySelectorAll(".multisend-row"));
  const addresses = rowEls.map((row) => row.querySelector(".ms-address")?.value ?? "");

  rowEls.forEach((row) => {
    const badge = row.querySelector(".ms-row-badge");
    if (badge) badge.innerHTML = "🔎 確認中…";
  });

  const results = await checkAddressesPooled(addresses);

  let okCount = 0;
  let newCount = 0;
  let warnCount = 0;

  results.forEach((result, i) => {
    const row = rowEls[i];
    let badge = row.querySelector(".ms-row-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "ms-row-badge";
      row.appendChild(badge);
    }
    badge.outerHTML = badgeHtml(result);

    if (result.status === "ok") okCount++;
    else if (result.status === "new") newCount++;
    else warnCount++;
  });

  return { total: results.length, okCount, newCount, warnCount };
}

window.W.multisendRecipientCheck = {
  checkMultisendRows
};
