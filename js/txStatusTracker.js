// txStatusTracker.js
// 「送りっぱなし」をやめるための、送金の着金確認トラッカー。
//
// ノードへアナウンスした後、そのトランザクションが
//   ノード受理 → 未承認プール → ブロック承認(確定)
// のどの段階にあるかをリアルタイムに追跡し、#tx-tracking に表示する。
//
// WebSocket(confirmedAdded/unconfirmedAdded)を主に使いつつ、
// ポーリング(/transactionStatus/{hash})でも並行して確認することで、
// WSが切断・再接続中でも取りこぼさないようにしている。

import { appState, NetworkType } from "./config.js";
import { addCallback } from "./ws.js";

const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15分でポーリングは打ち切り(明示的に諦める)

// 二重に「確認済み」処理をしないための管理
const trackedHashes = new Set();
let wsHooksRegisteredForAddress = null;

function container(containerId) {
  return document.getElementById(containerId || "tx-tracking");
}

function getExplorerUrl(hash) {
  return appState.networkType === NetworkType.TESTNET
    ? `https://testnet.symbol.fyi/transactions/${hash}`
    : `https://symbol.fyi/transactions/${hash}`;
}

function cardId(hash) {
  return `tx-track-${hash}`;
}

function stepHtml(step, label, state) {
  // state: "done" | "active" | "pending" | "failed"
  const icon =
    state === "done" ? "🍅" :
    state === "failed" ? "✖" :
    state === "active" ? "🌱" : "○";

  return `<div class="track-step track-step-${state}"><span class="track-step-icon">${icon}</span><span>${label}</span></div>`;
}

function renderCard({ hash, recipient, mosaicLabel, amountText, steps, footerHtml, containerId }) {
  const el = container(containerId);
  if (!el) return;

  const existing = document.getElementById(cardId(hash));
  const html = `
    <div class="track-card" id="${cardId(hash)}">
      <div class="track-card-head">
        <span class="track-card-title">送金の追跡</span>
        <a class="track-card-link" href="${getExplorerUrl(hash)}" target="_blank" rel="noopener">Explorerで見る ↗</a>
      </div>
      <div class="track-card-sub">Hash: <span class="track-mono">${hash}</span></div>
      <div class="track-card-sub">宛先: <span class="track-mono">${recipient}</span></div>
      <div class="track-card-sub">${mosaicLabel} ${amountText}</div>
      <div class="track-steps">${steps}</div>
      ${footerHtml || ""}
    </div>
  `;

  if (existing) {
    existing.outerHTML = html;
  } else {
    el.insertAdjacentHTML("afterbegin", html);
  }
}

function buildSteps(state) {
  // state: "announced" | "unconfirmed" | "confirmed" | "failed" | "timeout"
  const s1 = "done"; // ノードへの送信は常に完了している状態でこの関数が呼ばれる
  const s2 =
    state === "announced" ? "active" :
    (state === "unconfirmed" || state === "confirmed") ? "done" :
    state === "failed" ? "failed" : "active";
  const s3 =
    state === "confirmed" ? "done" :
    state === "failed" ? "failed" :
    state === "timeout" ? "pending" : "pending";

  return [
    stepHtml(1, "ノードへ送信", s1),
    stepHtml(2, "未承認プールで検知", s2),
    stepHtml(3, "ブロックで承認(着金確定)", s3),
  ].join("");
}

function footerFor(state, detail) {
  if (state === "confirmed") {
    return `<div class="track-footer track-footer-ok">✅ ブロックに取り込まれ、着金が確定しました。</div>`;
  }
  if (state === "failed") {
    return `<div class="track-footer track-footer-fail">✖ トランザクションが失敗しました${detail ? `（${detail}）` : ""}。</div>`;
  }
  if (state === "timeout") {
    return `<div class="track-footer track-footer-warn">⏳ まだ承認が確認できていません。ネットワークが混雑している可能性があります。Explorerのリンクから状況をご確認ください。</div>`;
  }
  return `<div class="track-footer track-footer-pending">承認を待っています…</div>`;
}

/* ============================================================
   出金トランザクションの追跡を開始する
   opts: { hash, recipient, mosaicLabel, amountText }
============================================================ */
export function trackOutgoingTransaction(opts) {
  const { hash, recipient, mosaicLabel = "", amountText = "", containerId } = opts;
  if (!hash || trackedHashes.has(hash)) return;
  trackedHashes.add(hash);

  let resolved = false;

  const update = (state, detail) => {
    renderCard({
      hash,
      recipient,
      mosaicLabel,
      amountText,
      steps: buildSteps(state),
      footerHtml: footerFor(state, detail),
      containerId,
    });
  };

  update("announced");

  // ---- WebSocket経由(即時反映) ----
  const myAddress = appState.currentAddress?.toString();
  if (myAddress) {
    addCallback(`unconfirmedAdded/${myAddress}`, (payload) => {
      if (resolved) return;
      if (payload?.data?.meta?.hash === hash) {
        update("unconfirmed");
      }
    });
    addCallback(`confirmedAdded/${myAddress}`, (payload) => {
      if (payload?.data?.meta?.hash === hash) {
        resolved = true;
        update("confirmed");
      }
    });
  }

  // ---- ポーリング経由(WS取りこぼし対策・フォールバック) ----
  const startedAt = Date.now();

  const poll = async () => {
    if (resolved) return;

    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      update("timeout");
      return;
    }

    try {
      const res = await fetch(new URL(`/transactionStatus/${hash}`, appState.NODE));
      if (res.ok) {
        const json = await res.json();
        const group = json.group;

        if (group === "confirmed") {
          resolved = true;
          update("confirmed");
          return;
        }
        if (group === "failed") {
          resolved = true;
          update("failed", json.status);
          return;
        }
        if (group === "unconfirmed" || group === "partial") {
          update("unconfirmed");
        }
      }
    } catch (e) {
      // ネットワーク瞬断などは無視して次のポーリングへ
      console.warn("txStatusTracker poll error:", e);
    }

    setTimeout(poll, POLL_INTERVAL_MS);
  };

  setTimeout(poll, POLL_INTERVAL_MS);
}
