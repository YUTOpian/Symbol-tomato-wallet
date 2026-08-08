// mosaic.js
// モザイクの作成・供給量変更・自分が保有するモザイク一覧(ネームスペースとのリンク状況付き)の取得

const {appState} = W.config;
const {setStatus} = W.ui;
const {formatMosaicAmount} = W.utils;
const {signAndAnnounceTx, estimateFeeFromTx} = W.auth;
const {fetchOwnedNamespaceOptions} = W.namespace;
const {estimateMosaicRentalFee} = W.rentalFees;


// Symbolのブロック目標間隔(秒)。メインネット/テストネットともに30秒。
const BLOCK_TARGET_SECONDS = 30;
const BLOCKS_PER_DAY = (24 * 60 * 60) / BLOCK_TARGET_SECONDS;

async function fetchOwnedMosaicIds() {
  const address = appState.currentAddress.toString();
  const params = new URLSearchParams({ ownerAddress: address, pageSize: 100 });
  const res = await fetch(`${appState.NODE}/mosaics?${params}`);
  const json = await res.json();
  return (json.data ?? []).map((item) => item.mosaic.id.toUpperCase());
}

/* ============================================================
   対象モザイクの詳細(供給量・可分性など)を取得
============================================================ */
async function fetchMosaicDetail(mosaicIdHex) {
  const res = await fetch(`${appState.NODE}/mosaics/${mosaicIdHex.toUpperCase()}`);
  if (!res.ok) throw new Error("モザイク情報の取得に失敗しました");
  const json = await res.json();
  return json.mosaic;
}

