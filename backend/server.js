// A minimal Express server that:
// 1. Serves the frontend HTML page.
// 2. Provides a test API endpoint at /api/hello.
// 3. Provides /api/leads, which reads rows from a Google Sheet.
// 4. Provides /api/leads/:phone (detail), plus /stage, /notes, /callback,
//    /draft-sms, and /send-sms writes, for the lead detail side panel.
// 5. Provides /api/leads/due, which computes which leads need a call-back
//    right now (manual time passed, or the auto Hot/Warm/Cold rule).
// 6. Provides /api/call and /api/test-call, which place real phone calls via Twilio.
// 7. Streams live call audio from Twilio to /media-stream for live transcription,
//    and periodically checks that transcript for a live AI coaching tip to
//    push to the browser over /browser-feed.
// 8. Sends AI-drafted post-call SMS follow-ups through a swappable SMS
//    abstraction (see sms/index.js), same pattern as the AI abstraction.
// 9. Logs every completed call as its own record (call-log.json) and
//    provides /api/analytics, which computes the Analytics dashboard's
//    numbers from that log (pick-up rate, outcome breakdown, temperature
//    split, pick-up rate by hour of day), filterable by date/time range.
// 10. Provides "Sign in with Google" (see auth.js): /auth/google,
//     /auth/google/callback, /api/me, and /auth/logout. Authentication
//     only for now - the app still uses the one hardcoded sheet either way.

// Load variables from .env into process.env (must happen before anything reads them)
require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { WebSocketServer } = require("ws");
const { google } = require("googleapis");
const twilio = require("twilio");
const { DeepgramClient } = require("@deepgram/sdk");
const { generateCallInsights, generateRelationshipSummary, generateCoachingTip, generateFollowUpSms } = require("./ai");
const { sendSms } = require("./sms");
const {
  getGoogleAuthUrl,
  exchangeCodeForUser,
  saveUser,
  getUser,
  getCurrentUser,
  updateUserCompany,
  updateUserSellerContext,
  updateUserTheme,
  updateUserSheetId,
  updateUserPhoneColumnFormatted,
  updateUserTourCompleted,
  getSheetsForUser,
  addSheetForUser,
  renameSheetForUser,
  getUserOAuthClient,
  createSession,
  destroySession,
  readSessionIdFromRequest,
  setSessionCookie,
  clearSessionCookie,
} = require("./auth");
const {
  isDemoRequest,
  setDemoCookie,
  clearDemoCookie,
  DEMO_SHEETS,
  getDemoActiveSheetId,
  setDemoActiveSheetCookie,
  clearDemoActiveSheetCookie,
} = require("./demo");
const db = require("./db");
const { canUsePaidFeatures, getPilotBlockedMessage } = require("./pilotAccess");

// ── Last-resort process-level safety nets ────────────────────────────────
// Without these, ANY unhandled promise rejection or thrown error ANYWHERE
// in this file (including deep inside a WebSocket callback or a library
// we don't control) crashes the entire Node process by default - taking
// down every signed-in rep's in-progress call at once, not just whatever
// triggered it. These are a BACKSTOP, not a substitute for handling errors
// at the source (see the try/catch around the /media-stream message
// handler below, which is what should actually catch the known case) -
// this just guarantees that even an error nobody anticipated logs and the
// server keeps running, instead of silently taking everyone down.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server staying up):", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception (server staying up):", error);
});

const app = express();
const PORT = 3000;

// Lets us read JSON bodies sent by the frontend (needed for POST /api/call)
app.use(express.json());

// Lets us read form-encoded bodies - this is the format Twilio uses when it
// calls our POST /voice endpoint during a browser call.
app.use(express.urlencoded({ extended: false }));

// GET /: the public marketing landing page - served to EVERYONE, signed in
// or not, no auth check at all (this is the public front door, now that
// most visitors can't sign in yet - see landing.html's own "Try the demo"/
// "Sign in" buttons). Registered BEFORE the static middleware below so it
// takes priority over that middleware's own default "serve index.html for
// /" behaviour - the actual app now lives at /index.html instead (see the
// updated redirects in /auth/google/callback and /demo below, which used
// to send people back to "/" and would otherwise land them back on this
// marketing page instead of the app).
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "landing.html"));
});

// GET /privacy and GET /terms: public legal pages, linked from the landing
// page's footer - no auth check, same as "/" above. Clean URLs rather than
// the raw "/privacy.html"/"/terms.html" static paths (those still work too,
// via the static middleware below, but these are what's actually linked).
app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "privacy.html"));
});

app.get("/terms", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "terms.html"));
});

// Serve everything in the "frontend" folder as static files (index.html,
// callbacks.html, analytics.html, landing.html itself, css/js, etc.)
app.use(express.static(path.join(__dirname, "..", "frontend")));

// Test API endpoint the frontend button will call
app.get("/api/hello", (req, res) => {
  res.json({ message: "Hello from the backend!" });
});

// ── Sign in with Google ──────────────────────────────────────────────────
// This is authentication ONLY, for now - once signed in, the app still
// reads/writes the one hardcoded sheet in SHEET_CONFIG below, exactly like
// before. A LATER step will switch to a separate sheet per signed-in user.

// GET /auth/google: starts the sign-in flow by sending the browser to
// Google's own consent screen.
app.get("/auth/google", (req, res) => {
  res.redirect(getGoogleAuthUrl());
});

// GET /auth/google/callback: Google redirects back here after the user
// approves (or cancels) access, with a one-time "code" in the URL. This
// path must be EXACTLY /auth/google/callback - it has to match the redirect
// URI registered in the Google Cloud Console, or Google will refuse it.
app.get("/auth/google/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    // The user clicked "Cancel" on Google's consent screen, or something
    // else went wrong on Google's side.
    return res.status(400).send(`Sign-in was cancelled or failed: ${error}`);
  }

  if (!code) {
    return res.status(400).send("Missing authorization code from Google.");
  }

  try {
    const { tokens, profile } = await exchangeCodeForUser(code);
    await saveUser(profile.email, tokens, profile);

    const sessionId = createSession(profile.email);
    setSessionCookie(res, sessionId);
    clearDemoCookie(res); // a real sign-in always replaces demo mode, never layers on top of it
    clearDemoActiveSheetCookie(res);

    // Straight to the app, not "/" - that's the public landing page now,
    // which would otherwise show a freshly signed-in user the marketing
    // page instead of their actual leads.
    res.redirect("/index.html");
  } catch (err) {
    console.error("Google sign-in failed:", err.message);
    res.status(500).send("Sign-in failed: " + err.message);
  }
});

// GET /api/me: tells the frontend who (if anyone) is currently signed in,
// and whether this browser is in DEMO MODE instead. Never sends tokens to
// the browser - just what the UI needs to show.
app.get("/api/me", async (req, res) => {
  const user = await getCurrentUser(req);
  res.json({
    // hasSheet tells the frontend whether to show the leads table or the
    // onboarding screen (see checkSignedIn() in each page) - true only once
    // this user has created or connected their own Rhythm sheet. sheetId
    // itself is what lets the frontend build an "Open my sheet" link - it's
    // not sensitive (the user already owns/can open this sheet in Google
    // Sheets directly), so there's no harm in sending it down.
    user: user
      ? {
          email: user.email,
          name: user.name,
          picture: user.picture || null,
          hasSheet: !!user.sheetId,
          sheetId: user.sheetId || null,
          theme: user.theme || null,
          // Whether the guided product tour has already run for this user -
          // see checkSignedIn() in the frontend, which auto-starts the tour
          // only when this is false (a genuinely first login).
          tourCompleted: !!user.tourCompleted,
          // PILOT gate (see pilotAccess.js) - false means this is a
          // genuinely signed-in user who just isn't on the pilot allowlist.
          // The frontend shows a full-screen "invite-only" message instead
          // of the app for this case (see checkSignedIn()) - but that's
          // just UX. The REAL enforcement is server-side, on every paid
          // endpoint itself (see blockIfNoPaidAccess() above).
          paidAccess: canUsePaidFeatures(user.email),
        }
      : null,
    demo: isDemoRequest(req),
    // Same wording the backend's own 403s use (see getPilotBlockedMessage())
    // - sent unconditionally (cheap, and harmless for anyone approved or
    // signed out) so the frontend never has to hardcode this copy itself.
    pilotBlockedMessage: getPilotBlockedMessage(),
  });
});

// POST /api/tour/complete: marks the guided product tour as seen, so it
// never auto-runs again for this user - called both when the tour finishes
// AND when it's skipped (either way, the rep has now seen it once). The
// "Replay tour" option in the profile menu does NOT call this - it just
// re-starts the tour directly, without touching this flag.
app.post("/api/tour/complete", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in." });
  }

  await updateUserTourCompleted(user.email);
  res.json({ success: true });
});

// ── Demo Mode entry points ───────────────────────────────────────────────
// Both the sign-in screen's "View Demo" button and visiting /demo directly
// land here. This is the ONLY place that ever sets the demo cookie - after
// this, every route below checks isDemoRequest() and either reads from the
// seeded demo sheet/call-log instead of the real ones, or fakes success
// without calling Twilio/Deepgram/Gemini at all. See the comments at each
// of those checks for exactly what's gated and why.
app.get("/demo", (req, res) => {
  setDemoCookie(res);
  // Straight to the app, not "/" - see the same note on /auth/google/
  // callback above. "/" is the public landing page now.
  res.redirect("/index.html");
});

// POST /demo/exit: leaves demo mode (the "Exit demo" button).
app.post("/demo/exit", (req, res) => {
  clearDemoCookie(res);
  clearDemoActiveSheetCookie(res);
  res.json({ ok: true });
});

// POST /auth/logout: signs the current browser out.
app.post("/auth/logout", (req, res) => {
  const sessionId = readSessionIdFromRequest(req);
  if (sessionId) destroySession(sessionId);
  clearSessionCookie(res);
  res.json({ success: true });
});

// Counts how many rows in the sheet currently have the given Stage value -
// used for the profile menu's "Deals closed" stat (Stage === "Closed/Won").
async function countLeadsAtStage(sheets, sheetId, stageName) {
  const { headers, dataRows } = await loadSheetRows(sheets, sheetId);
  const stageCol = getColumnIndex(headers, "stage");

  return dataRows.filter((row) => (row[stageCol] || "").trim() === stageName).length;
}

// A made-up persona for demo mode's profile panel - there's no real signed-in
// user to describe, but the demo is meant to showcase this feature too, so
// it gets a believable stand-in instead of an error. Stats below are real
// numbers computed from the seeded demo call log/sheet, not made up.
const DEMO_PROFILE_PERSONA = {
  name: "Demo Visitor",
  email: "demo@rhythm.ai",
  company: "Rhythm Demo Co.",
};

// GET /api/profile: the signed-in user's own info (name/email/photo/company)
// plus their all-time personal stats. This app is single-operator, and the
// call log has no per-user attribution, so "personal stats" here means the
// whole call history - which IS this rep's own activity, since they're the
// only one placing calls. In demo mode there's no real signed-in user, so a
// fixed persona (see DEMO_PROFILE_PERSONA above) stands in, with stats
// computed from the seeded demo call log/sheet instead of the real ones.
app.get("/api/profile", async (req, res) => {
  if (isDemoRequest(req)) {
    try {
      const analytics = computeAnalytics(loadDemoCallLog());

      let dealsClosed = 0;
      try {
        const { sheets, sheetId } = await getSheetsContextForRequest(req);
        dealsClosed = await countLeadsAtStage(sheets, sheetId, "Closed/Won");
      } catch (error) {
        console.error("Could not compute demo deals closed:", error.message);
      }

      return res.json({
        name: DEMO_PROFILE_PERSONA.name,
        email: DEMO_PROFILE_PERSONA.email,
        picture: null,
        company: DEMO_PROFILE_PERSONA.company,
        hasSheet: true,
        sheetId: null, // no "Open my sheet" link - it's a shared seeded demo sheet, not the visitor's own
        theme: null,
        stats: {
          totalCalls: analytics.totalCalls,
          connectedCount: analytics.connectedCount,
          pickupRate: analytics.pickupRate,
          dealsClosed,
        },
      });
    } catch (error) {
      console.error("Failed to load demo profile:", error.message);
      return res.status(500).json({ error: "Failed to load demo profile." });
    }
  }

  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in." });
  }

  try {
    // computeAnalytics() with no date/time filter = the whole call history.
    // Scoped to THIS user (see loadCallLog()) - previously this read the
    // single shared call-log.json unscoped, so every rep's stats were
    // mixed together; now each user only ever sees their own calls.
    const analytics = computeAnalytics(await loadCallLog(user.email));

    // "Deals closed" needs this user's own sheet - but name/email/photo/
    // company are still meaningful even before they've onboarded, so a
    // missing sheet just means 0 here rather than failing the whole profile.
    let dealsClosed = 0;
    if (user.sheetId) {
      try {
        const { sheets, sheetId } = await getSheetsContextForUser(user);
        dealsClosed = await countLeadsAtStage(sheets, sheetId, "Closed/Won");
      } catch (error) {
        console.error("Could not compute deals closed:", error.message);
      }
    }

    res.json({
      name: user.name,
      email: user.email,
      picture: user.picture || null,
      company: user.company || "",
      hasSheet: !!user.sheetId,
      // Lets the profile panel show a permanent "Open my sheet" link.
      sheetId: user.sheetId || null,
      // "light"/"dark", or null to mean "follow system preference".
      theme: user.theme || null,
      // The 5-question "seller context" profile (see POST /api/profile and
      // buildSellerContextString() above) - every field "" until filled in.
      // Nested so the frontend can spread it straight onto its 5 inputs.
      sellerContext: {
        sellsWhat: user.sellsWhat || "",
        sellsTo: user.sellsTo || "",
        callGoal: user.callGoal || "",
        commonObjections: user.commonObjections || "",
        extraContext: user.extraContext || "",
      },
      stats: {
        totalCalls: analytics.totalCalls,
        connectedCount: analytics.connectedCount,
        pickupRate: analytics.pickupRate,
        dealsClosed,
      },
    });
  } catch (error) {
    console.error("Failed to load profile:", error.message);
    res.status(500).json({ error: "Failed to load profile." });
  }
});

// POST /api/profile: updates the signed-in user's company/organisation,
// theme preference, and/or seller-context profile - the editable fields in
// the profile panel. Expects any of: { "company": "..." },
// { "theme": "light"|"dark"|null }, and/or the 5 seller-context fields
// (sellsWhat/sellsTo/callGoal/commonObjections/extraContext) - all optional
// free text, saved together whenever the "Your sales context" section is
// submitted (see updateUserSellerContext() in auth.js).
app.post("/api/profile", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in." });
  }

  const { company, theme, sellsWhat, sellsTo, callGoal, commonObjections, extraContext } = req.body;
  const sellerContextFields = { sellsWhat, sellsTo, callGoal, commonObjections, extraContext };
  const sellerContextProvided = Object.values(sellerContextFields).some((value) => value !== undefined);

  if (company === undefined && theme === undefined && !sellerContextProvided) {
    return res.status(400).json({ error: "Request body must include 'company', 'theme', or a seller-context field." });
  }

  if (company !== undefined) await updateUserCompany(user.email, company);
  if (theme !== undefined) await updateUserTheme(user.email, theme);
  if (sellerContextProvided) await updateUserSellerContext(user.email, sellerContextFields);

  res.json({ success: true, company, theme });
});

// ── Google Sheet configuration ──────────────────────────────────────────
// Sheets are now per-user (see the "Per-user Sheets access" section below) -
// this object only holds the SHARED SCHEMA every user's sheet follows, not
// a sheet ID. Every place in this file that reads or writes a sheet looks
// up column positions through here - nothing else in the code hard-codes a
// column letter or header string.
const SHEET_CONFIG = {
  // Maps our internal field names (used throughout this file) to the exact
  // header text expected in row 1 of the sheet. We match by this text, not
  // by column position, so columns can be added/reordered safely. Also used
  // (in order) as the header row when creating a brand-new "Rhythm Leads"
  // sheet for a user - see createRhythmSheetForUser() below.
  columns: {
    name: "Name",
    phone: "Phone",
    stage: "Stage",
    lastOutcome: "Last outcome",
    attempts: "Attempts",
    lastCalled: "Last called",
    firstConnected: "First Connected",
    notes: "Notes",
    temperature: "Temperature",
    aiNotes: "AI Notes",
    previousCalls: "Previous Calls",
    callBackOn: "Call Back On",
  },
};

// Path to the service account key file used to authenticate with Google
// (local dev only - see below). ONLY ever used for DEMO MODE's seeded
// sheet now - every signed-in user's OWN sheet is accessed with THEIR OWN
// OAuth tokens instead (see getUserOAuthClient() in auth.js), never this.
const KEY_FILE_PATH = path.join(__dirname, "..", "google-key.json");

// In deployment there's usually no disk to put google-key.json on, so we
// support passing the whole key as one env var (GOOGLE_KEY_JSON) instead.
// Locally, it's simpler to just keep using the key file, so that stays the
// fallback.
const serviceAccountAuthOptions = {
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
};
if (process.env.GOOGLE_KEY_JSON) {
  serviceAccountAuthOptions.credentials = JSON.parse(process.env.GOOGLE_KEY_JSON);
} else {
  serviceAccountAuthOptions.keyFile = KEY_FILE_PATH;
}

// GoogleAuth reads the key (from wherever we pointed it above) and handles
// getting us an access token for the DEMO sheet only.
const serviceAccountAuth = new google.auth.GoogleAuth(serviceAccountAuthOptions);

// ── Per-user Sheets access ───────────────────────────────────────────────
// The ONE place every route/helper in this file gets its Google Sheets
// access through - there is no other path that can fall back to a shared/
// global sheet. Two identities are possible:
// - Demo mode: always the seeded DEMO_SHEET_ID, via the service account.
// - A signed-in user: THEIR OWN sheetId, via THEIR OWN stored OAuth tokens.
// Both return the same shape: { sheets, sheetId }.

