// ws.js
import { appState } from "./config.js";
import { playSoundOnce } from "./utils.js";

let ws = null;
let uid = "";
let callbacks = {};              // ← 再接続ごとにリセットされるように維持
let soundHooksRegistered = false; // ← 音のcallbackを二重登録しないため

/* ============================================================
   WebSocket 開始
============================================================ */
export function initWebSocket(address) {
  const wsUrl = appState.NODE.replace("http", "ws") + "/ws";

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("WS Connected:", wsUrl);

    soundHooksRegistered = false;
  };

  ws.onmessage = e => {
    const data = JSON.parse(e.data);

    // ① 初回受信（uid 受け取り）
    if (data.uid !== undefined) {
      uid = data.uid;

      // 監視開始
      subscribe("block");
      subscribe(`unconfirmedAdded/${address}`);
      subscribe(`confirmedAdded/${address}`);

      // 🔥 音の callback は **1回だけ登録する**
      registerSoundCallbacks(address);

      return;
    }

    // ② 通常のメッセージ
    const topic = data.topic;
    if (callbacks[topic]) {
      // 登録された callback を実行
      callbacks[topic].forEach(cb => cb(data));
    }
  };

  ws.onerror = err => console.error("WS error:", err);

  ws.onclose = () => {
    console.log("WS Closed. Reconnecting...");
    // 🔥 Socket が閉じたら 1.2秒後に自動再接続
    setTimeout(() => initWebSocket(address), 1200);
  };
}

/* ============================================================
   WebSocket 切断（ノード切替時などに使用）
============================================================ */
export function closeWebSocket() {
  if (ws) {
    ws.onclose = null; // 自動再接続を無効化してから閉じる
    ws.close();
    ws = null;
  }
}

/* ============================================================
   subscribe
============================================================ */
export function subscribe(topic) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ uid, subscribe: topic }));
}

/* ============================================================
   callback 登録
============================================================ */
export function addCallback(topic, cb) {
  if (!callbacks[topic]) callbacks[topic] = [];
  callbacks[topic].push(cb);
}

/* ============================================================
   block height → timestamp
============================================================ */
export async function getBlockTimestamp(height) {
  try {
    const url = `${appState.NODE}/blocks/${height}`;
    const json = await fetch(url).then(r => r.json());
    return json.block.timestamp;
  } catch {
    return null;
  }
}

/* ============================================================
   未承認 / 承認の音を１回だけ登録
============================================================ */
function registerSoundCallbacks(address) {
  if (soundHooksRegistered) return; // 🔥 2重登録防止

  // 未承認トランザクション検知
  addCallback(`unconfirmedAdded/${address}`, () => {
    playSoundOnce("./sounds/ding.ogg");
  });

  // 承認トランザクション検知
  addCallback(`confirmedAdded/${address}`, () => {
    playSoundOnce("./sounds/ding2.ogg");
  });

  soundHooksRegistered = true;
}
