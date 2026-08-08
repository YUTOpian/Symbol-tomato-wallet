// multisig.js
// マルチシグ設定 / マルチシグ送金 / マルチシグ署名(連署)
//
// マルチシグの設定変更・送金は「新しく追加される連署者の同意」や
// 「既存連署者の承認」が必要になるため、基本的に
//   ① アグリゲートボンデッドTxを自分の署名で作成
//   ② ハッシュロックTxで10XYMを一時的にロック(スパム防止の担保)
//   ③ ハッシュロックの承認を待つ
//   ④ /transactions/partial にボンデッドTxをアナウンス
// という流れで「提案」し、他の連署者は後から「マルチシグ署名」画面で
// 連署(cosign)して承認する、という設計にしている。

const {appState, getXymMosaicIdHex} = W.config;
const {signTxOnly, signAndAnnounceTx, cosignTransactionHash, estimateFeeFromTx} = W.auth;
const {hexToBytes} = W.utils;
const {requestTxConfirmation, formatTxDeadline, TxCancelledError} = W.txConfirm;

const HASH_LOCK_AMOUNT = 10_000_000n; // 10 XYM (microXYM)

// アグリゲートボンデッドTx本体の有効期限(秒)。proposeBondedAggregate内の
// createTransactionFromTypedDescriptor() 呼び出しと必ず同じ値を使うこと。
const AGGREGATE_BONDED_DEADLINE_SECONDS = 60 * 60 * 6; // 6時間

// ブロック生成間隔(秒)。メインネット/テストネットともに30秒。
const BLOCK_TARGET_SECONDS = 30;

// ハッシュロックの有効期間(ブロック数)。
// ★ここは必ずアグリゲート本体の有効期限(AGGREGATE_BONDED_DEADLINE_SECONDS)より
//   長くすること。短いと、有効期限ぎりぎりで連署が集まった際に
//   ハッシュロックの担保が先に失効・返却されてしまい、アグリゲートTxが
//   確定できずに送金が失敗する(連署者からは「見えていたのに送れなかった」
//   ように見えるバグの原因になる)。念のため1時間分の余裕を持たせる。
const HASH_LOCK_DURATION = BigInt(
  Math.ceil(AGGREGATE_BONDED_DEADLINE_SECONDS / BLOCK_TARGET_SECONDS) + Math.ceil(3600 / BLOCK_TARGET_SECONDS)
); // 6時間 + 1時間の余裕 ≒ 840ブロック