// Tags an error so handleSheetsError() (below) can turn it into the right
// HTTP response, instead of a generic 500 either way.
function taggedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Resolves { sheets, sheetId } for ONE already-looked-up signed-in user.
// Throws a NEEDS_ONBOARDING error if they haven't created/connected a sheet
// yet - every caller either handles that (the onboarding endpoints
// themselves) or lets it bubble up to handleSheetsError().
async function getSheetsContextForUser(user) {
  if (!user.sheetId) {
    throw taggedError("You haven't connected a Rhythm sheet yet.", "NEEDS_ONBOARDING");
  }

  const oauthClient = getUserOAuthClient(user);
  const sheets = google.sheets({ version: "v4", auth: oauthClient });

  // One-time fix-up for anyone who connected their sheet BEFORE the Phone
  // column was set to plain text (see applyPhoneColumnPlainTextFormat) -
  // this is the first place every signed-in request passes through once
  // they have a sheet, so it runs automatically on their next request
  // rather than needing its own button. Guarded so it only ever runs once
  // per user, and never blocks the actual request if it fails.
  if (!user.phoneColumnFormatted) {
    try {
      await applyPhoneColumnPlainTextFormat(sheets, user.sheetId);
      await updateUserPhoneColumnFormatted(user.email);
      user.phoneColumnFormatted = true; // keep this in-memory copy in sync too
    } catch (error) {
      console.error("Could not apply plain-text Phone format for", user.email, "-", error.message);
    }
  }

  return { sheets, sheetId: user.sheetId };
}

// Resolves { sheets, sheetId } for a normal browser request - demo mode's
// seeded sheet, or the signed-in user's own sheet. This is what almost
// every route below calls.
async function getSheetsContextForRequest(req) {
  if (isDemoRequest(req)) {
    if (!process.env.DEMO_SHEET_ID) {
      throw new Error("Demo mode is on, but DEMO_SHEET_ID is not set in .env.");
    }
    const authClient = await serviceAccountAuth.getClient();
    return { sheets: google.sheets({ version: "v4", auth: authClient }), sheetId: process.env.DEMO_SHEET_ID };
  }

  const user = await getCurrentUser(req);
  if (!user) {
    throw taggedError("Not signed in.", "REAUTH_REQUIRED");
  }
  return getSheetsContextForUser(user);
}

// Demo mode only: splits the one seeded demo sheet's rows into three
// roughly-even, STABLE subsets by row position, so "My sheets" can offer
// three fake sheets (see DEMO_SHEETS in demo.js) that a visitor can
// genuinely switch between and see different leads. Real users never hit
// this - they simply have separate, real Google Sheets.
function partitionDemoRows(rows, activeDemoSheetId) {
  const bucketIndex = DEMO_SHEETS.findIndex((sheet) => sheet.sheetId === activeDemoSheetId);
  const bucket = bucketIndex === -1 ? 0 : bucketIndex;
  return rows.filter((_, index) => index % DEMO_SHEETS.length === bucket);
}

// Resolves { sheets, sheetId } from an EMAIL directly rather than a request -
// needed for the Twilio call-status webhook, which Twilio calls server-to-
// server with no browser session/cookie at all. See the /voice and
// /call-status handlers below for how the email gets there.
async function getSheetsContextForEmail(email) {
  const user = await getUser(email);
  if (!user) {
    throw taggedError(`No stored account for ${email}.`, "REAUTH_REQUIRED");
  }
  return getSheetsContextForUser(user);
}

// True if a Google API error looks like an auth failure (expired/revoked
// token) rather than some other problem (e.g. a sheet genuinely missing a
// column). Used by handleSheetsError to decide whether "sign in again" is
// the right message.
function isGoogleAuthError(error) {
  const status = error.code || (error.response && error.response.status);
  return status === 401 || /invalid_grant|invalid_token|No refresh token/i.test(error.message || "");
}

// Shared by every route that resolves a Sheets context: turns whatever went
// wrong into the right HTTP response, instead of every route re-implementing
// this. NEEDS_ONBOARDING and auth failures get a distinct shape the
// frontend can detect and act on (show onboarding / prompt to sign in
// again) rather than a generic failure message.
function handleSheetsError(res, error) {
  if (error.code === "NEEDS_ONBOARDING") {
    return res.status(409).json({ error: error.message, needsOnboarding: true });
  }
  if (error.code === "REAUTH_REQUIRED" || isGoogleAuthError(error)) {
    console.error("Google auth failed:", error.message);
    return res.status(401).json({
      error: "Your Google connection needs to be refreshed - please sign in again.",
      reauthRequired: true,
    });
  }
  console.error("Sheets operation failed:", error.message);
  return res.status(500).json({ error: error.message || "Something went wrong." });
}

// Reads every row from the sheet, splitting the header row from the data
// rows. We ask for a wide range (A1:Z) rather than a fixed number of columns,
// so this keeps working even if columns are added or reordered later.
async function loadSheetRows(sheets, sheetId) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "A1:Z",
  });

  const allRows = response.data.values || [];
  return {
    headers: allRows[0] || [],
    dataRows: allRows.slice(1),
  };
}

// Finds which column a logical field (e.g. "phone") lives in, by matching
// SHEET_CONFIG's header text against the sheet's actual header row.
// This is the one place that turns a "logical name" into a real column.
function getColumnIndex(headers, fieldName) {
  const headerText = SHEET_CONFIG.columns[fieldName];
  const normalizedTarget = headerText.trim().toLowerCase();

  const index = headers.findIndex(
    (header) => (header || "").trim().toLowerCase() === normalizedTarget
  );

  if (index === -1) {
    throw new Error(`Could not find a "${headerText}" column in the sheet.`);
  }

  return index;
}

// Converts a 0-based column index (0, 1, 2...) into a sheet column letter (A, B, C...)
function columnIndexToLetter(index) {
  let letter = "";
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

// Sets the Phone column's cell format to PLAIN TEXT, for the WHOLE column -
// so typing a leading "+" (e.g. "+91 98765 43210") is never misread as a
// formula by Google Sheets. Safe to call on a sheet that already has real
// data: this only changes how cells are FORMATTED/how NEW input into them
// is interpreted from now on - it never touches any existing cell's value.
async function applyPhoneColumnPlainTextFormat(sheets, sheetId) {
  // Need two things: which column is "Phone" (from the header row), and
  // this spreadsheet's TAB's own internal numeric ID - the Sheets API
  // addresses formatting requests by that, not by the spreadsheet's string
  // ID (which is what's used everywhere else in this file).
  const [{ headers }, metadata] = await Promise.all([
    loadSheetRows(sheets, sheetId),
    sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties" }),
  ]);

  const phoneCol = getColumnIndex(headers, "phone");
  const tabId = metadata.data.sheets[0].properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            // Leaving startRowIndex/endRowIndex unset targets EVERY row in
            // the column, not just the ones that currently have data.
            range: { sheetId: tabId, startColumnIndex: phoneCol, endColumnIndex: phoneCol + 1 },
            cell: { userEnteredFormat: { numberFormat: { type: "TEXT" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        },
      ],
    },
  });
}

// ── Onboarding: creating or connecting a user's own Rhythm sheet ─────────
// A signed-in user with no sheetId yet sees the onboarding screen instead
// of the leads table (see checkSignedIn() in the frontend) - these two
// endpoints are its two options.

// Creates a brand-new Google Sheet in the user's OWN Drive - using THEIR
// OAuth tokens (drive.file scope covers creating files this way), never the
// service account - with the correct header row. `name` becomes the actual
// Google file's title AND the Rhythm-side display name (see the two
// callers below), so they start out in sync.
async function createRhythmSheetForUser(user, name) {
  const oauthClient = getUserOAuthClient(user);
  const sheets = google.sheets({ version: "v4", auth: oauthClient });

  const createResponse = await sheets.spreadsheets.create({
    requestBody: { properties: { title: name } },
  });
  const sheetId = createResponse.data.spreadsheetId;

  const headerRow = Object.values(SHEET_CONFIG.columns);
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headerRow] },
  });

  // Fix the "+91..." formula-misread problem from the very start, so a
  // brand-new sheet never has it.
  await applyPhoneColumnPlainTextFormat(sheets, sheetId);

  return sheetId;
}

// POST /api/onboarding/create-sheet: creates a new "Rhythm Leads" sheet in
// the signed-in user's own Drive and connects it to their account. This is
// the ONLY onboarding option for now - "connect an existing sheet" would
// need either the broader (Google-restricted) "spreadsheets" scope or a
// Google Picker integration, neither of which is built yet. See the
// onboarding screen's "coming soon" note.
app.post("/api/onboarding/create-sheet", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in.", reauthRequired: true });
  }

  // Idempotency guard: if this user already has a sheet, hand back that
  // SAME one instead of creating another. Without this, hitting the
  // endpoint twice (e.g. a double-click, or the onboarding screen briefly
  // reappearing for someone who already onboarded) would silently create a
  // second "Rhythm Leads" sheet and orphan the first one in their Drive.
  if (user.sheetId) {
    return res.json({ success: true, sheetId: user.sheetId });
  }

  try {
    // Onboarding stays frictionless - no name prompt, just a sensible
    // default. Renaming (with the Google file kept in sync) is one click
    // away afterward in "My sheets" if they want something different.
    const sheetId = await createRhythmSheetForUser(user, "Rhythm Leads");
    await updateUserSheetId(user.email, sheetId);
    // createRhythmSheetForUser() already applied the plain-text Phone
    // format as part of creation - mark it done so getSheetsContextForUser()
    // doesn't redundantly re-apply it on this user's next request.
    await updateUserPhoneColumnFormatted(user.email);
    // Also add it to the "My sheets" list (see /api/sheets below) - this is
    // this user's FIRST sheet, so the list starts with just this one entry.
    await addSheetForUser(user.email, sheetId, "Rhythm Leads");
    res.json({ success: true, sheetId });
  } catch (error) {
    handleSheetsError(res, error);
  }
});

// ── Multiple sheets ("My sheets" in the profile panel) ───────────────────
// A user can have more than one Rhythm sheet and switch which one the WHOLE
// app works off - see auth.js's getSheetsForUser()/addSheetForUser()/
// renameSheetForUser() for how the list itself is stored. The ACTIVE sheet
// is still just user.sheetId, so nothing outside these four routes needs
// to change - every existing /api/leads, /api/analytics, etc. route keeps
// reading user.sheetId exactly as before, it just may now point at a
// different sheet than it used to.

// GET /api/sheets: this user's full list, plus which one is active.
app.get("/api/sheets", async (req, res) => {
  // Demo mode: three fake sheets (see DEMO_SHEETS in demo.js), no real
  // signed-in user required - the "active" one is just remembered in a
  // cookie (see getDemoActiveSheetId).
  if (isDemoRequest(req)) {
    return res.json({ sheets: DEMO_SHEETS, activeSheetId: getDemoActiveSheetId(req) });
  }

  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in." });
  }

  const sheets = await getSheetsForUser(user.email);
  res.json({ sheets, activeSheetId: user.sheetId || null });
});

// POST /api/sheets: creates a genuinely NEW sheet (unlike onboarding's
// create-sheet, this is NOT idempotent - it's "I'm done with my current
// leads, give me a fresh sheet" - see the profile panel's "Create a new
// sheet" button), adds it to the list, and makes it the active one.
// Expects a JSON body like: { "name": "Rhythm Leads - Jul 24, 2026" } - the
// frontend prompts for this (defaulting to that same date-stamped
// suggestion) before calling here, since unlike onboarding, this ISN'T the
// user's very first sheet, so a moment's naming friction is worth it to
// keep sheets distinguishable later. Falls back to "Rhythm Leads" if the
// name is somehow missing, just so this endpoint never hard-fails on that.
app.post("/api/sheets", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in." });
  }

  const name = (req.body.name || "").trim() || "Rhythm Leads";

  try {
    const sheetId = await createRhythmSheetForUser(user, name);
    await addSheetForUser(user.email, sheetId, name);
    await updateUserSheetId(user.email, sheetId);
    res.json({ success: true, sheetId });
  } catch (error) {
    handleSheetsError(res, error);
  }
});

// POST /api/sheets/:sheetId/activate: switches which sheet is active -
// the frontend does a full page reload right after this succeeds, so
// nothing from the previous sheet (leads, filters, pagination) lingers on
// screen. Always checks the sheetId is actually one of THIS user's own
// sheets first - never blindly trust an id from the URL.
app.post("/api/sheets/:sheetId/activate", async (req, res) => {
  const { sheetId } = req.params;

  // Demo mode: just remember which of the three fake sheets is active in a
  // cookie - there's no real per-user storage to update. This is what
  // actually makes switching "genuinely work" in demo mode (see
  // partitionDemoRows() and GET /api/leads above).
  if (isDemoRequest(req)) {
    const isDemoSheet = DEMO_SHEETS.some((sheet) => sheet.sheetId === sheetId);
    if (!isDemoSheet) {
      return res.status(404).json({ error: "That sheet isn't in the demo." });
    }
    setDemoActiveSheetCookie(res, sheetId);
    return res.json({ success: true, sheetId });
  }

  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in." });
  }

  const sheets = await getSheetsForUser(user.email);
  const owned = sheets.some((sheet) => sheet.sheetId === sheetId);
  if (!owned) {
    return res.status(404).json({ error: "That sheet isn't in your list." });
  }

  await updateUserSheetId(user.email, sheetId);
  res.json({ success: true, sheetId });
});

// POST /api/sheets/:sheetId/rename: changes a sheet's display name, AND
// tries to rename the actual Google Sheets file to match, so the two stay
// in sync (the app created the file, so drive.file scope permits this).
// Expects a JSON body like: { "name": "Q2 leads" }
app.post("/api/sheets/:sheetId/rename", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in." });
  }

  const { sheetId } = req.params;
  const name = (req.body.name || "").trim();
  if (!name) {
    return res.status(400).json({ error: "Request body must include a non-empty 'name'." });
  }

  // The Rhythm-side rename is the one that must always stick - do it
  // first, and never roll it back because of what happens next.
  const updated = await renameSheetForUser(user.email, sheetId, name);
  if (!updated) {
    return res.status(404).json({ error: "That sheet isn't in your list." });
  }

  // Best-effort: also rename the actual Google Sheets file. If this fails
  // (revoked access, a transient API error, etc.) we still report success
  // for the Rhythm-side rename above - just tell the rep the Google file
  // itself is now out of sync, rather than hiding that or undoing a change
  // that already succeeded.
  let googleRenameError = null;
  try {
    const oauthClient = getUserOAuthClient(user);
    const sheets = google.sheets({ version: "v4", auth: oauthClient });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{ updateSpreadsheetProperties: { properties: { title: name }, fields: "title" } }],
      },
    });
  } catch (error) {
    console.error("Could not rename the Google Sheets file", sheetId, "-", error.message);
    googleRenameError = "Renamed in Rhythm, but couldn't rename the Google Sheets file itself: " + error.message;
  }

  res.json({ success: true, sheet: updated, googleRenameError });
});

// /api/leads: reads every row from the sheet and returns them as JSON.
app.get("/api/leads", async (req, res) => {
  try {
    // Demo-mode visitors read the seeded DEMO sheet here; everyone else
    // reads THEIR OWN sheet, via their own OAuth tokens - see
    // getSheetsContextForRequest() above, the one place this is resolved.
    const { sheets, sheetId } = await getSheetsContextForRequest(req);

    const loaded = await loadSheetRows(sheets, sheetId);
    const headers = loaded.headers;

    // Real sheet row number for each row (matching findLeadRow()'s own +2
    // offset), computed BEFORE any demo partitioning below so it stays
    // meaningful - see RowNumber on the returned lead object, which the
    // frontend uses to unambiguously target ONE specific row when two
    // leads share a phone number (the "which lead?" picker - see
    // attachCallHandlers() in shared-lead-panel.js). Demo mode never
    // writes anywhere real (every demo call/write is faked), so RowNumber
    // is left null there instead of sending a partitioned, misleading index.
    const demoMode = isDemoRequest(req);
    const rowsWithNumbers = loaded.dataRows.map((row, index) => ({ row, rowNumber: index + 2 }));
    // Demo mode: only show the rows belonging to whichever of the three
    // fake demo sheets is currently active - see partitionDemoRows() above.
    const dataRows = demoMode ? partitionDemoRows(rowsWithNumbers, getDemoActiveSheetId(req)) : rowsWithNumbers;

    // Look up each column's position by header name, using SHEET_CONFIG.
    const nameCol = getColumnIndex(headers, "name");
    const phoneCol = getColumnIndex(headers, "phone");
    const stageCol = getColumnIndex(headers, "stage");
    const notesCol = getColumnIndex(headers, "notes");
    const temperatureCol = getColumnIndex(headers, "temperature");
    const lastCalledCol = getColumnIndex(headers, "lastCalled");
    const callBackOnCol = getColumnIndex(headers, "callBackOn");
    const firstConnectedCol = getColumnIndex(headers, "firstConnected");

    // Turn each row (an array of cell values) into an object the frontend expects.
    // We also skip fully-blank rows (e.g. leftover empty rows at the bottom
    // of the sheet), since those aren't real leads.
    const leads = dataRows
      .map(({ row, rowNumber }) => {
        const temperatureValue = parseTemperatureValue(row[temperatureCol]);

        // Include whether this lead is due for a call-back, so the table can
        // show a small badge on it (see computeCallbackDue above).
        const due = computeCallbackDue(
          temperatureValue,
          row[lastCalledCol] || "",
          row[callBackOnCol] || "",
          row[firstConnectedCol] || ""
        );

        return {
          Name: row[nameCol] || "",
          Phone: row[phoneCol] || "",
          Status: row[stageCol] || "",
          Notes: row[notesCol] || "",
          Due: !!due,
          DueReason: due ? due.reason : null,
          // Used by the frontend's Hot/Warm/Cold filter - null if this lead
          // has no temperature yet.
          TemperatureValue: temperatureValue,
          // The raw manual call-back time (if set) - used by the frontend's
          // pop-in reminder toasts, so it doesn't need a separate request
          // per lead just to check "is a reminder coming up?".
          CallBackOn: row[callBackOnCol] || "",
          // See the comment above dataRows - only meaningful for a real
          // signed-in user's own sheet, null in demo mode.
          RowNumber: demoMode ? null : rowNumber,
        };
      })
      .filter((lead) => lead.Name || lead.Phone);

    res.json(leads);
  } catch (error) {
    handleSheetsError(res, error);
  }
});