/* ============================================================
   自分が作成した(オーナーになっている)モザイク一覧 + ネームスペースリンク状況
   保有量(mosaicInfo)ではなく、/mosaics?ownerAddress= で
   「自分が定義者になっているモザイク」を取得する。
   リンクされていないモザイクには、その場でネームスペースを
   選んでリンクできる操作を表示する。有効期限がある場合は
   残り日数の目安も表示する。
============================================================ */
async function loadOwnedMosaicsWithAlias() {
  const el = document.getElementById("owned-mosaic-list");
  if (!el) return;

  el.textContent = "読み込み中...";

  try {
    const address = appState.currentAddress.toString();
    const params = new URLSearchParams({ ownerAddress: address, pageSize: 100 });

    const [res, chainInfo] = await Promise.all([
      fetch(`${appState.NODE}/mosaics?${params}`),
      fetch(`${appState.NODE}/chain/info`).then((r) => r.json()).catch(() => null),
    ]);
    const json = await res.json();
    const mosaicItems = json.data ?? [];
    const currentHeight = chainInfo ? Number(chainInfo.height) : null;

    if (mosaicItems.length === 0) {
      el.innerHTML = `<div style="color:#94a3b8;">作成したモザイクはありません</div>`;
      return;
    }

    const ids = mosaicItems.map((item) => item.mosaic.id.toUpperCase());

    const [namesRes, namespaceOptions] = await Promise.all([
      fetch(`${appState.NODE}/namespaces/mosaic/names`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mosaicIds: ids }),
      }).then((r) => r.json()),
      fetchOwnedNamespaceOptions().catch(() => []),
    ]);

    const aliasMap = {};
    for (const item of namesRes.mosaicNames || []) {
      const mosaicId = item.mosaicId.toUpperCase();
      if (item.names && item.names.length > 0) {
        const first = item.names[0];
        const name = typeof first === "string" ? first : first?.name;
        if (name) {
          const path = appState.sdkSymbol.generateNamespacePath(name);
          const namespaceIdHex = path[path.length - 1].toString(16).toUpperCase().padStart(16, "0");
          aliasMap[mosaicId] = { name, namespaceIdHex };
        }
      }
    }

    const namespaceOptionsHtml = namespaceOptions
      .map((ns) => `<option value="${ns.id}">${ns.name}</option>`)
      .join("");

    el.innerHTML = mosaicItems
      .map((item) => {
        const m = item.mosaic;
        const id = m.id.toUpperCase();
        const alias = aliasMap[id];
        const divisibility = Number(m.divisibility ?? 0);
        const supply = m.supply != null ? formatMosaicAmount(m.supply, divisibility) : "---";

        const flags = m.flags ?? 0;
        const flagLabels = [];
        if (flags & 0x1) flagLabels.push("供給量変更可能");
        if (flags & 0x2) flagLabels.push("第三者へ譲渡可能");
        if (flags & 0x4) flagLabels.push("制限設定可能");
        if (flags & 0x8) flagLabels.push("取り消し可能");

        const duration = Number(m.duration ?? 0);
        const startHeight = Number(m.startHeight ?? 0);
        let expiryHtml = "有効期限: 無期限";
        if (duration > 0) {
          const endHeight = startHeight + duration;
          let remaining = "";
          if (currentHeight != null) {
            const remainingBlocks = endHeight - currentHeight;
            remaining =
              remainingBlocks > 0
                ? `（あと${Math.round(remainingBlocks / BLOCKS_PER_DAY)}日）`
                : "（有効期限切れ）";
          }
          expiryHtml = `有効期限: ブロック高${endHeight}${remaining}`;
        }

        const linkControlHtml = alias
          ? `
            <div class="mosaic-link-row">
              <button class="account-hide-btn" data-action="unlink-mosaic" data-mosaic-id="${id}" data-namespace-id="${alias.namespaceIdHex}">リンク解除</button>
            </div>
          `
          : namespaceOptions.length === 0
          ? `<div style="font-size:12px;color:#94a3b8;">(先にネームスペースを登録するとリンクできます)</div>`
          : `
            <div class="mosaic-link-row">
              <select class="input-box mosaic-link-select" data-mosaic-id="${id}">
                <option value="">-- ネームスペースを選択 --</option>
                ${namespaceOptionsHtml}
              </select>
              <button class="account-hide-btn" data-action="link-mosaic" data-mosaic-id="${id}">リンクする</button>
            </div>
          `;

        return `
          <div class="harvest-history-item">
            <div>モザイクID: ${id}</div>
            <div>供給量: ${supply}</div>
            <div>可分性: ${divisibility}</div>
            <div>${expiryHtml}</div>
            <div>フラグ: ${flagLabels.length ? flagLabels.join(", ") : "なし"}</div>
            <div>${alias ? `🔗 ネームスペース: ${alias.name}` : "ネームスペースとのリンクなし"}</div>
            ${linkControlHtml}
          </div>
        `;
      })
      .join("");
  } catch (e) {
    console.error("loadOwnedMosaicsWithAlias error:", e);
    el.textContent = "取得に失敗しました";
  }
}

/* ============================================================
   モザイク作成用: 保有ネームスペース候補(リンク先選択)
============================================================ */
async function populateMosaicNamespaceSelect() {
  const select = document.getElementById("mosaic-link-namespace-select");
  if (!select) return;

  select.innerHTML = `<option value="">-- リンクしない --</option>`;

  try {
    const options = await fetchOwnedNamespaceOptions();
    select.innerHTML += options.map((ns) => `<option value="${ns.id}">${ns.name}</option>`).join("");
  } catch (e) {
    console.warn("ネームスペース候補の取得に失敗しました", e);
  }
}

/* ============================================================
   作成済みモザイクを後からネームスペースにリンク/解除する
============================================================ */
async function setMosaicAlias(mosaicIdHex, namespaceIdHex, action = "link") {
  const tx = buildMosaicAliasTx(mosaicIdHex, namespaceIdHex, action);
  return await signAndAnnounceTx(tx, {
    typeLabel: action === "unlink" ? "モザイクエイリアス解除" : "モザイクエイリアス設定",
    details: [
      { label: "モザイクID", value: mosaicIdHex.toUpperCase() },
      { label: "ネームスペースID", value: namespaceIdHex.toUpperCase() },
    ],
  });
}

