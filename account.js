// account.js
// Account情報取得・Mosaic残高取得

const {appState} = W.config;
const {setText, setStatus} = W.ui;
const {formatMosaicAmount} = W.utils;
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

window.W.account = {
  refreshAccount,
  initLiveBalanceRefresh,
  getRecipientPublicKey
};
