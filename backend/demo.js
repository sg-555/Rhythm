// Demo Mode: lets a visitor explore the app WITHOUT signing in - see
// server.js for every place this is checked. This file only tracks ONE
// thing: whether a browser has entered demo mode. It's deliberately much
// simpler than auth.js's real sessions (no identity, no user storage) -
// demo mode is the same for every visitor.
//
// The actual safety rules (never touch the real sheet, never place a real
// call/SMS/AI request) all live in server.js, at each place that matters -
// this file just answers "is this request in demo mode?".

const DEMO_COOKIE_NAME = "rhythm_demo";

// True if this request's browser has already entered demo mode.
function isDemoRequest(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return false;

  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .some((part) => part === `${DEMO_COOKIE_NAME}=1`);
}

// Marks this browser as being in demo mode. Not HttpOnly - there's no
// sensitive data in it (just "1"), and it doesn't need to be hidden from
// the page's own JavaScript.
//
// Uses res.append() rather than res.setHeader() - Set-Cookie is a
// multi-value header, and setHeader() would silently REPLACE any other
// cookie already queued on this same response instead of adding to it (see
// auth.js's setSessionCookie for the concrete case this matters for).
function setDemoCookie(res) {
  const maxAgeSeconds = 24 * 60 * 60; // 1 day - a demo visit is a short thing
  res.append(
    "Set-Cookie",
    `${DEMO_COOKIE_NAME}=1; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`
  );
}

// Clears the demo cookie (the "Exit demo" button, and also called whenever
// a real sign-in succeeds - see server.js's /auth/google/callback).
function clearDemoCookie(res) {
  res.append("Set-Cookie", `${DEMO_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`);
}

module.exports = { isDemoRequest, setDemoCookie, clearDemoCookie };
