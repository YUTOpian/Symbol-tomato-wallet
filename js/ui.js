// ui.js
// 単純な UI 操作用ユーティリティ

/**
 * テキストを書き換える
 */
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/**
 * ステータス表示を更新する
 * color: default / success / error
 */
function setStatus(id, text, type = "default") {
  const el = document.getElementById(id);
  if (!el) return;

  el.textContent = text;

  el.style.color =
    type === "success"
      ? "#10b981"   // 緑
      : type === "error"
      ? "#ef4444"   // 赤
      : "#e5e7eb";  // 通常
}

window.W.ui = {
  setText,
  setStatus
};
