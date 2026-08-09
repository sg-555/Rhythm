// ── PILOT-ONLY access gate ──────────────────────────────────────────────
// TEMPORARY control for this pilot: only approved emails may use any PAID
// feature (Twilio calls/SMS, Deepgram transcription, Gemini AI). Everyone
// else can still sign in and look around demo-style, but every paid action
// is blocked - see canUsePaidFeatures() below, and every call site listed
// in its own comment, in server.js.
//
// Deliberately isolated in its own file, behind ONE function, so this is a
// single obvious thing to rip out or replace later (rate limits, a real
// paywall, ...) - swap what's INSIDE canUsePaidFeatures() and nothing that
// CALLS it ever needs to change.

// Comma-separated approved emails - edit PILOT_ALLOWED_EMAILS in your
// environment (Render's dashboard in production, .env locally) to add or
// remove pilot users. No code change or redeploy-from-a-commit needed.
// Matched case-insensitively. Example:
//   PILOT_ALLOWED_EMAILS="alice@example.com, bob@example.com"
function getAllowedEmails() {
  return (process.env.PILOT_ALLOWED_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

// THE single choke point for "is this signed-in user allowed to spend our
// money?" - every endpoint that calls Twilio, Deepgram, or Gemini checks
// this before doing anything paid. See server.js: GET /api/token (the main
// gate for real calls), POST /api/call, GET /api/test-call,
// POST /api/leads/:phone/draft-sms, POST /api/leads/:phone/send-sms,
// POST /api/regenerate-insights, and POST /api/test-insights.
function canUsePaidFeatures(email) {
  if (!email) return false;
  return getAllowedEmails().includes(email.toLowerCase());
}

// Shown to a signed-in-but-not-approved user (both the frontend's full-
// screen block and every backend 403 below use this SAME string) - one
// place to edit the wording. PILOT_CONTACT_EMAIL is who they should
// actually email; falls back to a generic phrase if that's unset so this
// never prints "undefined".
function getPilotBlockedMessage() {
  const contact = process.env.PILOT_CONTACT_EMAIL || "the person who invited you";
  return `Access is currently invite-only - request access at ${contact}.`;
}

module.exports = { canUsePaidFeatures, getPilotBlockedMessage };
