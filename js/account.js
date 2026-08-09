(function () {
"use strict";

// account.js
// Account情報取得・Mosaic残高取得

const {appState} = W.config;
const {setText, setStatus} = W.ui;
const {formatMosaicAmount, hexToBytes} = W.utils;
const {addCallback} = W.ws;
const {getXymJpyRate, getXymUsdRate} = W.priceRates;

function toHexMosaicId(id) {
  if (typeof id === "string") {
    return id.toUpperCase();
  }
  return BigInt(id)
    .toString(16)
    .toUpperCase()
    .padStart(16, "0");
}

// 換算表示の非同期更新が古い結果で上書きしないようにするための管理
let balanceFiatRequestId = 0;

async function updateBalanceFiatDisplay(xymAmount, baseText) {
  const requestId = ++balanceFiatRequestId;

  const [jpyRate, usdResult] = await Promise.all([getXymJpyRate(), getXymUsdRate()]);
  if (requestId !== balanceFiatRequestId) return; // その間に新しい残高取得が走っていれば古い結果は捨てる

  const el = document.getElementById("account-balance");
  if (!el) return;

  const usdRate = usdResult.rate;
  const parts = [];
  if (jpyRate != null) {
    const jpy = Math.round(xymAmount * jpyRate);
    parts.push(`${jpy.toLocaleString("ja-JP")}円`);
  }
  if (usdRate != null) {
    const usd = xymAmount * usdRate;
    parts.push(`${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}ドル`);
  }

  if (parts.length > 0) {
    el.textContent = `${baseText} (${parts.join(" / ")})`;
  }
}

async function refreshAccount() {
  if (!appState.NODE || !appState.currentAddress) {
    return;
  }

  setStatus("account-status", "Account情報取得中…");

  try {
    const address = appState.currentAddress.toString();
    document.getElementById("account-address").textContent = address;

    /*
      Account情報取得
      quick_learning_symbol_v3形式
      accountInfo = json.account
    */
    const accountInfo = await fetch(
      new URL("/accounts/" + address, appState.NODE),
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json"
        }
      }
    )
    .then((res) => {
      if (res.status === 404) {
        return null;
      }
      return res.json();
    })
    .then((json) => {
      return json ? json.account : null;
    });

    /*
      未登録Account
    */
    if (!accountInfo) {
      console.log("未登録Account");
      appState.mosaicInfo = {};
      document.getElementById("account-balance").textContent = "0.000 XYM";

      const mosaicList = document.getElementById("mosaic-list");
      if (mosaicList) {
        mosaicList.innerHTML = "<div>保有Mosaicはありません</div>";
      }

      setStatus("account-status", "新規Accountです", "success");
      return;
    }

    /*
      所有Mosaic一覧
      quick_learning_symbol_v3: accountInfo.mosaics
    */
    const mosaics = accountInfo.mosaics || [];

    /*
      Namespace取得
      MosaicId → Namespace名
    */
    const namespaceMap = {};
    const mosaicIds = mosaics.map((mosaic) => {
      return toHexMosaicId(mosaic.id);
    });

    try {
      const namespaceInfo = await fetch(
        new URL("/namespaces/mosaic/names", appState.NODE),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ mosaicIds })
        }
      ).then((res) => res.json());

      for (const item of namespaceInfo.mosaicNames || []) {
        const mosaicId = item.mosaicId.toUpperCase();
        if (item.names && item.names.length > 0) {
          const first = item.names[0];
          // names[] の各要素は文字列の場合とオブジェクト({name, parentId, ...})の場合がある
          const resolvedName = typeof first === "string" ? first : first?.name;
          if (resolvedName) {
            namespaceMap[mosaicId] = resolvedName;
          }
        }
      }
    } catch(e) {
      console.warn("Namespace取得失敗", e);
    }

    /*
      Mosaic情報初期化
    */
    appState.mosaicInfo = {};

    const mosaicList = document.getElementById("mosaic-list");
    if (mosaicList) {
      mosaicList.innerHTML = "";
    }

    const select = document.getElementById("tx-mosaic");
    if (select) {
      select.innerHTML = "";
    }

    /*
      Mosaic情報取得
    */
    const mosaicInfoList = await Promise.all(
      mosaics.map(async (mosaic) => {
        const mosaicId = toHexMosaicId(mosaic.id);

        /*
          所有量
          quick_learning_symbol_v3: accountInfo.mosaics[0].amount
        */
        const mosaicAmount = mosaic.amount;
        let mosaicName = namespaceMap[mosaicId] ?? mosaicId;
        let divisibility = 0;

        /*
          XYM
          Native Mosaic
        */
        if (mosaicId === "72C0212E67A08BCE" || mosaicId === "6BED913FA20223F8") {
          mosaicName = "XYM";
          divisibility = 6;
        } else {
          try {
            /*
              MosaicInfo取得
              quick_learning_symbol_v3:
              mosaicInfo = await fetch(/mosaics/{id})
            */
            const mosaicInfo = await fetch(
              new URL("/mosaics/" + mosaicId, appState.NODE),
              {
                method: "GET",
                headers: {
                  "Content-Type": "application/json"
                }
              }
            )
            .then((res) => res.json())
            .then((json) => json.mosaic);

            /*
              可分性
              v3: mosaicInfo.divisibility
            */
            divisibility = mosaicInfo.divisibility;
          } catch(e) {
            console.warn("MosaicInfo取得失敗", mosaicId, e);
          }
        }

        return {
          mosaicId,
          mosaicAmount,
          divisibility,
          mosaicName
        };
      })
    );

    /*
      Account Mosaic表示
    */
    for (const mosaic of mosaicInfoList) {
      const { mosaicId, mosaicAmount, divisibility, mosaicName } = mosaic;

      /*
        内部保存
        amountはREST API v3形式を維持
      */
      appState.mosaicInfo[mosaicId] = {
        mosaicName,
        amount: mosaicAmount,
        divisibility
      };

      /*
        Transfer用Mosaic選択
      */
      if (select) {
        const option = document.createElement("option");
        option.value = mosaicId;
        option.textContent = `${mosaicName} (${formatMosaicAmount(mosaicAmount, divisibility)})`;
        select.appendChild(option);
      }

      /*
        Account Mosaic一覧表示
      */
      if (mosaicList) {
        const item = document.createElement("div");
        item.className = "mosaic-item";

        const displayName = (mosaicId === "72C0212E67A08BCE" || mosaicId === "6BED913FA20223F8")
          ? "XYM"
          : (namespaceMap[mosaicId] ?? mosaicName);

        item.innerHTML = `
          <div class="mosaic-left">
            <div class="mosaic-name">${displayName}</div>
            <div class="mosaic-id">${mosaicId}</div>
          </div>
          <div class="mosaic-right">
            <div class="mosaic-amount">${formatMosaicAmount(mosaicAmount, divisibility)}</div>
          </div>
        `;

        item.onclick = () => {
          console.log("Mosaic選択:", mosaicId);

          if (select) {
            select.value = mosaicId;
          }

          const idElement = document.getElementById("selected-mosaic-id");
          if (idElement) {
            "value" in idElement ? idElement.value = mosaicId : idElement.textContent = mosaicId;
          }

          const nameElement = document.getElementById("selected-mosaic-name");
          if (nameElement) {
            nameElement.textContent = displayName;
          }

          const balanceElement = document.getElementById("selected-mosaic-balance");
          if (balanceElement) {
            balanceElement.textContent = formatMosaicAmount(mosaicAmount, divisibility);
          }

          const dialog = document.getElementById("transfer-dialog");
          if (dialog && typeof dialog.showModal === "function") {
            dialog.showModal();
          }
        };

        mosaicList.appendChild(item);
      }
    }

    /*
      XYM残高表示
      Native Mosaic
    */
    const xymId = appState.networkType === 152 ? "72C0212E67A08BCE" : "6BED913FA20223F8";
    const xym = appState.mosaicInfo[xymId];

    const xymBalanceText = xym
      ? `${formatMosaicAmount(xym.amount, xym.divisibility)} XYM`
      : "0.000 XYM";
    document.getElementById("account-balance").textContent = xymBalanceText;

    // 円・ドル換算(bitbank / Gate.io)。取得に時間がかかる・失敗することが
    // あるため、まずXYM残高だけ即表示し、換算額は取れ次第あとから追記する。
    const xymAmountNumber = xym ? Number(xym.amount) / (10 ** xym.divisibility) : 0;
    updateBalanceFiatDisplay(xymAmountNumber, xymBalanceText);

    // 送金画面で選択中のモザイクがあれば、保有数量の表示もここで同期する
    // (着金などでmosaicInfoが更新された時、選択中の残高表示が古いまま
    //  取り残されないようにするため)
    const selectedIdEl = document.getElementById("selected-mosaic-id");
    const selectedBalanceEl = document.getElementById("selected-mosaic-balance");
    if (selectedIdEl && selectedBalanceEl && selectedIdEl.value) {
      const info = appState.mosaicInfo[selectedIdEl.value.toUpperCase()];
      selectedBalanceEl.textContent = info
        ? formatMosaicAmount(info.amount, info.divisibility)
        : "0";
    }

    setStatus("account-status", "取得成功", "success");
  } catch(e) {
    console.error(e);
    setStatus("account-status", "取得に失敗しました", "error");
  }
}

