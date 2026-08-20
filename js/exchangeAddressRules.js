(function () {
"use strict";

// exchangeAddressRules.js
// 取引所(bitbank・Zaif)の入金アドレス宛て送金に関する共通ルール。
//
// bitbank・ZaifへXYMを送る場合、宛先ウォレット側でどのユーザーの入金かを
// 識別するために「入金メッセージ(タグ)」をメッセージ欄に入れる必要があり、
// これが無いと反映されない(最悪の場合、資産を引き出せなくなる)。
// また、これらの入金アドレスはXYM専用のため、XYM以外のモザイクを送っても
// 反映されない。
//
// そのため、送金・マルチシグ送金・複数送信など、XYMの送金を伴う画面では
// このモジュールを使って共通のチェックを行う。

const {getXymMosaicIdHex} = W.config;

// 取引所名の入金アドレス一覧(正規化済み・大文字/ハイフンなし)
const EXCHANGE_DEPOSIT_ADDRESSES = {
  "NDURU3U7Y7KKTPC2VVVF6U3VJIU5HDWSHQZCS4Q": "bitbank",
  "NBVU44NKAED5MLPEY4Y7Z5OMUAUXLYI7HOIKNSY": "Zaif",
};

function normalizeAddress(raw) {
  return (raw || "").toString().trim().toUpperCase().replace(/[\s-]/g, "");
}

/* ============================================================
   宛先アドレスが取引所の入金アドレスであれば、その取引所名を返す
   (対象外であればnull)
============================================================ */
function getExchangeNameForAddress(rawAddress) {
  return EXCHANGE_DEPOSIT_ADDRESSES[normalizeAddress(rawAddress)] ?? null;
}

/* ============================================================
   宛先アドレス・モザイクID(16進、空/未指定はXYM扱い)・メッセージ本文から、
   送金可能かどうかを判定する。
   問題なければnullを、問題があればユーザー向けエラーメッセージを返す。
============================================================ */
function validateExchangeRecipient(rawAddress, mosaicIdHex, messageText) {
  const exchangeName = getExchangeNameForAddress(rawAddress);
  if (!exchangeName) return null; // 取引所アドレス以外は対象外

  const trimmedMosaicIdHex = (mosaicIdHex || "").trim().toUpperCase();
  const xymId = getXymMosaicIdHex().toUpperCase();

  if (trimmedMosaicIdHex && trimmedMosaicIdHex !== xymId) {
    return `${exchangeName}の入金アドレスへは、XYM以外のモザイクを送ることはできません。`;
  }

  if (!messageText || !messageText.trim()) {
    return `${exchangeName}の入金アドレスへ送る場合は、メッセージ欄に入金メッセージ(タグ)を入力してください（入力がないと反映されないおそれがあります）。`;
  }

  return null;
}

window.W.exchangeAddressRules = {
  EXCHANGE_DEPOSIT_ADDRESSES,
  getExchangeNameForAddress,
  validateExchangeRecipient
};

})();
