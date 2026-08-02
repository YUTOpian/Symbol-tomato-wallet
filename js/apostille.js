// apostille.js
// アポスティーユ(ファイル公証)機能
//
// 昔のNEM Apostilleは所有者の秘密鍵から専用アカウントを都度生成する
// 方式だったが、これはSSS Extensionでは秘密鍵に直接触れられないため
// 実現できない。代わりに、ファイルのSHA-256ハッシュを含む証明情報を
// TransferTransactionのメッセージに刻み、任意でAccountMetadataも
// 付与する方式にしている(SSS/ローカル署名どちらでも動作する)。
//
// 内部フロー:
//   ファイル選択 → ファイルハッシュ生成 → 証明情報生成
//   → (任意)メタデータ作成 → Aggregate Tx生成 → 署名 → アナウンス

import { appState } from "./config.js";
import { signAndAnnounceTx } from "./auth.js";

const CERT_PREFIX = "APOSTILLE1:"; // メッセージ先頭に付けて識別する

/* ============================================================
   ファイルのSHA-256ハッシュを計算
============================================================ */
export async function computeFileHash(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ============================================================
   証明情報の作成(アポスティーユ作成)
   file / fileHashHex: 事前にcomputeFileHashで計算済みのものを渡す
   ownerAddress: 所有者(承認者)割り当て。空なら自分自身
   metadataKey / metadataValue: 任意。指定時はAccountMetadataも付与
============================================================ */
export async function createApostille({ file, fileHashHex, ownerAddress, metadataKey, metadataValue }) {
  const { descriptors } = appState.sdkSymbol;

  const cert = {
    v: 1,
    fileName: file?.name ?? "",
    fileHash: fileHashHex,
    timestamp: new Date().toISOString(),
    owner: ownerAddress || appState.currentAddress.toString(),
  };

  const messageText = CERT_PREFIX + JSON.stringify(cert);
  const messageBytes = new Uint8Array([0x00, ...new TextEncoder().encode(messageText)]);

  const recipientAddress = ownerAddress
    ? new appState.sdkSymbol.Address(ownerAddress)
    : appState.currentAddress;

  const transferDescriptor = new descriptors.TransferTransactionV1Descriptor(
    recipientAddress,
    [],
    messageBytes
  );

  const embedded = [
    appState.facade.createEmbeddedTransactionFromTypedDescriptor(transferDescriptor, appState.currentPubKey),
  ];

  if (metadataKey && metadataKey.trim()) {
    const scopedMetadataKey = appState.sdkSymbol.metadataGenerateKey(metadataKey.trim());
    const valueBytes = new TextEncoder().encode(metadataValue || fileHashHex);

    const metadataDescriptor = new descriptors.AccountMetadataTransactionV1Descriptor(
      appState.currentAddress,
      scopedMetadataKey,
      valueBytes.length,
      valueBytes
    );

    embedded.push(
      appState.facade.createEmbeddedTransactionFromTypedDescriptor(metadataDescriptor, appState.currentPubKey)
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

  return await signAndAnnounceTx(tx, {
    typeLabel: "アポスティーユ証明(ファイル公証)",
    recipient: recipientAddress.toString(),
    details: [
      { label: "ファイル名", value: cert.fileName || "(なし)" },
      { label: "ファイルハッシュ (SHA-256)", value: fileHashHex },
      ...(metadataKey && metadataKey.trim()
        ? [
            { label: "メタデータキー", value: metadataKey.trim() },
            { label: "メタデータ値", value: metadataValue || fileHashHex },
          ]
        : []),
    ],
  });
}

/* ============================================================
   メッセージから証明情報を復元(0x00 PlainMessageのみ対応)
============================================================ */
function tryParseCert(messageHex) {
  if (!messageHex) return null;
  try {
    const bytes = new Uint8Array(messageHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
    if (bytes[0] !== 0x00) return null;
    const text = new TextDecoder().decode(bytes.slice(1));
    if (!text.startsWith(CERT_PREFIX)) return null;
    return JSON.parse(text.slice(CERT_PREFIX.length));
  } catch {
    return null;
  }
}

/* ============================================================
   指定アドレスの取引履歴から、指定ハッシュの証明トランザクションを
   すべて検索する(直近のトランザクションのみが対象。REST APIは
   メッセージ内容での全文検索を提供していないため)
============================================================ */
export async function searchApostilleTransactions(fileHashHex, targetAddress, { pageSize = 100 } = {}) {
  const address = targetAddress || appState.currentAddress.toString();
  const params = new URLSearchParams({
    address,
    embedded: true,
    order: "desc",
    pageSize,
  });

  const url = `${appState.NODE}/transactions/confirmed?${params}`;
  const res = await fetch(url);
  const json = await res.json();
  const items = json.data ?? [];

  const matches = [];

  const tryMatch = (tx, meta) => {
    const cert = tryParseCert(tx.message);
    if (cert && cert.fileHash === fileHashHex) {
      matches.push({
        hash: meta.hash,
        height: meta.height,
        timestamp: meta.timestamp,
        sender: tx.signerPublicKey,
        recipient: tx.recipientAddress,
        cert,
      });
    }
  };

  for (const item of items) {
    const tx = item.transaction;

    // 通常の(アグリゲートでない)トランザクションは、そのままメッセージを確認できる
    if (tx.message) {
      tryMatch(tx, item.meta);
      continue;
    }

    // アグリゲート(Complete/Bonded)は一覧に埋め込みTxの中身を含まないため、
    // ハッシュを使って個別に詳細を取得し直す
    const isAggregate = tx.type === 16705 || tx.type === 16961 || tx.type === "16705" || tx.type === "16961";
    if (!isAggregate) continue;

    try {
      const detailRes = await fetch(`${appState.NODE}/transactions/confirmed/${item.meta.hash}`);
      const detail = await detailRes.json();
      const innerTxs = detail.transaction?.transactions ?? [];

      for (const inner of innerTxs) {
        const innerTx = inner.transaction;
        if (innerTx?.message) {
          tryMatch(innerTx, item.meta);
        }
      }
    } catch (e) {
      console.warn("[apostille] アグリゲート詳細の取得に失敗:", item.meta.hash, e);
    }
  }

  // 古い順に並べ替える(履歴の変化を追いやすくするため)
  matches.sort((a, b) => Number(a.height) - Number(b.height));

  return matches;
}