/* ============================================================
   承認待ちポーリング(ハッシュロックの確定待ち)
============================================================ */
async function waitConfirmed(hash, { timeoutMs = 90000, intervalMs = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${appState.NODE}/transactionStatus/${hash}`);
      if (res.ok) {
        const json = await res.json();
        if (json.group === "confirmed") return true;
        if (json.group === "failed") {
          throw new Error("ハッシュロックTxが失敗しました: " + (json.code ?? "unknown"));
        }
      }
    } catch (e) {
      console.warn("waitConfirmed polling error:", e);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("ハッシュロックの承認待ちがタイムアウトしました");
}

/* ============================================================
   アグリゲートボンデッドTxを作成・署名し、
   ハッシュロック → 承認待ち → /transactions/partial アナウンス
   まで一括で行う共通処理
============================================================ */
async function proposeBondedAggregate(embeddedTransactions, cosignerCount, confirmInfo) {
  const { descriptors, models } = appState.sdkSymbol;

  const aggregateDescriptor = new descriptors.AggregateBondedTransactionV3Descriptor(
    appState.facade.static.hashEmbeddedTransactions(embeddedTransactions),
    embeddedTransactions
  );

  const aggregateTx = appState.facade.createTransactionFromTypedDescriptor(
    aggregateDescriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    AGGREGATE_BONDED_DEADLINE_SECONDS,
    cosignerCount
  );

  // マルチシグの提案内容そのものの確認(実際の担保としてハッシュロックで10XYMが
  // 一時的にロックされることも合わせて表示する)
  if (confirmInfo) {
    const confirmed = await requestTxConfirmation({
      typeLabel: confirmInfo.typeLabel,
      sender: confirmInfo.sender,
      recipient: confirmInfo.recipient,
      fee: estimateFeeFromTx(aggregateTx),
      deadlineText: formatTxDeadline(aggregateTx),
      details: [
        ...(confirmInfo.details ?? []),
        { label: "必要な追加連署者数", value: cosignerCount },
        { label: "担保(ハッシュロック)", value: "10 XYM（承認完了、または期限切れで返却されます）" },
      ],
    });
    if (!confirmed) {
      throw new TxCancelledError();
    }
  }

  const { jsonPayload: aggregateJsonPayload, signedBytes } = await signTxOnly(aggregateTx);
  const signedAggregateTx = appState.facade.transactionFactory.static.deserialize(signedBytes);
  const aggregateHash = appState.facade.hashTransaction(signedAggregateTx);

  // SSS Extensionでは、直前の署名ポップアップを閉じた直後に次のポップアップを
  // 開こうとすると、表示が間に合わず一瞬で消えてしまうことがある
  // (transfer.jsのメッセージ暗号化時と同じ問題)。
  // ここではアグリゲート本体の署名(ポップアップ①)の直後に
  // ハッシュロックTxの署名(ポップアップ②)をリクエストするため、
  // ローカル署名(ニーモニック/秘密鍵)以外の場合は少し間隔を空ける。
  if (appState.authMode !== "local") {
    await new Promise((r) => setTimeout(r, 600));
  }

  // ハッシュロックTx (10 XYMを一時ロック。連署が集まらず期限切れになると自動返却)
  const xymId = getXymMosaicIdHex();
  const hashLockDescriptor = new descriptors.HashLockTransactionV1Descriptor(
    new descriptors.UnresolvedMosaicDescriptor(
      new models.UnresolvedMosaicId(BigInt("0x" + xymId)),
      new models.Amount(HASH_LOCK_AMOUNT)
    ),
    new models.BlockDuration(HASH_LOCK_DURATION),
    aggregateHash
  );

  const hashLockTx = appState.facade.createTransactionFromTypedDescriptor(
    hashLockDescriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  const hashLockTxHash = await signAndAnnounceTx(hashLockTx);

  await waitConfirmed(hashLockTxHash);

  // ハッシュロック確定後、ボンデッドTxを/transactions/partialへ
  const res = await fetch(new URL("/transactions/partial", appState.NODE), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: aggregateJsonPayload,
  });
  const result = await res.json();
  if (!res.ok) {
    throw new Error(result.message ?? "アグリゲートボンデッドTxのアナウンスに失敗しました");
  }

  return aggregateHash.toString();
}

/* ============================================================
   マルチシグ情報の取得
============================================================ */
async function loadMultisigInfo() {
  const el = document.getElementById("multisig-info");
  if (!el) return;

  el.textContent = "読み込み中...";

  try {
    const address = appState.currentAddress.toString();
    const res = await fetch(`${appState.NODE}/account/${address}/multisig`);

    if (res.status === 404) {
      el.innerHTML = `<div style="color:#94a3b8;">このアカウントはまだマルチシグ化されていません</div>`;
      return;
    }

    const json = await res.json();
    const m = json.multisig;

    const cosignatoriesHtml = (m.cosignatoryAddresses || [])
      .map((a) => `<div>・${a}</div>`)
      .join("") || "<div>(なし)</div>";

    const multisigAddressesHtml = (m.multisigAddresses || [])
      .map((a) => `<div>・${a}</div>`)
      .join("") || "<div>(なし)</div>";

    el.innerHTML = `
      <div class="harvest-history-item">
        <div>最小承認者数(minApproval): ${m.minApproval}</div>
        <div>最小削除承認者数(minRemoval): ${m.minRemoval}</div>
        <div>連署者:</div>
        ${cosignatoriesHtml}
        <div>自分が連署者になっているマルチシグアカウント:</div>
        ${multisigAddressesHtml}
      </div>
    `;
  } catch (e) {
    console.error("loadMultisigInfo error:", e);
    el.textContent = "取得に失敗しました";
  }
}

/* ============================================================
   自分が連署者になっているマルチシグアカウント一覧(送金元選択用)
============================================================ */
async function fetchCosignatoryOfAddresses() {
  const address = appState.currentAddress.toString();
  const res = await fetch(`${appState.NODE}/account/${address}/multisig`);
  if (res.status === 404) return [];
  const json = await res.json();
  return json.multisig?.multisigAddresses || [];
}

/* ============================================================
   マルチシグ設定(自分自身のアカウントを対象)
   追加する連署者は全員の同意(連署)が必要なため、常にボンデッドで提案する
============================================================ */
async function updateMultisigSettings({
  minApprovalDelta,
  minRemovalDelta,
  additionAddresses,
  deletionAddresses,
}) {
  const { descriptors, models } = appState.sdkSymbol;

  const additions = additionAddresses.map((a) => new appState.sdkSymbol.Address(a));
  const deletions = deletionAddresses.map((a) => new appState.sdkSymbol.Address(a));

  const descriptor = new descriptors.MultisigAccountModificationTransactionV1Descriptor(
    minRemovalDelta,
    minApprovalDelta,
    additions,
    deletions
  );

  const embeddedTx = appState.facade.createEmbeddedTransactionFromTypedDescriptor(
    descriptor,
    appState.currentPubKey
  );

  // 新規追加する連署者の人数分だけ、追加の連署が必要
  const cosignerCount = additions.length;

  return await proposeBondedAggregate([embeddedTx], cosignerCount, {
    typeLabel: "マルチシグ設定変更",
    details: [
      { label: "最小承認者数の増減", value: minApprovalDelta },
      { label: "最小削除承認者数の増減", value: minRemovalDelta },
      { label: "追加する連署者", value: additionAddresses.length ? additionAddresses.join(", ") : "(なし)" },
      { label: "削除する連署者", value: deletionAddresses.length ? deletionAddresses.join(", ") : "(なし)" },
    ],
  });
}

/* ============================================================
   マルチシグ送金
============================================================ */
async function sendFromMultisig({ multisigAddress, recipientAddress, amountXym, message }) {
  const { descriptors, models } = appState.sdkSymbol;

  // 送金元(マルチシグアカウント)の公開鍵を取得
  const accountInfo = await fetch(new URL("/accounts/" + multisigAddress, appState.NODE)).then((r) =>
    r.json()
  );
  const multisigPublicKey = accountInfo.account?.publicKey;
  if (!multisigPublicKey || /^0+$/.test(multisigPublicKey)) {
    throw new Error("送金元アカウントの公開鍵が取得できません(未初期化アカウントの可能性があります)");
  }

  const xymId = getXymMosaicIdHex();
  const mosaics =
    amountXym > 0
      ? [
          new descriptors.UnresolvedMosaicDescriptor(
            new models.UnresolvedMosaicId(BigInt("0x" + xymId)),
            new models.Amount(BigInt(Math.floor(amountXym * 1_000_000)))
          ),
        ]
      : [];

  const messageBytes = new Uint8Array([0x00, ...new TextEncoder().encode(message || "")]);

  const transferDescriptor = new descriptors.TransferTransactionV1Descriptor(
    new appState.sdkSymbol.Address(recipientAddress),
    mosaics,
    messageBytes
  );

  const embeddedTx = appState.facade.createEmbeddedTransactionFromTypedDescriptor(
    transferDescriptor,
    new appState.sdkCore.PublicKey(multisigPublicKey)
  );

  // 自分自身の署名(起案者)がマルチシグの連署者の1人としてそのままカウントされるため、
  // ここでは追加の連署者数は指定しない(0)。承認数が足りない場合は他の連署者が
  // 「マルチシグ署名」から追加で連署する。
  return await proposeBondedAggregate([embeddedTx], 0, {
    typeLabel: "マルチシグ送金(提案)",
    sender: multisigAddress,
    recipient: recipientAddress,
    details: [
      { label: "数量", value: `${amountXym} XYM` },
      { label: "メッセージ", value: message || "(なし)" },
    ],
  });
}

/* ============================================================
   マルチシグ署名(保留中のアグリゲートボンデッドTx一覧・連署)

   ⚠ アグリゲートボンデッドTxは、アナウンスされたノードのローカルな
   「partial」キャッシュに載るだけで、他ノードへの伝播にはP2P同期の
   時間差がある(伝播しないケースもある)。そのため、連署する側が
   アナウンスした側と別のノードに接続していると、この一覧に
   何も表示されないことがある。これを補うため、相手から渡された
   「コサイン情報」(ハッシュ＋アナウンス先ノード)がある場合は、
   そのノードへ直接ハッシュ指定で問い合わせて表示する
   (externalHash 引数、feeDelegation.js から利用)。
============================================================ */

// 1件分のカードHTML(一覧表示・直接取得表示の両方で共通利用)
function renderPendingItemHtml(hash, transaction, nodeUrl) {
  const cosigCount = (transaction.cosignatures || []).length;
  const alreadySigned = (transaction.cosignatures || []).some(
    (c) => c.signerPublicKey?.toUpperCase() === appState.currentPubKey?.toUpperCase()
  );

  return `
    <div class="harvest-history-item">
      <div>Hash: ${hash}</div>
      <div>現在の連署数: ${cosigCount}</div>
      <div>${alreadySigned ? "✅ 署名済み" : ""}</div>
      ${
        alreadySigned
          ? ""
          : `<button class="account-hide-btn" data-action="cosign" data-hash="${hash}" data-node="${nodeUrl ?? ""}">署名する</button>`
      }
    </div>
  `;
}

/* ============================================================
   指定ノードから、指定ハッシュの連署待ち(partial)Txを1件だけ直接取得する。
   アドレス検索(loadPendingPartialTransactions)に頼らないため、
   そのノードのキャッシュに載ってさえいれば、自分の接続ノードとは
   無関係に見つけられる。
============================================================ */
async function fetchPartialTransactionByHash(nodeUrl, hash) {
  if (!nodeUrl || !hash) return null;
  try {
    const res = await fetch(`${nodeUrl}/transactions/partial/${hash}`);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.transaction ? json : null;
  } catch (e) {
    console.warn("fetchPartialTransactionByHash error:", nodeUrl, e);
    return null;
  }
}

/* ============================================================
   externalHash: { hash, node } を渡すと、通常のアドレス検索結果に
   含まれていなかった場合のみ、そのノードへ直接問い合わせて追加表示する。
============================================================ */
async function loadPendingPartialTransactions(elId = "multisig-pending-list", externalHash = null) {
  const el = document.getElementById(elId);
  if (!el) return;

  el.textContent = "読み込み中...";

  try {
    const address = appState.currentAddress.toString();
    const params = new URLSearchParams({ address, embedded: true, pageSize: 50 });
    const res = await fetch(`${appState.NODE}/transactions/partial?${params}`);
    const json = await res.json();
    const items = json.data ?? [];

    let externalHtml = "";
    if (externalHash?.hash) {
      const alreadyListed = items.some(
        (item) => item.meta?.hash?.toUpperCase() === externalHash.hash.toUpperCase()
      );
      if (!alreadyListed) {
        const targetNode = externalHash.node || appState.NODE;
        const found = await fetchPartialTransactionByHash(targetNode, externalHash.hash);
        if (found?.transaction) {
          externalHtml =
            `<div style="color:#facc15;font-size:12px;">🔎 指定ノード(${targetNode})から直接見つかりました(自分の接続ノードにはまだ反映されていない可能性があります)</div>` +
            renderPendingItemHtml(externalHash.hash, found.transaction, targetNode);
        }
      }
    }

    if (items.length === 0 && !externalHtml) {
      el.innerHTML = `<div style="color:#94a3b8;">署名待ちのトランザクションはありません</div>`;
      return;
    }

    const listHtml = items
      .map((item) => renderPendingItemHtml(item.meta.hash, item.transaction, appState.NODE))
      .join("");

    el.innerHTML = externalHtml + listHtml;
  } catch (e) {
    console.error("loadPendingPartialTransactions error:", e);
    el.textContent = "取得に失敗しました";
  }
}

/* ============================================================
   nodeUrlOverride を指定すると、そのノードへ直接コサインをアナウンスする
   (相手から伝えられた「アナウンス先ノード」に確実に届けるため)。
   省略時は従来通り自分の接続中ノード(appState.NODE)を使う。
============================================================ */
async function cosignPending(transactionHashHex, nodeUrlOverride = null) {
  const nodeUrl = nodeUrlOverride || appState.NODE;

  const confirmed = await requestTxConfirmation({
    typeLabel: "マルチシグ連署(承認)",
    details: [
      { label: "対象トランザクションHash", value: transactionHashHex },
      ...(nodeUrlOverride ? [{ label: "アナウンス先ノード", value: nodeUrl }] : []),
    ],
  });
  if (!confirmed) {
    throw new TxCancelledError();
  }

  const cosignature = cosignTransactionHash(transactionHashHex);

  const res = await fetch(new URL("/transactions/cosignature", nodeUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cosignature),
  });

  const result = await res.json();
  if (!res.ok) {
    throw new Error(result.message ?? "連署のアナウンスに失敗しました");
  }
  return result;
}

window.W.multisig = {
  proposeBondedAggregate,
  loadMultisigInfo,
  fetchCosignatoryOfAddresses,
  updateMultisigSettings,
  sendFromMultisig,
  fetchPartialTransactionByHash,
  loadPendingPartialTransactions,
  cosignPending
};
