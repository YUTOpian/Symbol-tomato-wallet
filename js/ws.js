// ws.js
// Symbol REST Node の WebSocket (/ws) 接続管理
//
// 提供する機能:
//   initWebSocket(address) : 接続開始(ログイン完了時・ノード切替時に呼ぶ)
//   closeWebSocket()       : 接続を明示的に閉じる(ログアウト・ノード切替前)
//   subscribe(topic)       : topicを購読する(すでに購読中なら何もしない)
//   addCallback(topic, cb) : topic受信時のコールバック登録。登録時に自動でsubscribeも行う
//   getBlockTimestamp(h)   : 指定した高さのブロックタイムスタンプをREST APIから取得(キャッシュ付き)
//
// Symbol REST の /ws プロトコル:
//   接続直後にサーバーから {"uid": "xxxx"} が送られてくる。
//   購読は {"uid": uid, "subscribe": "confirmedAdded/ADDRESS"} を送信して行う。
//   受信データは {"topic": "confirmedAdded/ADDRESS", "data": {...}} の形で届く。
//
// 切断時は指数バックオフで自動再接続し、それまで購読していたtopicを
// 再接続後に再購読する(呼び出し側で再度addCallback/subscribeし直す必要はない)。
// ※ txStatusTracker.js 側はさらにポーリングも併用しており、
//   再接続中の取りこぼしにも備えている。

const {appState} = W.config;

const MAX_RECONNECT_DELAY_MS = 15000;

let socket = null;
let uid = null;
let manuallyClosed = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let lastAddress = null;

// 接続確立(uid受信)前に来た購読要求。uid受信後にまとめて送信する
const pendingSubscriptions = new Set();
// 実際にsubscribeメッセージを送信済みのtopic(再接続時の再購読に使う)
const subscribedTopics = new Set();

// topic → callback群
const callbacks = new Map();

// getBlockTimestamp用キャッシュ(確定済みブロックのタイムスタンプは変化しないため)
const blockTimestampCache = new Map();

/* ============================================================
   http(s):// の NODE URL → ws(s)://.../ws に変換
============================================================ */
function toWsUrl(nodeOrigin) {
  const u = new URL(nodeOrigin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  return u.toString();
}

function sendSubscribeMessage(topic) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !uid) {
    pendingSubscriptions.add(topic);
    return;
  }
  try {
    socket.send(JSON.stringify({ uid, subscribe: topic }));
    subscribedTopics.add(topic);
    pendingSubscriptions.delete(topic);
  } catch (e) {
    console.warn("ws subscribe送信失敗:", topic, e);
    pendingSubscriptions.add(topic);
  }
}

function flushPendingSubscriptions() {
  for (const topic of pendingSubscriptions) {
    sendSubscribeMessage(topic);
  }
}

function handleMessage(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch (e) {
    console.warn("wsメッセージのパースに失敗しました:", e);
    return;
  }

  // 接続直後の初回メッセージ(uid通知)
  if (msg && msg.uid && !msg.topic) {
    uid = msg.uid;
    flushPendingSubscriptions();
    return;
  }

  const topic = msg && msg.topic;
  if (!topic) return;

  const cbs = callbacks.get(topic);
  if (!cbs || cbs.size === 0) return;

  for (const cb of cbs) {
    try {
      cb(msg);
    } catch (e) {
      console.error("wsコールバックでエラーが発生しました:", topic, e);
    }
  }
}

function scheduleReconnect() {
  if (manuallyClosed) return;

  reconnectAttempts++;
  const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS);

  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (manuallyClosed) return;
    console.warn(`WebSocket再接続を試みます(${reconnectAttempts}回目)`);
    connect();
  }, delay);
}

function connect() {
  if (!appState.NODE) return;

  uid = null;

  let wsUrl;
  try {
    wsUrl = toWsUrl(appState.NODE);
  } catch (e) {
    console.warn("WebSocket URLの組み立てに失敗しました:", e);
    scheduleReconnect();
    return;
  }

  try {
    socket = new WebSocket(wsUrl);
  } catch (e) {
    console.warn("WebSocket接続の作成に失敗しました:", e);
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    reconnectAttempts = 0;

    // 再接続の場合、以前購読していたtopicをすべて再購読要求として積む
    for (const topic of subscribedTopics) {
      pendingSubscriptions.add(topic);
    }
    subscribedTopics.clear();
  };

  socket.onmessage = handleMessage;

  socket.onerror = (e) => {
    console.warn("WebSocketエラー:", e);
  };

  socket.onclose = () => {
    socket = null;
    uid = null;
    if (!manuallyClosed) {
      scheduleReconnect();
    }
  };
}

/* ============================================================
   接続開始(ログイン完了時・ノード切替時に呼ぶ)
============================================================ */
function initWebSocket(address) {
  lastAddress = address;
  manuallyClosed = false;
  reconnectAttempts = 0;
  clearTimeout(reconnectTimer);
  connect();
}

/* ============================================================
   接続を明示的に閉じる(ログアウト・ノード切替前)
============================================================ */
function closeWebSocket() {
  manuallyClosed = true;
  clearTimeout(reconnectTimer);

  if (socket) {
    try {
      socket.close();
    } catch {
      // noop
    }
  }

  socket = null;
  uid = null;
  lastAddress = null;
  pendingSubscriptions.clear();
  subscribedTopics.clear();
  callbacks.clear();
}

/* ============================================================
   topicを購読する(すでに購読中/購読待ちなら何もしない)
============================================================ */
function subscribe(topic) {
  if (!topic) return;
  if (subscribedTopics.has(topic) || pendingSubscriptions.has(topic)) return;
  sendSubscribeMessage(topic);
}

/* ============================================================
   topic受信時のコールバック登録。
   呼び出し側が個別にsubscribe()を呼ばなくても動作するよう、
   登録時に自動的にsubscribeも行う。
============================================================ */
function addCallback(topic, cb) {
  if (!topic || typeof cb !== "function") return;

  if (!callbacks.has(topic)) {
    callbacks.set(topic, new Set());
  }
  callbacks.get(topic).add(cb);

  subscribe(topic);
}

/* ============================================================
   指定した高さのブロックタイムスタンプ(Symbol Timestamp, 生の数値文字列)を取得する
   確定済みブロックの値は変化しないためキャッシュする。
============================================================ */
async function getBlockTimestamp(height) {
  const key = String(height);

  if (blockTimestampCache.has(key)) {
    return blockTimestampCache.get(key);
  }

  if (!appState.NODE || height == null) return null;

  try {
    const res = await fetch(new URL("/blocks/" + height, appState.NODE));
    if (!res.ok) return null;

    const json = await res.json();
    const timestamp = json.block?.timestamp ?? null;

    blockTimestampCache.set(key, timestamp);
    return timestamp;
  } catch (e) {
    console.warn("ブロックタイムスタンプの取得に失敗しました:", height, e);
    return null;
  }
}

window.W.ws = {
  initWebSocket,
  closeWebSocket,
  subscribe,
  addCallback,
  getBlockTimestamp
};