function buildMosaicAliasTx(mosaicIdHex, namespaceIdHex, action = "link") {
  const { descriptors, models } = appState.sdkSymbol;

  const namespaceId = new models.NamespaceId(BigInt("0x" + namespaceIdHex));
  const mosaicId = new models.MosaicId(BigInt("0x" + mosaicIdHex));
  const aliasAction = action === "unlink" ? models.AliasAction.UNLINK : models.AliasAction.LINK;

  const aliasDescriptor = new descriptors.MosaicAliasTransactionV1Descriptor(namespaceId, mosaicId, aliasAction);

  return appState.facade.createTransactionFromTypedDescriptor(
    aliasDescriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );
}

function estimateMosaicAliasFee(mosaicIdHex, namespaceIdHex, action = "link") {
  return estimateFeeFromTx(buildMosaicAliasTx(mosaicIdHex, namespaceIdHex, action));
}

// 後方互換用エイリアス
async function linkNamespaceToMosaic(mosaicIdHex, namespaceIdHex) {
  return await setMosaicAlias(mosaicIdHex, namespaceIdHex, "link");
}

/* ============================================================
   モザイク作成トランザクションの組み立て(署名前・共通処理)
   手数料試算(estimateMosaicCreationFee)と実際の作成(createMosaic)
   の両方から使う。
============================================================ */
function buildMosaicCreationTx({
  divisibility,
  isUnlimited,
  durationBlocks,
  supplyMutable,
  transferable,
  restrictable,
  revokable,
  initialSupply,
  linkNamespaceIdHex,
}) {
  const { descriptors, models } = appState.sdkSymbol;

  // ナンス(4byte)をランダム生成
  const nonceBytes = new Uint8Array(4);
  crypto.getRandomValues(nonceBytes);
  const nonceValue =
    nonceBytes[0] + nonceBytes[1] * 0x100 + nonceBytes[2] * 0x10000 + nonceBytes[3] * 0x1000000;
  const nonce = new models.MosaicNonce(nonceValue);

  const mosaicIdValue = appState.sdkSymbol.generateMosaicId(appState.currentAddress, nonceValue);
  const mosaicId = new models.MosaicId(mosaicIdValue);

  let flagValue = models.MosaicFlags.NONE.value;
  if (supplyMutable) flagValue += models.MosaicFlags.SUPPLY_MUTABLE.value;
  if (transferable) flagValue += models.MosaicFlags.TRANSFERABLE.value;
  if (restrictable) flagValue += models.MosaicFlags.RESTRICTABLE.value;
  if (revokable) flagValue += models.MosaicFlags.REVOKABLE.value;
  const flags = new models.MosaicFlags(flagValue);

  const definitionDescriptor = new descriptors.MosaicDefinitionTransactionV1Descriptor(
    mosaicId,
    new models.BlockDuration(isUnlimited ? 0n : BigInt(durationBlocks || 0)),
    nonce,
    flags,
    divisibility
  );

  const embedded = [
    appState.facade.createEmbeddedTransactionFromTypedDescriptor(definitionDescriptor, appState.currentPubKey),
  ];

  if (initialSupply > 0) {
    const supplyDescriptor = new descriptors.MosaicSupplyChangeTransactionV1Descriptor(
      new models.UnresolvedMosaicId(mosaicIdValue),
      new models.Amount(BigInt(Math.floor(initialSupply * 10 ** divisibility))),
      models.MosaicSupplyChangeAction.INCREASE
    );
    embedded.push(
      appState.facade.createEmbeddedTransactionFromTypedDescriptor(supplyDescriptor, appState.currentPubKey)
    );
  }

  if (linkNamespaceIdHex) {
    const namespaceId = new models.NamespaceId(BigInt("0x" + linkNamespaceIdHex));
    const aliasDescriptor = new descriptors.MosaicAliasTransactionV1Descriptor(
      namespaceId,
      mosaicId,
      models.AliasAction.LINK
    );
    embedded.push(
      appState.facade.createEmbeddedTransactionFromTypedDescriptor(aliasDescriptor, appState.currentPubKey)
    );
  }

  const aggregateDescriptor = new descriptors.AggregateCompleteTransactionV3Descriptor(
    appState.facade.static.hashEmbeddedTransactions(embedded),
    embedded
  );

  return appState.facade.createTransactionFromTypedDescriptor(
    aggregateDescriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );
}

