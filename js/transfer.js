// transfer.js
// Symbol SDK v3
// モザイク送金トランザクション（SSS署名）

const {appState} = W.config;
const {setStatus} = W.ui;
const {getRecipientPublicKey} = W.account;
const {hexToBytes} = W.utils;
const {signAndAnnounceTx, encryptMessageLocally} = W.auth;
const {trackOutgoingTransaction} = W.txStatusTracker;

async function sendTx() {
  /*
    初期化確認
  */
  if (
    !appState.NODE ||
    !appState.currentAddress ||
    !appState.currentPubKey ||
    !appState.isSdkReady
  ) {
    setStatus("tx-status", "初期化が未完了です。", "error");
    return;
  }

  /*
    入力取得
  */
  const recipientRaw = document.getElementById("tx-recipient").value.trim();
  const amountStr = document.getElementById("tx-amount").value;
  const messageText = document.getElementById("tx-message").value || "";
  const selectedMosaicId = document.getElementById("selected-mosaic-id")?.value;

  /*
    入力チェック
  */
  if (!selectedMosaicId) {
    setStatus("tx-status", "モザイクを選択してください。", "error");
    return;
  }

  if (!recipientRaw || amountStr === "") {
    setStatus("tx-status", "アドレスと金額は必須です。", "error");
    return;
  }

  /*
    Address
  */
  const recipientAddress = new appState.sdkSymbol.Address(recipientRaw);
  const amount = Number(amountStr);

  if (Number.isNaN(amount) || amount <= 0) {
    setStatus("tx-status", "金額が不正です。", "error");
    return;
  }

  /*
    Mosaic情報取得
  */
  const divisibility = appState.mosaicInfo?.[selectedMosaicId]?.divisibility ?? 0;

  /*
    Mosaic Descriptor作成
  */
  const mosaic = new appState.sdkSymbol.descriptors.UnresolvedMosaicDescriptor(
    new appState.sdkSymbol.models.UnresolvedMosaicId(BigInt("0x" + selectedMosaicId)),
    new appState.sdkSymbol.models.Amount(BigInt(Math.floor(amount * (10 ** divisibility))))
  );

  /*
    Message
    速習Symbol v3形式
    0x00 = Plain Message / 0x01 = Encrypted Message

    「メッセージを暗号化する」がチェックされている場合、
    SSS Extensionログイン時は requestSignEncription()、
    ニーモニックログイン時はローカルの秘密鍵で暗号化する
    （SSS利用時は秘密鍵がここに出てくることはない）
  */
  const shouldEncrypt = !!document.getElementById("tx-encrypt")?.checked;
  let message;

  if (shouldEncrypt && messageText.trim() !== "") {
    try {
      setStatus("tx-status", "受信者の公開鍵を取得中...");
      const recipientPubKeyHex = await getRecipientPublicKey(recipientAddress);

      if (appState.authMode === "local") {
        setStatus("tx-status", "メッセージを暗号化しています...");
        message = encryptMessageLocally(recipientPubKeyHex, messageText);
      } else {
        setStatus("tx-status", "SSSでメッセージを暗号化しています...");
        window.SSS.setMessage(messageText, recipientPubKeyHex);
        const encrypted = await window.SSS.requestSignEncription();

        if (!encrypted?.payload) {
          throw new Error("メッセージの暗号化に失敗しました");
        }

        message = new Uint8Array([0x01, ...hexToBytes(encrypted.payload)]);

        // SSS Extensionのポップアップを閉じた直後に次のポップアップを
        // 開こうとすると、表示が間に合わず一瞬で消えてしまうことがあるため、
        // 少し間隔を空けてから次の署名(送金Tx)をリクエストする
        await new Promise((r) => setTimeout(r, 600));
      }
    } catch (e) {
      console.error("encrypt message error:", e);
      setStatus(
        "tx-status",
        "メッセージの暗号化に失敗しました（受信者アカウントに公開鍵が公開されていない可能性があります）。",
        "error"
      );
      return;
    }
  } else {
    const messageBytes = new TextEncoder().encode(messageText);
    message = new Uint8Array([0x00, ...messageBytes]);
  }

  /*
    Transfer Descriptor
    TransferTransactionV1
  */
  const descriptor = new appState.sdkSymbol.descriptors.TransferTransactionV1Descriptor(
    recipientAddress,
    [mosaic],
    message
  );

  /*
    Transaction作成
    deadline 1時間
  */
  const tx = appState.facade.createTransactionFromTypedDescriptor(
    descriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  /*
    確認画面用の情報
    (手数料・期限・送信元は signAndAnnounceTx 側で tx から自動算出される)
  */
  const mosaicInfo = appState.mosaicInfo?.[selectedMosaicId];
  const mosaicName = mosaicInfo?.mosaicName ?? selectedMosaicId;

  const confirmInfo = {
    typeLabel: "送金",
    recipient: recipientRaw,
    details: [
      { label: "モザイク", value: `${mosaicName} (${selectedMosaicId})` },
      { label: "数量", value: amountStr },
      { label: "メッセージ", value: messageText.trim() !== "" ? messageText : "(なし)" },
      ...(shouldEncrypt ? [{ label: "メッセージ暗号化", value: "する" }] : []),
    ],
  };

  try {
    setStatus("tx-status", "確認画面を表示しています...");
    const hash = await signAndAnnounceTx(tx, confirmInfo);
    setStatus("tx-status", "", "default");

    trackOutgoingTransaction({
      hash,
      recipient: recipientRaw,
      mosaicLabel: mosaicName,
      amountText: `${amountStr} 数量`,
    });
  } catch (e) {
    if (e?.cancelled) {
      setStatus("tx-status", "送金をキャンセルしました。");
      return;
    }
    console.error("transfer error:", e);
    setStatus("tx-status", e.message ?? "署名または送信に失敗しました。", "error");
  }
}

window.W.transfer = {
  sendTx
};
