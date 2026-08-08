// txStatusTracker.js
// 「送りっぱなし」をやめるための、着金・承認確認トラッカー。
//
// ノードへアナウンスした後、そのトランザクションが
//   ノード受理 → 未承認プール → ブロック承認(確定)
// のどの段階にあるかをリアルタイムに追跡し、機能ごとの追跡欄に表示する。
// 送金・複数送信・モザイク作成・ネームスペース登録・メタデータ登録・
// マルチシグ設定・アポスティーユ作成など、アナウンスを伴うあらゆる機能から呼べる
// 共通モジュール。カードのタイトルは呼び出し側が指定する(例:「送金の追跡」
// 「モザイク作成の追跡」)。
//
// WebSocket(confirmedAdded/unconfirmedAdded)を主に使いつつ、
// ポーリング(/transactionStatus/{hash})でも並行して確認することで、
// WSが切断・再接続中でも取りこぼさないようにしている。
//
// 表示は直近3件のみ、それ以上は「もっと見る」で直近10件まで展開する。
// 送金(#tx-tracking)のみ、直近の記録をlocalStorageに保存しリロード後も
// 表示・追跡を継続する。それ以外の機能はリロードで消えてよい一時的な
// 表示として扱う(セッション内のみ)。

const {appState, NetworkType} = W.config;
const {addCallback} = W.ws;

const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15分でポーリングは打ち切り(明示的に諦める)
const VISIBLE_COLLAPSED = 3;
const MAX_STORED = 10;
const STORAGE_PREFIX = "tomatoWallet:txTracking:";

// リロードをまたいで保存・復元する対象のコンテナ(送金のみ)
const PERSISTED_CONTAINER_IDS = ["tx-tracking"];

// containerId ごとの状態: { records: [...], expanded: boolean, persist: boolean }
const trackerState = {};

// 二重にポーリング/WS処理を開始しないための管理(hash単位)
const activeHashes = new Set();

/* ============================================================
   永続化(送金のみ)
============================================================ */
function storageKey(containerId) {
  return STORAGE_PREFIX + containerId;
}

