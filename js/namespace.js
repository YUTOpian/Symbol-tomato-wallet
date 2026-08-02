// namespace.js
// ネームスペースの登録(ルート/サブ・最大3階層)、更新(延長)、
// モザイク/アカウントへのリンク・解除、保有ネームスペース一覧の取得
//
// 参考: https://docs.symboltest.net/ja/textbook/namespaces/

import { appState } from "./config.js";
import { signAndAnnounceTx, estimateFeeFromTx } from "./auth.js";
import { estimateRootNamespaceRentalFee, estimateSubNamespaceRentalFee } from "./rentalFees.js";

export { estimateRootNamespaceRentalFee, estimateSubNamespaceRentalFee };

/* ============================================================
   このネームスペース自身のID(16進)を depth に応じて正しく取り出す
   depth=1→level0 / depth=2→level1 / depth=3→level2
   (level0は常に「ルート」のID。深い階層では別フィールドを見る必要がある)
============================================================ */
function ownIdOf(ns) {
  if (ns.depth === 1) return ns.level0;
  if (ns.depth === 2) return ns.level1;
  return ns.level2;
}

/* ============================================================
   保有ネームスペース一覧
============================================================ */

// Symbolのブロック目標間隔(秒)。メインネット/テストネットともに30秒。
const BLOCK_TARGET_SECONDS = 30;
const BLOCKS_PER_DAY = (24 * 60 * 60) / BLOCK_TARGET_SECONDS;
// 実質「無期限」とみなす閾値(uint64の最大値付近)
const ETERNAL_THRESHOLD = 18000000000000000000;

function formatRemaining(endHeight, currentHeight) {
  const end = Number(endHeight);
  if (end > ETERNAL_THRESHOLD) return "（無期限）";

  const remainingBlocks = end - currentHeight;
  if (remainingBlocks <= 0) return "（有効期限切れ）";

  const days = Math.round(remainingBlocks / BLOCKS_PER_DAY);
  return `（あと${days}日）`;
}

export async function loadOwnedNamespaces() {
  const el = document.getElementById("namespace-list");
  if (!el) return;

  el.textContent = "読み込み中...";

  try {
    const address = appState.currentAddress.toString();
    const params = new URLSearchParams({
      ownerAddress: address,
      pageSize: 100,
    });

    const [res, chainInfo] = await Promise.all([
      fetch(`${appState.NODE}/namespaces?${params}`),
      fetch(`${appState.NODE}/chain/info`).then((r) => r.json()).catch(() => null),
    ]);
    const json = await res.json();
    const items = json.data ?? [];
    const currentHeight = chainInfo ? Number(chainInfo.height) : null;

    if (items.length === 0) {
      el.innerHTML = `<div style="color:#94a3b8;">保有しているネームスペースはありません</div>`;
      return;
    }

    el.innerHTML = items
      .map((item) => {
        const ns = item.namespace;
        const level = ns.depth === 1 ? "ルート" : `サブ(レベル${ns.depth})`;
        const aliasType = ns.alias?.type;
        const aliasInfo =
          aliasType === 1
            ? `🔗 モザイクエイリアス: ${ns.alias.mosaicId}`
            : aliasType === 2
            ? `🔗 アドレスエイリアス: ${ns.alias.address}`
            : "エイリアスなし";

        const remaining = currentHeight != null ? formatRemaining(ns.endHeight, currentHeight) : "";

        return `
          <div class="harvest-history-item">
            <div>種別: ${level}</div>
            <div>NamespaceId: ${ownIdOf(ns)}</div>
            <div>${aliasInfo}</div>
            <div>失効高さ: ${ns.endHeight}${remaining}</div>
          </div>
        `;
      })
      .join("");
  } catch (e) {
    console.error("loadOwnedNamespaces error:", e);
    el.textContent = "取得に失敗しました";
  }
}

/* ============================================================
   保有ネームスペース候補の取得(共通)
   サブネームスペース登録時の親選択、リンク対象選択などで使う。
   depth(1 or 2)も一緒に返す(depth=3は親にできないため)。
============================================================ */
export async function fetchOwnedNamespaceOptions() {
  const address = appState.currentAddress.toString();
  const params = new URLSearchParams({ ownerAddress: address, pageSize: 100 });
  const res = await fetch(`${appState.NODE}/namespaces?${params}`);
  const json = await res.json();
  const items = json.data ?? [];

  if (items.length === 0) return [];

  const ids = items.map((i) => ownIdOf(i.namespace));
  const namesRes = await fetch(`${appState.NODE}/namespaces/names`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ namespaceIds: ids }),
  }).then((r) => r.json());

  const nameMap = {};
  for (const n of namesRes || []) {
    nameMap[n.id] = n.name;
  }

  return items.map((item) => ({
    id: ownIdOf(item.namespace),
    name: nameMap[ownIdOf(item.namespace)] ?? ownIdOf(item.namespace),
    depth: item.namespace.depth,
  }));
}

/* ============================================================
   サブネームスペース登録時の親選択プルダウン
   (深さ3は親にできないため depth<3 のみ候補にする)
============================================================ */
export async function populateParentNamespaceSelect() {
  const select = document.getElementById("sub-namespace-parent-select");
  if (!select) return;

  select.innerHTML = `<option value="">-- 読み込み中... --</option>`;

  try {
    const options = await fetchOwnedNamespaceOptions();
    const eligible = options.filter((o) => o.depth < 3);

    if (eligible.length === 0) {
      select.innerHTML = `<option value="">-- 親にできるネームスペースがありません --</option>`;
      return;
    }

    select.innerHTML =
      `<option value="">-- 親ネームスペースを選択 --</option>` +
      eligible
        .map((o) => `<option value="${o.id}" data-depth="${o.depth}">${o.name}（レベル${o.depth}）</option>`)
        .join("");
  } catch (e) {
    console.warn("親ネームスペース候補の取得に失敗しました", e);
    select.innerHTML = `<option value="">-- 取得に失敗しました --</option>`;
  }
}