// GET /api/leads/due: returns every lead currently due for a call-back
// (manual "Call Back On" time passed, or the auto Hot/Warm/Cold rule
// triggered - see computeCallbackDue above), sorted MOST overdue first.
// Powers the compact "due for call-back" banner and its dedicated page.
app.get("/api/leads/due", async (req, res) => {
  try {
    const { sheets, sheetId } = await getSheetsContextForRequest(req);

    const loaded = await loadSheetRows(sheets, sheetId);
    const headers = loaded.headers;
    // Demo mode: same partitioning as GET /api/leads, so the due-for-
    // callback list matches whichever demo sheet is currently active. Row
    // numbers are computed BEFORE partitioning (same reason as GET
    // /api/leads: partitioning reshuffles/subsets rows, so their real sheet
    // position has to be captured first) - demo mode never has a real one
    // anyway (there's no real sheet row to point at), same as GET /api/leads.
    const demoMode = isDemoRequest(req);
    const rowsWithNumbers = loaded.dataRows.map((row, index) => ({ row, rowNumber: index + 2 }));
    const dataRows = demoMode ? partitionDemoRows(rowsWithNumbers, getDemoActiveSheetId(req)) : rowsWithNumbers;

    const nameCol = getColumnIndex(headers, "name");
    const phoneCol = getColumnIndex(headers, "phone");
    const temperatureCol = getColumnIndex(headers, "temperature");
    const lastCalledCol = getColumnIndex(headers, "lastCalled");
    const callBackOnCol = getColumnIndex(headers, "callBackOn");
    const firstConnectedCol = getColumnIndex(headers, "firstConnected");

    const dueLeads = [];

    for (const { row, rowNumber } of dataRows) {
      const name = row[nameCol] || "";
      const phone = row[phoneCol] || "";
      if (!name && !phone) continue; // skip blank rows

      const temperatureValue = parseTemperatureValue(row[temperatureCol]);
      const due = computeCallbackDue(
        temperatureValue,
        row[lastCalledCol] || "",
        row[callBackOnCol] || "",
        row[firstConnectedCol] || ""
      );

      if (due) {
        dueLeads.push({
          name,
          phone,
          temperatureValue,
          reason: due.reason,
          overdueDays: due.overdueDays,
          // Lets the frontend open this exact row's detail panel without
          // re-deriving it from the phone number later - see GET
          // /api/leads/:phone's ?rowNumber= param.
          rowNumber: demoMode ? null : rowNumber,
        });
      }
    }

    dueLeads.sort((a, b) => b.overdueDays - a.overdueDays); // most overdue first

    res.json(dueLeads);
  } catch (error) {
    handleSheetsError(res, error);
  }
});

// GET /api/leads/:phone: returns EVERY field SHEET_CONFIG knows about for one
// lead (used by the frontend's lead detail side panel). Looping over
// SHEET_CONFIG.columns like this - instead of listing field names by hand -
// means this endpoint never needs updating if a column is added later.
//
// Optional ?rowNumber= query param: the specific sheet row the CALLER
// already resolved this phone number to (e.g. the exact row the rep clicked
// in the table) - see findLeadRow()'s preferredRowNumber. This is what lets
// the panel open the RIGHT lead even when two leads share a phone number,
// instead of hitting the ambiguous-refuse fallback below. Omit it (any path
// with no row context - a bare phone-number deep link, etc.) and this falls
// back to the same refuse-and-flag behaviour as every other read/write here.
app.get("/api/leads/:phone", async (req, res) => {
  try {
    const { sheets, sheetId } = await getSheetsContextForRequest(req);

    const preferredRowNumber = req.query.rowNumber ? parseInt(req.query.rowNumber, 10) : undefined;
    const lead = await findLeadRow(sheets, req.params.phone, sheetId, preferredRowNumber);
    if (respondIfLeadUnresolved(res, lead)) return;

    const { headers, row, rowNumber } = lead;

    const details = {};
    for (const fieldName of Object.keys(SHEET_CONFIG.columns)) {
      const col = getColumnIndex(headers, fieldName);
      details[fieldName] = row[col] || "";
    }

    // A couple of values the panel needs are stored as formatted text (e.g.
    // Temperature is "5 (Hot)", AI Notes is one big labelled text block) -
    // we already own that format (see buildAiNotesBlock below), so we parse
    // it back out here instead of making the frontend re-implement that.
    details.temperatureValue = parseTemperatureValue(details.temperature);
    details.aiNotesParsed = parseAiNotesBlock(details.aiNotes);
    // The row this actually resolved to - not necessarily rowNumber above's
    // preferredRowNumber verbatim (findLeadRow re-validates it before
    // trusting it, and demo mode never has a real row number at all).
    details.rowNumber = isDemoRequest(req) ? null : rowNumber;

    res.json(details);
  } catch (error) {
    handleSheetsError(res, error);
  }
});

// POST /api/leads/:phone/stage: writes ONLY the "Stage" column. This is the
// one and only place in the whole app that ever writes Stage - it's how the
// side panel's "Accept suggested stage" button applies the AI's suggestion.
// Expects a JSON body like: { "stage": "Interested" }
app.post("/api/leads/:phone/stage", async (req, res) => {
  const { stage } = req.body;
  if (!stage) {
    return res.status(400).json({ error: "Request body must include a 'stage'." });
  }

  // DEMO MODE: fake success, never write to any sheet. The frontend updates
  // its own on-screen copy of the stage from this response either way, so
  // the UI still reacts normally - it just doesn't persist anywhere.
  if (isDemoRequest(req)) {
    return res.json({ success: true });
  }

  try {
    const { sheets, sheetId } = await getSheetsContextForRequest(req);

    const lead = await findLeadRow(sheets, req.params.phone, sheetId);
    if (respondIfLeadUnresolved(res, lead)) return;

    const { headers, rowNumber } = lead;
    const stageCol = getColumnIndex(headers, "stage");

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${columnIndexToLetter(stageCol)}${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[stage]] },
    });

    res.json({ success: true });
  } catch (error) {
    handleSheetsError(res, error);
  }
});

// POST /api/leads/:phone/notes: writes ONLY the (human) "Notes" column - the
// rep's own notes, kept separate from the AI-generated "AI Notes" column.
// Expects a JSON body like: { "notes": "Called back, wants a demo Friday" }
app.post("/api/leads/:phone/notes", async (req, res) => {
  const { notes } = req.body;
  if (notes === undefined) {
    return res.status(400).json({ error: "Request body must include 'notes'." });
  }

  // DEMO MODE: fake success, never write to any sheet.
  if (isDemoRequest(req)) {
    return res.json({ success: true });
  }

  try {
    const { sheets, sheetId } = await getSheetsContextForRequest(req);

    const lead = await findLeadRow(sheets, req.params.phone, sheetId);
    if (respondIfLeadUnresolved(res, lead)) return;

    const { headers, rowNumber } = lead;
    const notesCol = getColumnIndex(headers, "notes");

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${columnIndexToLetter(notesCol)}${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[notes]] },
    });

    res.json({ success: true });
  } catch (error) {
    handleSheetsError(res, error);
  }
});

// POST /api/leads/:phone/callback: writes ONLY the "Call Back On" column -
// the ONE place that sets (or clears) a lead's manual call-back reminder.
// Expects a JSON body like: { "callBackOn": "2026-07-15T14:30" } (the value
// straight from the browser's <input type="datetime-local">), or
// { "callBackOn": "" } to clear a previously-set call-back time.
app.post("/api/leads/:phone/callback", async (req, res) => {
  const { callBackOn } = req.body;
  if (callBackOn === undefined) {
    return res.status(400).json({ error: "Request body must include 'callBackOn' (use '' to clear it)." });
  }

  // DEMO MODE: fake success, never write to any sheet. Still echoes back the
  // formatted value (same formatting the real endpoint would store) so the
  // panel can show it was "saved".
  if (isDemoRequest(req)) {
    const valueToStore = callBackOn ? new Date(callBackOn).toLocaleString() : "";
    return res.json({ success: true, callBackOn: valueToStore });
  }

  try {
    const { sheets, sheetId } = await getSheetsContextForRequest(req);

    const lead = await findLeadRow(sheets, req.params.phone, sheetId);
    if (respondIfLeadUnresolved(res, lead)) return;

    const { headers, rowNumber } = lead;
    const callBackOnCol = getColumnIndex(headers, "callBackOn");

    // Store it the same friendly locale-formatted way as Last called / First
    // connected, so it reads nicely if you open the sheet directly. An empty
    // string clears it. new Date(callBackOn).toLocaleString() round-trips
    // fine back through new Date() when we later read it for the due check.
    const valueToStore = callBackOn ? new Date(callBackOn).toLocaleString() : "";

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${columnIndexToLetter(callBackOnCol)}${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[valueToStore]] },
    });

    res.json({ success: true, callBackOn: valueToStore });
  } catch (error) {
    handleSheetsError(res, error);
  }
});

// POST /api/leads/:phone/draft-sms: asks the AI to draft a short follow-up
// SMS for this lead, based on their most recent call's transcript (still
// held in memory in callTranscripts - see further down this file) and the
// "AI Notes" summary already written to the sheet for that call. Does NOT
// send anything or touch the sheet - just returns the draft text for the
// rep to review/edit in the panel before sending.
app.post("/api/leads/:phone/draft-sms", async (req, res) => {
  // DEMO MODE: return a canned draft instead of calling Gemini - skips the
  // transcript check below entirely, since demo calls are simulated and
  // never produce a real transcript to draft from.
  if (isDemoRequest(req)) {
    try {
      const { sheets, sheetId } = await getSheetsContextForRequest(req);
      const lead = await findLeadRow(sheets, req.params.phone, sheetId);
      // Ambiguous is treated the same as not-found here - no real name to
      // draft with either way, so just fall back to the generic "there".
      const usableLead = lead && !lead.ambiguous ? lead : null;
      const nameCol = usableLead ? getColumnIndex(usableLead.headers, "name") : -1;
      const leadName = usableLead ? usableLead.row[nameCol] || "there" : "there";
      return res.json({
        draft: `Hi ${leadName}, great speaking with you today! I'll send over the details we discussed - let me know if any questions come up before then.`,
      });
    } catch (error) {
      return res.json({ draft: "Hi, great speaking with you today! I'll send over the details we discussed - let me know if any questions come up." });
    }
  }

  // Real signed-in users only past this point - this calls Gemini for real,
  // at our cost, so it must never run for an unauthenticated or non-
  // approved caller. Checked up front, before even looking for a
  // transcript, so an unapproved user gets the same clear pilot-blocked
  // reason every other paid endpoint gives, not a confusing 404.
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in." });
  }
  if (blockIfNoPaidAccess(res, user.email)) return;

  const normalizedPhone = normalizePhoneNumber(req.params.phone);
  const transcriptLines = callTranscripts.get(normalizedPhone);

  if (!transcriptLines || transcriptLines.length === 0) {
    return res.status(404).json({
      error: "No call transcript available for this lead yet - place a call first (or the server may have restarted since the last one).",
    });
  }

  try {
    const { sheets, sheetId } = await getSheetsContextForRequest(req);
    const lead = await findLeadRow(sheets, req.params.phone, sheetId);
    if (respondIfLeadUnresolved(res, lead)) return;

    const nameCol = getColumnIndex(lead.headers, "name");
    const aiNotesCol = getColumnIndex(lead.headers, "aiNotes");
    const leadName = lead.row[nameCol] || "";
    const aiNotes = lead.row[aiNotesCol] || "";

    const transcriptText = transcriptLinesToText(transcriptLines);
    const sellerContext = buildSellerContextString(user);
    const draft = await generateFollowUpSms(leadName, transcriptText, aiNotes, sellerContext);

    if (!draft) {
      // AI failed even after retries (e.g. rate-limited/quota) - the rep can
      // still write their own message in the panel and send that instead.
      return res.status(502).json({ error: "AI couldn't draft a message right now - you can still write your own and send it." });
    }

    res.json({ draft });
  } catch (error) {
    handleSheetsError(res, error);
  }
});

// Appends one line to the (human) "Notes" column recording that an SMS was
// sent, and when - so there's always a record of what went out, without
// needing a whole new sheet column. Clearly marked with a "[SMS sent ...]"
// prefix so it's easy to tell apart from the rep's own typed notes.
async function appendSmsLogToNotes(sheets, sheetId, phone, message) {
  const lead = await findLeadRow(sheets, phone, sheetId);
  if (!lead) {
    console.error("No lead found in the sheet to log the sent SMS against, phone:", phone);
    return;
  }
  if (lead.ambiguous) {
    console.error("Multiple leads share this phone number - can't log the sent SMS unambiguously, phone:", phone);
    await flagAmbiguousPhoneRows(sheets, sheetId, lead.matchedRowNumbers, lead.headers);
    return;
  }

  const { headers, row, rowNumber } = lead;
  const notesCol = getColumnIndex(headers, "notes");

  const existingNotes = row[notesCol] || "";
  const logLine = `[SMS sent ${new Date().toLocaleString()}] ${message}`;
  const updatedNotes = existingNotes ? `${existingNotes}\n${logLine}` : logLine;

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${columnIndexToLetter(notesCol)}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[updatedNotes]] },
  });
}

// POST /api/leads/:phone/send-sms: sends the given message to this lead via
// the swappable SMS abstraction (see sms/index.js), then logs it to Notes.
// Expects a JSON body like: { "message": "Hi John, great speaking today..." }
app.post("/api/leads/:phone/send-sms", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Request body must include a 'message'." });
  }

  // DEMO MODE: fake success - never calls Twilio, never writes to any sheet.
  if (isDemoRequest(req)) {
    return res.json({ success: true });
  }

  // Real signed-in users only past this point - this sends a REAL text
  // message (attacker-controlled destination + content, straight from the
  // request) via Twilio at our cost, so it must never run for an
  // unauthenticated caller, not just a non-demo one.
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in." });
  }
  if (blockIfNoPaidAccess(res, user.email)) return;

  // req.params.phone is straight from the sheet - toE164() makes sure
  // Twilio gets a properly formatted number regardless of how it's stored
  // (see the comment on toE164() above for why the sheet itself never
  // needs a leading "+"). null means it couldn't make sense of this one -
  // surface the same clear reason /voice gives for calls, instead of
  // handing Twilio a malformed number and getting back an opaque error.
  const smsTarget = toE164(req.params.phone);
  if (!smsTarget) {
    return res.status(400).json({ error: UNRECOGNIZED_PHONE_MESSAGE });
  }

  try {
    await sendSms(smsTarget, message);
  } catch (error) {
    console.error("Failed to send SMS:", error.message);
    return res.status(500).json({ error: "Failed to send SMS: " + error.message });
  }

  // The SMS itself already went out successfully at this point - don't fail
  // the whole request just because the logging step had a problem. The rep
  // still needs to know the text actually sent. Uses getSheetsContextForUser
  // directly (not getSheetsContextForRequest) since we already resolved and
  // validated `user` above - no need to look the session up a second time.
  try {
    const { sheets, sheetId } = await getSheetsContextForUser(user);
    await appendSmsLogToNotes(sheets, sheetId, req.params.phone, message);
  } catch (error) {
    console.error("SMS sent, but failed to log it to Notes:", error.message);
  }

  res.json({ success: true });
});

// Twilio client, authenticated using the credentials from .env
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Verifying requests actually came from Twilio ─────────────────────────
// /voice and /call-status below are public URLs (Twilio has to be able to
// reach them from the internet) that TRIGGER real actions - dialing a
// number, and writing a signed-in user's sheet. Without checking who's
// really calling them, anyone who found these URLs could forge a fake
// "call finished" event (e.g. with a different callerEmail) and write to
// someone else's sheet, or trigger other unwanted behaviour.
//
// Twilio signs every request it sends us with an X-Twilio-Signature header,
// computed from OUR auth token, the exact URL it was told to call, and the
// request's own params - so only Twilio (who also knows our auth token) can
// produce a signature that matches. This checks that signature and rejects
// anything that doesn't match, for every route it's attached to.
//
// The URL has to be reconstructed as EXACTLY what we gave Twilio (this is
// why we always use PUBLIC_BASE_URL, never req.protocol/req.get("host") -
// those can be rewritten by a proxy in front of the app, e.g. on Render,
// and would make a genuine request's signature look invalid).
function validateTwilioRequest(req, res, next) {
  const signature = req.headers["x-twilio-signature"];
  const url = `${process.env.PUBLIC_BASE_URL}${req.originalUrl}`;

  const isValid = twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body);

  if (!isValid) {
    console.error(`Rejected a request to ${req.originalUrl} - missing or invalid X-Twilio-Signature.`);
    return res.status(403).send("Invalid Twilio signature.");
  }

  next();
}

// The public URL Twilio can reach us at (via ngrok locally, or your Render
// URL in production). Twilio needs this because it calls OUR server from
// THEIR servers, not from your browser - and validateTwilioRequest above
// needs it to be exactly right, too.
const CALL_STATUS_CALLBACK_URL = `${process.env.PUBLIC_BASE_URL}/call-status`;

// The WebSocket URL Twilio will stream live call audio to. Media Streams use
// "wss://" (secure WebSocket), so we swap that in for the "https://" from .env.
const MEDIA_STREAM_URL = `${process.env.PUBLIC_BASE_URL.replace(/^https:\/\//, "wss://")}/media-stream`;

// Deepgram client, authenticated using the API key from .env. This is used
// below to open a live transcription connection for each call.
const deepgramClient = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });

// ── Figuring out which track is the Rep and which is the Lead ──────────
//
// You'd expect Twilio's "inbound" / "outbound" track names to always mean
// the same speaker, but in testing they didn't - the same call setup
// (browser -> /voice -> <Start><Stream> -> <Dial><Number>) produced
// "inbound = rep" on some calls and "inbound = lead" on others. Twilio's own
// docs define inbound/outbound only as "audio Twilio received" vs "audio
// Twilio sent" on this leg - that's a plumbing detail, not a promise about
// which human is on which side, so a fixed inbound->Rep mapping can never
// be reliable.
//
// Instead of guessing, we work it out fresh for every call using one fact
// that's always true for how we place calls: the rep's microphone is live
// from the moment the call starts, but the lead's line is completely silent
// until Twilio finishes dialing them and they pick up. So: whichever track
// produces the FIRST real piece of speech is the rep - every time, no
// matter what Twilio happened to label it. See assignSpeakerLabels() below.