function loadStoredRecords(containerId) {
  try {
    const raw = localStorage.getItem(storageKey(containerId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveStoredRecords(containerId, records) {
  try {
    localStorage.setItem(storageKey(containerId), JSON.stringify(records.slice(0, MAX_STORED)));
  } catch (e) {
    console.warn("txStatusTracker: localStorage保存に失敗しました", e);
  }
}

function getState(containerId) {
  if (!trackerState[containerId]) {
    const persist = PERSISTED_CONTAINER_IDS.includes(containerId);
    trackerState[containerId] = {
      records: persist ? loadStoredRecords(containerId) : [],
      expanded: false,
      persist,
    };
  }
  return trackerState[containerId];
}

/* ============================================================
   描画
============================================================ */
function container(containerId) {
  return document.getElementById(containerId || "tx-tracking");
}

function getExplorerUrl(hash) {
  return appState.networkType === NetworkType.TESTNET
    ? `https://testnet.symbol.fyi/transactions/${hash}`
    : `https://symbol.fyi/transactions/${hash}`;
}

function stepHtml(label, state) {
  // state: "done" | "active" | "pending" | "failed"
  const icon =
    state === "done" ? "🍅" :
    state === "failed" ? "✖" :
    state === "active" ? "🌱" : "○";

  return `<div class="track-step track-step-${state}"><span class="track-step-icon">${icon}</span><span>${label}</span></div>`;
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
    state === "failed" ? "failed" : "pending";

  return [
    stepHtml("ノードへ送信", s1),
    stepHtml("未承認プールで検知", s2),
    stepHtml("ブロックで承認(確定)", s3),
  ].join("");
}

function footerFor(state, detail) {
  if (state === "confirmed") {
    return `<div class="track-footer track-footer-ok">✅ ブロックに取り込まれ、確定しました。</div>`;
  }
  if (state === "failed") {
    return `<div class="track-footer track-footer-fail">✖ トランザクションが失敗しました${detail ? `（${detail}）` : ""}。</div>`;
  }
  if (state === "timeout") {
    return `<div class="track-footer track-footer-warn">⏳ まだ承認が確認できていません。ネットワークが混雑している可能性があります。Explorerのリンクから状況をご確認ください。</div>`;
  }
  return `<div class="track-footer track-footer-pending">承認を待っています…</div>`;
}

function cardHtml(record) {
  const { hash, recipient, targetLabel, mosaicLabel, amountText, state, detail, label } = record;
  const title = label || "送金の追跡";

  const targetLine = recipient
    ? `<div class="track-card-sub">${targetLabel || "宛先"}: <span class="track-mono">${recipient}</span></div>`
    : "";
  const detailLine = (mosaicLabel || amountText)
    ? `<div class="track-card-sub">${mosaicLabel || ""} ${amountText || ""}</div>`
    : "";

  return `
    <div class="track-card">
      <div class="track-card-head">
        <span class="track-card-title">${title}</span>
        <a class="track-card-link" href="${getExplorerUrl(hash)}" target="_blank" rel="noopener">Explorerで見る ↗</a>
      </div>
      <div class="track-card-sub">Hash: <span class="track-mono">${hash}</span></div>
      ${targetLine}
      ${detailLine}
      <div class="track-steps">${buildSteps(state)}</div>
      ${footerFor(state, detail)}
    </div>
  `;
}

function renderList(containerId) {
  const el = container(containerId);
  if (!el) return;

  const st = getState(containerId);
  const visibleCount = st.expanded ? Math.min(MAX_STORED, st.records.length) : Math.min(VISIBLE_COLLAPSED, st.records.length);
  const visible = st.records.slice(0, visibleCount);
  const remaining = st.records.length - visibleCount;

  let html = visible.map(cardHtml).join("");

  if (st.records.length > VISIBLE_COLLAPSED) {
    if (!st.expanded) {
      html += `<button type="button" class="track-more-btn" data-track-toggle="${containerId}">もっと見る（あと${remaining}件）</button>`;
    } else if (remaining <= 0) {
      html += `<button type="button" class="track-more-btn" data-track-toggle="${containerId}">閉じる</button>`;
    }
  }

  el.innerHTML = html;

  const toggleBtn = el.querySelector("[data-track-toggle]");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      st.expanded = !st.expanded;
      renderList(containerId);
    });
  }
}

/* ============================================================
   レコードの追加・更新
============================================================ */
function upsertRecord(containerId, hash, patch) {
  const st = getState(containerId);
  let record = st.records.find((r) => r.hash === hash);

  if (!record) {
    record = { hash, startedAt: Date.now(), state: "announced", ...patch };
    st.records.unshift(record);
    if (st.records.length > MAX_STORED) st.records.length = MAX_STORED;
  } else {
    Object.assign(record, patch);
  }

  if (st.persist) saveStoredRecords(containerId, st.records);
  renderList(containerId);
  return record;
}

/* ============================================================
   追跡本体(WebSocket + ポーリング)
============================================================ */
function beginTracking({ hash, containerId, startedAt }) {
  if (activeHashes.has(hash)) return;
  activeHashes.add(hash);

  let resolved = false;

  const update = (state, detail) => {
    upsertRecord(containerId, hash, { state, detail });
  };

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
  const pollStartedAt = startedAt || Date.now();

  const poll = async () => {
    if (resolved) return;

    if (Date.now() - pollStartedAt > POLL_TIMEOUT_MS) {
      update("timeout");
      return;
    }

    if (!appState.NODE) {
      setTimeout(poll, POLL_INTERVAL_MS);
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

/* ============================================================
   アナウンス済みトランザクションの追跡を開始する
   opts:
     hash          : トランザクションハッシュ(必須)
     containerId   : 表示先の要素id(省略時 "tx-tracking")
     label         : カードタイトル(省略時 "送金の追跡")
     recipient     : 対象の説明(宛先アドレス、ネームスペース名など。省略可)
     targetLabel   : recipientの行ラベル(省略時 "宛先")
     mosaicLabel, amountText : 補足の1行(モザイク名・数量など)
============================================================ */
function trackOutgoingTransaction(opts) {
  const {
    hash,
    recipient,
    targetLabel,
    mosaicLabel = "",
    amountText = "",
    containerId = "tx-tracking",
    label,
  } = opts;
  if (!hash) return;

  const record = upsertRecord(containerId, hash, {
    recipient,
    targetLabel,
    mosaicLabel,
    amountText,
    label,
    state: "announced",
  });

  beginTracking({ hash, containerId, startedAt: record.startedAt });
}

/* ============================================================
   リロード後の復元(送金のみ):
   保存済みの記録をすぐ描画し、まだ確定していないものは追跡を再開する。
   NODE準備が整うまで(ログイン完了まで)少し待ってから追跡を再開する。
============================================================ */
function waitForNodeReady(cb, elapsed = 0) {
  if (appState.NODE) {
    cb();
    return;
  }
  if (elapsed > 60000) return; // 1分待っても未接続なら諦める(手動操作を待つ)
  setTimeout(() => waitForNodeReady(cb, elapsed + 500), 500);
}

function resumeFromStorage(containerId) {
  const st = getState(containerId);
  renderList(containerId); // まずキャッシュされた内容をそのまま表示する

  const pending = st.records.filter((r) => r.state !== "confirmed" && r.state !== "failed");
  if (pending.length === 0) return;

  waitForNodeReady(() => {
    pending.forEach((record) => {
      beginTracking({ hash: record.hash, containerId, startedAt: record.startedAt });
    });
  });
}

PERSISTED_CONTAINER_IDS.forEach(resumeFromStorage);

window.W.txStatusTracker = {
  trackOutgoingTransaction
};
