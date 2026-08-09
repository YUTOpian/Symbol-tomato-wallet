(function () {
"use strict";

// harvest.js
// 委任ハーベスティング (Delegated Harvesting) フル実装
//
// 手順:
//   ① AccountKeyLinkTransaction  … メインアカウントの重要度をリモート署名アカウントへ委任
//   ② VrfKeyLinkTransaction      … VRF鍵をメインアカウントにリンク（委任ハーベスト必須）
//   ③ NodeKeyLinkTransaction     … どのノードに委任するかをオンチェーンで宣言
//   ①②③は1つのAggregate Complete Transactionにまとめ、署名してアナウンスする
//   ④ PersistentDelegationRequestTransaction
//        … リモート鍵・VRF鍵の秘密鍵を「ノード宛」に暗号化したメッセージとして
//          TransferTransactionに載せて送る。これでノードがハーベスト委任を認識する。
//
// 署名はSSS Extension / ニーモニックログイン(ローカル署名)の両方に対応。
//
// 参考: https://docs.symbol.dev/concepts/harvesting.html
//       https://docs.symbol.dev/guides/harvesting/activating-delegated-harvesting-manual.html

const {appState, MAINNET_NODEWATCH_URL, TESTNET_NODEWATCH_URL, NetworkType} = W.config;
const {setStatus} = W.ui;
// (requestTxConfirmation はここでは直接使わない。署名・アナウンスはauth.jsのsignAndAnnounceTxに委譲している)
const {trackOutgoingTransaction} = W.txStatusTracker;
const {addCallback} = W.ws;
const {hexToBytes, formatMosaicAmount} = W.utils;
const {getXymJpyRate, getXymUsdRate} = W.priceRates;

/* ============================================================
   委任先ノード候補の読み込み（NodeWatchから取得しプルダウンに反映）
   ※ ここで出てくるのは単にオンラインなノード一覧であり、
     「委任ハーベスティングを受け付けている」保証はない。
============================================================ */
async function loadHarvestNodeCandidates() {
  const select = document.getElementById("harvest-node-select");
  if (!select) return;

  select.innerHTML = `<option value="">-- 候補を読み込み中... --</option>`;

  const isTestnet = appState.networkType === NetworkType.TESTNET;
  const url = isTestnet ? TESTNET_NODEWATCH_URL : MAINNET_NODEWATCH_URL;

  try {
    const res = await fetch(url);
    const nodes = await res.json();

    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new Error("empty");
    }

    nodes.sort((a, b) => b.height - a.height);

    select.innerHTML =
      `<option value="">-- ノードを選択（未選択なら接続中ノードを使用）--</option>` +
      nodes
        .slice(0, 30)
        .map((n) => {
          const label = `${n.endpoint}（高さ:${n.height}）`;
          return `<option value="${n.endpoint}">${label}</option>`;
        })
        .join("");
  } catch (e) {
    console.warn("ノード候補の取得に失敗しました", e);
    select.innerHTML = `<option value="">-- 候補の取得に失敗（下に直接URLを入力してください）--</option>`;
  }
}

/* ============================================================
   実際に使用する委任先ノードURLを決定
   優先順位: 直接入力欄 > プルダウン選択 > 現在接続中のノード(appState.NODE)
============================================================ */
function getSelectedHarvestNodeUrl() {
  const manual = document.getElementById("harvest-node-input")?.value?.trim();
  if (manual) return manual;

  const selected = document.getElementById("harvest-node-select")?.value?.trim();
  if (selected) return selected;

  return appState.NODE;
}

/* ============================================================
   直近生成したリモート鍵・VRF鍵（セッション内のみ保持）
   ページをリロードすると消えるので、④が失敗した場合に備えて
   画面にも表示してユーザーに控えてもらう。
============================================================ */
let lastGeneratedKeys = null;

/* ============================================================
   ランダム秘密鍵生成（32byte）
============================================================ */
function randomPrivateKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return new appState.sdkCore.PrivateKey(bytes);
}

function toHex(bytesOrKey) {
  const bytes = bytesOrKey.bytes ?? bytesOrKey;
  return appState.sdkCore.utils.uint8ToHex(bytes);
}

/* ============================================================
   ノード公開鍵取得 (/node/info の nodePublicKey)
   ※ これは NodeKeyLinkTransaction 用の鍵であり、
     REST証明書(CA)公開鍵とは別物なので注意
============================================================ */
async function fetchNodePublicKey(nodeUrl) {
  const res = await fetch(new URL("/node/info", nodeUrl));
  const info = await res.json();
  if (!info.nodePublicKey) {
    throw new Error(`ノード(${nodeUrl})から nodePublicKey を取得できませんでした`);
  }
  return new appState.sdkCore.PublicKey(info.nodePublicKey);
}

/* ============================================================
   対象アカウントの選択（自分自身 / 連署者になっているマルチシグアカウント）
   ハーベストは必ずしも「今ログイン中のアカウント」に対して設定するとは
   限らない。マルチシグアカウントの委任ハーベスティングは、連署者が
   自分自身のアカウントでログインした状態で、対象としてマルチシグの
   アドレスを選び、提案(アグリゲートボンデッド)する形になる。
   また、マルチシグアカウントの状態を確認するだけなら、読み取り専用
   モードでそのアドレスを直接開いても良い(その場合は署名系の操作は
   すべて弾かれる)。
============================================================ */
async function loadHarvestTargetOptions() {
  const select = document.getElementById("harvest-target-select");
  if (!select) return;

  const selfAddress = appState.currentAddress?.toString();
  select.innerHTML = `<option value="">-- 自分自身（${selfAddress ?? "---"}）--</option>`;

  // 読み取り専用モードでは「連署者として提案する」ことができないため、
  // マルチシグ候補の取得自体を行わない(自分自身の閲覧のみ)
  if (appState.isReadOnly || !W.multisig) return;

  try {
    const addresses = await W.multisig.fetchCosignatoryOfAddresses();
    for (const a of addresses) {
      const option = document.createElement("option");
      option.value = a;
      option.textContent = `${a}（連署者として提案）`;
      select.appendChild(option);
    }
  } catch (e) {
    console.warn("マルチシグ候補の取得に失敗しました", e);
  }
}

