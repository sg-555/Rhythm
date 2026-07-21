// This is the "swappable SMS provider" entry point - same pattern as
// ai/index.js. Everywhere else in the app calls sendSms() through this file,
// without knowing (or needing to know) which SMS service is actually behind
// it.
//
// To switch providers later (e.g. to Plivo or Telnyx), write a new file next
// to this one (e.g. plivoProvider.js) that exports sendSms(toNumber, message)
// with the same shape - throws on failure, resolves on success - then change
// the line below to point at that file instead. Nothing else in the app
// needs to change.

const provider = require("./twilioProvider");

async function sendSms(toNumber, message) {
  return provider.sendSms(toNumber, message);
}

module.exports = { sendSms };