/*
  着金(自分宛の確定トランザクション)を検知したら、
  保有残高・保有モザイク一覧をすぐに再取得して画面に反映する。
  ノード切替・アカウント切替のたびに呼ばれても二重登録しないよう、
  アドレスごとに一度だけ登録する。
*/
const liveBalanceRegisteredAddresses = new Set();

function initLiveBalanceRefresh(address) {
  if (!address || liveBalanceRegisteredAddresses.has(address)) return;
  liveBalanceRegisteredAddresses.add(address);

  addCallback(`confirmedAdded/${address}`, () => {
    refreshAccount();
  });
}

/*
  受信者Account PublicKey取得
  quick_learning_symbol_v3: accountInfo.publicKey
*/
async function getRecipientPublicKey(address) {
  const accountInfo = await fetch(
    new URL("/accounts/" + address.toString(), appState.NODE),
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      }
    }
  )
  .then((res) => res.json())
  .then((json) => json.account);

  const publicKey = accountInfo.publicKey;

  if (!publicKey || publicKey === "0000000000000000000000000000000000000000000000000000000000000000") {
    throw new Error("受信者のPublicKeyが存在しません");
  }

  return publicKey;
}

/* ============================================================
   「対象アカウント」共有選択（ウォレット画面の 保有モザイク / アクティビティ /
   ハーベスト報酬 の3タブすべてで共通利用）
   ・自分自身 と、自分が連署者になっているマルチシグアカウントを候補にする
   ・読み取り専用モードでは「連署者として提案する」操作ができないため、
     閲覧中のアドレス自身のみを対象にする
============================================================ */

