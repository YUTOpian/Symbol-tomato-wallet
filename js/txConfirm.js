// txConfirm.js
// トランザクションをアナウンス(ブロードキャスト)する前に、内容を確認するための共通ダイアログ。
// send/transfer, namespace登録, mosaic作成, multisig提案, metadata登録, restriction設定,
// apostille作成 など、ノードへアナウンスするすべての機能から共通で使う。

import { appState } from "./config.js";

/* ============================================================
   ユーザーがキャンセルしたことを示す専用エラー
   呼び出し側は e.cancelled で判定できる
============================================================ */
export class TxCancelledError extends Error {
  constructor(message = "ユーザーがキャンセルしました") {
    super(message);
    this.name = "TxCancelledError";
    this.cancelled = true;
  }
}

/* ============================================================
   tx.deadline (Symbol Timestampオブジェクト) を人間が読める日時に変換
============================================================ */
export function formatTxDeadline(tx) {
  try {
    const raw = tx?.deadline?.value ?? tx?.deadline;
    if (raw == null || !appState.epochAdjustment) return "---";
    const unixMs = Number(appState.epochAdjustment) * 1000 + Number(raw);
    return new Date(unixMs).toLocaleString("ja-JP", { hour12: false });
  } catch {
    return "---";
  }
}

/* ============================================================
   確認ダイアログを表示し、「確認」/「キャンセル」の結果をPromise<boolean>で返す

   info:
     typeLabel   : トランザクション種別ラベル(必須。例:"送金","ネームスペース登録")
     sender      : 送信元(省略時は appState.currentAddress)
     recipient   : 送信先(任意。指定が無ければ行ごと非表示)
     fee         : 手数料(XYM、文字列。任意)
     deadlineText: 有効期限の表示テキスト(任意)
     details     : [{ label, value }] 追加の確認項目(ネームスペース名・モザイクIDなど)
============================================================ */
export function requestTxConfirmation(info) {
  const { typeLabel, sender, recipient, fee, deadlineText, details = [] } = info;

  return new Promise((resolve) => {
    const dialog = document.getElementById("tx-confirm-dialog");

    // ダイアログ要素が無い場合は window.confirm にフォールバック
    if (!dialog || typeof dialog.showModal !== "function") {
      const lines = [
        `種別: ${typeLabel ?? "---"}`,
        `送信元: ${sender ?? appState.currentAddress?.toString() ?? "---"}`,
        recipient ? `送信先: ${recipient}` : null,
        fee != null ? `手数料: ${fee} XYM` : null,
        deadlineText ? `期限: ${deadlineText}` : null,
        ...details.map((d) => `${d.label}: ${d.value}`),
      ].filter(Boolean);
      resolve(window.confirm(lines.join("\n")));
      return;
    }

    document.getElementById("confirm-tx-type").textContent = typeLabel ?? "---";
    document.getElementById("confirm-tx-sender").textContent =
      sender ?? appState.currentAddress?.toString() ?? "---";

    const recipientRow = document.getElementById("confirm-tx-recipient-row");
    if (recipient) {
      recipientRow.style.display = "";
      document.getElementById("confirm-tx-recipient").textContent = recipient;
    } else {
      recipientRow.style.display = "none";
    }

    const feeRow = document.getElementById("confirm-tx-fee-row");
    if (fee != null) {
      feeRow.style.display = "";
      document.getElementById("confirm-tx-fee").textContent = fee;
    } else {
      feeRow.style.display = "none";
    }

    const deadlineRow = document.getElementById("confirm-tx-deadline-row");
    if (deadlineText) {
      deadlineRow.style.display = "";
      document.getElementById("confirm-tx-deadline").textContent = deadlineText;
    } else {
      deadlineRow.style.display = "none";
    }

    const detailsEl = document.getElementById("confirm-tx-details");
    detailsEl.innerHTML = details
      .map(
        (d) =>
          `<div class="confirm-tx-row"><b>${d.label}：</b><span>${d.value ?? "---"}</span></div>`
      )
      .join("");

    const okBtn = document.getElementById("confirm-tx-ok-btn");
    const cancelBtn = document.getElementById("confirm-tx-cancel-btn");

    const cleanup = (result) => {
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onDialogCancel);
      if (dialog.open) dialog.close();
      resolve(result);
    };

    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onDialogCancel = (e) => {
      e.preventDefault();
      cleanup(false);
    };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onDialogCancel);

    dialog.showModal();
  });
}