/* ============================================================
   モザイク作成の推定手数料(XYM)を試算する
   実際に送信はしない。tx.size(byte) × feeMultiplier で計算。
============================================================ */
function estimateMosaicCreationFee(options) {
  const tx = buildMosaicCreationTx(options);
  return {
    sizeBytes: tx.size,
    feeXym: estimateFeeFromTx(tx),
  };
}

/* ============================================================
   モザイク作成
============================================================ */
async function createMosaic(options) {
  const tx = buildMosaicCreationTx(options);
  const {
    divisibility,
    isUnlimited,
    durationBlocks,
    supplyMutable,
    transferable,
    restrictable,
    revokable,
    initialSupply,
    linkNamespaceIdHex,
  } = options;

  let rentalFeeXym = "---";
  try {
    rentalFeeXym = await estimateMosaicRentalFee();
  } catch (e) {
    console.warn("レンタル手数料の取得に失敗しました", e);
  }

  return await signAndAnnounceTx(tx, {
    typeLabel: "モザイク作成",
    details: [
      { label: "可分性", value: divisibility },
      { label: "初期供給量", value: initialSupply || 0 },
      { label: "有効期限", value: isUnlimited ? "無期限" : `${durationBlocks} ブロック` },
      { label: "供給量変更可能", value: supplyMutable ? "はい" : "いいえ" },
      { label: "第三者へ譲渡可能", value: transferable ? "はい" : "いいえ" },
      { label: "制限設定可能", value: restrictable ? "はい" : "いいえ" },
      { label: "取り消し可能", value: revokable ? "はい" : "いいえ" },
      { label: "推定レンタル手数料", value: `約 ${rentalFeeXym} XYM` },
      ...(linkNamespaceIdHex
        ? [{ label: "リンク先ネームスペースID", value: linkNamespaceIdHex.toUpperCase() }]
        : []),
    ],
  });
}

/* ============================================================
   モザイク供給量変更(既存モザイクの供給量を増減する)
   ※ supplyMutable フラグ付きで作成されたモザイクのみ変更可能
============================================================ */
async function changeMosaicSupply({ mosaicIdHex, direction, amount, divisibility }) {
  const { descriptors, models } = appState.sdkSymbol;

  const supplyDescriptor = new descriptors.MosaicSupplyChangeTransactionV1Descriptor(
    new models.UnresolvedMosaicId(BigInt("0x" + mosaicIdHex.toUpperCase())),
    new models.Amount(BigInt(Math.floor(amount * 10 ** divisibility))),
    direction === "decrease" ? models.MosaicSupplyChangeAction.DECREASE : models.MosaicSupplyChangeAction.INCREASE
  );

  const tx = appState.facade.createTransactionFromTypedDescriptor(
    supplyDescriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  return await signAndAnnounceTx(tx, {
    typeLabel: "モザイク供給量変更",
    details: [
      { label: "モザイクID", value: mosaicIdHex.toUpperCase() },
      { label: "増減", value: direction === "decrease" ? "減少" : "増加" },
      { label: "数量", value: amount },
    ],
  });
}

window.W.mosaic = {
  estimateMosaicRentalFee,
  fetchOwnedMosaicIds,
  fetchMosaicDetail,
  loadOwnedMosaicsWithAlias,
  populateMosaicNamespaceSelect,
  setMosaicAlias,
  estimateMosaicAliasFee,
  linkNamespaceToMosaic,
  estimateMosaicCreationFee,
  createMosaic,
  changeMosaicSupply
};
