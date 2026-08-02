// metadata.js
// メタデータの登録・更新 (アドレス / ネームスペース / モザイク)
// 自分自身が対象(target)の場合のみ対応。他人のアカウント宛は
// 相手の共同署名が必要になるため、このアプリでは扱わない。

import { appState } from "./config.js";
import { signAndAnnounceTx } from "./auth.js";
import { hexToBytes } from "./utils.js";

/* ============================================================
   既存メタデータの取得(更新の際のXOR差分計算に使う)
============================================================ */
async function fetchExistingValueHex(scopedMetadataKeyHex, targetIdHex) {
  const address = appState.currentAddress.toString();
  const params = new URLSearchParams({
    sourceAddress: address,
    targetAddress: address,
    scopedMetadataKey: scopedMetadataKeyHex,
  });
  if (targetIdHex) params.set("targetId", targetIdHex);

  const res = await fetch(`${appState.NODE}/metadata?${params}`);
  const json = await res.json();
  const entry = (json.data ?? [])[0];
  return entry?.metadataEntry?.value ?? null;
}

/* ============================================================
   新旧の値からXOR差分とvalueSizeDeltaを計算する
   (Symbolのメタデータ更新は「差分」を送る仕様のため)
============================================================ */
function buildValueDiff(oldValueHex, newValueBytes) {
  const oldBytes = oldValueHex ? hexToBytes(oldValueHex) : new Uint8Array(0);
  const len = Math.max(oldBytes.length, newValueBytes.length);
  const xored = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    const o = i < oldBytes.length ? oldBytes[i] : 0;
    const n = i < newValueBytes.length ? newValueBytes[i] : 0;
    xored[i] = o ^ n;
  }

  return {
    value: xored,
    valueSizeDelta: newValueBytes.length - oldBytes.length,
  };
}

/* ============================================================
   メタデータ登録/更新
   targetType: "address" | "namespace" | "mosaic"
   targetIdHex: namespace/mosaicの場合のみ必要(16進ID)
============================================================ */
export async function setMetadata(targetType, targetIdHex, keyString, valueString) {
  const { descriptors, models } = appState.sdkSymbol;

  const scopedMetadataKey = appState.sdkSymbol.metadataGenerateKey(keyString);
  const scopedMetadataKeyHex = scopedMetadataKey.toString(16).toUpperCase().padStart(16, "0");

  const newValueBytes = new TextEncoder().encode(valueString);
  const oldValueHex = await fetchExistingValueHex(scopedMetadataKeyHex, targetIdHex);
  const { value, valueSizeDelta } = buildValueDiff(oldValueHex, newValueBytes);

  const targetAddress = appState.currentAddress;

  let descriptor;
  if (targetType === "namespace") {
    const namespaceId = new models.NamespaceId(BigInt("0x" + targetIdHex));
    descriptor = new descriptors.NamespaceMetadataTransactionV1Descriptor(
      targetAddress,
      scopedMetadataKey,
      namespaceId,
      valueSizeDelta,
      value
    );
  } else if (targetType === "mosaic") {
    const mosaicId = new models.UnresolvedMosaicId(BigInt("0x" + targetIdHex));
    descriptor = new descriptors.MosaicMetadataTransactionV1Descriptor(
      targetAddress,
      scopedMetadataKey,
      mosaicId,
      valueSizeDelta,
      value
    );
  } else {
    descriptor = new descriptors.AccountMetadataTransactionV1Descriptor(
      targetAddress,
      scopedMetadataKey,
      valueSizeDelta,
      value
    );
  }

  const embedded = [
    appState.facade.createEmbeddedTransactionFromTypedDescriptor(descriptor, appState.currentPubKey),
  ];

  const aggregateDescriptor = new descriptors.AggregateCompleteTransactionV3Descriptor(
    appState.facade.static.hashEmbeddedTransactions(embedded),
    embedded
  );

  const tx = appState.facade.createTransactionFromTypedDescriptor(
    aggregateDescriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  const typeLabelMap = {
    address: "メタデータ登録(アカウント)",
    namespace: "メタデータ登録(ネームスペース)",
    mosaic: "メタデータ登録(モザイク)",
  };

  return await signAndAnnounceTx(tx, {
    typeLabel: typeLabelMap[targetType] ?? "メタデータ登録",
    details: [
      ...(targetIdHex ? [{ label: "対象ID", value: targetIdHex.toUpperCase() }] : []),
      { label: "キー", value: keyString },
      { label: "値", value: valueString },
    ],
  });
}

/* ============================================================
   自分に紐づく既存メタデータ一覧(参考表示用)
============================================================ */
export async function loadOwnMetadataList() {
  const el = document.getElementById("metadata-list");
  if (!el) return;

  el.textContent = "読み込み中...";

  try {
    const address = appState.currentAddress.toString();
    const params = new URLSearchParams({ sourceAddress: address, pageSize: 100 });
    const res = await fetch(`${appState.NODE}/metadata?${params}`);
    const json = await res.json();
    const items = json.data ?? [];

    if (items.length === 0) {
      el.innerHTML = `<div style="color:#94a3b8;">登録済みのメタデータはありません</div>`;
      return;
    }

    el.innerHTML = items
      .map((item) => {
        const m = item.metadataEntry;
        const typeLabel = m.metadataType === 0 ? "アドレス" : m.metadataType === 1 ? "モザイク" : "ネームスペース";
        let valueText = "";
        try {
          valueText = new TextDecoder().decode(hexToBytes(m.value));
        } catch {
          valueText = m.value;
        }
        return `
          <div class="harvest-history-item">
            <div>対象種別: ${typeLabel}</div>
            <div>キー: ${m.scopedMetadataKey}</div>
            <div>値: ${valueText}</div>
          </div>
        `;
      })
      .join("");
  } catch (e) {
    console.error("loadOwnMetadataList error:", e);
    el.textContent = "取得に失敗しました";
  }
}
