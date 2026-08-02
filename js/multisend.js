// multisend.js
// 複数送信: 手動設定 / CSVインポートのどちらも、複数の送金先を
// 1つの Aggregate Complete Transaction にまとめて送信する

import { appState, getXymMosaicIdHex } from "./config.js";
import { signAndAnnounceTx } from "./auth.js";

// mosaic文字列(ネームスペース名 or 16進ID) → divisibility のキャッシュ
const divisibilityCache = {};

/* ============================================================
   CSVパース (address,mosaic,amount,message ヘッダー行あり想定)
   簡易的なダブルクォート対応つきCSVパーサ
============================================================ */
function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/* ============================================================
   CSVパース
   列構成(ヘッダー行なし・固定位置):
     A列: ラベル(任意・未使用、Excel上でのメモ用)
     B列: 送金先アドレス または ネームスペース名
     C列: 送金数量
     D列: モザイクID(16進) または ネームスペース名(省略時はXYM)
     E列: メッセージ(任意)
   最大100件まで。
============================================================ */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];

  if (lines.length > 100) {
    throw new Error("CSVに登録できる送金先は最大100件です。");
  }

  return lines.map((line) => {
    const cells = parseCsvLine(line);
    return {
      address: cells[1] ?? "",
      amount: cells[2] ?? "",
      mosaic: cells[3]?.trim() ? cells[3] : "symbol.xym",
      message: cells[4] ?? "",
    };
  });
}

/* ============================================================
   mosaic文字列 → UnresolvedMosaicId(BigInt)
   16進のモザイクIDならそのまま、ドット区切りのネームスペース名なら
   generateNamespacePath で決定論的にID計算する(ネットワーク通信不要)
============================================================ */
function resolveUnresolvedMosaicIdValue(mosaicField) {
  const trimmed = mosaicField.trim();

  if (/^[0-9A-Fa-f]{16}$/.test(trimmed)) {
    return BigInt("0x" + trimmed.toUpperCase());
  }

  const path = appState.sdkSymbol.generateNamespacePath(trimmed);
  return path[path.length - 1];
}

/* ============================================================
   mosaic文字列 → divisibility (人間可読の数量をベース単位に変換するため)
============================================================ */
async function resolveDivisibility(mosaicField) {
  const trimmed = mosaicField.trim();
  const xymId = getXymMosaicIdHex();

  if (trimmed.toLowerCase() === "symbol.xym" || trimmed.toUpperCase() === xymId) {
    return 6;
  }

  if (divisibilityCache[trimmed] !== undefined) {
    return divisibilityCache[trimmed];
  }

  try {
    let mosaicIdHex;

    if (/^[0-9A-Fa-f]{16}$/.test(trimmed)) {
      mosaicIdHex = trimmed.toUpperCase();
    } else {
      // ネームスペース名 → 実際のモザイクIDをノードに問い合わせて解決
      const namespaceIdValue = resolveUnresolvedMosaicIdValue(trimmed);
      const namespaceIdHex = namespaceIdValue.toString(16).toUpperCase().padStart(16, "0");
      const nsRes = await fetch(`${appState.NODE}/namespaces/${namespaceIdHex}`).then((r) => r.json());
      if (nsRes.namespace?.alias?.mosaicId) {
        mosaicIdHex = nsRes.namespace.alias.mosaicId.toUpperCase();
      }
    }

    if (!mosaicIdHex) {
      divisibilityCache[trimmed] = 0;
      return 0;
    }

    const mosaicRes = await fetch(`${appState.NODE}/mosaics/${mosaicIdHex}`).then((r) => r.json());
    const divisibility = Number(mosaicRes.mosaic?.divisibility ?? 0);
    divisibilityCache[trimmed] = divisibility;
    return divisibility;
  } catch (e) {
    console.warn("divisibility解決失敗:", trimmed, e);
    divisibilityCache[trimmed] = 0;
    return 0;
  }
}

/* ============================================================
   複数送金の一括送信
   rows: [{ address, mosaic, amount, message }]
   すべて自分自身が送信者なので、単純な Aggregate Complete で完結する
============================================================ */
export async function sendMultiTransfer(rows) {
  if (rows.length === 0) {
    throw new Error("送金先が1件もありません。");
  }
  if (rows.length > 100) {
    throw new Error("一度に送信できるのは100件までです。");
  }

  const { descriptors, models } = appState.sdkSymbol;
  const embedded = [];

  for (const [i, row] of rows.entries()) {
    const address = row.address.trim();
    const mosaicField = row.mosaic.trim();
    const amount = Number(row.amount);

    if (!address) {
      throw new Error(`${i + 1}行目: 送金先アドレスが空です。`);
    }
    if (!mosaicField) {
      throw new Error(`${i + 1}行目: モザイクが空です。`);
    }
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`${i + 1}行目: 数量が不正です。`);
    }

    const divisibility = await resolveDivisibility(mosaicField);
    const unresolvedMosaicIdValue = resolveUnresolvedMosaicIdValue(mosaicField);

    const mosaics =
      amount > 0
        ? [
            new descriptors.UnresolvedMosaicDescriptor(
              new models.UnresolvedMosaicId(unresolvedMosaicIdValue),
              new models.Amount(BigInt(Math.round(amount * 10 ** divisibility)))
            ),
          ]
        : [];

    const messageBytes = new Uint8Array([0x00, ...new TextEncoder().encode(row.message || "")]);

    const transferDescriptor = new descriptors.TransferTransactionV1Descriptor(
      new appState.sdkSymbol.Address(address),
      mosaics,
      messageBytes
    );

    embedded.push(
      appState.facade.createEmbeddedTransactionFromTypedDescriptor(transferDescriptor, appState.currentPubKey)
    );
  }

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

  const MAX_DETAIL_ROWS = 20;
  const rowDetails = rows.slice(0, MAX_DETAIL_ROWS).map((row, i) => ({
    label: `送金先 ${i + 1}`,
    value: `${row.address} / ${row.mosaic} / ${row.amount}${row.message ? " / " + row.message : ""}`,
  }));
  if (rows.length > MAX_DETAIL_ROWS) {
    rowDetails.push({ label: "その他", value: `他 ${rows.length - MAX_DETAIL_ROWS} 件` });
  }

  return await signAndAnnounceTx(tx, {
    typeLabel: "複数送金",
    details: [{ label: "送金先件数", value: `${rows.length} 件` }, ...rowDetails],
  });
}