// Turns a Twilio call's final status into the human-readable value we store
// in the "Last outcome" column. Twilio doesn't have a single "invalid number"
// status - a bad number usually shows up as "failed" with a SIP response code
// like 404, so we check that too.
function mapCallStatusToOutcome(callStatus, sipResponseCode) {
  if (callStatus === "completed") return "Connected";
  if (callStatus === "no-answer") return "No answer";
  if (callStatus === "busy") return "Busy";

  if (callStatus === "failed") {
    if (sipResponseCode === "404" || sipResponseCode === "484") {
      return "Invalid number";
    }
    return "Switched off / unreachable";
  }

  return "Failed"; // fallback for anything else (e.g. "canceled")
}

// Keeps only the digits from a phone number, so "+91 90000-00000" and
// "919000000000" are recognized as the same number when matching rows.
function normalizePhoneNumber(phone) {
  return (phone || "").replace(/\D/g, "");
}

// Turns a lead's phone number - straight from the sheet, in WHATEVER format
// it's stored in ("91 98765 43210", "+91 98765 43210", "919876543210",
// "9876543210", "09876543210", ...) - into the E.164 format
// ("+919876543210") Twilio actually requires to dial or text it correctly.
// The sheet itself deliberately never NEEDS a leading "+" (that's what
// triggers Sheets' formula-parsing bug - see the onboarding empty state's
// guidance), so this is the one place that adds it back, right before the
// number is ever handed to Twilio.
//
// INDIA-ONLY for this pilot: reps type Indian numbers in a handful of
// predictable shapes, and this fills in the +91 country code by GUESSING
// from digit count alone - a bare 10-digit number is assumed to be an
// Indian mobile because that's overwhelmingly the common case for this
// pilot, not because it's actually knowable from the digits themselves. If
// this app ever needs to support non-Indian leads, this whole function
// needs revisiting (10 digits stops being a safe "must be Indian" signal
// the moment a US/UK/etc number can show up in the same sheet).
//
// Returns null if the digits don't match any recognized shape, INSTEAD of
// guessing or returning a malformed number - every caller must check for
// null and surface a clear reason to the rep rather than silently handing
// Twilio something it will just reject (see /voice and
// POST /api/leads/:phone/send-sms for how each does that).
function toE164(phone) {
  const digits = normalizePhoneNumber(phone);

  if (digits.length === 10) {
    // Bare 10-digit number, no country code - by far the most common shape
    // reps will type. Assume Indian mobile.
    return "+91" + digits;
  }

  if (digits.length === 11 && digits.startsWith("0")) {
    // Domestic trunk-prefix format (e.g. "09876543210") - the leading 0
    // isn't part of the number itself, it's dropped, then the country code
    // takes its place.
    return "+91" + digits.slice(1);
  }

  if (digits.length === 12 && digits.startsWith("91")) {
    // Already has the country code - whether it was typed as "91..." or
    // "+91..." (normalizePhoneNumber above already stripped any "+"), this
    // is the same 12-digit shape either way. Used as-is - NOT prepending a
    // second "91" on top of it.
    return "+" + digits;
  }

  // Wrong length, or a shape we don't recognize (a non-Indian number, a
  // typo, garbage data) - don't guess.
  return null;
}

// Shown to the rep when a lead's phone number isn't blank, but toE164()
// couldn't make sense of it - a wrong digit count, or a shape it doesn't
// recognize. Deliberately explains WHAT to check instead of just saying
// "invalid" - see toE164()'s own comment for exactly which shapes it
// accepts today. Shared by /voice (calls) and POST /api/leads/:phone/send-
// sms (follow-up texts) - the same gap in toE164() affects both.
const UNRECOGNIZED_PHONE_MESSAGE =
  "This number doesn't look right - check it's a 10-digit Indian mobile or includes a full country code.";

// Finds a lead's row by phone number. Returns:
//   - null                                     if no row matches
//   - { headers, row, rowNumber }               if exactly one row matches
//     (or preferredRowNumber resolved directly - see below)
//   - { ambiguous: true, matchedRowNumbers, headers }   if 2+ rows share
//     this phone number and we don't already know which one is meant -
//     every caller MUST check for `.ambiguous` before using `.row`/
//     `.rowNumber`, which won't exist on this shape. See each call site
//     for how it responds - the ones on the manual call path resolve this
//     BEFORE it ever gets here (see preferredRowNumber below); everywhere
//     else (notes/stage/callback/SMS/regenerate-insights - "background"
//     actions with no picker involved) treats it as "can't safely act,
//     tell the rep to make phone numbers unique" instead of guessing.
//
// preferredRowNumber (optional): when the caller ALREADY knows exactly
// which row this is for - the rep picked a specific lead from the "which
// lead?" duplicate-phone picker, or there was only ever one match when the
// call started (see startRealCall() in shared-lead-panel.js and
// /call-status below, which is what actually passes this through) - we use
// that row DIRECTLY instead of re-scanning the whole sheet by phone. This
// is what makes the picker's choice unambiguous even though OTHER rows
// still share that same phone number. Still RE-VALIDATED against the
// current sheet (not blindly trusted) in case the row was edited/deleted
// out from under us since the call started - if its phone no longer
// matches, we fall through to the normal full search below rather than
// silently writing to a row that's no longer the right one.
async function findLeadRow(sheets, phone, sheetId, preferredRowNumber) {
  const { headers, dataRows } = await loadSheetRows(sheets, sheetId);
  const phoneCol = getColumnIndex(headers, "phone");
  const nameCol = getColumnIndex(headers, "name");
  const targetPhone = normalizePhoneNumber(phone);

  console.log(
    `[findLeadRow] Looking for phone raw="${phone}" normalized="${targetPhone}"` +
      (preferredRowNumber ? ` (preferred row ${preferredRowNumber})` : "")
  );

  if (preferredRowNumber) {
    const preferredRow = dataRows[preferredRowNumber - 2];
    if (preferredRow && normalizePhoneNumber(preferredRow[phoneCol]) === targetPhone) {
      console.log(`[findLeadRow] Preferred row ${preferredRowNumber} still matches - using it directly, no full search needed.`);
      return { headers, row: preferredRow, rowNumber: preferredRowNumber };
    }
    console.log(`[findLeadRow] Preferred row ${preferredRowNumber} no longer matches this phone - falling back to a full search.`);
  }

  const matchedRowNumbers = [];
  let firstMatchIndex = -1;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rawRowPhone = row[phoneCol];
    const normalizedRowPhone = normalizePhoneNumber(rawRowPhone);
    const isMatch = normalizedRowPhone === targetPhone;

    console.log(
      `[findLeadRow]   row ${i} (sheet row ${i + 2}) name="${row[nameCol]}" ` +
        `phone raw="${rawRowPhone}" normalized="${normalizedRowPhone}" -> ${isMatch ? "MATCH" : "no match"}`
    );

    if (isMatch) {
      matchedRowNumbers.push(i + 2);
      if (firstMatchIndex === -1) firstMatchIndex = i;
    }
  }

  if (matchedRowNumbers.length === 0) {
    console.log(`[findLeadRow] No row matched phone "${targetPhone}" - returning null.`);
    return null;
  }

  if (matchedRowNumbers.length > 1) {
    console.log(
      `[findLeadRow] AMBIGUOUS: ${matchedRowNumbers.length} rows share phone "${targetPhone}" - rows ${matchedRowNumbers.join(", ")}. Refusing to guess.`
    );
    return { ambiguous: true, matchedRowNumbers, headers };
  }

  const matchedRow = dataRows[firstMatchIndex];
  console.log(
    `[findLeadRow] Decided on row ${firstMatchIndex} (sheet row ${firstMatchIndex + 2}): ` +
      `name="${matchedRow[nameCol]}" phone="${matchedRow[phoneCol]}" (the only match)`
  );

  return {
    headers,
    row: matchedRow,
    rowNumber: firstMatchIndex + 2, // +1 for the header row, +1 to be 1-indexed
  };
}

// Shared by every plain REST route below that reads/writes ONE lead by
// phone with no picker context involved (notes, stage, callback time,
// draft-sms, opening the detail panel) - these aren't part of the call
// flow itself, so there's no resolved row number to fall back on the way
// /call-status has. Sends the appropriate error response for findLeadRow()
// returning null (not found) or `.ambiguous` (multiple leads share this
// phone number), and returns true - the caller should just `return` right
// after. Returns false if `lead` is a normal, usable result.
function respondIfLeadUnresolved(res, lead) {
  if (!lead) {
    res.status(404).json({ error: "Lead not found." });
    return true;
  }
  if (lead.ambiguous) {
    res.status(409).json({
      error: "Multiple leads share this phone number, so this can't be uniquely identified. Open your sheet and make phone numbers unique.",
    });
    return true;
  }
  return false;
}

// PILOT gate (see pilotAccess.js - temporary, until this app has a real
// paywall/rate-limiting model). Shared by every endpoint below that spends
// real money (Twilio, Deepgram, Gemini) - call this ONLY after already
// confirming `email` belongs to a genuinely signed-in user (demo mode never
// reaches these endpoints at all - see each call site's own demo check).
// Same shape as respondIfLeadUnresolved above: sends the 403 itself and
// returns true, so callers just `if (blockIfNoPaidAccess(res, user.email)) return;`.
function blockIfNoPaidAccess(res, email) {
  if (canUsePaidFeatures(email)) return false;
  res.status(403).json({ error: getPilotBlockedMessage() });
  return true;
}

// Writes a plain, visible warning into every row that shares an ambiguous
// phone number - the rep needs to see this on THEIR OWN sheet, not just in
// a server log they'll never check. Reuses the AI Notes cell (same spot
// writeAiInsightsFailurePlaceholder() uses for a failed AI attempt) since
// that's the one place a rep already looks for "why don't I have notes for
// this call" - but deliberately leaves Temperature untouched (unlike that
// placeholder), so we're never destroying a real temperature a PREVIOUS,
// unambiguous call already set, just because a later call couldn't be
// resolved.
async function flagAmbiguousPhoneRows(sheets, sheetId, matchedRowNumbers, headers) {
  const aiNotesCol = getColumnIndex(headers, "aiNotes");
  const warningText =
    "⚠️ Multiple leads share this phone number — this call's notes/outcome weren't auto-recorded. Open your sheet and make phone numbers unique to fix.";

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: matchedRowNumbers.map((rowNumber) => ({
        range: `${columnIndexToLetter(aiNotesCol)}${rowNumber}`,
        values: [[warningText]],
      })),
    },
  });
}

// After a call finishes, updates that lead's row:
// - Last outcome always gets overwritten with the latest result.
// - Attempts always goes up by 1.
// - Last called is always set to right now.
// - First Connected is only ever set ONCE, the first time outcome is
//   "Connected" - it is never overwritten after that.
// - Stage and Notes are never touched.
//
// preferredRowNumber (optional): the rep already resolved which lead this
// call was for - via the "which lead?" duplicate-phone picker, or there
// was only ever one match to begin with - see /call-status below, which
// threads leadRowNumber through to here. Passed straight to findLeadRow().
//
// Returns { callNumber, rowNumber } (rowNumber gets threaded on to the AI-
// insights-writing step right after this, so it operates on the EXACT SAME
// row - never re-derives independently and can never diverge from this
// write). Returns null if the lead couldn't be resolved at all: either not
// found, OR still ambiguous even after checking preferredRowNumber and a
// full fallback search - in the ambiguous case, a plain warning is written
// into every colliding row instead of guessing (see flagAmbiguousPhoneRows
// above), and the REST of this call's sheet-writing (AI insights,
// relationship history) is skipped entirely by the caller, since returning
// null here is the exact same signal /call-status already treats as
// "nothing to do next" for the plain not-found case.
async function updateLeadAfterCall(sheets, sheetId, phone, outcome, preferredRowNumber) {
  const lead = await findLeadRow(sheets, phone, sheetId, preferredRowNumber);

  if (!lead) {
    console.error("No lead found in the sheet for phone:", phone);
    return null;
  }

  if (lead.ambiguous) {
    console.error(
      `Ambiguous phone number for ${phone} - flagging rows ${lead.matchedRowNumbers.join(", ")} instead of guessing which one this call was for.`
    );
    try {
      await flagAmbiguousPhoneRows(sheets, sheetId, lead.matchedRowNumbers, lead.headers);
    } catch (error) {
      console.error("Failed to write the ambiguous-phone-number flag:", error.message);
    }
    return null;
  }

  const { headers, row, rowNumber } = lead;

  // Look up each column's position by header name, using SHEET_CONFIG.
  const lastOutcomeCol = getColumnIndex(headers, "lastOutcome");
  const attemptsCol = getColumnIndex(headers, "attempts");
  const lastCalledCol = getColumnIndex(headers, "lastCalled");
  const firstConnectedCol = getColumnIndex(headers, "firstConnected");

  const newAttempts = (parseInt(row[attemptsCol], 10) || 0) + 1;
  const nowText = new Date().toLocaleString();

  // Each field is written to its own single cell. This way, the columns
  // don't need to sit next to each other - they can be anywhere/any order.
  const updates = [
    { col: lastOutcomeCol, value: outcome },
    { col: attemptsCol, value: newAttempts },
    { col: lastCalledCol, value: nowText },
  ];

  // Only fill in First Connected the very first time - never overwrite it.
  const firstConnectedAlreadySet = (row[firstConnectedCol] || "").trim() !== "";
  if (outcome === "Connected" && !firstConnectedAlreadySet) {
    updates.push({ col: firstConnectedCol, value: nowText });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: updates.map((update) => ({
        range: `${columnIndexToLetter(update.col)}${rowNumber}`,
        values: [[update.value]],
      })),
    },
  });

  return { callNumber: newAttempts, rowNumber };
}

// Where we save the most recent real call's transcript, so it's easy to
// reuse for testing (see POST /api/test-insights and GET /api/last-transcript).
const LAST_TRANSCRIPT_FILE_PATH = path.join(__dirname, "last-transcript.json");

// Turns an array of { speaker, text } lines into the plain "Rep: ...\nLead:
// ..." text block the AI abstraction expects.
function transcriptLinesToText(lines) {
  return lines.map((line) => `${line.speaker}: ${line.text}`).join("\n");
}

// Turns a 0-5 temperature number into its word, per the scale we asked
// Gemini to use: 0-1 = Cold, 2-3 = Warm, 4-5 = Hot.
function temperatureWord(temperature) {
  if (temperature <= 1) return "Cold";
  if (temperature <= 3) return "Warm";
  return "Hot";
}

// Builds the compact, scannable text block we store in the "AI Notes" column.
// The temperature word (Cold/Warm/Hot) is computed here from the number, then
// combined with Gemini's short "headline" verdict on one eye-catch top line -
// this guarantees the word always matches the number, rather than trusting
// Gemini to repeat it consistently.
function buildAiNotesBlock(insights) {
  const tempLabel = `${insights.temperature} (${temperatureWord(insights.temperature)})`;

  return [
    `🌡️ ${tempLabel} — ${insights.headline}`,
    `✅ Positives: ${insights.positives}`,
    `⚠️ Concerns: ${insights.concerns}`,
    `🤝 Agreed: ${insights.commitments}`,
    `👉 Next call: ${insights.nextCall}`,
    `🔍 Research/Prep: ${insights.researchPrep}`,
    `📌 Suggested stage: ${insights.suggestedStage}`,
  ].join("\n");
}