function getSelectedHarvestTargetAddress() {
  const selected = document.getElementById("harvest-target-select")?.value?.trim();
  return selected || appState.currentAddress?.toString();
}

/* ============================================================
   注記: 「ハーベスト報酬」タブの対象アカウント選択(自分自身 / 連署者に
   なっているマルチシグアカウント)は、保有モザイク・アクティビティの
   両タブとも共通のウォレット画面の対象アカウント選択(wallet-target-select)
   に統合されている。選択肢の読み込み・選択中アドレスの取得は
   account.js の loadWalletTargetOptions() / getSelectedWalletTargetAddress()
   が担う(loadHarvestRewards() 内から利用)。
============================================================ */

/* ============================================================
   指定アドレスの公開鍵を解決する。
   - 自分自身（ログイン中のアカウント）なら appState.currentPubKey を使う
     (まだ一度もチェーンへ送信していないアカウントでも、ログイン時点で
     公開鍵は分かっているため)
   - それ以外(マルチシグアカウントなど、秘密鍵を保持していない対象)は
     チェーン上の /accounts/{address} から publicKey を取得する。
     一度も自分自身でトランザクションを送信していないアカウントは
     公開鍵がまだチェーンに登録されておらず(全ゼロ)、解決できない。
============================================================ */
async function resolveAccountPublicKeyHex(address) {
  if (!address) return null;

  if (appState.currentPubKey && address === appState.currentAddress?.toString()) {
    return appState.currentPubKey.toString();
  }

  if (!appState.NODE) return null;

  try {
    const res = await fetch(`${appState.NODE}/accounts/${address}`);
    if (!res.ok) return null;
    const json = await res.json();
    const pubKey = json.account?.publicKey;
    if (!pubKey || /^0+$/.test(pubKey)) return null;
    return pubKey;
  } catch (e) {
    console.warn("公開鍵の解決に失敗しました:", address, e);
    return null;
  }
}

/* ============================================================
   ハーベストしたブロックの検索に使う「実際にブロックへ署名した鍵」を
   すべて解決する。
   Symbolの委任ハーベスティングでは、ブロックは本体アカウントの鍵ではなく
   AccountKeyLinkでリンクした「リモート鍵」で署名される
   (supplementalPublicKeys.linked.publicKey がそれにあたる)。
   本体アカウントの鍵だけで /blocks?signerPublicKey= を検索すると、
   委任ハーベスティングで実際にブロックを生成していても
   常にヒットしない(誤って「ハーベスト履歴なし」と表示される)ため、
   本体の鍵とリモート鍵の両方を候補として返す。
   ・kind: "self" … 本体アカウントの鍵で直接ハーベスト(委任なし)
   ・kind: "node" … リモート鍵で署名＝ノードへの委任ハーベスティング
   両方をUI側で区別して表示できるよう、鍵とあわせて種別を返す。
============================================================ */
async function resolveHarvestSignerPublicKeys(address) {
  if (!address || !appState.NODE) return [];

  try {
    const res = await fetch(`${appState.NODE}/accounts/${address}`);
    if (!res.ok) return [];
    const json = await res.json();
    const account = json.account;
    if (!account) return [];

    const seen = new Set();
    const result = [];

    const mainPubKey = account.publicKey;
    if (mainPubKey && !/^0+$/.test(mainPubKey)) {
      const key = mainPubKey.toUpperCase();
      seen.add(key);
      result.push({ key, kind: "self" });
    }

    const linkedPubKey = account.supplementalPublicKeys?.linked?.publicKey;
    if (linkedPubKey && !/^0+$/.test(linkedPubKey)) {
      const key = linkedPubKey.toUpperCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ key, kind: "node" });
      }
    }

    return result;
  } catch (e) {
    console.warn("ハーベスト署名鍵の解決に失敗しました:", address, e);
    return [];
  }
}

/* ============================================================
   ハーベスト種別（本人 / ノード委任）を示す小さなバッジHTML
   ※ 内部的には self(本体アカウントの鍵) / node(委任先ノードのリモート鍵)
     を区別しているが、表示上はどちらも同じ「ハーベスト」ラベルにする
============================================================ */
function harvestKindBadgeHtml(kind) {
  if (kind !== "node" && kind !== "self") return "";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:bold;background:#3f2d1e;color:#fbbf24;">🍅 ハーベスト</span>`;
}

/* ============================================================
   XYM数量(atomic)から、円・ドル換算を「(32円 / 0.21ドル)」の形で
   付け足すための文字列を作る。レートが取得できていない側は省略する。
   (account.jsの残高換算表示と同じ考え方)
============================================================ */
function formatFiatSuffix(xymAmountNumber, jpyRate, usdRate) {
  const parts = [];
  if (jpyRate != null) {
    const jpy = Math.round(xymAmountNumber * jpyRate);
    parts.push(`${jpy.toLocaleString("ja-JP")}円`);
  }
  if (usdRate != null) {
    const usd = xymAmountNumber * usdRate;
    parts.push(`${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}ドル`);
  }
  return parts.length > 0 ? ` (${parts.join(" / ")})` : "";
}

/* ============================================================
   複数の signerPublicKey で取得したブロック一覧を、高さ(height)で
   重複排除しつつ新しい順に並べ直す
   (各itemに付与された __harvestKind はそのまま保持される)
============================================================ */
function dedupeAndSortBlocksDesc(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const height = String(item.block?.height);
    if (seen.has(height)) continue;
    seen.add(height);
    unique.push(item);
  }
  unique.sort((a, b) => Number(b.block.height) - Number(a.block.height));
  return unique;
}

/* ============================================================
   指定アドレスがマルチシグアカウントかどうか
============================================================ */
async function checkIsMultisig(address) {
  try {
    const res = await fetch(`${appState.NODE}/account/${address}/multisig`);
    if (res.status === 404) return { isMultisig: false };
    if (!res.ok) return { isMultisig: false };
    const json = await res.json();
    return { isMultisig: true, minApproval: json.multisig?.minApproval };
  } catch (e) {
    console.warn("マルチシグ判定に失敗しました:", address, e);
    return { isMultisig: false };
  }
}

