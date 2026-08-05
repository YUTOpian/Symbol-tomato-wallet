// dataPage.js
// 「データ」画面: アカウントの詳細情報とSymbolネットワーク統計をまとめて表示する

import { appState, NetworkType } from "./config.js";
import { estimateRootNamespaceRentalFee, estimateSubNamespaceRentalFee, estimateMosaicRentalFee } from "./rentalFees.js";
import { fetchOwnedNamespaceOptions } from "./namespace.js";

// 30秒/ブロックを前提とした1年あたりのブロック数(namespace.jsのBLOCKS_PER_DAYと同じ前提)
const BLOCKS_PER_YEAR = Math.round((24 * 60 * 60) / 30 * 365);

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/* ============================================================
   アカウント情報
============================================================ */
async function loadAccountSection() {
  setText("data-account-network", appState.networkType === NetworkType.TESTNET ? "Testnet" : "Mainnet");
  setText("data-account-node", appState.NODE || "---");

  const address = appState.currentAddress?.toString();
  if (!address || !appState.NODE) {
    setText("data-account-importance", "---");
    document.getElementById("data-account-namespaces").textContent = "未接続です";
    return;
  }

  // 重要度
  try {
    const res = await fetch(new URL("/accounts/" + address, appState.NODE));
    if (res.status === 404) {
      setText("data-account-importance", "0（未使用アドレス）");
    } else {
      const json = await res.json();
      const importance = json.account?.importance ?? "0";
      setText("data-account-importance", Number(importance).toLocaleString("ja-JP"));
    }
  } catch (e) {
    console.warn("重要度取得失敗:", e);
    setText("data-account-importance", "取得失敗");
  }

  // 保有ルートネームスペース
  const nsEl = document.getElementById("data-account-namespaces");
  try {
    const options = await fetchOwnedNamespaceOptions();
    const roots = options.filter((o) => o.depth === 1);

    if (roots.length === 0) {
      nsEl.innerHTML = `<span style="font-weight:normal;color:#94a3b8;">なし</span>`;
    } else {
      nsEl.innerHTML = roots.map((r) => `<span class="data-namespace-chip">${r.name}</span>`).join("");
    }
  } catch (e) {
    console.warn("保有ネームスペース取得失敗:", e);
    nsEl.textContent = "取得に失敗しました";
  }
}

/* ============================================================
   Symbolネットワーク統計: 高さ・トランザクション数
============================================================ */
async function loadChainSection() {
  if (!appState.NODE) return;

  try {
    const res = await fetch(new URL("/chain/info", appState.NODE));
    const json = await res.json();
    const height = json.height;
    const finalizedHeight = json.latestFinalizedBlock?.height;

    setText("data-chain-height", Number(height).toLocaleString("ja-JP"));
    setText("data-chain-finalized-height", finalizedHeight != null ? Number(finalizedHeight).toLocaleString("ja-JP") : "---");

    // 最新ブロックのtotalTransactionsCount(累計トランザクション数)
    try {
      const blockRes = await fetch(new URL(`/blocks/${height}`, appState.NODE));
      const blockJson = await blockRes.json();
      const totalTx = blockJson.block?.totalTransactionsCount;
      setText("data-chain-total-tx", totalTx != null ? Number(totalTx).toLocaleString("ja-JP") : "---");
    } catch (e) {
      console.warn("合計トランザクション数取得失敗:", e);
      setText("data-chain-total-tx", "取得失敗");
    }
  } catch (e) {
    console.warn("チェーン情報取得失敗:", e);
    setText("data-chain-height", "取得失敗");
    setText("data-chain-finalized-height", "取得失敗");
    setText("data-chain-total-tx", "取得失敗");
  }
}