// The "Temperature" column stores formatted text like "5 (Hot)" (see
// writeAiInsightsToSheet below), not a plain number. This pulls the leading
// number back out for the frontend's coloured badge. Returns null if there's
// no leading number yet (e.g. "—", or a lead that's never been called).
function parseTemperatureValue(temperatureText) {
  const match = (temperatureText || "").match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// Reverses buildAiNotesBlock() below: turns the "AI Notes" column's one big
// labelled text block back into its individual parts, so the frontend's side
// panel can show each one separately (bold label, own line) instead of
// re-parsing raw text itself. Any part not found comes back as null - this
// happens for the whole result when aiNotesText doesn't match the expected
// format at all (e.g. it's empty, or it's the failure placeholder text).
function parseAiNotesBlock(aiNotesText) {
  const parsed = {
    headline: null,
    positives: null,
    concerns: null,
    commitments: null,
    nextCall: null,
    researchPrep: null,
    suggestedStage: null,
  };

  if (!aiNotesText) return parsed;

  // Each pattern matches one line buildAiNotesBlock() produces, capturing
  // just the text after its emoji + label.
  const patterns = {
    headline: /^🌡️.*?—\s*(.*)$/,
    positives: /^✅ Positives:\s*(.*)$/,
    concerns: /^⚠️ Concerns:\s*(.*)$/,
    commitments: /^🤝 Agreed:\s*(.*)$/,
    nextCall: /^👉 Next call:\s*(.*)$/,
    researchPrep: /^🔍 Research\/Prep:\s*(.*)$/,
    suggestedStage: /^📌 Suggested stage:\s*(.*)$/,
  };

  for (const line of aiNotesText.split("\n")) {
    for (const [field, pattern] of Object.entries(patterns)) {
      const match = line.match(pattern);
      // Gemini is told never to use markdown (see the EMPHASIS RULE in
      // geminiProvider.js), but strip any "**" it slips in anyway - we do
      // our own bolding of just the label on the frontend, so no stray
      // markdown from the AI's text should ever end up rendered oddly.
      if (match) parsed[field] = match[1].trim().replace(/\*\*/g, "");
    }
  }

  return parsed;
}

// ── Call-back due rules ──────────────────────────────────────────────────
// A lead is "due for a call-back" if EITHER:
// - it has a manually-set "Call Back On" time that has already passed, OR
// - it matches the auto-rule below, based on Temperature + days since Last
//   called (a lead with no temperature yet, or never called, is never
//   auto-flagged - there's nothing to base the rule on).
// These three thresholds are the dials to tune - how many days of silence
// is too many, for each temperature band.
const HOT_CALLBACK_DAYS = 1; // Hot (temperature 4-5): due if >= 1 day since last call
const WARM_CALLBACK_DAYS = 3; // Warm (temperature 2-3): due if >= 3 days since last call
const COLD_CALLBACK_DAYS = 7; // Cold (temperature 0-1): due if >= 7 days since last call

// Picks the right threshold for a lead's temperature. Uses the same 0-1 /
// 2-3 / 4-5 boundaries as temperatureWord() above, so "Hot" always means the
// same thing here as it does on the Temperature badge.
function callbackThresholdDays(temperatureValue) {
  if (temperatureValue >= 4) return HOT_CALLBACK_DAYS;
  if (temperatureValue >= 2) return WARM_CALLBACK_DAYS;
  return COLD_CALLBACK_DAYS;
}

// Works out whether ONE lead is due for a call-back right now, and why.
// Returns null if it's not due. Otherwise returns { reason, overdueDays } -
// a bigger overdueDays means MORE overdue, so callers can sort by it (both
// the manual and auto cases produce a comparable "days past due" number).
//
// Manual takes priority: if a manually-set call-back time has passed, that's
// the reason returned, even when the auto-rule would also have triggered -
// and it's checked on its own, without needing a temperature or Last called
// value too (a lead can have a manual call-back time set before it's ever
// been analyzed by AI).
//
// `firstConnectedText` gates the WHOLE feature: a lead that has never been
// connected (First Connected still blank) can never be due, manual or auto -
// there's no point reminding you to call back someone you've never actually
// reached yet.
function computeCallbackDue(temperatureValue, lastCalledText, callBackOnText, firstConnectedText) {
  if (!firstConnectedText) return null;

  const now = new Date();
  const MS_PER_DAY = 1000 * 60 * 60 * 24;

  // 1. Manual call-back time, if it's set, parses to a real date, and has
  // already passed. Checked entirely on its own - no temperature or Last
  // called value required.
  if (callBackOnText) {
    const callBackDate = new Date(callBackOnText);
    if (!isNaN(callBackDate) && callBackDate <= now) {
      const overdueDays = (now - callBackDate) / MS_PER_DAY;
      return { reason: "Manual call-back time reached", overdueDays };
    }
  }

  // 2. Auto rule - needs BOTH a temperature and a parseable Last called date.
  if (temperatureValue === null || !lastCalledText) return null;

  const lastCalledDate = new Date(lastCalledText);
  if (isNaN(lastCalledDate)) return null;

  const daysSinceLastCalled = (now - lastCalledDate) / MS_PER_DAY;
  const thresholdDays = callbackThresholdDays(temperatureValue);

  if (daysSinceLastCalled >= thresholdDays) {
    const roundedDays = Math.floor(daysSinceLastCalled);
    return {
      reason: `${temperatureWord(temperatureValue)}, ${roundedDays} day${roundedDays === 1 ? "" : "s"} since last call`,
      overdueDays: daysSinceLastCalled - thresholdDays,
    };
  }

  return null; // not due
}

// Shared by writeAiInsightsToSheet and writeAiInsightsFailurePlaceholder
// below: finds the lead's row and writes whatever Temperature/AI Notes
// values it's given into it.
//
// preferredRowNumber (optional): passed all the way down from /call-status,
// where updateLeadAfterCall() already resolved (and validated) exactly
// which row this call was for, moments earlier in the same request - using
// it here means this operates on the EXACT SAME row, not a fresh, possibly-
// different phone-based guess. Still re-validated by findLeadRow() itself
// (not blindly trusted), in case the sheet changed during the Gemini call
// this waits on in between. If it's ever missing/stale AND a fallback scan
// finds the phone is (now) ambiguous, this flags every colliding row the
// same way updateLeadAfterCall() does, rather than silently picking one.
async function writeAiCells(sheets, sheetId, phone, temperatureValue, notesValue, preferredRowNumber) {
  const lead = await findLeadRow(sheets, phone, sheetId, preferredRowNumber);

  if (!lead) {
    console.error("No lead found in the sheet for AI insights, phone:", phone);
    return;
  }

  if (lead.ambiguous) {
    console.error(`Ambiguous phone number for ${phone} while writing AI insights - flagging rows ${lead.matchedRowNumbers.join(", ")} instead of guessing.`);
    try {
      await flagAmbiguousPhoneRows(sheets, sheetId, lead.matchedRowNumbers, lead.headers);
    } catch (error) {
      console.error("Failed to write the ambiguous-phone-number flag:", error.message);
    }
    return;
  }

  const { headers, rowNumber } = lead;
  const temperatureCol = getColumnIndex(headers, "temperature");
  const aiNotesCol = getColumnIndex(headers, "aiNotes");

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: `${columnIndexToLetter(temperatureCol)}${rowNumber}`, values: [[temperatureValue]] },
        { range: `${columnIndexToLetter(aiNotesCol)}${rowNumber}`, values: [[notesValue]] },
      ],
    },
  });
}

// Writes the AI-generated Temperature and AI Notes for a lead.
// Stage is deliberately NOT touched here - suggestedStage is only shown
// inside the notes block for now, not applied automatically.
async function writeAiInsightsToSheet(sheets, sheetId, phone, insights, preferredRowNumber) {
  const temperatureLabel = `${insights.temperature} (${temperatureWord(insights.temperature)})`;
  const notesBlock = buildAiNotesBlock(insights);

  await writeAiCells(sheets, sheetId, phone, temperatureLabel, notesBlock, preferredRowNumber);
  console.log(`AI insights written for ${phone}: Temperature = ${temperatureLabel}`);
}

// Used when AI insights fail even after every retry (see ai/index.js).
// Writes an obvious placeholder instead of leaving the cells looking blank
// or stale, so it's clear this call still needs insights generated - either
// automatically next time, or via POST /api/regenerate-insights.
async function writeAiInsightsFailurePlaceholder(sheets, sheetId, phone, preferredRowNumber) {
  await writeAiCells(sheets, sheetId, phone, "—", "AI insights unavailable — will retry later", preferredRowNumber);
  console.log(`AI insights failed for ${phone} - wrote placeholder to sheet`);
}

// ── Seller context (personalizing the AI prompts) ───────────────────────
// A rep's own 5-question profile (see POST /api/profile and the profile
// panel's "Your sales context" section) - assembled into ONE plain-English
// string every AI prompt builder optionally takes, so Gemini can judge
// fit/relevance instead of reasoning in a vacuum. Any blank field is simply
// omitted; if every field is blank this returns "" (never null), and every
// prompt builder treats "" exactly the same as not being passed a context
// at all - so a user who never fills this in gets IDENTICAL output to
// before this feature existed.
//
// Per-user only for now, deliberately - see the task this shipped with for
// why (team/manager-inherited context is a natural next step, not needed
// for the pilot). Nothing about this shape stops a later
// getSellerContextForTeam(teamId) from reusing buildSellerContextString()
// underneath it.
function buildSellerContextString(user) {
  if (!user) return "";

  const parts = [];
  if (user.sellsWhat) parts.push(`Sells: ${user.sellsWhat}.`);
  if (user.sellsTo) parts.push(`Sells to: ${user.sellsTo}.`);
  if (user.callGoal) parts.push(`Goal on calls: ${user.callGoal}.`);
  if (user.commonObjections) parts.push(`Common objections: ${user.commonObjections}.`);
  if (user.extraContext) parts.push(`Notes: ${user.extraContext}.`);

  return parts.join(" ");
}

// Same as buildSellerContextString(), but starting from just an email - the
// shape most non-HTTP-request call sites actually have on hand (a Twilio
// webhook's callerEmail, a media-stream's custom parameter, ...). Returns
// "" for a missing/unknown email, same as buildSellerContextString does for
// a user with nothing filled in - callers never need to branch on which
// case they hit.
async function getSellerContextForEmail(email) {
  if (!email) return "";
  const user = await getUser(email);
  return buildSellerContextString(user);
}

// Generates AI insights for one finished call and writes them to the sheet.
// Safe to call even if Gemini fails after all its retries - we still write
// a clear placeholder rather than silently leaving the row unchanged, and
// any sheet-writing error is caught here so it never breaks /call-status.
// Returns the insights object (or null if it failed) - the caller uses this
// to update the cross-call "Previous Calls" history, see below. userEmail
// is used ONLY to look up the seller-context profile (see
// getSellerContextForEmail above) - may be null (e.g. /call-status
// couldn't resolve who placed the call), in which case insights just come
// out generic, same as before this feature existed.
async function generateAndSaveInsights(sheets, sheetId, phone, transcriptText, callNumber, preferredRowNumber, userEmail) {
  const sellerContext = await getSellerContextForEmail(userEmail);
  const insights = await generateCallInsights(transcriptText, callNumber, sellerContext);

  try {
    if (insights) {
      await writeAiInsightsToSheet(sheets, sheetId, phone, insights, preferredRowNumber);
    } else {
      await writeAiInsightsFailurePlaceholder(sheets, sheetId, phone, preferredRowNumber);
    }
  } catch (error) {
    console.error("Failed to write AI insights to sheet:", error.message);
  }

  return insights;
}

// ── "Previous Calls" relationship history ───────────────────────────────
// Our leads often take 8-15 calls to close, so the ARC of the relationship
// matters, not just the latest call. This section keeps two things:
// 1. A persisted, per-lead history file (call-history.json) with a compact
//    entry for every call - raw material for this feature and future ones.
// 2. The "Previous Calls" sheet column, an evolving PROSE narrative across
//    every call (separate from "AI Notes", which always stays latest-call-only).

// Where the per-lead call history is persisted in JSON-file mode (local dev
// without DATABASE_URL - see db.js). In database mode this file is never
// touched; rows go in the call_history table instead, scoped by user_email.
const CALL_HISTORY_FILE_PATH = path.join(__dirname, "call-history.json");

