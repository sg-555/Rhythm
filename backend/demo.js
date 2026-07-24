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

// ── Demo "My sheets" ─────────────────────────────────────────────────────
// A real signed-in user can have several Google Sheets to switch between
// (see server.js's /api/sheets routes). Demo visitors don't have a real
// Google account, so there's nothing to actually create/store per visitor -
// instead we show three FAKE sheets, all backed by the same seeded
// DEMO_SHEET_ID data (see partitionDemoRows() in server.js, which splits
// that one sheet's rows into three subsets by position so switching
// genuinely shows different leads).
const DEMO_SHEETS = [
  { sheetId: "demo-sheet-1", name: "Q3 Enterprise Leads" },
  { sheetId: "demo-sheet-2", name: "Inbound — July" },
  { sheetId: "demo-sheet-3", name: "Conference Follow-ups" },
];

const DEMO_ACTIVE_SHEET_COOKIE_NAME = "rhythm_demo_sheet";

// Which of the three demo sheets this browser last switched to - defaults
// to the first one if never set (or set to something no longer valid).
function getDemoActiveSheetId(req) {
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const prefix = `${DEMO_ACTIVE_SHEET_COOKIE_NAME}=`;
    const match = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix));
    if (match) {
      const sheetId = decodeURIComponent(match.slice(prefix.length));
      if (DEMO_SHEETS.some((sheet) => sheet.sheetId === sheetId)) return sheetId;
    }
  }
  return DEMO_SHEETS[0].sheetId;
}

// Remembers which demo sheet is "active" for this browser - same idea as
// setDemoCookie, just a separate cookie so it can be cleared independently.
function setDemoActiveSheetCookie(res, sheetId) {
  const maxAgeSeconds = 24 * 60 * 60;
  res.append(
    "Set-Cookie",
    `${DEMO_ACTIVE_SHEET_COOKIE_NAME}=${encodeURIComponent(sheetId)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`
  );
}

// Clears the active-demo-sheet cookie (called on demo exit, so the NEXT
// demo visit starts back on the first sheet rather than wherever this one left off).
function clearDemoActiveSheetCookie(res) {
  res.append("Set-Cookie", `${DEMO_ACTIVE_SHEET_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`);
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

module.exports = {
  isDemoRequest,
  setDemoCookie,
  clearDemoCookie,
  DEMO_SHEETS,
  getDemoActiveSheetId,
  setDemoActiveSheetCookie,
  clearDemoActiveSheetCookie,
};