/* ============================================================
   ハーベスト状態確認
   targetAddress省略時は harvest-target-select の選択(なければ自分自身)を使う
============================================================ */
async function checkHarvestStatus(targetAddress) {
  const address = targetAddress || getSelectedHarvestTargetAddress();
  const addressEl = document.getElementById("harvest-address");
  if (addressEl && address) addressEl.textContent = address;
  return await checkHarvestStatusFor(address);
}

async function checkHarvestStatusFor(address) {
  const statusEl = document.getElementById("harvest-status");
  const importanceEl = document.getElementById("harvest-importance");
  const badgeEl = document.getElementById("harvest-badge");
  if (!statusEl) return;

  const setBadge = (cls, text) => {
    if (!badgeEl) return;
    badgeEl.className = `harvest-badge ${cls}`;
    badgeEl.textContent = text;
  };

  if (!address) {
    statusEl.textContent = "対象アカウントが未指定です";
    setBadge("inactive", "❌ 未指定");
    return;
  }

  try {
    statusEl.textContent = "状態確認中...";
    setBadge("", "確認中...");

    const res = await fetch(`${appState.NODE}/accounts/${address}`);
    const json = await res.json();
    const account = json.account;

    if (!account) {
      statusEl.textContent = "アカウント情報取得失敗";
      setBadge("inactive", "❌ アカウント未登録");
      return;
    }

    const importance = account.importance;
    console.log("importance:", importance);

    if (importanceEl) {
      importanceEl.textContent = importance ? BigInt(importance).toString() : "0";
    }

    // supplementalPublicKeys の有無で委任状況を判定
    const keys = account.supplementalPublicKeys;
    const linked = !!keys?.linked;
    const vrf = !!keys?.vrf;
    const node = !!keys?.node;
    const linkedInfo = `remote:${linked} vrf:${vrf} node:${node}`;

    if (linked && vrf && node) {
      setBadge("active", "✅ 委任ハーベスティング設定済み（鍵リンク完了）");
    } else if (linked || vrf || node) {
      setBadge("partial", "⚠️ 一部の鍵のみリンク済み（設定不完全）");
    } else {
      setBadge("inactive", "❌ 委任ハーベスティング未設定");
    }

    statusEl.textContent =
      importance && Number(importance) > 0
        ? `重要度あり ${linkedInfo}`
        : `重要度なし ${linkedInfo}`;
  } catch (e) {
    console.error("Harvest status error:", e);
    statusEl.textContent = "状態取得エラー";
    setBadge("inactive", "❌ 状態取得エラー");
  }
}

