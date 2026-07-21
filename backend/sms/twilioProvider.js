// Sends SMS via Twilio's REST API. Implements the interface described in
// sms/index.js: sendSms(toNumber, message) - throws on failure, so the
// caller (server.js) can show a clear error to the rep.
//
// To swap in a different SMS provider later (Plivo, Telnyx, etc.), write a
// new file next to this one that exports the same sendSms(toNumber, message)
// function, then point sms/index.js at it instead - nothing else in the app
// needs to change, since everything else only ever calls sms/index.js.

const twilio = require("twilio");

// A separate Twilio client from the one in server.js - this file is meant
// to be self-contained, the same way ai/geminiProvider.js builds its own
// Gemini client instead of sharing one from elsewhere.
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Which number the SMS appears to come FROM. Falls back to the same number
// used for voice calls (TWILIO_FROM_NUMBER) if you haven't set a dedicated
// SMS number (TWILIO_SMS_FROM) in .env - most trial setups only have one
// Twilio number anyway, and it can usually send SMS too.
const SMS_FROM_NUMBER = process.env.TWILIO_SMS_FROM || process.env.TWILIO_FROM_NUMBER;

// Sends one SMS. Returns Twilio's message SID (its unique ID for this
// message) on success. Throws on failure - server.js catches this and shows
// the rep a clear error (e.g. "unverified number" on a Twilio trial account).
async function sendSms(toNumber, message) {
  const result = await twilioClient.messages.create({
    to: toNumber,
    from: SMS_FROM_NUMBER,
    body: message,
  });

  return result.sid;
}

module.exports = { sendSms };