/* ============================================================
   ルートネームスペース登録・更新(延長)
   既に自分が所有している同名のルートネームスペースに対して再度
   実行すると、有効期間が延長される(公式仕様)。サブネームスペースは
   ルートと同じ期間を共有するため個別の更新は不要。
============================================================ */
/* ============================================================
   ルートネームスペース登録・更新(延長)
   既に自分が所有している同名のルートネームスペースに対して再度
   実行すると、有効期間が延長される(公式仕様)。サブネームスペースは
   ルートと同じ期間を共有するため個別の更新は不要。
============================================================ */
function buildRootNamespaceTx(name, durationBlocks) {
  const { descriptors, models } = appState.sdkSymbol;

  const namespaceId = new models.NamespaceId(appState.sdkSymbol.generateNamespaceId(name));

  const descriptor = new descriptors.NamespaceRegistrationTransactionV1Descriptor(
    namespaceId,
    models.NamespaceRegistrationType.ROOT,
    new models.BlockDuration(BigInt(durationBlocks)),
    undefined,
    name
  );

  return appState.facade.createTransactionFromTypedDescriptor(
    descriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );
}

export function estimateRootNamespaceFee(name, durationBlocks) {
  return estimateFeeFromTx(buildRootNamespaceTx(name, durationBlocks));
}

export async function registerRootNamespace(name, durationBlocks) {
  const tx = buildRootNamespaceTx(name, durationBlocks);
  let rentalFeeXym = "---";
  try {
    rentalFeeXym = await estimateRootNamespaceRentalFee(durationBlocks);
  } catch (e) {
    console.warn("レンタル手数料の取得に失敗しました", e);
  }

  return await signAndAnnounceTx(tx, {
    typeLabel: "ネームスペース登録(ルート)",
    details: [
      { label: "ネームスペース名", value: name },
      { label: "登録期間", value: `${durationBlocks} ブロック` },
      { label: "推定レンタル手数料", value: `約 ${rentalFeeXym} XYM` },
    ],
  });
}

/* ============================================================
   サブネームスペース登録(最大3階層目まで)
============================================================ */
function buildSubNamespaceTx(parentIdHex, subName) {
  const { descriptors, models } = appState.sdkSymbol;

  const parentId = new models.NamespaceId(BigInt("0x" + parentIdHex));
  const namespaceId = new models.NamespaceId(
    appState.sdkSymbol.generateNamespaceId(subName, parentId.value)
  );

  const descriptor = new descriptors.NamespaceRegistrationTransactionV1Descriptor(
    namespaceId,
    models.NamespaceRegistrationType.CHILD,
    undefined,
    parentId,
    subName
  );

  return appState.facade.createTransactionFromTypedDescriptor(
    descriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );
}

export function estimateSubNamespaceFee(parentIdHex, subName) {
  return estimateFeeFromTx(buildSubNamespaceTx(parentIdHex, subName));
}

export async function registerSubNamespace(parentIdHex, subName) {
  const tx = buildSubNamespaceTx(parentIdHex, subName);
  let rentalFeeXym = "---";
  try {
    rentalFeeXym = await estimateSubNamespaceRentalFee();
  } catch (e) {
    console.warn("レンタル手数料の取得に失敗しました", e);
  }

  return await signAndAnnounceTx(tx, {
    typeLabel: "ネームスペース登録(サブ)",
    details: [
      { label: "親ネームスペースID", value: parentIdHex.toUpperCase() },
      { label: "サブネームスペース名", value: subName },
      { label: "推定レンタル手数料", value: `約 ${rentalFeeXym} XYM` },
    ],
  });
}

/* ============================================================
   ネームスペース ⇔ アカウント のリンク/解除
   (モザイクへのリンクは mosaic.js 側にある)
   ※ リンク先アカウント自身がAccountOperationRestrictionで
     AddressAliasTransactionをブロックしていると失敗する(仕様通り)。
============================================================ */
function buildAddressAliasTx(namespaceIdHex, targetAddress, action) {
  const { descriptors, models } = appState.sdkSymbol;

  const namespaceId = new models.NamespaceId(BigInt("0x" + namespaceIdHex));
  const address = new appState.sdkSymbol.Address(targetAddress);
  const aliasAction = action === "unlink" ? models.AliasAction.UNLINK : models.AliasAction.LINK;

  const descriptor = new descriptors.AddressAliasTransactionV1Descriptor(namespaceId, address, aliasAction);

  return appState.facade.createTransactionFromTypedDescriptor(
    descriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );
}

export function estimateAddressAliasFee(namespaceIdHex, targetAddress, action) {
  return estimateFeeFromTx(buildAddressAliasTx(namespaceIdHex, targetAddress, action));
}

export async function setAddressAlias(namespaceIdHex, targetAddress, action) {
  const tx = buildAddressAliasTx(namespaceIdHex, targetAddress, action);
  return await signAndAnnounceTx(tx, {
    typeLabel: action === "unlink" ? "アドレスエイリアス解除" : "アドレスエイリアス設定",
    recipient: targetAddress,
    details: [{ label: "ネームスペースID", value: namespaceIdHex.toUpperCase() }],
  });
}
