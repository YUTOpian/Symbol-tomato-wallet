// restriction.js
// 制限機能: アカウント制限(アドレス) / モザイク制限 / トランザクション制限(操作)
// いずれも「自分自身のアカウント」に対する制限設定。
// 自分の署名だけで完結する(他者の同意は不要)。

import { appState } from "./config.js";
import { signAndAnnounceTx } from "./auth.js";

/* ============================================================
   現在の制限設定を取得(参考表示用)
============================================================ */
export async function loadAccountRestrictions(elId, restrictionType) {
  const el = document.getElementById(elId);
  if (!el) return;

  el.textContent = "読み込み中...";

  const F = appState.sdkSymbol.models.AccountRestrictionFlags;
  const typeBit =
    restrictionType === "mosaic" ? F.MOSAIC_ID.value : restrictionType === "operation" ? F.TRANSACTION_TYPE.value : F.ADDRESS.value;

  try {
    const address = appState.currentAddress.toString();
    const res = await fetch(`${appState.NODE}/restrictions/account/${address}`);

    if (res.status === 404) {
      el.innerHTML = `<div style="color:#94a3b8;">現在、制限は設定されていません</div>`;
      return;
    }

    const json = await res.json();
    const all = json.accountRestrictions?.restrictions ?? [];
    const restrictions = all.filter((r) => (Number(r.restrictionFlags) & typeBit) !== 0);

    if (restrictions.length === 0) {
      el.innerHTML = `<div style="color:#94a3b8;">現在、制限は設定されていません</div>`;
      return;
    }

    el.innerHTML = restrictions
      .map((r) => {
        const values = (r.values || []).map((v) => `<div>・${JSON.stringify(v)}</div>`).join("");
        return `
          <div class="harvest-history-item">
            <div>restrictionFlags: ${r.restrictionFlags}</div>
            ${values || "<div>(値なし)</div>"}
          </div>
        `;
      })
      .join("");
  } catch (e) {
    console.error("loadAccountRestrictions error:", e);
    el.textContent = "取得に失敗しました";
  }
}

/* ============================================================
   共通: フラグ値の組み立て
   restrictionType: "address" | "mosaic" | "operation"
   block: true=ブロックリスト / false=許可リスト
   outgoing: true=送信(自分発)に適用 / false=受信(自分宛)に適用
============================================================ */
function buildFlags(restrictionType, block, outgoing) {
  const F = appState.sdkSymbol.models.AccountRestrictionFlags;
  let value =
    restrictionType === "mosaic" ? F.MOSAIC_ID.value : restrictionType === "operation" ? F.TRANSACTION_TYPE.value : F.ADDRESS.value;

  if (outgoing) value += F.OUTGOING.value;
  if (block) value += F.BLOCK.value;

  return new F(value);
}