// REST APIから返るアドレス表現は 16進(48文字) と base32(39文字) が
// 混在するため、常に base32(39文字・大文字)に統一する
// (recipientInfo.js の normalizeMaybeHexAddress と同じ考え方)
function normalizeToBase32Address(raw) {
  if (!raw || typeof raw !== "string") return raw;
  const trimmed = raw.trim().toUpperCase();
  if (trimmed.length === 39) return trimmed;
  if (trimmed.length === 48 && /^[0-9A-F]+$/.test(trimmed) && appState.sdkSymbol) {
    try {
      return new appState.sdkSymbol.Address(hexToBytes(trimmed)).toString();
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

async function loadWalletTargetOptions() {
  const select = document.getElementById("wallet-target-select");
  if (!select) return;

  const selfAddress = appState.currentAddress?.toString();
  const previousValue = select.value;
  select.innerHTML = `<option value="">-- 自分自身（${selfAddress ?? "---"}）--</option>`;

  if (!appState.isReadOnly && W.multisig) {
    try {
      const addresses = await W.multisig.fetchCosignatoryOfAddresses();
      for (const raw of addresses) {
        const a = normalizeToBase32Address(raw);
        const option = document.createElement("option");
        option.value = a;
        option.textContent = `${a}（連署者になっているマルチシグ）`;
        select.appendChild(option);
      }
    } catch (e) {
      console.warn("マルチシグ候補の取得に失敗しました（対象アカウント選択）", e);
    }
  }

  // 選び直しの手間を減らすため、選択肢が残っていれば選択状態を保つ
  if (previousValue && Array.from(select.options).some((o) => o.value === previousValue)) {
    select.value = previousValue;
  }
}

function getSelectedWalletTargetAddress() {
  const selected = document.getElementById("wallet-target-select")?.value?.trim();
  return normalizeToBase32Address(selected) || appState.currentAddress?.toString();
}

function isWalletTargetSelf(address) {
  const selfAddress = appState.currentAddress?.toString();
  return !address || !selfAddress || address === selfAddress;
}

/* ============================================================
   任意アドレス(主にマルチシグアカウント)の保有モザイク一覧を、
   閲覧専用として #mosaic-list 相当の要素へ描画する。
   refreshAccount() と違い、以下は一切行わない:
     ・appState.mosaicInfo の書き換え(ログイン中アカウントの送金用情報を破壊しないため)
     ・送金用モザイク選択(#tx-mosaic)の更新
     ・XYM残高ヘッダー(#account-balance)の更新
     ・クリックで送金ダイアログを開く動作(マルチシグからの送金は
       別途「連署者として提案」の手続きが必要なため、単純な送金
       ダイアログに繋げると誤操作のもとになる)
============================================================ */
async function loadMosaicListForAddress(address, elId = "mosaic-list") {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!appState.NODE || !address) return;

  el.innerHTML = "読み込み中...";

  try {
    const accountInfo = await fetch(new URL("/accounts/" + address, appState.NODE))
      .then((res) => (res.status === 404 ? null : res.json()))
      .then((json) => (json ? json.account : null));

    const mosaics = accountInfo?.mosaics || [];

    if (mosaics.length === 0) {
      el.innerHTML = `<div>保有Mosaicはありません</div>`;
      return;
    }

    const mosaicIds = mosaics.map((m) => toHexMosaicId(m.id));
    const namespaceMap = {};

    try {
      const namespaceInfo = await fetch(new URL("/namespaces/mosaic/names", appState.NODE), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mosaicIds }),
      }).then((res) => res.json());

      for (const item of namespaceInfo.mosaicNames || []) {
        const mosaicId = item.mosaicId.toUpperCase();
        const first = item.names?.[0];
        const resolvedName = typeof first === "string" ? first : first?.name;
        if (resolvedName) namespaceMap[mosaicId] = resolvedName;
      }
    } catch (e) {
      console.warn("Namespace取得失敗(対象アカウント閲覧):", e);
    }

    const xymId = appState.networkType === 152 ? "72C0212E67A08BCE" : "6BED913FA20223F8";

    const rows = await Promise.all(
      mosaics.map(async (mosaic) => {
        const mosaicId = toHexMosaicId(mosaic.id);
        let mosaicName = namespaceMap[mosaicId] ?? mosaicId;
        let divisibility = 0;

        if (mosaicId === xymId) {
          mosaicName = "XYM";
          divisibility = 6;
        } else {
          try {
            const mosaicInfo = await fetch(new URL("/mosaics/" + mosaicId, appState.NODE))
              .then((res) => res.json())
              .then((json) => json.mosaic);
            divisibility = mosaicInfo.divisibility;
          } catch (e) {
            console.warn("MosaicInfo取得失敗(対象アカウント閲覧)", mosaicId, e);
          }
        }

        return { mosaicId, amount: mosaic.amount, divisibility, mosaicName };
      })
    );

    el.innerHTML = rows
      .map(
        ({ mosaicId, amount, divisibility, mosaicName }) => `
        <div class="mosaic-item">
          <div class="mosaic-left">
            <div class="mosaic-name">${mosaicName}</div>
            <div class="mosaic-id">${mosaicId}</div>
          </div>
          <div class="mosaic-right">
            <div class="mosaic-amount">${formatMosaicAmount(amount, divisibility)}</div>
          </div>
        </div>
      `
      )
      .join("");
  } catch (e) {
    console.error("loadMosaicListForAddress error:", e);
    el.innerHTML = "取得に失敗しました";
  }
}

window.W.account = {
  refreshAccount,
  initLiveBalanceRefresh,
  getRecipientPublicKey,
  loadWalletTargetOptions,
  getSelectedWalletTargetAddress,
  isWalletTargetSelf,
  loadMosaicListForAddress
};

})();