// Adds one compact entry to a lead's history. Scoped by userEmail (may be
// null if we couldn't resolve who placed the call - see /call-status - in
// which case it's just recorded without an owner rather than dropped).
//
// Database mode: a plain INSERT - no need to read existing rows first the
// way the JSON file does, since a new row doesn't disturb any other row.
// JSON-file mode: read-modify-write the whole file, same as before.
async function appendCallHistoryEntry(userEmail, phone, entry) {
  const normalizedPhone = normalizePhoneNumber(phone);

  if (db.isDatabaseMode) {
    try {
      await db.query(
        `INSERT INTO call_history (user_email, phone, call_number, "date", temperature, headline, concern, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userEmail, normalizedPhone, entry.callNumber, entry.date, entry.temperature, entry.headline, entry.concern, entry.outcome]
      );
    } catch (error) {
      console.error("Failed to save call history entry to database:", error.message);
    }
    return;
  }

  let history;
  try {
    history = JSON.parse(fs.readFileSync(CALL_HISTORY_FILE_PATH, "utf8"));
  } catch (error) {
    history = {};
  }

  if (!history[normalizedPhone]) {
    history[normalizedPhone] = [];
  }
  history[normalizedPhone].push(entry);

  try {
    fs.writeFileSync(CALL_HISTORY_FILE_PATH, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error("Failed to save call-history.json:", error.message);
  }
}

// After a call's per-call insights are generated, this:
// 1. Saves a compact entry (date, call number, temperature, headline, key
//    objection/outcome) to persistent storage (see appendCallHistoryEntry).
// 2. If this ISN'T the lead's first call, asks the AI to fold this call into
//    an updated "Previous Calls" narrative and writes it to the sheet.
// On the first call (callNumber === 1), "Previous Calls" is left blank, per
// the spec - there's no "relationship" to summarize yet.
// Safe to call even if insights is null (the per-call AI attempt failed) -
// there's nothing worth recording in that case, so this just does nothing.
// preferredRowNumber (optional): same as writeAiCells() above - carried
// through from /call-status's own resolution so this operates on the exact
// same row, not a fresh phone-based guess.
async function updateRelationshipHistory(userEmail, sheets, sheetId, phone, insights, transcriptText, callNumber, preferredRowNumber) {
  if (!insights) return; // per-call AI attempt failed - nothing to record

  await appendCallHistoryEntry(userEmail, phone, {
    callNumber,
    date: new Date().toLocaleString(),
    temperature: insights.temperature,
    headline: insights.headline,
    concern: insights.concerns,
    outcome: insights.suggestedStage,
  });

  if (callNumber <= 1) return; // first call - "Previous Calls" stays blank

  try {
    const lead = await findLeadRow(sheets, phone, sheetId, preferredRowNumber);
    if (!lead) {
      console.error("No lead found in the sheet for relationship summary, phone:", phone);
      return;
    }
    if (lead.ambiguous) {
      // updateLeadAfterCall() already flagged the colliding rows earlier in
      // this same request (that's why we even have a preferredRowNumber to
      // try) - no need to write it again, just skip this lower-stakes field.
      console.error(`Ambiguous phone number for ${phone} while updating relationship history - skipping.`);
      return;
    }

    const previousCallsCol = getColumnIndex(lead.headers, "previousCalls");
    const existingSummary = lead.row[previousCallsCol] || "";

    const sellerContext = await getSellerContextForEmail(userEmail);
    const updatedSummary = await generateRelationshipSummary(existingSummary, transcriptText, callNumber, sellerContext);
    if (!updatedSummary) return; // already logged inside the AI provider

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${columnIndexToLetter(previousCallsCol)}${lead.rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[updatedSummary]] },
    });

    console.log(`Previous Calls summary updated for ${phone} (call ${callNumber})`);
  } catch (error) {
    console.error("Failed to update Previous Calls summary:", error.message);
  }
}

// Builds the TwiML (Twilio Markup Language) that says our test message out loud.
// TwiML is just XML that tells Twilio what to do during a call.
function buildGreetingTwiml() {
  const response = new twilio.twiml.VoiceResponse();
  response.say("Hello! This is a test call from Rhythm. Your setup is working.");
  return response.toString();
}

// Adds ?callerEmail=... onto a callback URL, so /call-status (which Twilio
// calls server-to-server, with no browser session) can still work out
// WHICH signed-in user's sheet this call belongs to. See getSheetsContext-
// ForEmail() above and the /call-status handler below.
// leadRowNumber is OPTIONAL - only /voice's browser-initiated calls have
// one to offer (the rep picked a specific row via the "which lead?" picker,
// or there was only ever one match - see startRealCall() in shared-lead-
// panel.js). placeCall()'s own two callers (/api/call, /api/test-call)
// never pass one - those aren't placed from a lead row at all, so
// /call-status falls back to its normal phone-based lookup for them,
// exactly as it always has.
// rawPhone is ALSO optional, same reasoning as leadRowNumber - only /voice
// has one to offer. Twilio's status callback later echoes back "To", but
// that's whatever toE164() actually DIALED (e.g. "+919819876680"), never
// necessarily what's stored in the sheet or typed by the rep (e.g. the bare
// "9819876680" toE164() built that from) - digit-count changes toE164() can
// make (adding "91", dropping a leading "0") mean plain digit-stripping
// can no longer reconcile the two. rawPhone is what lets /call-status use
// the ORIGINAL phone for every matching/lookup purpose instead - see its
// own comment for the full list of what that fixes.
function withCallerEmail(url, callerEmail, leadRowNumber, rawPhone) {
  const params = new URLSearchParams();
  if (callerEmail) params.set("callerEmail", callerEmail);
  if (leadRowNumber) params.set("leadRowNumber", leadRowNumber);
  if (rawPhone) params.set("rawPhone", rawPhone);
  const query = params.toString();
  return query ? `${url}?${query}` : url;
}

// Places a call to the given phone number and speaks the greeting when answered.
// Returns the Twilio call object (which includes a "sid" - the call's unique ID).
function placeCall(toNumber, callerEmail) {
  return twilioClient.calls.create({
    to: toNumber,
    from: process.env.TWILIO_FROM_NUMBER,
    twiml: buildGreetingTwiml(),
    // Tells Twilio to notify our /call-status endpoint once the call finishes
    statusCallback: withCallerEmail(CALL_STATUS_CALLBACK_URL, callerEmail),
    statusCallbackEvent: ["completed"],
    statusCallbackMethod: "POST",
  });
}

// POST /api/call: places a call to whatever phone number is sent in the request body.
// Expects a JSON body like: { "to": "+15551234567" }
app.post("/api/call", async (req, res) => {
  const { to } = req.body;

  if (!to) {
    return res.status(400).json({ error: "Request body must include a 'to' phone number." });
  }

  // DEMO MODE: never place a real call. The frontend never calls this
  // endpoint in demo mode anyway (see startDemoCall() in the frontend), but
  // this refusal is a backend safety net in case it's ever hit directly.
  if (isDemoRequest(req)) {
    return res.status(403).json({ error: "Calling is disabled in demo mode." });
  }

  // Real signed-in users only past this point - this places a REAL phone
  // call, to whatever number is in the request body, at our cost. Must
  // never run for an unauthenticated caller, not just a non-demo one.
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in." });
  }
  if (blockIfNoPaidAccess(res, user.email)) return;

  try {
    const call = await placeCall(to, user.email);
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    // Twilio errors have a helpful .message - send it back so we can see what went wrong
    console.error("Twilio call failed:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/test-call: a shortcut that calls TEST_TO_NUMBER from .env automatically,
// so you can trigger a test call to your own phone just by visiting this URL.
app.get("/api/test-call", async (req, res) => {
  // DEMO MODE: never place a real call.
  if (isDemoRequest(req)) {
    return res.status(403).json({ error: "Calling is disabled in demo mode." });
  }

  // Real signed-in users only past this point - this is a GET route, so it
  // can be triggered just by visiting a URL (no CSRF token, nothing) - it
  // must never place a real call for an unauthenticated caller.
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in." });
  }
  if (blockIfNoPaidAccess(res, user.email)) return;

  const to = process.env.TEST_TO_NUMBER;

  if (!to) {
    return res.status(400).json({ error: "TEST_TO_NUMBER is not set in .env" });
  }

  try {
    const call = await placeCall(to, user.email);
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error("Twilio test call failed:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/token: creates a short-lived access token that lets the browser
// itself make calls through Twilio, using the "Voice SDK" (WebRTC).
//
// THIS IS THE MAIN GATE THAT KEEPS DEMO MODE - AND ANYONE NOT APPROVED FOR
// THE PILOT - FROM EVER COSTING MONEY: the frontend's demo-mode Call button
// (see startDemoCall() in index.html / callbacks.html) never asks for a
// token in the first place, and refusing to hand one out here means even a
// demo visitor (or an unapproved signed-in user) poking at devtools can't
// get the Twilio Voice SDK to place a real WebRTC call - without a valid
// token, device.connect() has nothing to authenticate with, so it can never
// reach Twilio's servers, which means /voice and /media-stream below (both
// only ever called BY Twilio, for a call that was actually placed) are
// never reachable either. This is why neither of those two needs its OWN
// separate pilot-allowlist check - there's no way to reach them without a
// token from here first.
app.get("/api/token", async (req, res) => {
  if (isDemoRequest(req)) {
    return res.status(403).json({ error: "Calling is disabled in demo mode." });
  }

  // Real signed-in, pilot-approved users only past this point. Note: before
  // this fix, this route had NO sign-in check at all - only the demo-mode
  // refusal above - so anyone who found this URL (signed in or not) could
  // fetch a working Twilio Voice SDK token directly. Fixed here as part of
  // the same pilot-gating pass.
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in." });
  }
  if (blockIfNoPaidAccess(res, user.email)) return;

  try {
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    // A "grant" is a permission slip - this one allows outgoing calls through
    // our TwiML App (which points Twilio at our POST /voice endpoint below).
    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
    });

    // The token identifies the browser as "rhythm_user" and is signed with
    // our API Key SID/Secret so Twilio knows it's really us.
    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY_SID,
      process.env.TWILIO_API_KEY_SECRET,
      { identity: "rhythm_user" }
    );
    token.addGrant(voiceGrant);

    res.json({ token: token.toJwt() });
  } catch (error) {
    console.error("Failed to generate Twilio token:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /voice: Twilio calls this endpoint itself when the browser starts a
// call, asking "what should happen now?". We reply with TwiML that dials
// the phone number the browser asked for, showing our Twilio number as the
// caller ID. validateTwilioRequest (above) rejects anything not genuinely
// signed by Twilio before this handler ever runs.
app.post("/voice", validateTwilioRequest, (req, res) => {
  // Straight from the lead's sheet row, in whatever format it's stored in.
  const rawTo = req.body.To || "";
  // toE164() below is what makes sure Twilio actually dials it correctly
  // regardless of that format - null means it couldn't (see its own
  // comment for why), handled explicitly below instead of ever handing
  // Twilio a malformed number and letting it fail unexplained.
  const to = rawTo ? toE164(rawTo) : "";
  // Set by the browser's device.connect({ params: { To, callerEmail } }) -
  // see attachCallHandlers() in the frontend - so /call-status below (which
  // Twilio calls with no browser session at all) can still work out WHICH
  // signed-in user's sheet this call belongs to.
  const callerEmail = req.body.callerEmail || "";
  // Set ONLY when the rep either picked a specific lead from the "which
  // lead?" duplicate-phone picker, or there was just the one match to
  // begin with - see startRealCall() in shared-lead-panel.js. Empty
  // otherwise (e.g. a call placed some other way), in which case /call-
  // status falls back to its normal phone-based lookup.
  const leadRowNumber = req.body.leadRowNumber || "";
  const response = new twilio.twiml.VoiceResponse();

  if (to) {
    // <Start><Stream> tells Twilio to also send us the call's live audio over
    // a WebSocket, WITHOUT interrupting the actual call - the two people on
    // the call keep talking normally while this streams in the background.
    // track: "both_tracks" makes Twilio send the rep's and lead's audio as
    // two separate, labeled tracks instead of one blended stream.
    const start = response.start();
    const stream = start.stream({ url: MEDIA_STREAM_URL, track: "both_tracks" });

    // Passes the lead's phone number into the media stream as a custom
    // parameter, so /media-stream knows which lead this call's transcript
    // belongs to (it shows up as data.start.customParameters.leadPhone).
    // Deliberately the RAW number (rawTo), not the E.164 dial target (to) -
    // this becomes the callTranscripts key and the broadcast tag the
    // frontend matches against activeCallPhone, which is ALSO the raw
    // number (see startRealCall() in shared-lead-panel.js) - "to" is only
    // ever for the actual Twilio dial below, never for matching.
    stream.parameter({ name: "leadPhone", value: rawTo });

    // Same idea, for the CALLER's email - lets /media-stream look up this
    // rep's seller-context profile (see getSellerContextForEmail() below)
    // to personalize live coaching tips. May be empty (a call placed some
    // other way) - getSellerContextForEmail("") just returns "" too, same
    // as no profile filled in, so coaching simply stays generic.
    stream.parameter({ name: "callerEmail", value: callerEmail });

    const dial = response.dial({ callerId: process.env.TWILIO_FROM_NUMBER });

    // Tells Twilio to notify our /call-status endpoint once this call
    // finishes - with callerEmail, leadRowNumber (if we have one), and
    // rawTo carried through the URL itself, since Twilio's status callback
    // request won't have our session cookie (and its own "To" field will
    // only ever have the E.164 DIALED number, not this original one).
    dial.number(
      {
        statusCallback: withCallerEmail(CALL_STATUS_CALLBACK_URL, callerEmail, leadRowNumber, rawTo),
        statusCallbackEvent: ["completed"],
        statusCallbackMethod: "POST",
      },
      to
    );
  } else if (rawTo) {
    // A number WAS provided, but toE164() couldn't turn it into anything
    // dialable. Rather than let Twilio attempt a malformed number and
    // report back a generic "Invalid number"/SIP failure that doesn't
    // explain WHY, catch it here and tell the rep directly - the SAME way
    // any other call outcome reaches their screen (see broadcastCallOutcome
    // below and pendingCallOutcomeCallback in shared-lead-panel.js), using
    // the raw, un-normalized number so it matches activeCallPhone on the
    // frontend exactly as typed. The call is never dialed at all (no
    // dial.number() above), so /call-status never fires for this - nothing
    // gets logged as a real attempt, no Attempts increment, no Outcome
    // write.
    broadcastCallOutcome(rawTo, UNRECOGNIZED_PHONE_MESSAGE, false);
    response.say(UNRECOGNIZED_PHONE_MESSAGE);
  } else {
    response.say("No destination number was provided.");
  }

  // Twilio expects TwiML back as XML, not JSON
  res.type("text/xml");
  res.send(response.toString());
});

// Stores the transcript lines for each call currently in progress, keyed by
// the lead's (normalized) phone number. /media-stream fills this in as the
// call happens; /call-status below reads it once the call ends.
const callTranscripts = new Map();

// ── Per-call log (the data behind the Analytics dashboard) ──────────────
// call-history.json above is keyed PER LEAD and only gets an entry when the
// AI insights step succeeds - great for the "Previous Calls" narrative, but
// not accurate for analytics (a lead's entry there doesn't reflect every
// call, just the ones that got fully analyzed). This file is different: it's
// one FLAT list, and every single completed call gets exactly one entry
// here, regardless of whether AI insights succeed - see /call-status below.

// Where the per-call log is persisted in JSON-file mode (local dev without
// DATABASE_URL - see db.js). In database mode this file is never touched;
// rows go in the call_log table instead, scoped by user_email - see
// loadCallLog()/appendCallLogEntry() below.
const CALL_LOG_FILE_PATH = path.join(__dirname, "call-log.json");

// The seeded demo call log (see test-tools/seed-demo.js) - static data
// committed to the repo, not real user data, so this ALWAYS reads straight
// from disk regardless of DATABASE_URL - demo mode never touches the
// database at all, in either mode.
const DEMO_CALL_LOG_FILE_PATH = path.join(__dirname, "call-log.demo.json");

function loadDemoCallLog() {
  try {
    return JSON.parse(fs.readFileSync(DEMO_CALL_LOG_FILE_PATH, "utf8"));
  } catch (error) {
    return [];
  }
}

// Reads the REAL call log for one user. Returns [] if there's nothing yet
// (or userEmail is null - see below) or something goes wrong reading it.
//
// Database mode: SELECT scoped to user_email, so each rep only ever sees
// their own calls - previously call-log.json was one shared, unscoped file,
// so every rep's stats were mixed together (the "global-stats problem").
// JSON-file mode: still the single shared file, unscoped - fine for local,
// single-operator development, which is what that mode is for.
async function loadCallLog(userEmail) {
  if (db.isDatabaseMode) {
    // No email to scope by (e.g. an unresolvable /call-status callerEmail) -
    // return nothing rather than guess at "everyone's calls".
    if (!userEmail) return [];

    try {
      const result = await db.query(
        `SELECT "timestamp", phone, name, outcome, connected, duration_seconds, temperature
         FROM call_log WHERE user_email = $1 ORDER BY "timestamp"`,
        [userEmail]
      );
      return result.rows.map((row) => ({
        timestamp: row.timestamp.toISOString(),
        phone: row.phone,
        name: row.name,
        outcome: row.outcome,
        connected: row.connected,
        durationSeconds: row.duration_seconds,
        temperature: row.temperature,
      }));
    } catch (error) {
      console.error("Failed to load call log from database:", error.message);
      return [];
    }
  }

  try {
    return JSON.parse(fs.readFileSync(CALL_LOG_FILE_PATH, "utf8"));
  } catch (error) {
    return [];
  }
}

// Resolves "the call log this request should see" - demo mode's seeded
// file, or the signed-in user's own real calls. Used by /api/analytics,
// /api/analytics/drilldown, and /api/profile so none of them need to
// re-implement the demo-vs-real, database-vs-file branching themselves.
async function getCallLogForRequest(req) {
  if (isDemoRequest(req)) return loadDemoCallLog();

  const user = await getCurrentUser(req);
  return loadCallLog(user ? user.email : null);
}

// Adds one call record to the log. entry.userEmail scopes it to whichever
// rep placed the call (see /call-status) - may be null if we couldn't
// resolve who that was, in which case it's still logged, just unowned (and
// won't show up in anyone's per-user stats in database mode).
async function appendCallLogEntry(entry) {
  if (db.isDatabaseMode) {
    try {
      await db.query(
        `INSERT INTO call_log (user_email, "timestamp", phone, name, outcome, connected, duration_seconds, temperature)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [entry.userEmail || null, entry.timestamp, entry.phone, entry.name, entry.outcome, entry.connected, entry.durationSeconds, entry.temperature]
      );
    } catch (error) {
      console.error("Failed to save call log entry to database:", error.message);
    }
    return;
  }

  let log;
  try {
    log = JSON.parse(fs.readFileSync(CALL_LOG_FILE_PATH, "utf8"));
  } catch (error) {
    log = [];
  }
  log.push(entry);

  try {
    fs.writeFileSync(CALL_LOG_FILE_PATH, JSON.stringify(log, null, 2));
  } catch (error) {
    console.error("Failed to save call-log.json:", error.message);
  }
}

// Looks up a lead's current name and temperature (as a plain 0-5 number, or
// null if it hasn't been set yet). Used to record what the lead's
// temperature was BEFORE this call - i.e. what we believed about them going
// in, not what this call's own (not-yet-generated) insights might say.
// preferredRowNumber (optional): same as writeAiCells() above.
async function getLeadNameAndTemperature(sheets, sheetId, phone, preferredRowNumber) {
  const lead = await findLeadRow(sheets, phone, sheetId, preferredRowNumber);
  // Ambiguous is treated the same as not-found here - this is only used
  // for the call-log's informational fields, not a write, so there's
  // nothing to flag; updateLeadAfterCall() (called moments later in the
  // same request) is what actually flags an ambiguous phone number.
  if (!lead || lead.ambiguous) return { name: "", temperatureValue: null };

  const nameCol = getColumnIndex(lead.headers, "name");
  const temperatureCol = getColumnIndex(lead.headers, "temperature");

  return {
    name: lead.row[nameCol] || "",
    temperatureValue: parseTemperatureValue(lead.row[temperatureCol]),
  };
}

// ── Analytics ────────────────────────────────────────────────────────────
// Turns the per-call log into the numbers the Analytics dashboard needs.
// Every FILTER (date range, time-of-day range) is applied ONCE up front (see
// filterCallLog), then every metric is computed from that same filtered
// list - so the metrics, the pie chart, and the breakdowns on the dashboard
// always agree with each other and with whatever filter is currently picked.

// Same 0-1 / 2-3 / 4-5 boundaries used everywhere else in the app
// (Temperature badge, call-back auto-rule) - keeps the pie chart's bands
// consistent with what the rest of the app calls "Hot"/"Warm"/"Cold".
function temperatureBand(temperatureValue) {
  if (temperatureValue === null || temperatureValue === undefined) return "unknown";
  if (temperatureValue >= 4) return "hot";
  if (temperatureValue >= 2) return "warm";
  return "cold";
}

// Keeps only the calls inside the requested date range and time-of-day
// range. Any filter left null/undefined is simply not applied. Hours are
// compared using the SERVER's local time (matching how the rest of the app
// already displays times), so "2pm-4pm" means the rep's own local afternoon.
function filterCallLog(log, { fromDate, toDate, hourFrom, hourTo }) {
  return log.filter((call) => {
    const callDate = new Date(call.timestamp);
    if (isNaN(callDate)) return false; // skip anything unparseable, just in case

    if (fromDate && callDate < fromDate) return false;
    if (toDate && callDate > toDate) return false;

    if (hourFrom !== null && hourTo !== null) {
      const hour = callDate.getHours();
      if (hour < hourFrom || hour > hourTo) return false;
    }

    return true;
  });
}

// Builds the whole analytics response from an already-filtered list of call
// records (see filterCallLog above).
function computeAnalytics(calls) {
  const totalCalls = calls.length;
  const connectedCount = calls.filter((call) => call.connected).length;
  const notConnectedCount = totalCalls - connectedCount;
  const pickupRate = totalCalls > 0 ? connectedCount / totalCalls : 0;

  // How many calls ended in each technical outcome (Connected, No answer,
  // Busy, Invalid number, ...).
  const outcomeBreakdown = {};
  calls.forEach((call) => {
    outcomeBreakdown[call.outcome] = (outcomeBreakdown[call.outcome] || 0) + 1;
  });

  // Hot/Warm/Cold split, using each call's OWN recorded temperature-at-the-
  // time (not the lead's temperature right now) - this is what lets the
  // pie chart respect the date/time filters too.
  const temperatureBreakdown = { hot: 0, warm: 0, cold: 0, unknown: 0 };
  calls.forEach((call) => {
    temperatureBreakdown[temperatureBand(call.temperature)]++;
  });

  // Pick-up rate for each hour of the day (0-23) - only hours that actually
  // have at least one call show up, so the chart doesn't show a misleading
  // flat 0% for hours you've simply never called during.
  const byHour = {};
  calls.forEach((call) => {
    const hour = new Date(call.timestamp).getHours();
    if (!byHour[hour]) byHour[hour] = { total: 0, connected: 0 };
    byHour[hour].total++;
    if (call.connected) byHour[hour].connected++;
  });

  const pickupRateByHour = Object.keys(byHour)
    .map((hour) => ({
      hour: parseInt(hour, 10),
      total: byHour[hour].total,
      connected: byHour[hour].connected,
      rate: byHour[hour].connected / byHour[hour].total,
    }))
    .sort((a, b) => a.hour - b.hour);

  return {
    totalCalls,
    connectedCount,
    notConnectedCount,
    pickupRate,
    outcomeBreakdown,
    temperatureBreakdown,
    pickupRateByHour,
  };
}

// ── Leads view (how many LEADS, not calls, have been reached) ───────────
// The Calls view above counts CALLS. This counts LEADS instead - every
// current lead in the sheet is put into exactly ONE bucket, based on their
// calls within the SAME filtered date/time window as the Calls view, so
// switching the dashboard's toggle never uses a different time range.
//
// leads: [{ name, phone }] - every lead as it exists in the sheet RIGHT NOW.
// filteredCalls: the call log, already narrowed by filterCallLog() above.
//
// Returns four lists (arrays of leads), used both for the Leads view's
// summary counts and for the "drill down to the Leads page" endpoint below:
//   reached          - at least one CONNECTED call in the window
//   neverReached      - at least one call, but never connected, in the window
//   notYetCalled     - zero calls at all in the window
//   notConnectedCalls - at least one not-connected call in the window (this
//                       one is a CALLS-view idea, so it can OVERLAP with
//                       "reached" - e.g. a lead who was missed once then
//                       connected on a later try. It's only used for the
//                       Calls view's "Not-connected calls" drill-down, never
//                       for the Leads view's three mutually-exclusive buckets.
function computeLeadReachBuckets(leads, filteredCalls) {
  // One pass over the calls, grouped by phone (digits-only, so formatting
  // differences between the sheet and the call log - "+91 98..." vs
  // "9198..." - never cause a mismatch) - much faster than re-scanning the
  // whole call log once per lead.
  const callCountsByPhone = new Map();
  filteredCalls.forEach((call) => {
    const key = normalizePhoneNumber(call.phone);
    if (!callCountsByPhone.has(key)) {
      callCountsByPhone.set(key, { connectedCount: 0, notConnectedCount: 0 });
    }
    const counts = callCountsByPhone.get(key);
    if (call.connected) counts.connectedCount++;
    else counts.notConnectedCount++;
  });

  const reached = [];
  const neverReached = [];
  const notYetCalled = [];
  const notConnectedCalls = [];

  leads.forEach((lead) => {
    const counts = callCountsByPhone.get(normalizePhoneNumber(lead.phone));

    if (!counts) {
      notYetCalled.push(lead);
      return;
    }

    if (counts.connectedCount > 0) {
      reached.push(lead);
    } else {
      neverReached.push(lead);
    }

    if (counts.notConnectedCount > 0) {
      notConnectedCalls.push(lead);
    }
  });

  return { reached, neverReached, notYetCalled, notConnectedCalls };
}