/* ============================================================
   手数料相場
============================================================ */
async function loadFeeSection() {
  if (!appState.NODE) return;

  try {
    const res = await fetch(new URL("/network/fees/transaction", appState.NODE));
    const json = await res.json();
    const median = json.medianFeeMultiplier ?? json.averageFeeMultiplier;
    setText("data-fee-transfer-median", median != null ? `feeMultiplier: ${median}` : "---");
  } catch (e) {
    console.warn("送金手数料相場取得失敗:", e);
    setText("data-fee-transfer-median", "取得失敗");
  }

  try {
    const yearFee = await estimateRootNamespaceRentalFee(BLOCKS_PER_YEAR);
    setText("data-fee-namespace-year", `約 ${yearFee} XYM`);
  } catch (e) {
    console.warn("ネームスペース年間手数料取得失敗:", e);
    setText("data-fee-namespace-year", "取得失敗");
  }

  try {
    const subFee = await estimateSubNamespaceRentalFee();
    setText("data-fee-sub-namespace", `${subFee} XYM`);
  } catch (e) {
    console.warn("子ネームスペースレンタル手数料取得失敗:", e);
    setText("data-fee-sub-namespace", "取得失敗");
  }

  try {
    const mosaicFee = await estimateMosaicRentalFee();
    setText("data-fee-mosaic-rental", `${mosaicFee} XYM`);
  } catch (e) {
    console.warn("モザイクレンタル手数料取得失敗:", e);
    setText("data-fee-mosaic-rental", "取得失敗");
  }
}

/* ============================================================
   ノード情報(NodeWatchの一覧をロール別に集計)
   roles はビットマスク: 1=Peer, 2=Api, 4=Voting
============================================================ */
async function loadNodeSection() {
  const isTestnet = appState.networkType === NetworkType.TESTNET;
  const base = isTestnet
    ? "https://nodewatch.symbol.tools/testnet/api/symbol/nodes/peer"
    : "https://nodewatch.symbol.tools/api/symbol/nodes/peer";

  try {
    const res = await fetch(`${base}?limit=5000`);
    const nodes = await res.json();

    if (!Array.isArray(nodes)) throw new Error("unexpected response");

    const counts = {
      total: 0,
      peer: 0,
      api: 0,
      peerApi: 0,
      voting: 0,
      peerVoting: 0,
      apiVoting: 0,
      peerApiVoting: 0,
    };

    for (const n of nodes) {
      const roles = Number(n.roles);
      if (!Number.isFinite(roles)) continue;

      counts.total++;
      const hasPeer = (roles & 1) !== 0;
      const hasApi = (roles & 2) !== 0;
      const hasVoting = (roles & 4) !== 0;

      if (hasPeer && hasApi && hasVoting) counts.peerApiVoting++;
      else if (hasApi && hasVoting) counts.apiVoting++;
      else if (hasPeer && hasVoting) counts.peerVoting++;
      else if (hasPeer && hasApi) counts.peerApi++;
      else if (hasVoting) counts.voting++;
      else if (hasApi) counts.api++;
      else if (hasPeer) counts.peer++;
    }

    setText("data-nodes-total", counts.total.toLocaleString("ja-JP"));
    setText("data-nodes-peer", counts.peer.toLocaleString("ja-JP"));
    setText("data-nodes-api", counts.api.toLocaleString("ja-JP"));
    setText("data-nodes-peer-api", counts.peerApi.toLocaleString("ja-JP"));
    setText("data-nodes-voting", counts.voting.toLocaleString("ja-JP"));
    setText("data-nodes-peer-voting", counts.peerVoting.toLocaleString("ja-JP"));
    setText("data-nodes-api-voting", counts.apiVoting.toLocaleString("ja-JP"));
    setText("data-nodes-peer-api-voting", counts.peerApiVoting.toLocaleString("ja-JP"));
  } catch (e) {
    console.warn("ノード統計取得失敗:", e);
    ["data-nodes-total", "data-nodes-peer", "data-nodes-api", "data-nodes-peer-api", "data-nodes-voting", "data-nodes-peer-voting", "data-nodes-api-voting", "data-nodes-peer-api-voting"]
      .forEach((id) => setText(id, "取得失敗"));
  }
}

/* ============================================================
   画面を開いたときにまとめて読み込む
============================================================ */
export async function loadDataPage() {
  const statusEl = document.getElementById("data-page-status");
  if (statusEl) statusEl.textContent = "読み込み中...";

  await Promise.all([
    loadAccountSection(),
    loadChainSection(),
    loadFeeSection(),
    loadNodeSection(),
  ]);

  if (statusEl) statusEl.textContent = "";
}