async function submitRestriction(descriptor, confirmInfo) {
  const embedded = appState.facade.createEmbeddedTransactionFromTypedDescriptor(descriptor, appState.currentPubKey);

  const aggregateDescriptor = new appState.sdkSymbol.descriptors.AggregateCompleteTransactionV3Descriptor(
    appState.facade.static.hashEmbeddedTransactions([embedded]),
    [embedded]
  );

  const tx = appState.facade.createTransactionFromTypedDescriptor(
    aggregateDescriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  return await signAndAnnounceTx(tx, confirmInfo);
}

/* ============================================================
   アカウント制限(アドレス)
============================================================ */
export async function setAddressRestriction({ block, outgoing, additions, deletions }) {
  const { descriptors } = appState.sdkSymbol;
  const flags = buildFlags("address", block, outgoing);

  const descriptor = new descriptors.AccountAddressRestrictionTransactionV1Descriptor(
    flags,
    additions.map((a) => new appState.sdkSymbol.Address(a)),
    deletions.map((a) => new appState.sdkSymbol.Address(a))
  );

  return await submitRestriction(descriptor, {
    typeLabel: "アカウント制限(アドレス)",
    details: [
      { label: "モード", value: block ? "ブロックリスト" : "許可リスト" },
      { label: "方向", value: outgoing ? "送信(自分発)" : "受信(自分宛)" },
      { label: "追加", value: additions.length ? additions.join(", ") : "(なし)" },
      { label: "削除", value: deletions.length ? deletions.join(", ") : "(なし)" },
    ],
  });
}

/* ============================================================
   モザイク制限
============================================================ */
export async function setMosaicRestriction({ block, outgoing, additions, deletions }) {
  const { descriptors, models } = appState.sdkSymbol;
  const flags = buildFlags("mosaic", block, outgoing);

  const toId = (hex) => new models.UnresolvedMosaicId(BigInt("0x" + hex.trim().toUpperCase()));

  const descriptor = new descriptors.AccountMosaicRestrictionTransactionV1Descriptor(
    flags,
    additions.map(toId),
    deletions.map(toId)
  );

  return await submitRestriction(descriptor, {
    typeLabel: "アカウント制限(モザイク)",
    details: [
      { label: "モード", value: block ? "ブロックリスト" : "許可リスト" },
      { label: "方向", value: outgoing ? "送信(自分発)" : "受信(自分宛)" },
      { label: "追加", value: additions.length ? additions.join(", ") : "(なし)" },
      { label: "削除", value: deletions.length ? deletions.join(", ") : "(なし)" },
    ],
  });
}

/* ============================================================
   トランザクション制限(操作/operation)
============================================================ */
export async function setOperationRestriction({ block, outgoing, additions, deletions }) {
  const { descriptors, models } = appState.sdkSymbol;
  const flags = buildFlags("operation", block, outgoing);

  const toType = (name) => models.TransactionType[name];

  const descriptor = new descriptors.AccountOperationRestrictionTransactionV1Descriptor(
    flags,
    additions.map(toType),
    deletions.map(toType)
  );

  return await submitRestriction(descriptor, {
    typeLabel: "アカウント制限(操作)",
    details: [
      { label: "モード", value: block ? "ブロックリスト" : "許可リスト" },
      { label: "方向", value: outgoing ? "送信(自分発)" : "受信(自分宛)" },
      { label: "追加", value: additions.length ? additions.join(", ") : "(なし)" },
      { label: "削除", value: deletions.length ? deletions.join(", ") : "(なし)" },
    ],
  });
}

/* ============================================================
   トランザクション制限で選べる代表的な種類
============================================================ */
export const OPERATION_TYPE_OPTIONS = [
  { value: "TRANSFER", label: "送金 (Transfer)" },
  { value: "NAMESPACE_REGISTRATION", label: "ネームスペース登録" },
  { value: "MOSAIC_DEFINITION", label: "モザイク定義" },
  { value: "MOSAIC_SUPPLY_CHANGE", label: "モザイク供給量変更" },
  { value: "MOSAIC_ALIAS", label: "モザイクエイリアス" },
  { value: "MULTISIG_ACCOUNT_MODIFICATION", label: "マルチシグ設定変更" },
  { value: "ACCOUNT_METADATA", label: "アカウントメタデータ" },
  { value: "MOSAIC_METADATA", label: "モザイクメタデータ" },
  { value: "NAMESPACE_METADATA", label: "ネームスペースメタデータ" },
  { value: "ACCOUNT_KEY_LINK", label: "アカウント鍵リンク(ハーベスト)" },
  { value: "VRF_KEY_LINK", label: "VRF鍵リンク(ハーベスト)" },
  { value: "NODE_KEY_LINK", label: "ノード鍵リンク(ハーベスト)" },
];

/* ============================================================
   モザイク制限で選べる比較演算子
============================================================ */
export const MOSAIC_RESTRICTION_TYPE_OPTIONS = [
  { value: "NONE", label: "NONE（制限なし）" },
  { value: "EQ", label: "EQ（等しい場合に許可）" },
  { value: "NE", label: "NE（等しくない場合に許可）" },
  { value: "LT", label: "LT（より小さい場合に許可）" },
  { value: "LE", label: "LE（以下の場合に許可）" },
  { value: "GT", label: "GT（より大きい場合に許可）" },
  { value: "GE", label: "GE（以上の場合に許可）" },
];

/* ============================================================
   モザイクグローバル制限
   ※ 対象モザイクの作成者(オーナー)のみが設定できる
============================================================ */
export async function setMosaicGlobalRestriction({
  mosaicIdHex,
  referenceMosaicIdHex,
  keyString,
  previousValue,
  newValue,
  previousType,
  newType,
}) {
  const { descriptors, models } = appState.sdkSymbol;

  const mosaicId = new models.UnresolvedMosaicId(BigInt("0x" + mosaicIdHex.trim().toUpperCase()));
  const referenceMosaicId = new models.UnresolvedMosaicId(
    referenceMosaicIdHex ? BigInt("0x" + referenceMosaicIdHex.trim().toUpperCase()) : 0n
  );
  const restrictionKey = appState.sdkSymbol.mosaicRestrictionGenerateKey(keyString);

  const descriptor = new descriptors.MosaicGlobalRestrictionTransactionV1Descriptor(
    mosaicId,
    referenceMosaicId,
    restrictionKey,
    BigInt(previousValue),
    BigInt(newValue),
    models.MosaicRestrictionType[previousType],
    models.MosaicRestrictionType[newType]
  );

  return await submitRestriction(descriptor, {
    typeLabel: "モザイクグローバル制限",
    details: [
      { label: "モザイクID", value: mosaicIdHex.trim().toUpperCase() },
      { label: "参照モザイクID", value: referenceMosaicIdHex ? referenceMosaicIdHex.trim().toUpperCase() : "(なし)" },
      { label: "制限キー", value: keyString },
      { label: "変更前の値/種別", value: `${previousValue} / ${previousType}` },
      { label: "変更後の値/種別", value: `${newValue} / ${newType}` },
    ],
  });
}

/* ============================================================
   モザイクアドレス制限
   ※ 対象モザイクの作成者(オーナー)のみが設定できる
============================================================ */
export async function setMosaicAddressRestriction({
  mosaicIdHex,
  keyString,
  previousValue,
  newValue,
  targetAddress,
}) {
  const { descriptors, models } = appState.sdkSymbol;

  const mosaicId = new models.UnresolvedMosaicId(BigInt("0x" + mosaicIdHex.trim().toUpperCase()));
  const restrictionKey = appState.sdkSymbol.mosaicRestrictionGenerateKey(keyString);

  const descriptor = new descriptors.MosaicAddressRestrictionTransactionV1Descriptor(
    mosaicId,
    restrictionKey,
    BigInt(previousValue),
    BigInt(newValue),
    new appState.sdkSymbol.Address(targetAddress)
  );

  return await submitRestriction(descriptor, {
    typeLabel: "モザイクアドレス制限",
    recipient: targetAddress,
    details: [
      { label: "モザイクID", value: mosaicIdHex.trim().toUpperCase() },
      { label: "制限キー", value: keyString },
      { label: "変更前の値", value: previousValue },
      { label: "変更後の値", value: newValue },
    ],
  });
}