// GET /api/analytics: computes call-log-based analytics for the dashboard.
// Optional query params:
//   ?from=2026-07-01&to=2026-07-10   - date range (either end can be omitted)
//   ?hourFrom=14&hourTo=16           - time-of-day range, 0-23, BOTH required
//                                       together (e.g. 14-16 = 2pm-4pm)
app.get("/api/analytics", async (req, res) => {
  try {
    const log = await getCallLogForRequest(req);

    // A plain date-only string like "2026-07-10" parses as UTC midnight if
    // we hand it to `new Date()` as-is, but "...T00:00:00" (no "Z"/offset)
    // parses as LOCAL midnight instead - we want LOCAL here, so both ends of
    // the range are measured the same way (and match how the rest of the
    // app already shows times in local time). "to" uses the END of that day
    // (23:59:59) so it includes every call made ON that day, not just at
    // its very first moment.
    const fromDate = req.query.from ? new Date(req.query.from + "T00:00:00") : null;
    const toDate = req.query.to ? new Date(req.query.to + "T23:59:59") : null;
    const hourFrom = req.query.hourFrom !== undefined ? parseInt(req.query.hourFrom, 10) : null;
    const hourTo = req.query.hourTo !== undefined ? parseInt(req.query.hourTo, 10) : null;

    const filtered = filterCallLog(log, { fromDate, toDate, hourFrom, hourTo });
    const analytics = computeAnalytics(filtered);

    // The call-back pipeline counts are a live SNAPSHOT of the sheet right
    // now, not from the call log - there's no "when" to filter these two by,
    // so the date/time filters above don't apply to them. This is the only
    // sheet-dependent part of this endpoint, so a signed-in user who hasn't
    // onboarded yet still gets their call-log-based numbers, just with
    // these two at 0, rather than the whole dashboard failing.
    let callbacksDueNow = 0;
    let callbacksUpcoming = 0;

    // The Leads-view summary the dashboard's Calls/Leads toggle switches
    // to - see computeLeadReachBuckets() above. Defaults to all-zero if the
    // sheet can't be read (e.g. not onboarded yet), same fallback as
    // callbacksDueNow/Upcoming above - one failure here shouldn't break the
    // whole dashboard.
    let leadsView = { totalLeads: 0, reached: 0, neverReached: 0, notYetCalled: 0, contactRate: 0 };

    try {
      const { sheets, sheetId } = await getSheetsContextForRequest(req);
      const { headers, dataRows } = await loadSheetRows(sheets, sheetId);

      const nameCol = getColumnIndex(headers, "name");
      const phoneCol = getColumnIndex(headers, "phone");
      const temperatureCol = getColumnIndex(headers, "temperature");
      const lastCalledCol = getColumnIndex(headers, "lastCalled");
      const callBackOnCol = getColumnIndex(headers, "callBackOn");
      const firstConnectedCol = getColumnIndex(headers, "firstConnected");
      const now = new Date();

      // Collected here so the SAME loop that already reads every row can
      // also feed the Leads-view buckets below - no second pass over the sheet.
      const currentLeads = [];

      dataRows.forEach((row) => {
        const name = row[nameCol] || "";
        const phone = row[phoneCol] || "";
        if (!name && !phone) return; // skip blank rows

        currentLeads.push({ name, phone });

        const temperatureValue = parseTemperatureValue(row[temperatureCol]);
        const due = computeCallbackDue(
          temperatureValue,
          row[lastCalledCol] || "",
          row[callBackOnCol] || "",
          row[firstConnectedCol] || ""
        );

        if (due) {
          callbacksDueNow++;
          return;
        }

        const callBackOnText = row[callBackOnCol] || "";
        if (callBackOnText) {
          const callBackDate = new Date(callBackOnText);
          if (!isNaN(callBackDate) && callBackDate > now) callbacksUpcoming++;
        }
      });

      // Classify every current lead using the SAME filtered call log as the
      // Calls view above, so toggling the dashboard never changes the time
      // range being looked at.
      const buckets = computeLeadReachBuckets(currentLeads, filtered);
      const reachedCount = buckets.reached.length;
      const neverReachedCount = buckets.neverReached.length;
      const attemptedCount = reachedCount + neverReachedCount; // leads actually called at least once

      leadsView = {
        totalLeads: currentLeads.length,
        reached: reachedCount,
        neverReached: neverReachedCount,
        notYetCalled: buckets.notYetCalled.length,
        // "Contact rate": of leads actually attempted, how many were
        // reached - DIFFERENT question from Pick-up rate (which is about
        // calls, not leads) - see analytics.html for where this is labeled.
        contactRate: attemptedCount > 0 ? reachedCount / attemptedCount : 0,
      };
    } catch (error) {
      console.error("Could not compute call-back pipeline / leads-view counts:", error.message);
    }

    res.json({ ...analytics, callbacksDueNow, callbacksUpcoming, leadsView });
  } catch (error) {
    console.error("Failed to compute analytics:", error.message);
    res.status(500).json({ error: "Failed to compute analytics." });
  }
});

// GET /api/analytics/drilldown: given one of the Analytics dashboard's
// clickable metrics (a "bucket") plus the SAME date/time filters already
// applied there, returns exactly which LEADS are behind that metric. This
// is what powers "click a metric, jump to the Leads page already filtered"-
// Analytics counts CALLS, but the Leads page lists LEADS, so this resolves
// a metric back to the distinct leads behind it (see computeLeadReachBuckets).
//
// Query params: bucket (required) + the same from/to/hourFrom/hourTo as
// GET /api/analytics.
//   bucket=connected          - leads with >=1 connected call (Calls view's
//                                "Connected calls" AND Leads view's "Reached"
//                                are the exact same set of leads)
//   bucket=notConnectedCalls  - leads with >=1 not-connected call (Calls
//                                view's "Not-connected calls" - can overlap
//                                with "connected", since a lead can have
//                                both outcomes across different attempts)
//   bucket=neverReached       - leads with >=1 call, but never connected
//   bucket=notYetCalled       - leads with zero calls in the window
app.get("/api/analytics/drilldown", async (req, res) => {
  try {
    const bucket = req.query.bucket;
    const validBuckets = ["connected", "notConnectedCalls", "neverReached", "notYetCalled"];
    if (!validBuckets.includes(bucket)) {
      return res.status(400).json({ error: "Unknown or missing 'bucket' parameter." });
    }

    const log = await getCallLogForRequest(req);
    const fromDate = req.query.from ? new Date(req.query.from + "T00:00:00") : null;
    const toDate = req.query.to ? new Date(req.query.to + "T23:59:59") : null;
    const hourFrom = req.query.hourFrom !== undefined ? parseInt(req.query.hourFrom, 10) : null;
    const hourTo = req.query.hourTo !== undefined ? parseInt(req.query.hourTo, 10) : null;
    const filtered = filterCallLog(log, { fromDate, toDate, hourFrom, hourTo });

    const { sheets, sheetId } = await getSheetsContextForRequest(req);
    const { headers, dataRows } = await loadSheetRows(sheets, sheetId);
    const nameCol = getColumnIndex(headers, "name");
    const phoneCol = getColumnIndex(headers, "phone");

    const currentLeads = dataRows
      .map((row) => ({ name: row[nameCol] || "", phone: row[phoneCol] || "" }))
      .filter((lead) => lead.name || lead.phone);

    const buckets = computeLeadReachBuckets(currentLeads, filtered);
    const matchedLeads = buckets[bucket === "connected" ? "reached" : bucket];

    // "callCount" is the number of CALLS behind this bucket (as opposed to
    // leadCount, the number of distinct LEADS) - this is what lets the
    // Leads page's filter chip say something like "60 leads from 168
    // calls", so the difference between call counts and lead counts is
    // obvious rather than looking like a bug.
    const matchedPhones = new Set(matchedLeads.map((lead) => normalizePhoneNumber(lead.phone)));
    let callCount;
    if (bucket === "connected") {
      callCount = filtered.filter((call) => call.connected && matchedPhones.has(normalizePhoneNumber(call.phone))).length;
    } else if (bucket === "notYetCalled") {
      callCount = 0; // by definition - these leads have no calls in the window
    } else {
      // "notConnectedCalls" and "neverReached" both mean "count the
      // not-connected calls to these specific leads".
      callCount = filtered.filter((call) => !call.connected && matchedPhones.has(normalizePhoneNumber(call.phone))).length;
    }

    res.json({
      phones: matchedLeads.map((lead) => lead.phone),
      leadCount: matchedLeads.length,
      callCount,
    });
  } catch (error) {
    handleSheetsError(res, error);
  }
});

// ── Live AI coaching tips ────────────────────────────────────────────────
// While a call is in progress, we periodically ask the AI "is a coaching tip
// worth showing right now?" - see checkForCoachingTip() further down. These
// three constants are the dials to tune if it feels too chatty/slow/expensive.

// How often (in ms) we even CHECK for a tip. This is the main dial: lower =
// more responsive coaching, but more AI calls (cost + rate-limit risk).
const COACHING_CHECK_INTERVAL_MS = 5000; // 5 seconds

// Skip the AI call entirely if fewer than this many NEW transcript lines
// have come in since the last check (e.g. the call has gone quiet) - no
// point paying for an AI call when nothing new was said.
const COACHING_MIN_NEW_LINES = 2;

// How many of the most recent transcript lines to send the AI each check -
// keeps each request small/cheap/fast, and keeps the AI focused on "what's
// happening right now" rather than re-reading the whole call so far.
const COACHING_WINDOW_LINES = 12;

// POST /call-status: Twilio sends a request here once a call finishes.
// We read the outcome, map it to a friendly label, update the sheet, and
// (if we captured a transcript) generate AI insights for the call.
// validateTwilioRequest (above) is what makes it safe to trust callerEmail
// below - without it, anyone who found this URL could claim to be any user.
app.post("/call-status", validateTwilioRequest, async (req, res) => {
  const { To, CallStatus, SipResponseCode, CallDuration } = req.body;
  // Twilio calls this endpoint directly, server-to-server - there's no
  // browser session/cookie here at all, so the signed-in rep's email was
  // threaded through the callback URL's query string instead (see /voice
  // and placeCall() above, which set it).
  const callerEmail = req.query.callerEmail;
  // Set ONLY when the rep resolved which lead this call was for at call
  // time - via the "which lead?" duplicate-phone picker, or there was only
  // ever one match to begin with - see /voice above (which is what
  // actually threads this through from the browser) and findLeadRow()'s
  // own comment for the full picture. Empty for calls placed some other
  // way (e.g. POST /api/call), in which case every lookup below falls back
  // to its normal phone-based search.
  const leadRowNumber = req.query.leadRowNumber ? parseInt(req.query.leadRowNumber, 10) : undefined;
  // The ORIGINAL phone number (raw, whatever format it's stored/typed in) -
  // see withCallerEmail()'s own comment above for why this must be used for
  // every matching/lookup purpose below instead of To. Falls back to To for
  // calls with no rawPhone to offer (POST /api/call / /api/test-call, via
  // placeCall() - those supply "to" directly, already in whatever format
  // the caller gave it, so there's no separate "raw" form to recover).
  const phone = req.query.rawPhone || To;

  console.log(
    "Call finished:", To, "(matching as", phone + ")", CallStatus, SipResponseCode,
    "for", callerEmail || "(no callerEmail)",
    leadRowNumber ? `(lead row ${leadRowNumber})` : ""
  );

  const outcome = mapCallStatusToOutcome(CallStatus, SipResponseCode);

  // Tell the browser the outcome RIGHT AWAY - everything below (sheet
  // writes, AI insight generation) can take several seconds, and the power
  // dialer needs to know NOW whether to auto-advance (not connected) or
  // stop and hand control back to the rep (connected) - it shouldn't have
  // to wait for the slower stuff to finish first. Uses `phone` (raw), not
  // To - this is exactly what the frontend's activeCallPhone comparison
  // (see startTranscriptFeed() in shared-lead-panel.js) needs to match
  // against, since that's ALSO the raw, un-normalized number.
  broadcastCallOutcome(phone, outcome, outcome === "Connected");

  // Resolve WHICH user's sheet this call belongs to, ONCE, up front. If we
  // can't (missing/unknown email, expired tokens), we still log the call
  // for analytics below, just without a name/temperature pulled from any
  // sheet, and skip the sheet-writing/AI-insights step entirely rather than
  // guessing at some other sheet.
  let sheetsContext = null;
  if (callerEmail) {
    try {
      sheetsContext = await getSheetsContextForEmail(callerEmail);
    } catch (error) {
      console.error("Could not resolve a sheet for", callerEmail, "-", error.message);
    }
  } else {
    console.error("No callerEmail on /call-status - can't update any sheet for this call.");
  }

  // Log this call as its own record FIRST, in its own try/catch. This way,
  // a problem further down (sheet update, AI insights) can never stop the
  // call from being recorded for analytics, and a logging hiccup here can
  // never stop the rest of the normal call-handling below.
  try {
    const { name, temperatureValue } = sheetsContext
      ? await getLeadNameAndTemperature(sheetsContext.sheets, sheetsContext.sheetId, phone, leadRowNumber)
      : { name: "", temperatureValue: null };

    // phone (raw), not To - the Analytics drill-down matches call-log
    // entries back to sheet leads via normalizePhoneNumber(lead.phone) (see
    // /api/analytics/drilldown), which is ALSO the raw stored format.
    await appendCallLogEntry({
      timestamp: new Date().toISOString(), // ISO so it sorts/parses reliably
      phone: normalizePhoneNumber(phone),
      name,
      outcome,
      connected: outcome === "Connected",
      // Twilio includes CallDuration (seconds) on the "completed" event -
      // null if it's missing for some reason, rather than a fake 0.
      durationSeconds: CallDuration ? parseInt(CallDuration, 10) : null,
      temperature: temperatureValue,
      // Whose call this was - lets /api/analytics and /api/profile show
      // each rep only their OWN calls (see loadCallLog()). null if we
      // couldn't resolve callerEmail above - still logged, just unowned.
      userEmail: callerEmail || null,
    });
  } catch (error) {
    console.error("Failed to log call record:", error.message);
  }

  if (sheetsContext) {
    try {
      const { sheets, sheetId } = sheetsContext;
      // { callNumber, rowNumber } - or null if the lead couldn't be
      // resolved at all (not found, or still ambiguous - see
      // updateLeadAfterCall()'s own comment). rowNumber gets threaded on
      // to every write below, so the WHOLE chain for this call operates on
      // the exact same row updateLeadAfterCall() already resolved -
      // nothing re-derives independently from here on. Uses `phone` (raw) -
      // findLeadRow() compares this against the sheet's own stored (raw)
      // value, so feeding it To (E.164) here is exactly what silently broke
      // this write for a bare-10-digit/leading-0 lead before this fix.
      const outcomeResult = await updateLeadAfterCall(sheets, sheetId, phone, outcome, leadRowNumber);

      // Grab whatever transcript lines we recorded for this call. We deliberately
      // do NOT delete it here - we keep the most recent call's transcript around
      // in memory so POST /api/regenerate-insights can re-run insights later if
      // this attempt fails. (The next call to this same lead will replace it
      // with a fresh, empty transcript when it starts.) Uses `phone` (raw) -
      // this MUST match the key /media-stream's "start" handler set (see
      // currentLeadPhone there), which is now also the raw number.
      const normalizedPhone = normalizePhoneNumber(phone);
      const transcriptLines = callTranscripts.get(normalizedPhone) || [];

      if (outcomeResult && transcriptLines.length > 0) {
        const { callNumber, rowNumber } = outcomeResult;

        // Save it to a local file too, so it's easy to reuse for testing later
        // via POST /api/test-insights or GET /api/last-transcript - this is
        // "nice to have" only, so a failure here should never break the call.
        try {
          fs.writeFileSync(
            LAST_TRANSCRIPT_FILE_PATH,
            JSON.stringify(
              { phone, callNumber, savedAt: new Date().toISOString(), transcript: transcriptLines },
              null,
              2
            )
          );
        } catch (error) {
          console.error("Failed to save last-transcript.json:", error.message);
        }

        // Both calls below also resolve a lead by phone internally
        // (writeAiCells / findLeadRow) if rowNumber's own re-validation
        // ever fails - `phone` (raw) here keeps that fallback consistent
        // with everything else in this handler, same reasoning as above.
        const transcriptText = transcriptLinesToText(transcriptLines);
        const insights = await generateAndSaveInsights(sheets, sheetId, phone, transcriptText, callNumber, rowNumber, callerEmail || null);
        await updateRelationshipHistory(callerEmail || null, sheets, sheetId, phone, insights, transcriptText, callNumber, rowNumber);
      }
    } catch (error) {
      console.error("Failed to update sheet after call:", error.message);
    }
  }

  // Twilio just needs a 200 OK here - it doesn't use the response body.
  res.sendStatus(200);
});

// POST /api/regenerate-insights: re-runs AI insights for a lead using the
// most recent call's transcript we still have in memory, and rewrites the
// Temperature/AI Notes columns. Useful when the automatic attempt failed
// even after retries (e.g. the AI provider was down for a while).
// Expects a JSON body like: { "phone": "+15551234567" }
app.post("/api/regenerate-insights", async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ error: "Request body must include a 'phone' number." });
  }

  // DEMO MODE: fake success - never calls Gemini, never writes to any sheet.
  if (isDemoRequest(req)) {
    return res.json({ success: true, message: "AI insights regenerated. (demo)" });
  }

  // Real signed-in users only past this point - this calls Gemini for real,
  // at our cost. Checked up front (moved earlier than the getCurrentUser()
  // call this route used to only make much later, deep in the try block)
  // so an unapproved user gets the clear pilot-blocked reason immediately,
  // before wasting a transcript lookup or sheet read.
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in." });
  }
  if (blockIfNoPaidAccess(res, user.email)) return;

  const normalizedPhone = normalizePhoneNumber(phone);
  const transcriptLines = callTranscripts.get(normalizedPhone);

  if (!transcriptLines || transcriptLines.length === 0) {
    return res.status(404).json({
      error: "No stored transcript found for this phone number (it may be too old, or the server restarted since that call).",
    });
  }

  try {
    const { sheets, sheetId } = await getSheetsContextForRequest(req);
    const lead = await findLeadRow(sheets, phone, sheetId);
    if (respondIfLeadUnresolved(res, lead)) return;

    // Use the lead's current Attempts count as the "call number" - the same
    // number that call would have used the first time insights were generated.
    const attemptsCol = getColumnIndex(lead.headers, "attempts");
    const callNumber = parseInt(lead.row[attemptsCol], 10) || 1;

    const transcriptText = transcriptLinesToText(transcriptLines);
    const insights = await generateAndSaveInsights(sheets, sheetId, phone, transcriptText, callNumber, lead.rowNumber, user.email);
    await updateRelationshipHistory(user.email, sheets, sheetId, phone, insights, transcriptText, callNumber, lead.rowNumber);

    res.json({ success: true, message: "AI insights regenerated." });
  } catch (error) {
    handleSheetsError(res, error);
  }
});