/* ============================================================
   トランザクション確認待ち（承認 or 失敗まで polling）
============================================================ */
async function waitConfirmed(hash, { timeoutMs = 60000, intervalMs = 3000 } = {}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${appState.NODE}/transactionStatus/${hash}`);
      if (res.ok) {
        const json = await res.json();
        if (json.group === "confirmed") return true;
        if (json.group === "failed") {
          throw new Error("Transaction failed: " + (json.code ?? "unknown"));
        }
      }
    } catch (e) {
      // 404 = まだunconfirmedにも乗っていない可能性があるので継続
      console.warn("waitConfirmed polling error:", e);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error("承認待ちがタイムアウトしました");
}

/* ============================================================
   署名 → アナウンス（共通処理）
   SSS Extension / ニーモニックログイン(ローカル署名)の両方に対応。
   実体は auth.js の signAndAnnounceTx に委譲する(オフライントランザクション
   としての書き出しにもこれで対応できる)。
============================================================ */
async function signAndAnnounce(tx, confirmInfo) {
  return await W.auth.signAndAnnounceTx(tx, confirmInfo);
}

/* ============================================================
   ① + ② + ③ を1つのAggregate Complete Transactionにまとめて送信
============================================================ */
async function announceKeyLinks(remoteKeyPair, vrfKeyPair, nodePublicKey, harvestNodeUrl, target) {
  const { descriptors, models } = appState.sdkSymbol;
  const { signerPublicKey, viaMultisig, address } = target;

  const embedded = [
    appState.facade.createEmbeddedTransactionFromTypedDescriptor(
      new descriptors.AccountKeyLinkTransactionV1Descriptor(
        remoteKeyPair.publicKey,
        models.LinkAction.LINK
      ),
      signerPublicKey
    ),
    appState.facade.createEmbeddedTransactionFromTypedDescriptor(
      new descriptors.VrfKeyLinkTransactionV1Descriptor(
        vrfKeyPair.publicKey,
        models.LinkAction.LINK
      ),
      signerPublicKey
    ),
    appState.facade.createEmbeddedTransactionFromTypedDescriptor(
      new descriptors.NodeKeyLinkTransactionV1Descriptor(
        nodePublicKey,
        models.LinkAction.LINK
      ),
      signerPublicKey
    ),
  ];

  const confirmInfo = {
    typeLabel: viaMultisig ? "委任ハーベスティング設定(鍵リンク・マルチシグ提案)" : "委任ハーベスティング設定(鍵リンク)",
    sender: address,
    kind: "harvest",
    details: [
      { label: "対象アカウント", value: address },
      { label: "委任先ノード", value: harvestNodeUrl },
      { label: "リモート公開鍵", value: remoteKeyPair.publicKey.toString() },
      { label: "VRF公開鍵", value: vrfKeyPair.publicKey.toString() },
      { label: "ノード公開鍵", value: nodePublicKey.toString() },
    ],
  };

  /*
    マルチシグアカウントは自分自身の鍵で直接署名することができない
    (ネットワーク側で拒否される)。連署者として、アグリゲートボンデッド
    Tx + ハッシュロックで「提案」し、必要数の連署が集まるのを待つ形にする
    (multisig.js の proposeBondedAggregate と同じ流れ)。
  */
  if (viaMultisig) {
    const hash = await W.multisig.proposeBondedAggregate(embedded, 0, confirmInfo);
    return { hash, pendingCosign: true };
  }

  const aggregateDescriptor = new descriptors.AggregateCompleteTransactionV3Descriptor(
    appState.facade.static.hashEmbeddedTransactions(embedded),
    embedded
  );

  const aggregateTx = appState.facade.createTransactionFromTypedDescriptor(
    aggregateDescriptor,
    signerPublicKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  const hash = await signAndAnnounce(aggregateTx, confirmInfo);
  return { hash, pendingCosign: false };
}

/* ============================================================
   ④ PersistentDelegationRequestTransaction の作成・送信
   ※ ここは symbol-sdk のバージョンによってAPI名が変わりやすい部分。
     見つからない場合は encoder のプロパティ一覧をconsoleに出して
     原因を特定できるようにしている。
============================================================ */
async function announcePersistentDelegationRequest(remoteKeyPair, vrfKeyPair, nodePublicKey, target) {
  const { signerPublicKey, viaMultisig, address } = target;
  const { descriptors, MessageEncoder } = appState.sdkSymbol;

  if (typeof MessageEncoder !== "function") {
    throw new Error(
      "このSDKバージョンには MessageEncoder が見つかりません。sdk.js で読み込んでいる " +
      "symbol-sdk のバンドル内容を console.log(appState.sdkSymbol) で確認してください。"
    );
  }

  // 暗号化自体はメインアカウントの秘密鍵を必要としない
  // （SDKが内部でephemeralな鍵を都度生成しノード公開鍵とECDHするため）。
  // encoder の生成にダミーのKeyPairが必要なSDKもあるので、その場合は
  // ランダム鍵で作ったAccount相当のオブジェクトを渡す。
  let encodedMessage;
  try {
    const dummyKeyPair = new appState.sdkSymbol.KeyPair(randomPrivateKey());
    const encoder = new MessageEncoder(dummyKeyPair);

    if (typeof encoder.encodePersistentHarvestingDelegation === "function") {
      encodedMessage = encoder.encodePersistentHarvestingDelegation(
        nodePublicKey,
        remoteKeyPair,
        vrfKeyPair
      );
    } else {
      console.warn(
        "encodePersistentHarvestingDelegation が見つかりません。利用可能なメソッド:",
        Object.getOwnPropertyNames(Object.getPrototypeOf(encoder))
      );
      throw new Error("MessageEncoderに委任メッセージ用のメソッドが見つかりませんでした");
    }
  } catch (e) {
    console.error("Persistent delegation message encode error:", e);
    throw e;
  }

  const nodeAddress = appState.sdkSymbol.Address.fromPublicKey
    ? appState.sdkSymbol.Address.fromPublicKey(nodePublicKey, appState.networkType)
    : appState.facade.network.publicKeyToAddress(nodePublicKey);

  const transferDescriptor = new descriptors.TransferTransactionV1Descriptor(
    nodeAddress,
    [],
    encodedMessage
  );

  const confirmInfo = {
    typeLabel: viaMultisig
      ? "委任ハーベスティング設定(委任リクエスト送信・マルチシグ提案)"
      : "委任ハーベスティング設定(委任リクエスト送信)",
    sender: address,
    kind: "harvest",
    recipient: nodeAddress.toString(),
    details: [
      { label: "対象アカウント", value: address },
      { label: "内容", value: "リモート鍵・VRF鍵を暗号化してノード宛に送信します" },
    ],
  };

  // ④もマルチシグアカウントからの送金(TransferTransaction)であるため、
  // 自分自身が送信元でない限り、①②③と同じくボンデッド提案が必要
  if (viaMultisig) {
    const embeddedTx = appState.facade.createEmbeddedTransactionFromTypedDescriptor(
      transferDescriptor,
      signerPublicKey
    );
    const hash = await W.multisig.proposeBondedAggregate([embeddedTx], 0, confirmInfo);
    return { hash, pendingCosign: true };
  }

  const transferTx = appState.facade.createTransactionFromTypedDescriptor(
    transferDescriptor,
    signerPublicKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  const hash = await signAndAnnounce(transferTx, confirmInfo);
  return { hash, pendingCosign: false };
}

/* ============================================================
   ハーベスト履歴
   このアカウントが実際にハーベスト(ブロック生成)した履歴を
   /blocks?signerPublicKey= で取得して一覧表示する
   ・本体アカウントの鍵(self)とリモート鍵(node)の両方を検索し、
     どちらでハーベストされたブロックかをバッジで区別する
============================================================ */
async function loadHarvestHistory(targetAddress) {
  const el = document.getElementById("harvest-history");
  if (!el) return;

  el.textContent = "読み込み中...";

  try {
    if (!appState.NODE) {
      throw new Error("アカウント未接続です");
    }

    const address = targetAddress || getSelectedHarvestTargetAddress();
    // 読み取り専用モードやマルチシグアカウントの閲覧など、appState.currentPubKey が
    // 空(null)のケースでも、チェーン上に公開鍵が登録済みであれば履歴を取得できるようにする。
    // 委任ハーベスティングはリモート鍵で署名されるため、本体の鍵とリモート鍵の
    // 両方を候補にして検索する。
    const signerEntries = await resolveHarvestSignerPublicKeys(address);

    if (signerEntries.length === 0) {
      el.innerHTML = `<div style="color:#94a3b8;">このアカウントはまだ自分自身でトランザクションを送信していないため、公開鍵が未登録です（ハーベスト履歴は照会できません）</div>`;
      return;
    }

    const perKeyResults = await Promise.all(
      signerEntries.map(async ({ key: signerPublicKey, kind }) => {
        const params = new URLSearchParams({
          signerPublicKey,
          order: "desc",
          pageSize: 10,
        });
        const res = await fetch(`${appState.NODE}/blocks?${params}`);
        const json = await res.json();
        return (json.data ?? []).map((item) => ({ ...item, __harvestKind: kind }));
      })
    );

    const items = dedupeAndSortBlocksDesc(perKeyResults.flat()).slice(0, 10);

    if (items.length === 0) {
      el.innerHTML = `<div>ハーベスト履歴はありません</div>`;
      return;
    }

    el.innerHTML = items.map((item) => {
      const block = item.block;
      const height = block.height;

      const feeXym = block.totalFee
        ? (Number(block.totalFee) / 1_000_000).toLocaleString("ja-JP", { maximumFractionDigits: 6 })
        : "0";

      let dateStr = "---";
      if (appState.epochAdjustment && block.timestamp) {
        const unixMs = Number(appState.epochAdjustment) * 1000 + Number(block.timestamp);
        dateStr = new Date(unixMs).toLocaleString("ja-JP", { hour12: false });
      }

      return `
        <div class="harvest-history-item">
          <div>${harvestKindBadgeHtml(item.__harvestKind)}</div>
          <div class="harvest-reward-amount">獲得手数料(概算): ${feeXym} XYM</div>
          <div class="harvest-reward-time">高さ: ${height} ・ ${dateStr}</div>
        </div>
      `;
    }).join("");
  } catch (e) {
    console.error("loadHarvestHistory error:", e);
    el.textContent = "履歴取得エラー";
  }
}

/* ============================================================
   委任ハーベスティング開始（メインエントリポイント）
============================================================ */
/* ============================================================
   対象アカウント情報を解決する(自分自身 か マルチシグか)。
   ・自分自身: appState.currentPubKey をそのまま使い、従来通り
     アグリゲートコンプリートで即時アナウンスする。
   ・マルチシグ(選択された対象が自分自身と異なる、または自分自身の
     アカウントがチェーン上マルチシグ化されている): その口座は
     自分の秘密鍵だけでは直接署名できない(ネットワーク側で拒否される)
     ため、連署者としてアグリゲートボンデッド+ハッシュロックで
     「提案」する必要がある。
============================================================ */
async function resolveHarvestTarget() {
  if (!appState.facade) {
    throw new Error("SDK未初期化です");
  }
  if (appState.isReadOnly) {
    throw new Error("読み取り専用アカウントのため署名できません。SSS Extensionまたはニーモニック/秘密鍵でログインしてください。");
  }
  if (!appState.currentPubKey) {
    throw new Error("アカウント未接続です");
  }

  const address = getSelectedHarvestTargetAddress();
  if (!address) {
    throw new Error("対象アカウントが未指定です");
  }

  const selfAddress = appState.currentAddress.toString();
  const isSelf = address === selfAddress;

  if (isSelf) {
    // 自分自身のアカウント自体がチェーン上マルチシグ化されている場合、
    // 自分の鍵だけでは直接署名できない(このアプリには他の連署者の鍵は
    // ないため、その連署者自身のアカウントでログインして「対象アカウント」に
    // このアドレスを選び直してもらう必要がある)
    const { isMultisig } = await checkIsMultisig(address);
    if (isMultisig) {
      throw new Error(
        "このアカウント自体がマルチシグ化されているため、自分自身の鍵だけでは設定できません。" +
        "このアカウントの連署者のアカウントでログインし直し、「対象アカウント」欄でこのアドレスを選択してから提案してください。"
      );
    }
    return { address, signerPublicKey: appState.currentPubKey.toString(), viaMultisig: false };
  }

  // 自分自身以外(=「連署者になっているマルチシグアカウント」一覧から選んだ対象)
  const signerPublicKey = await resolveAccountPublicKeyHex(address);
  if (!signerPublicKey) {
    throw new Error("対象アカウントの公開鍵がチェーン上でまだ確認できません(一度も自分自身でトランザクションを送信していない可能性があります)");
  }
  return { address, signerPublicKey, viaMultisig: true };
}

async function startHarvest() {
  const statusEl = document.getElementById("harvest-status");
  const setLine = (text) => {
    if (statusEl) statusEl.textContent = text;
    console.log("[harvest]", text);
  };

  try {
    const target = await resolveHarvestTarget();

    const harvestNodeUrl = getSelectedHarvestNodeUrl();
    if (!harvestNodeUrl) {
      throw new Error("委任先ノードが指定されていません");
    }

    setLine(`ノード情報取得中... (${harvestNodeUrl})`);
    const nodePublicKey = await fetchNodePublicKey(harvestNodeUrl);

    setLine("リモート鍵・VRF鍵を生成中...");
    const remoteKeyPair = new appState.sdkSymbol.KeyPair(randomPrivateKey());
    const vrfKeyPair = new appState.sdkSymbol.KeyPair(randomPrivateKey());

    // 画面に残しておく（④が失敗した場合、または④を後から個別に
    // 再送する場合のために、対象アカウント情報とあわせて保持する）
    lastGeneratedKeys = {
      remotePrivateKey: toHex(remoteKeyPair.privateKey),
      vrfPrivateKey: toHex(vrfKeyPair.privateKey),
      target,
      harvestNodeUrl,
    };
    console.warn(
      "生成したリモート鍵・VRF鍵の秘密鍵（この画面を閉じると失われます。再送が必要な場合のため控えてください）:",
      lastGeneratedKeys
    );

    setLine(
      target.viaMultisig
        ? "① AccountKeyLink / ② VrfKeyLink / ③ NodeKeyLink をマルチシグ提案として署名しています..."
        : appState.authMode === "local"
        ? "① AccountKeyLink / ② VrfKeyLink / ③ NodeKeyLink を署名しています..."
        : "① AccountKeyLink / ② VrfKeyLink / ③ NodeKeyLink をSSSで署名してください..."
    );
    const { hash: aggHash, pendingCosign } = await announceKeyLinks(
      remoteKeyPair,
      vrfKeyPair,
      nodePublicKey,
      harvestNodeUrl,
      target
    );
    trackOutgoingTransaction({
      hash: aggHash,
      label: target.viaMultisig ? "ハーベスト設定の追跡（鍵リンク・マルチシグ提案）" : "ハーベスト設定の追跡（鍵リンク）",
      containerId: "harvest-tracking",
    });

    if (pendingCosign) {
      // マルチシグ提案の場合、他の連署者の承認(コサイン)が集まるまで
      // 鍵リンクは確定しない。このアプリのセッション内で自動的に
      // 待ち続けることはせず、「マルチシグ署名」画面で連署が済んだのを
      // 確認したのち、改めてこの画面の「④ 委任リクエストを送信」から
      // 続きを行ってもらう。
      setLine("鍵リンクのマルチシグ提案を送信しました。");
      alert(
        "① AccountKeyLink / ② VrfKeyLink / ③ NodeKeyLink をマルチシグ提案として送信しました。\n\n" +
        "この提案は、対象アカウントの連署者が「マルチシグ署名」画面で必要数の承認(連署)を行うまで確定しません。\n" +
        "承認が完了して鍵リンクが反映されたら(このハーベスト画面のバッジが「設定済み」になったら)、\n" +
        "改めて「④ 委任リクエストを送信」ボタンから委任リクエストを送信してください。"
      );
      return;
    }

    setLine("鍵リンクTxを送信しました。承認を待っています...");
    await waitConfirmed(aggHash);
    setLine("鍵リンク承認完了。④ 委任リクエストを送信します...");

    const { hash: delegationHash } = await announcePersistentDelegationRequest(
      remoteKeyPair,
      vrfKeyPair,
      nodePublicKey,
      target
    );

    setLine("✅ 委任リクエスト送信完了。ノード側の反映をお待ちください。");
    trackOutgoingTransaction({
      hash: delegationHash,
      label: "ハーベスト設定の追跡（委任リクエスト）",
      containerId: "harvest-tracking",
    });
    alert(
      "委任ハーベスティングの設定リクエストを送信しました。\n" +
      "ノードが承諾すると数分〜数十分程度でハーベストが始まる場合があります。\n" +
      "（ノード側の判断次第のため、必ず開始される保証はありません）"
    );
  } catch (e) {
    if (e?.cancelled) {
      setLine("キャンセルしました");
      return;
    }
    if (e?.offlineExported) {
      setLine("📥 " + e.message);
      alert(
        "オフライントランザクションとして書き出しました。\n" +
        "① 鍵リンクトランザクションはまだノードへ送信されていません。\n" +
        "後で「高度機能 > オフライン署名データを読み込む」からアップロードしてアナウンスしたのち、" +
        "改めてこの画面から委任リクエスト送信(④)を行ってください。"
      );
      return;
    }
    console.error("startHarvest error:", e);
    setLine("❌ ハーベスト設定失敗: " + e.message);
    alert("ハーベスト設定失敗: " + e.message);
  }
}

/* ============================================================
   ④ 委任リクエストのみを個別に(再)送信する。
   マルチシグ提案(①②③)が連署されて確定した後の続きや、
   ④だけが何らかの理由で失敗・未送信だった場合の再送に使う。
   直前の startHarvest() 実行時にセッション内へ保持した
   リモート鍵・VRF鍵(lastGeneratedKeys)が必要(ページ再読み込みで失われる)。
============================================================ */
async function sendDelegationRequestOnly() {
  const statusEl = document.getElementById("harvest-status");
  const setLine = (text) => {
    if (statusEl) statusEl.textContent = text;
    console.log("[harvest]", text);
  };

  try {
    if (!lastGeneratedKeys) {
      throw new Error(
        "送信できるリモート鍵・VRF鍵がセッション内にありません（ページを再読み込みすると失われます）。" +
        "「開始」から改めて鍵リンクの設定をやり直してください。"
      );
    }

    const target = await resolveHarvestTarget();
    if (target.address !== lastGeneratedKeys.target?.address) {
      throw new Error("対象アカウントが①②③実行時と異なります。「対象アカウント」欄を元に戻してください。");
    }

    const nodePublicKey = await fetchNodePublicKey(lastGeneratedKeys.harvestNodeUrl);
    const remoteKeyPair = new appState.sdkSymbol.KeyPair(
      new appState.sdkCore.PrivateKey(hexToBytes(lastGeneratedKeys.remotePrivateKey))
    );
    const vrfKeyPair = new appState.sdkSymbol.KeyPair(
      new appState.sdkCore.PrivateKey(hexToBytes(lastGeneratedKeys.vrfPrivateKey))
    );

    setLine("④ 委任リクエストを送信します...");
    const { hash, pendingCosign } = await announcePersistentDelegationRequest(
      remoteKeyPair,
      vrfKeyPair,
      nodePublicKey,
      target
    );

    trackOutgoingTransaction({
      hash,
      label: pendingCosign ? "ハーベスト設定の追跡（委任リクエスト・マルチシグ提案）" : "ハーベスト設定の追跡（委任リクエスト）",
      containerId: "harvest-tracking",
    });

    if (pendingCosign) {
      setLine("委任リクエストのマルチシグ提案を送信しました。連署者の承認をお待ちください。");
      alert("委任リクエストをマルチシグ提案として送信しました。「マルチシグ署名」画面で連署者の承認が完了すると設定が反映されます。");
      return;
    }

    setLine("✅ 委任リクエスト送信完了。ノード側の反映をお待ちください。");
    alert("委任リクエストを送信しました。ノードが承諾すると数分〜数十分程度でハーベストが始まる場合があります。");
  } catch (e) {
    if (e?.cancelled) {
      setLine("キャンセルしました");
      return;
    }
    if (e?.offlineExported) {
      setLine("📥 " + e.message);
      return;
    }
    console.error("sendDelegationRequestOnly error:", e);
    setLine("❌ 委任リクエスト送信失敗: " + e.message);
    alert("委任リクエスト送信失敗: " + e.message);
  }
}

/* ============================================================
   委任解除（Unlink）
   ※ セッション内の一時キーには依存せず、REST APIで
     「現在チェーン上にリンクされている公開鍵」を取得して
     それをUNLINKする。これによりページ再読み込み後でも解除可能。
============================================================ */
async function stopHarvest() {
  const statusEl = document.getElementById("harvest-status");
  const setLine = (text) => {
    if (statusEl) statusEl.textContent = text;
    console.log("[harvest]", text);
  };

  try {
    const target = await resolveHarvestTarget();

    setLine("現在の委任状況を確認中...");
    const res = await fetch(`${appState.NODE}/accounts/${target.address}`);
    const json = await res.json();
    const keys = json.account?.supplementalPublicKeys;

    const linkedHex = keys?.linked?.publicKey;
    const vrfHex = keys?.vrf?.publicKey;
    const nodeHex = keys?.node?.publicKey;

    if (!linkedHex && !vrfHex && !nodeHex) {
      setLine("解除対象がありません（未設定）");
      alert("現在、委任ハーベスティングの鍵リンクは設定されていません。");
      return;
    }

    const summary = [
      linkedHex ? `remote: ${linkedHex}` : null,
      vrfHex ? `vrf: ${vrfHex}` : null,
      nodeHex ? `node: ${nodeHex}` : null,
    ].filter(Boolean).join("\n");

    const { descriptors, models } = appState.sdkSymbol;
    const embedded = [];

    if (linkedHex) {
      embedded.push(
        appState.facade.createEmbeddedTransactionFromTypedDescriptor(
          new descriptors.AccountKeyLinkTransactionV1Descriptor(
            new appState.sdkCore.PublicKey(linkedHex),
            models.LinkAction.UNLINK
          ),
          target.signerPublicKey
        )
      );
    }
    if (vrfHex) {
      embedded.push(
        appState.facade.createEmbeddedTransactionFromTypedDescriptor(
          new descriptors.VrfKeyLinkTransactionV1Descriptor(
            new appState.sdkCore.PublicKey(vrfHex),
            models.LinkAction.UNLINK
          ),
          target.signerPublicKey
        )
      );
    }
    if (nodeHex) {
      embedded.push(
        appState.facade.createEmbeddedTransactionFromTypedDescriptor(
          new descriptors.NodeKeyLinkTransactionV1Descriptor(
            new appState.sdkCore.PublicKey(nodeHex),
            models.LinkAction.UNLINK
          ),
          target.signerPublicKey
        )
      );
    }

    const confirmInfo = {
      typeLabel: target.viaMultisig ? "委任ハーベスティング解除(マルチシグ提案)" : "委任ハーベスティング解除",
      sender: target.address,
      kind: "harvest",
      details: [
        { label: "対象アカウント", value: target.address },
        { label: "解除対象", value: summary || "(なし)" },
      ],
    };

    let hash;
    let pendingCosign = false;

    if (target.viaMultisig) {
      setLine("解除トランザクションをマルチシグ提案として署名しています...");
      hash = await W.multisig.proposeBondedAggregate(embedded, 0, confirmInfo);
      pendingCosign = true;
    } else {
      const aggregateDescriptor = new descriptors.AggregateCompleteTransactionV3Descriptor(
        appState.facade.static.hashEmbeddedTransactions(embedded),
        embedded
      );

      const aggregateTx = appState.facade.createTransactionFromTypedDescriptor(
        aggregateDescriptor,
        target.signerPublicKey,
        appState.feeMultiplier ?? 100,
        60 * 60
      );

      setLine(
        appState.authMode === "local"
          ? "解除トランザクションを署名しています..."
          : "解除トランザクションをSSSで署名してください..."
      );
      hash = await signAndAnnounce(aggregateTx, confirmInfo);
    }

    trackOutgoingTransaction({
      hash,
      label: pendingCosign ? "ハーベスト解除の追跡（マルチシグ提案）" : "ハーベスト解除の追跡",
      containerId: "harvest-tracking",
    });

    if (pendingCosign) {
      setLine("解除トランザクションのマルチシグ提案を送信しました。連署者の承認をお待ちください。");
      alert("委任ハーベスティング解除をマルチシグ提案として送信しました。「マルチシグ署名」画面で連署者の承認が完了すると解除されます。");
      return;
    }

    setLine("解除トランザクションを送信しました。承認を待っています...");
    await waitConfirmed(hash);

    lastGeneratedKeys = null;
    setLine("✅ 委任ハーベスティングを解除しました");
    await checkHarvestStatus();
    alert("委任ハーベスティングの解除が完了しました。");
  } catch (e) {
    if (e?.cancelled) {
      setLine("キャンセルしました");
      return;
    }
    if (e?.offlineExported) {
      setLine("📥 " + e.message);
      return;
    }
    console.error("stopHarvest error:", e);
    setLine("❌ 解除失敗: " + e.message);
    alert("解除失敗: " + e.message);
  }
}

/*
  自分宛の確定トランザクションを検知するたびに、ハーベスト状態バッジを
  再取得して反映する。開始/停止ボタンを押した直後だけでなく、
  鍵リンクや委任リクエストが実際にブロックに取り込まれたタイミングで
  自動的に最新状態に切り替わるようにするため。
  ノード切替・アカウント切替のたびに呼ばれても二重登録しないよう、
  アドレスごとに一度だけ登録する。
*/
const liveHarvestStatusRegisteredAddresses = new Set();

function initLiveHarvestStatusRefresh(address) {
  if (!address || liveHarvestStatusRegisteredAddresses.has(address)) return;
  liveHarvestStatusRegisteredAddresses.add(address);

  addCallback(`confirmedAdded/${address}`, () => {
    checkHarvestStatus();
  });
}

/* ============================================================
   ハーベスト報酬(自分が実際にハーベストしたブロックと、その報酬)
   ・ブロック一覧: GET /blocks?signerPublicKey={自分}
   ・報酬額: 各ブロックの高さについて GET /statements/transaction?height={高さ}
     で取得できるレシート(statement.receipts)のうち、自分のアドレス宛の
       - Harvest_Fee (type=8515)  … トランザクション手数料報酬
       - Inflation   (type=20803) … インフレ報酬
     をそれぞれ別に合算し、その合計を「報酬合計」として一番上に表示する。
     (ブロック報酬 = トランザクション手数料 + インフレ による新規発行分。
      以前はHarvest_Feeのみを合算しておりインフレ報酬が反映されていなかった)
     ※ 以前は存在しない /blocks/{height}/statements を参照しており、
       常に取得に失敗して "---" 表示になっていたバグを修正。
   ・本体アカウントの鍵(self)とリモート鍵(node)のどちらでハーベストされた
     ブロックかは内部的に区別しているが、表示上はどちらも同じ「ハーベスト」
     バッジで表示する。
   ・報酬額(合計・インフレ報酬・トランザクション手数料報酬の3つとも)は
     円・ドル換算をあわせて表示する。
   ※ レシート取得はブロックごとに個別リクエストが必要なため、
     直近pageSize件のみを対象にする
============================================================ */
const HARVEST_FEE_RECEIPT_TYPE = 8515;  // Harvest_Fee（トランザクション手数料報酬）
const INFLATION_RECEIPT_TYPE = 20803;   // Inflation（インフレ報酬）

function normalizeReceiptAddress(addr) {
  if (!addr || typeof addr !== "string") return null;
  if (addr.length === 39) return addr.toUpperCase();
  if (addr.length === 48 && /^[0-9A-Fa-f]+$/.test(addr) && appState.sdkSymbol) {
    try {
      return new appState.sdkSymbol.Address(hexToBytes(addr)).toString();
    } catch {
      return null;
    }
  }
  return null;
}

async function loadHarvestRewards(elId = "harvest-reward-list", { pageSize = 20, address } = {}) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = "読み込み中...";

  try {
    if (!appState.NODE) throw new Error("未ログインです");

    // address省略時は、ウォレット画面共通の対象アカウント選択(自分自身 or
    // 連署者になっているマルチシグアカウント。account.js側で一元管理)に従う。
    // これにより、閲覧モード・ウォレットモードのどちらでも、また自分自身の
    // アカウントでもマルチシグアカウントでも、同じ画面から報酬を確認できる。
    const myAddress = address || W.account.getSelectedWalletTargetAddress();
    if (!myAddress) throw new Error("対象アカウントが未指定です");

    // 読み取り専用モード(マルチシグアカウントのアドレスを直接閲覧している場合など)や、
    // マルチシグアカウントを対象アカウントとして選択した場合は appState.currentPubKey が
    // 対象アカウントの鍵と一致しないため、チェーン上の公開鍵を代わりに解決する。
    // 委任ハーベスティングはリモート鍵で署名されるため、本体の鍵とリモート鍵の
    // 両方を候補にして検索する(本体の鍵だけでは常に0件になってしまうバグがあった)。
    const signerEntries = await resolveHarvestSignerPublicKeys(myAddress);
    if (signerEntries.length === 0) {
      el.innerHTML = `<div style="color:#94a3b8;">このアカウントはまだ自分自身でトランザクションを送信していないため、公開鍵が未登録です（ハーベスト報酬は照会できません）</div>`;
      return;
    }

    const perKeyResults = await Promise.all(
      signerEntries.map(async ({ key: signerPublicKey, kind }) => {
        const params = new URLSearchParams({
          signerPublicKey,
          order: "desc",
          pageSize,
        });
        const res = await fetch(`${appState.NODE}/blocks?${params}`);
        const json = await res.json();
        return (json.data ?? []).map((item) => ({ ...item, __harvestKind: kind }));
      })
    );

    const blocks = dedupeAndSortBlocksDesc(perKeyResults.flat()).slice(0, pageSize);

    if (blocks.length === 0) {
      el.innerHTML = `<div style="color:#94a3b8;">ハーベストしたブロックはまだありません</div>`;
      return;
    }

    // 円・ドル換算レートは(行ごとではなく)1回だけまとめて取得する
    const [jpyRate, usdResult] = await Promise.all([getXymJpyRate(), getXymUsdRate()]);
    const usdRate = usdResult?.rate ?? null;

    const rows = await Promise.all(
      blocks.map(async (item) => {
        const b = item.block;
        const height = b.height;
        let totalText = "---";
        let inflationText = "---";
        let feeText = "---";

        try {
          const params = new URLSearchParams({ height: String(height), pageSize: 50 });
          const stRes = await fetch(`${appState.NODE}/statements/transaction?${params}`);
          const stJson = await stRes.json();
          const statementItems = stJson.data ?? [];
          const receipts = statementItems.flatMap((entry) => entry.statement?.receipts ?? []);

          const sumByType = (type) =>
            receipts
              .filter((r) => Number(r.type) === type)
              .filter((r) => normalizeReceiptAddress(r.targetAddress) === myAddress)
              .reduce((sum, r) => sum + BigInt(r.amount ?? 0), 0n);

          const feeAtomic = sumByType(HARVEST_FEE_RECEIPT_TYPE);
          const inflationAtomic = sumByType(INFLATION_RECEIPT_TYPE);
          const totalAtomic = feeAtomic + inflationAtomic;

          const toText = (atomic) =>
            formatMosaicAmount(atomic, 6) + " XYM" + formatFiatSuffix(Number(atomic) / 1_000_000, jpyRate, usdRate);

          totalText = toText(totalAtomic);
          inflationText = toText(inflationAtomic);
          feeText = toText(feeAtomic);
        } catch (e) {
          console.warn("ハーベスト報酬レシート取得失敗:", height, e);
        }

        const timeMs = b.timestamp && appState.epochAdjustment
          ? Number(appState.epochAdjustment) * 1000 + Number(b.timestamp)
          : null;

        return { height, totalText, inflationText, feeText, timeMs, kind: item.__harvestKind };
      })
    );

    el.innerHTML = rows
      .map(
        (r) => `
      <div class="harvest-history-item">
        <div>${harvestKindBadgeHtml(r.kind)}</div>
        <div class="harvest-reward-amount">報酬合計: ${r.totalText}</div>
        <div class="harvest-reward-breakdown">
          <div>インフレ報酬: ${r.inflationText}</div>
          <div>トランザクション手数料報酬: ${r.feeText}</div>
        </div>
        <div class="harvest-reward-time">高さ: ${r.height}${r.timeMs ? ` ・ ${new Date(r.timeMs).toLocaleString("ja-JP", { hour12: false })}` : ""}</div>
      </div>
    `
      )
      .join("");
  } catch (e) {
    console.error("loadHarvestRewards error:", e);
    el.textContent = "取得に失敗しました";
  }
}

window.W.harvest = {
  loadHarvestNodeCandidates,
  loadHarvestTargetOptions,
  checkHarvestStatus,
  loadHarvestHistory,
  startHarvest,
  stopHarvest,
  sendDelegationRequestOnly,
  initLiveHarvestStatusRefresh,
  loadHarvestRewards
};

})();
