(function () {
"use strict";

// dataPage.js
// 「データ」画面: アカウントの詳細情報とSymbolネットワーク統計をまとめて表示する

const {appState, NetworkType, getXymMosaicIdHex} = W.config;
const {estimateRootNamespaceRentalFee, estimateSubNamespaceRentalFee, estimateMosaicRentalFee} = W.rentalFees;
const {fetchOwnedNamespaceOptions} = W.namespace;
const {getBlockTimestamp} = W.ws;

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

  // 重要度(ネットワーク全体のtotalChainImportanceに対する割合を、XEMBookと同じ小数表記で表示)
  try {
    const res = await fetch(new URL("/accounts/" + address, appState.NODE));
    if (res.status === 404) {
      setText("data-account-importance", "0.0000000000（未使用アドレス）");
    } else {
      const json = await res.json();
      const importance = Number(json.account?.importance ?? 0);

      try {
        const propsRes = await fetch(new URL("/network/properties", appState.NODE));
        const propsJson = await propsRes.json();

        // chainプロパティの数値は "8'999'999'998'000000" のように
        // アポストロフィ区切りの文字列で返ってくるため、Number()に渡す前に取り除く
        const totalChainImportanceRaw = String(propsJson.chain?.totalChainImportance ?? "").replace(/'/g, "");
        const totalChainImportance = Number(totalChainImportanceRaw);

        if (Number.isFinite(totalChainImportance) && totalChainImportance > 0) {
          setText("data-account-importance", (importance / totalChainImportance).toFixed(10));
        } else {
          throw new Error("totalChainImportanceが取得できません");
        }
      } catch (e2) {
        console.warn("totalChainImportance取得失敗:", e2);
        setText("data-account-importance", "取得失敗");
      }
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
  } catch (e) {
    console.warn("チェーン情報取得失敗:", e);
    setText("data-chain-height", "取得失敗");
    setText("data-chain-finalized-height", "取得失敗");
  }
}

// 目安手数料表示用の参考トランザクションサイズ(byte)
// メッセージなしの単純なXYM送金トランザクション相当(settings.jsのREF_TX_SIZEと同じ考え方)
const REF_TX_SIZE = 176;

function estimateFeeXymText(multiplier) {
  return ((multiplier * REF_TX_SIZE) / 1_000_000).toLocaleString("ja-JP", {
    maximumFractionDigits: 6,
  });
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
    setText("data-fee-transfer-median", median != null ? `約 ${estimateFeeXymText(median)} XYM` : "---");
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
   直近24時間の統計: 平均ブロック生成間隔 / XYM総移動量 / 送金件数
   ・現在の高さ/タイムスタンプから24時間前に相当するブロック高を、
     30秒/ブロックの目安を起点にした二分探索で特定する。
   ・平均ブロック生成間隔 = (終了ブロックの時刻 - 開始ブロックの時刻) ÷ ブロック数。
   ・対象ブロック高範囲に含まれるTransferトランザクションを新しい順に
     ページングしながら、範囲外に出た時点で打ち切って
       - 送金件数(トランザクション件数)
       - XYM総移動量(各トランザクションのXYMモザイク数量の合計)
     をあわせて集計する。
============================================================ */
const DAY_MS = 24 * 60 * 60 * 1000;
const TRANSFER_TX_TYPE = 16724; // Transfer
const TARGET_BLOCK_MS = 30 * 1000; // 目安のブロック生成間隔(30秒)

// currentHeight/currentRaw(現在の高さと、そのタイムスタンプ[epochAdjustment基準ms])から、
// targetRaw(24時間前に相当するタイムスタンプ)以前で最も新しいブロック高を求める
async function findHeightAtOrBeforeTimestamp(targetRaw, currentHeight, currentRaw) {
  const guessHeight = Math.min(
    currentHeight - 1,
    Math.max(1, currentHeight - Math.round((currentRaw - targetRaw) / TARGET_BLOCK_MS))
  );

  let lo = 1;
  let hi = currentHeight;
  let bestHeight = 1;

  for (let i = 0; i < 14 && lo <= hi; i++) {
    const mid = i === 0 ? guessHeight : Math.floor((lo + hi) / 2);
    const raw = await getBlockTimestamp(mid);
    if (raw == null) break;

    const rawNum = Number(raw);
    if (rawNum <= targetRaw) {
      bestHeight = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return bestHeight;
}

async function load24hSection() {
  if (!appState.NODE) return;

  setText("data-24h-block-interval", "---");
  setText("data-24h-xym-volume", "---");
  setText("data-24h-transfer-count", "---");

  try {
    const chainRes = await fetch(new URL("/chain/info", appState.NODE));
    const chainJson = await chainRes.json();
    const currentHeight = Number(chainJson.height);

    const currentRawStr = await getBlockTimestamp(currentHeight);
    if (currentRawStr == null) throw new Error("最新ブロックのタイムスタンプが取得できません");
    const currentRaw = Number(currentRawStr);
    const targetRaw = currentRaw - DAY_MS;

    const startHeight = await findHeightAtOrBeforeTimestamp(targetRaw, currentHeight, currentRaw);
    const startRawStr = await getBlockTimestamp(startHeight);
    const startRaw = Number(startRawStr ?? currentRaw);

    // 平均ブロック生成間隔
    const blockDelta = currentHeight - startHeight;
    if (blockDelta > 0) {
      const avgIntervalSec = (currentRaw - startRaw) / 1000 / blockDelta;
      setText("data-24h-block-interval", `${avgIntervalSec.toFixed(1)} 秒`);
    }

    // 送金件数・XYM総移動量(対象ブロック高範囲のTransferトランザクションを集計)
    const xymMosaicId = getXymMosaicIdHex().toUpperCase();
    let transferCount = 0;
    let xymVolumeAtomic = 0n;
    const PAGE_SIZE = 100;
    const MAX_PAGES = 50; // 過度なリクエストを防ぐための上限

    pageLoop:
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
      const params = new URLSearchParams({
        type: String(TRANSFER_TX_TYPE),
        order: "desc",
        pageNumber: String(pageNumber),
        pageSize: String(PAGE_SIZE),
      });
      const res = await fetch(`${appState.NODE}/transactions/confirmed?${params}`);
      const json = await res.json();
      const items = json.data ?? [];
      if (items.length === 0) break;

      for (const item of items) {
        const h = Number(item.meta?.height ?? 0);
        if (h > currentHeight) continue;
        if (h < startHeight) break pageLoop; // 対象範囲より古くなったら打ち切り

        transferCount++;

        const mosaics = item.transaction?.mosaics || [];
        for (const m of mosaics) {
          if (String(m.id).toUpperCase() === xymMosaicId) {
            xymVolumeAtomic += BigInt(m.amount ?? 0);
          }
        }
      }
    }

    setText("data-24h-transfer-count", `${transferCount.toLocaleString("ja-JP")} 件`);
    setText(
      "data-24h-xym-volume",
      `${(Number(xymVolumeAtomic) / 1_000_000).toLocaleString("ja-JP", { maximumFractionDigits: 6 })} XYM`
    );
  } catch (e) {
    console.warn("直近24時間の統計取得失敗:", e);
    setText("data-24h-block-interval", "取得失敗");
    setText("data-24h-xym-volume", "取得失敗");
    setText("data-24h-transfer-count", "取得失敗");
  }
}

/* ============================================================
   画面を開いたときにまとめて読み込む
============================================================ */
async function loadDataPage() {
  const statusEl = document.getElementById("data-page-status");
  if (statusEl) statusEl.textContent = "読み込み中...";

  await Promise.all([
    loadAccountSection(),
    loadChainSection(),
    loadFeeSection(),
    loadNodeSection(),
    load24hSection(),
  ]);

  if (statusEl) statusEl.textContent = "";
}

window.W.dataPage = {
  loadDataPage
};

})();