// GET /api/last-transcript: returns the most recently saved real call's
// transcript (see last-transcript.json), if one exists yet. Lets the test
// page load a real transcript with one click instead of copy/pasting it.
app.get("/api/last-transcript", (req, res) => {
  // DEMO MODE: refuse - this is a REAL past call's transcript (real lead
  // conversation), so demo visitors must never be able to read it.
  if (isDemoRequest(req)) {
    return res.status(403).json({ error: "Not available in demo mode." });
  }

  try {
    const contents = fs.readFileSync(LAST_TRANSCRIPT_FILE_PATH, "utf8");
    res.type("application/json").send(contents);
  } catch (error) {
    res.status(404).json({ error: "No saved transcript yet - finish a real call first." });
  }
});

// POST /api/test-insights: runs a transcript through the AI abstraction
// WITHOUT placing a real call and WITHOUT writing to the sheet - just
// returns what the AI produced, so you can quickly iterate on the prompt.
// Body: {
//   "transcript": [{ "speaker": "Rep", "text": "..." }, ...] OR a plain
//                 "Rep: ...\nLead: ..." text block,
//   "callNumber": <optional, defaults to 1>
// }
app.post("/api/test-insights", async (req, res) => {
  // DEMO MODE: refuse - this calls Gemini for real (it's a prompt-testing
  // tool, not something a demo visitor should be able to trigger).
  if (isDemoRequest(req)) {
    return res.status(403).json({ error: "Not available in demo mode." });
  }

  // Real signed-in users only past this point - this calls Gemini for real,
  // with a transcript taken directly from the request body, at our cost. It
  // must never run for an unauthenticated caller, not just a non-demo one.
  const user = await getCurrentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Not signed in." });
  }
  if (blockIfNoPaidAccess(res, user.email)) return;

  const { transcript, callNumber } = req.body;

  if (!transcript) {
    return res.status(400).json({ error: "Request body must include a 'transcript'." });
  }

  // Accept either an array of { speaker, text } lines or a plain text block.
  const transcriptText = Array.isArray(transcript)
    ? transcriptLinesToText(transcript)
    : transcript;

  const sellerContext = buildSellerContextString(user);
  const insights = await generateCallInsights(transcriptText, callNumber || 1, sellerContext);

  if (!insights) {
    return res.status(502).json({ error: "AI insights failed - check the server log for details." });
  }

  res.json({ insights, aiNotes: buildAiNotesBlock(insights) });
});

// We create a plain http.Server ourselves (instead of using app.listen)
// so that both Express (for normal web requests) and our WebSocket server
// (for Twilio's audio stream) can share the exact same port.
const server = http.createServer(app);

// Sets up the WebSocket endpoint Twilio connects to for Media Streams.
const wss = new WebSocketServer({ noServer: true });

// A SEPARATE WebSocket endpoint the FRONTEND PAGE connects to (not Twilio).
// This is how we push live transcript lines to the browser as they happen.
const browserFeedWss = new WebSocketServer({ noServer: true });

// Both WebSocket servers above are created with "noServer: true", which
// means WE decide which one handles each incoming connection, based on its
// URL path. (Attaching two WebSocketServers directly to the same http.Server
// doesn't work reliably - whichever is created first ends up rejecting
// connections meant for the other, so we route manually here instead.)
server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  if (pathname === "/media-stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else if (pathname === "/browser-feed") {
    browserFeedWss.handleUpgrade(request, socket, head, (ws) => {
      browserFeedWss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Every browser tab currently watching the page gets added here, so we know
// who to send new transcript lines to.
const browserFeedClients = new Set();

browserFeedWss.on("connection", (ws) => {
  console.log("Browser feed: a page connected");
  browserFeedClients.add(ws);

  ws.on("close", () => {
    console.log("Browser feed: a page disconnected");
    browserFeedClients.delete(ws);
  });
});

// Sends one transcript line (e.g. { speaker: "Rep", text: "hello" }) to
// EVERY browser page currently connected - this socket is shared by every
// signed-in rep's browser, not just the one on this call (see
// browserFeedClients above), so `phone` is included on every message and
// each browser is responsible for ignoring anything that isn't for its own
// active call (see startTranscriptFeed() in shared-lead-panel.js). Without
// this, two reps on calls at the same time would see each other's
// transcripts/tips interleaved into their own panels.
function broadcastTranscriptLine(speaker, text, phone) {
  const message = JSON.stringify({ speaker, text, phone });

  for (const client of browserFeedClients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

// Sends one live coaching tip to every browser page currently connected.
// Uses a "type: tip" field (transcript-line messages have no "type" field)
// so the frontend can tell the two apart on the same /browser-feed socket.
// `phone` - see broadcastTranscriptLine() above for why every broadcast
// carries this and why the frontend must filter by it.
function broadcastCoachingTip(text, phone) {
  const message = JSON.stringify({ type: "tip", text, phone });

  for (const client of browserFeedClients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

// Tells the browser how a just-finished REAL call actually went (Connected,
// No answer, Busy, ...) - the power dialer's ONLY way to find this out,
// since Twilio reports it to our SERVER (see /call-status below), never
// straight to the browser. Sent as its own "callOutcome" type on the same
// socket as transcript lines/tips, but never shown in either of those
// panels - see startRealCall()'s pendingCallOutcomeCallback in
// shared-lead-panel.js, which is what actually reads this. This socket is
// shared by every signed-in rep's browser (see browserFeedClients above),
// so `phone` is what lets a browser tell "my call finished" apart from
// "a DIFFERENT rep's call finished at the same moment" - shared-lead-
// panel.js only accepts this message if it matches its own active call.
function broadcastCallOutcome(phone, outcome, connected) {
  const message = JSON.stringify({ type: "callOutcome", phone, outcome, connected });

  for (const client of browserFeedClients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

// Opens a live transcription connection to Deepgram for ONE track (one
// side of the call). Twilio sends us mulaw-encoded audio at 8000 Hz, mono -
// we tell Deepgram exactly that so it can decode the audio correctly.
//
// `track` is Twilio's raw track name ("inbound" or "outbound") - we log with
// this until we know who it actually is.
// `phone` is THIS call's lead phone number - stamped onto every broadcast
// transcript line so the right browser (and only the right browser) shows
// it - see broadcastTranscriptLine()'s own comment for why that matters.
// `getLabel` is a function we call to look up the current Rep/Lead label for
// this track (it starts out unknown and gets filled in dynamically - see
// assignSpeakerLabels below).
// `onSpeech` is called every time this track produces a real transcript, so
// the caller can notice "someone just spoke" and assign labels if needed.
// `onFinalLine` is called with the finished "Rep: ..."/"Lead: ..." line each
// time a FINAL result comes in, so the caller can save it for AI insights.
async function openDeepgramConnection(track, phone, getLabel, onSpeech, onFinalLine) {
  try {
    const connection = await deepgramClient.listen.v1.connect({
      model: "nova-2-phonecall", // a model tuned specifically for phone call audio
      encoding: "mulaw",
      sample_rate: 8000,
      channels: 1,
      interim_results: "true", // send partial results as speech happens, not just at the end
    });

    connection.on("open", () => {
      console.log(`Deepgram (${track} track): connection opened`);
    });

    // Deepgram sends us transcription results here as speech is recognized.
    connection.on("message", (message) => {
      if (message.type !== "Results") return;

      const transcript = message.channel.alternatives[0].transcript;
      if (!transcript) return; // Deepgram sometimes sends empty results - ignore those

      onSpeech(track); // makes sure this track (and the other one) has a label by now
      const label = getLabel(track);

      if (message.is_final) {
        console.log(`${label}: ${transcript}`);
        // Push this final line to the frontend page(s) watching the call live.
        broadcastTranscriptLine(label, transcript, phone);
        // Save it too, so we have the full transcript once the call ends.
        onFinalLine(label, transcript);
      } else {
        console.log(`${label} (interim): ${transcript}`);
      }
    });

    connection.on("error", (error) => {
      console.error(`Deepgram (${track} track) error:`, error.message);
    });

    connection.on("close", () => {
      console.log(`Deepgram (${track} track): connection closed`);
    });

    // .connect() opens the actual socket; waitForOpen() waits until it's ready
    connection.connect();
    await connection.waitForOpen();

    return connection;
  } catch (error) {
    console.error(`Failed to open Deepgram connection for ${track} track:`, error.message);
    return null;
  }
}

// Closes every open Deepgram connection for a call (one per track).
function closeTrackConnections(trackConnections) {
  for (const track of Object.keys(trackConnections)) {
    if (trackConnections[track]) {
      trackConnections[track].close();
      trackConnections[track] = null;
    }
  }
}

wss.on("connection", (ws) => {
  console.log("Media stream: Twilio connected to /media-stream");

  // Counts how many audio chunks ("media" events) we've received on this
  // call (both tracks combined), so we can log a heartbeat every 50 instead
  // of flooding the console.
  let mediaMessageCount = 0;

  // One Deepgram connection per track, keyed by Twilio's track name
  // ("inbound" / "outbound").
  const trackConnections = {};

  // Rep/Lead label for each track, for THIS call only - starts empty and
  // gets filled in the first time someone speaks (see assignSpeakerLabels).
  let trackLabels = {};
  let speakerAssigned = false;
  let currentCallSid = null;

  // The lead's phone number for THIS call, read from the custom parameter
  // /voice attaches to the stream. Used to save transcript lines under the
  // right key in callTranscripts, so /call-status can find them later.
  let currentLeadPhone = null;

  // This call's rep's seller-context string (see getSellerContextForEmail()
  // below), resolved once at "start" from the callerEmail custom parameter
  // /voice attaches to the stream - used to personalize live coaching tips.
  // "" (never null) if there's no callerEmail or no profile filled in, same
  // as every other seller-context call site - checkForCoachingTip below
  // just passes it straight through either way.
  let currentCallerSellerContext = "";

  // ── Live AI coaching state, for THIS call only ──────────────────────
  // How many transcript lines existed the last time we checked for a tip -
  // lets us skip the AI call if not enough new conversation has happened.
  let linesSeenAtLastCoachingCheck = 0;
  // The most recent tip we showed, so we can tell the AI not to repeat it.
  let lastCoachingTip = null;
  // True while a coaching AI call is in flight (including retries) - stops
  // the next timer tick from starting an overlapping second request.
  let coachingCheckInProgress = false;
  // The setInterval handle for this call's periodic coaching checks, so we
  // can stop it once the call ends (see the "stop"/close handling below).
  let coachingIntervalHandle = null;

  // Looks up the current label for a track. Before anyone has spoken yet,
  // this just falls back to the raw track name so logging never breaks.
  function getLabel(track) {
    return trackLabels[track] || track;
  }

  // Runs on a timer (COACHING_CHECK_INTERVAL_MS) while this call is active.
  // Sends only the most recent slice of the transcript (COACHING_WINDOW_LINES)
  // to the AI and asks "is a coaching tip worth showing right now?" - most of
  // the time the answer is no, and nothing gets sent to the browser.
  async function checkForCoachingTip() {
    // Don't overlap with a request that's still retrying, and don't bother
    // if this call doesn't have a phone number yet (still starting up).
    if (coachingCheckInProgress || !currentLeadPhone) return;

    const allLines = callTranscripts.get(currentLeadPhone) || [];
    const newLinesCount = allLines.length - linesSeenAtLastCoachingCheck;

    // Not enough new conversation since last time - skip the AI call
    // entirely (e.g. the line has gone quiet, or only one short reply).
    if (newLinesCount < COACHING_MIN_NEW_LINES) return;

    coachingCheckInProgress = true;
    linesSeenAtLastCoachingCheck = allLines.length;

    try {
      const recentLines = allLines.slice(-COACHING_WINDOW_LINES);
      const recentText = transcriptLinesToText(recentLines);

      const tip = await generateCoachingTip(recentText, lastCoachingTip, currentCallerSellerContext);
      if (!tip) return; // the common case - AI decided nothing was worth flagging

      // Defensive check: even though the prompt tells the AI not to repeat
      // the last tip, don't trust it blindly - never show the exact same
      // tip twice in a row.
      if (tip.trim() === (lastCoachingTip || "").trim()) return;

      lastCoachingTip = tip;
      broadcastCoachingTip(tip, currentLeadPhone);
    } finally {
      coachingCheckInProgress = false;
    }
  }

  // Saves one finished transcript line for this call, so the full transcript
  // is ready by the time /call-status needs it. Stored as { speaker, text }
  // objects (not pre-joined strings) so the same data can be turned into
  // plain text (for the AI prompt) OR saved as JSON (for testing) as needed.
  function recordFinalLine(label, transcript) {
    if (!currentLeadPhone) return;
    const lines = callTranscripts.get(currentLeadPhone) || [];
    lines.push({ speaker: label, text: transcript });
    callTranscripts.set(currentLeadPhone, lines);
  }

  // The first track to produce a real transcript is the rep (their mic is
  // live from the start, while the lead's line is silent until Twilio
  // finishes dialing them) - this only runs once per call.
  function assignSpeakerLabels(firstTrack) {
    if (speakerAssigned) return;
    speakerAssigned = true;

    const otherTrack = firstTrack === "inbound" ? "outbound" : "inbound";
    trackLabels = { [firstTrack]: "Rep", [otherTrack]: "Lead" };

    console.log(
      `Speaker mapping for call ${currentCallSid}: "${firstTrack}" track spoke first -> Rep, "${otherTrack}" track -> Lead`
    );
  }

  // The ENTIRE body below is wrapped in try/catch - this is an async
  // event-listener callback, so nothing else awaits or catches whatever it
  // returns. Without this, a synchronous throw anywhere in here (e.g.
  // sendMedia() throwing "Socket is not open." the instant Deepgram drops a
  // track - confirmed in the SDK's own source) becomes an unhandled promise
  // rejection, which crashes the ENTIRE Node process on Node's current
  // defaults - taking down every other rep's in-progress call along with
  // it. One flaky Deepgram connection must only ever break ITS OWN call,
  // never the whole server.
  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.event === "connected") {
        console.log("Media stream event: connected");
      } else if (data.event === "start") {
        currentCallSid = data.start.callSid;
        console.log("Media stream event: start (call SID:", currentCallSid + ")");
        mediaMessageCount = 0;
        trackLabels = {};
        speakerAssigned = false;

        // Read the lead's phone number back out of the custom parameter we
        // attached to the stream in /voice, and start a fresh transcript for it.
        const leadPhone = data.start.customParameters && data.start.customParameters.leadPhone;
        currentLeadPhone = normalizePhoneNumber(leadPhone);
        callTranscripts.set(currentLeadPhone, []);

        // Same idea for the rep's own seller-context profile - see
        // currentCallerSellerContext's own comment above. Resolved once per
        // call (not on every coaching check) since it can't change mid-call.
        const callerEmail = data.start.customParameters && data.start.customParameters.callerEmail;
        currentCallerSellerContext = await getSellerContextForEmail(callerEmail);

        // Fresh coaching state for this new call, and start its periodic tip
        // check running (see checkForCoachingTip above).
        linesSeenAtLastCoachingCheck = 0;
        lastCoachingTip = null;
        coachingIntervalHandle = setInterval(checkForCoachingTip, COACHING_CHECK_INTERVAL_MS);

        // Open one Deepgram connection per track, so the rep and lead each
        // get transcribed separately instead of one blended transcript.
        const trackNames = ["inbound", "outbound"];
        const connections = await Promise.all(
          trackNames.map((track) =>
            openDeepgramConnection(track, currentLeadPhone, getLabel, assignSpeakerLabels, recordFinalLine)
          )
        );
        trackNames.forEach((track, i) => {
          trackConnections[track] = connections[i];
        });
      } else if (data.event === "media") {
        mediaMessageCount++;
        if (mediaMessageCount % 50 === 0) {
          console.log(`Media stream: ${mediaMessageCount} audio chunks received so far`);
        }

        // Twilio tells us which track ("inbound"/"outbound") this chunk
        // belongs to - send it only to that track's Deepgram connection.
        const track = data.media.track;
        const connection = trackConnections[track];

        // readyState 1 is the standard WebSocket OPEN value (the same
        // check the Deepgram SDK's own sendMedia() does internally before
        // THROWING if it's anything else) - checking it here ourselves
        // means we skip this one audio chunk instead of ever hitting that
        // throw. A connection can go non-open between chunks (Deepgram-side
        // drop, or our own close() on "stop"/"close" below) without us
        // having nulled the reference yet, so `if (connection)` alone
        // isn't enough - see the audit notes for why this crashed the
        // server before this fix.
        if (connection && connection.readyState === 1) {
          // Twilio sends audio as base64 text - decode it back to raw bytes.
          const audioBytes = Buffer.from(data.media.payload, "base64");
          connection.sendMedia(audioBytes);
        }
      } else if (data.event === "stop") {
        console.log("Media stream event: stop (audio stream ended)");
        closeTrackConnections(trackConnections);
        clearInterval(coachingIntervalHandle);
      }
    } catch (error) {
      // Log and move on - never let a single bad frame/dropped connection
      // take down the whole process (see the comment above this handler).
      console.error("Media stream: error handling a message, this call's transcription may be affected:", error.message);
    }
  });

  ws.on("close", () => {
    console.log("Media stream: connection closed");
    closeTrackConnections(trackConnections);
    clearInterval(coachingIntervalHandle);
  });
});

// Which persistence mode is active MATTERS a lot (see db.js) - JSON-file
// mode quietly loses everything on a restart on a host with an ephemeral
// filesystem (e.g. Render's free tier), so this is logged explicitly at
// startup rather than left implicit in whether DATABASE_URL happens to be set.
if (db.isDatabaseMode) {
  console.log("Persistence: Postgres (DATABASE_URL is set) - users.json/call-log.json/call-history.json are not used for real data.");
} else {
  console.log(
    "Persistence: local JSON files (DATABASE_URL is not set) - fine for local development, " +
      "but data will NOT survive a restart on a host with an ephemeral filesystem (e.g. Render)."
  );
}

async function startServer() {
  if (db.isDatabaseMode) {
    try {
      await db.createTablesIfNotExist();
      console.log("Database tables ready (created if they didn't already exist).");
    } catch (error) {
      // Don't crash the server if the database is briefly unavailable at
      // startup - every route that touches the database already handles
      // its OWN query failures gracefully (see auth.js and the call-log/
      // call-history functions above), so the app still comes up; it just
      // won't be able to read/write anything until the database is
      // reachable, the same as it would for any query failure at runtime.
      console.error(
        "Could not verify/create database tables at startup - the server will keep starting, " +
          "but requests that need the database may fail until this is resolved:",
        error.message
      );
    }
  }

  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
