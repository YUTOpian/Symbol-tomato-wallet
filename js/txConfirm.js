// txConfirm.js
// トランザクションをアナウンス(ブロードキャスト)する前に、内容を確認するための共通ダイアログ。
// send/transfer, namespace登録, mosaic作成, multisig提案, metadata登録, restriction設定,
// apostille作成 など、ノードへアナウンスするすべての機能から共通で使う。
//
// ダイアログには「確認してブロードキャスト」「オフライントランザクション」「キャンセル」の
// 3つの選択肢があり、requestTxConfirmation() は以下のいずれかの文字列で解決する:
//   "confirm" : そのままオンラインで署名・アナウンスする
//   "offline" : この場では署名のみ行い、JSONファイルとして書き出す(アナウンスはしない)
//   "cancel"  : 何もしない
// オフラインで書き出したJSONを読み込んでアナウンスする場面では、二重にオフライン化
// できても意味がないため、hideOfflineButton: true を渡してボタン自体を消す。

const {appState} = W.config;

/* ============================================================
   ユーザーがキャンセルしたことを示す専用エラー
   呼び出し側は e.cancelled で判定できる
============================================================ */
class TxCancelledError extends Error {
  constructor(message = "ユーザーがキャンセルしました") {
    super(message);
    this.name = "TxCancelledError";
    this.cancelled = true;
  }
}

/* ============================================================
   「オフライントランザクションとして書き出した」ことを示す専用エラー
   (アナウンスはまだ行われていない)。呼び出し側は e.offlineExported で判定できる
============================================================ */
class TxOfflineExportedError extends Error {
  constructor(message = "オフライントランザクションとしてJSONファイルを書き出しました。ノードへはまだ送信されていません。") {
    super(message);
    this.name = "TxOfflineExportedError";
    this.offlineExported = true;
  }
}

/* ============================================================
   tx.deadline (Symbol Timestampオブジェクト) を人間が読める日時に変換
============================================================ */
function formatTxDeadline(tx) {
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
   確認ダイアログを表示し、結果を Promise<"confirm"|"offline"|"cancel"> で返す

   info:
     typeLabel        : トランザクション種別ラベル(必須。例:"送金","ネームスペース登録")
     sender           : 送信元(省略時は appState.currentAddress)
     recipient        : 送信先(任意。指定が無ければ行ごと非表示)
     fee              : 手数料(XYM、文字列。任意)
     deadlineText     : 有効期限の表示テキスト(任意)
     details          : [{ label, value }] 追加の確認項目(ネームスペース名・モザイクIDなど)
     hideOfflineButton: true にすると「オフライントランザクション」ボタンを表示しない
                        (既にオフライン署名済みのデータをアナウンスするだけの場面で使う)
============================================================ */
function requestTxConfirmation(info) {
  const { typeLabel, sender, recipient, fee, deadlineText, details = [], hideOfflineButton = false } = info;

  return new Promise((resolve) => {
    const dialog = document.getElementById("tx-confirm-dialog");

    // ダイアログ要素が無い場合は window.confirm にフォールバック(オフライン選択は非対応)
    if (!dialog || typeof dialog.showModal !== "function") {
      const lines = [
        `種別: ${typeLabel ?? "---"}`,
        `送信元: ${sender ?? appState.currentAddress?.toString() ?? "---"}`,
        recipient ? `送信先: ${recipient}` : null,
        fee != null ? `手数料: ${fee} XYM` : null,
        deadlineText ? `期限: ${deadlineText}` : null,
        ...details.map((d) => `${d.label}: ${d.value}`),
      ].filter(Boolean);
      resolve(window.confirm(lines.join("\n")) ? "confirm" : "cancel");
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
    const offlineBtn = document.getElementById("confirm-tx-offline-btn");
    const cancelBtn = document.getElementById("confirm-tx-cancel-btn");

    if (offlineBtn) {
      offlineBtn.style.display = hideOfflineButton ? "none" : "";
    }

    const cleanup = (result) => {
      okBtn.removeEventListener("click", onOk);
      offlineBtn?.removeEventListener("click", onOffline);
      cancelBtn.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onDialogCancel);
      if (dialog.open) dialog.close();
      resolve(result);
    };

    const onOk = () => cleanup("confirm");
    const onOffline = () => cleanup("offline");
    const onCancel = () => cleanup("cancel");
    const onDialogCancel = (e) => {
      e.preventDefault();
      cleanup("cancel");
    };

    okBtn.addEventListener("click", onOk);
    offlineBtn?.addEventListener("click", onOffline);
    cancelBtn.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onDialogCancel);

    dialog.showModal();
  });
}

window.W.txConfirm = {
  TxCancelledError,
  TxOfflineExportedError,
  formatTxDeadline,
  requestTxConfirmation
};
