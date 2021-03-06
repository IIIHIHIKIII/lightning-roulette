#!/usr/bin/env node

const lnService = require("ln-service");
const admin = require("firebase-admin");
const serviceAccount = require("./lrt3-7deeb-firebase-adminsdk-meinj-ca0e2ccdcf.json");
const event = require("./lib/events");

const REQUESTED_PAYMENT = "requested";
const CONFIRMED_PAYMENT = "confirmed";
const ERROR_PAYMENT = "error";

const MAX_FEE = 50; // sats

const config = require("./lnd-config");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://lrt3-7deeb.firebaseio.com"
});

const db = admin.firestore();
const { lnd } = lnService.authenticatedLndGrpc(config);

function format(value) {
  return String(value).replace(/000$/, "k");
}

const processWithdraws = async () => {
  const querySnap = await db
    .collection("payments")
    .where("state", "==", REQUESTED_PAYMENT)
    .limit(1)
    .get();

  if (querySnap.empty) return;

  for (let paymentSnap of querySnap.docs) {
    const { uid, payment_request: request } = paymentSnap.data();

    try {
      let {
        tokens = 0,
        id,
        destination,
        is_expired
      } = await lnService.decodePaymentRequest({ lnd, request });

      if (is_expired) {
        throw new Error(`invoice expired.`);
      }

      // load account here
      const profileSnap = await db
        .collection("profiles")
        .doc(uid)
        .get();

      let { balance = 0, withdrawLock = false } = profileSnap.data();

      if (
        isNaN(balance) ||
        isNaN(tokens) ||
        typeof balance === "string" ||
        tokens <= 0 ||
        balance < tokens
      ) {
        throw new Error(
          `invoice amount should be less than or equal to ${balance} satoshis`
        );
      }

      if (tokens > 250000) {
        throw new Error(
          `invoice amount is too big. max 250k. You can withdraw more times if needed`
        );
      }

      if (withdrawLock) {
        throw new Error("please waith until previous withdraw is settled");
      }

      // call withdraw here  !!!
      const { secret, fee } = await lnService.pay({
        lnd,
        request,
        max_fee: MAX_FEE
      });

      await paymentSnap.ref.update({
        confirmedAt: new Date(),
        state: CONFIRMED_PAYMENT,
        destination,
        tokens,
        id,
        fee,
        secret
      });

      balance = balance - tokens - fee;

      await profileSnap.ref.update({
        balance
      });

      event(db, {
        type: "WITHDRAW",
        profile: uid,
        tokens: format(tokens),
        secret,
        fee
      });
    } catch (e) {
      //
      let error = "";
      try {
        error = e.toString().substring(0, 100);
      } catch (e) {}

      event(db, {
        type: "WITHDRAW_ERROR",
        profile: uid,
        error
      });

      await paymentSnap.ref.update({
        state: ERROR_PAYMENT,
        error
      });
    }
  }
};

(async () => {
  do {
    try {
      await processWithdraws();
    } catch (e) {
      console.log("ERROR", e);
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  } while (true);
})();
