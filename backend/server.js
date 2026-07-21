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
  getCurrentUser,
  createSession,
  destroySession,
  readSessionIdFromRequest,
  setSessionCookie,
  clearSessionCookie,
} = require("./auth");

const app = express();
const PORT = 3000;

// Lets us read JSON bodies sent by the frontend (needed for POST /api/call)
app.use(express.json());

// Lets us read form-encoded bodies - this is the format Twilio uses when it
// calls our POST /voice endpoint during a browser call.
app.use(express.urlencoded({ extended: false }));

// Serve everything in the "frontend" folder as static files
// (so visiting http://localhost:3000 loads frontend/index.html)
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
    saveUser(profile.email, tokens, profile);

    const sessionId = createSession(profile.email);
    setSessionCookie(res, sessionId);

    res.redirect("/"); // back to the app - now signed in
  } catch (err) {
    console.error("Google sign-in failed:", err.message);
    res.status(500).send("Sign-in failed: " + err.message);
  }
});

// GET /api/me: tells the frontend who (if anyone) is currently signed in.
// Never sends tokens to the browser - just what the UI needs to show.
app.get("/api/me", (req, res) => {
  const user = getCurrentUser(req);
  res.json({ user: user ? { email: user.email, name: user.name } : null });
});

// POST /auth/logout: signs the current browser out.
app.post("/auth/logout", (req, res) => {
  const sessionId = readSessionIdFromRequest(req);
  if (sessionId) destroySession(sessionId);
  clearSessionCookie(res);
  res.json({ success: true });
});

// ── Google Sheet configuration ──────────────────────────────────────────
// Everything about which sheet we use and what its columns are called lives
// in this ONE object. Every place in this file that reads or writes the
// sheet looks up column positions through here - nothing else in the code
// hard-codes a column letter or header string.
//
// NOTE FOR LATER: this is written so it can become per-user configuration
// (e.g. loaded from a database, one SHEET_CONFIG per account) instead of a
// single hard-coded object - each user could then name/order their own
// sheet's columns differently without any of the logic below needing to change.
const SHEET_CONFIG = {
  // Read from .env (DEFAULT_SHEET_ID) instead of hardcoded, so the actual
  // sheet ID never has to appear in source code (useful now that this repo
  // is public - anyone cloning it sets their own sheet ID in their own .env).
  sheetId: process.env.DEFAULT_SHEET_ID,

  // Maps our internal field names (used throughout this file) to the exact
  // header text expected in row 1 of the sheet. We match by this text, not
  // by column position, so columns can be added/reordered safely.
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

// Path to the service account key file used to authenticate with Google.
const KEY_FILE_PATH = path.join(__dirname, "..", "google-key.json");

// GoogleAuth reads the key file and handles getting us an access token.
// We need full (read + write) access, since /call-status below updates rows.
const auth = new google.auth.GoogleAuth({
  keyFile: KEY_FILE_PATH,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

// Reads every row from the sheet, splitting the header row from the data
// rows. We ask for a wide range (A1:Z) rather than a fixed number of columns,
// so this keeps working even if columns are added or reordered later.
async function loadSheetRows(sheets) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_CONFIG.sheetId,
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

// /api/leads: reads every row from the sheet and returns them as JSON.
app.get("/api/leads", async (req, res) => {
  try {
    // Get an authenticated client, then create a Sheets API instance.
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });

    const { headers, dataRows } = await loadSheetRows(sheets);

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
      .map((row) => {
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
        };
      })
      .filter((lead) => lead.Name || lead.Phone);

    res.json(leads);
  } catch (error) {
    console.error("Failed to read leads from Google Sheet:", error.message);
    res.status(500).json({ error: "Failed to read leads from Google Sheet." });
  }
});

// GET /api/leads/due: returns every lead currently due for a call-back
// (manual "Call Back On" time passed, or the auto Hot/Warm/Cold rule
// triggered - see computeCallbackDue above), sorted MOST overdue first.
// Powers the compact "due for call-back" banner and its dedicated page.
app.get("/api/leads/due", async (req, res) => {
  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });

    const { headers, dataRows } = await loadSheetRows(sheets);

    const nameCol = getColumnIndex(headers, "name");
    const phoneCol = getColumnIndex(headers, "phone");
    const temperatureCol = getColumnIndex(headers, "temperature");
    const lastCalledCol = getColumnIndex(headers, "lastCalled");
    const callBackOnCol = getColumnIndex(headers, "callBackOn");
    const firstConnectedCol = getColumnIndex(headers, "firstConnected");

    const dueLeads = [];

    for (const row of dataRows) {
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
        });
      }
    }

    dueLeads.sort((a, b) => b.overdueDays - a.overdueDays); // most overdue first

    res.json(dueLeads);
  } catch (error) {
    console.error("Failed to compute due call-backs:", error.message);
    res.status(500).json({ error: "Failed to compute due call-backs." });
  }
});

// GET /api/leads/:phone: returns EVERY field SHEET_CONFIG knows about for one
// lead (used by the frontend's lead detail side panel). Looping over
// SHEET_CONFIG.columns like this - instead of listing field names by hand -
// means this endpoint never needs updating if a column is added later.
app.get("/api/leads/:phone", async (req, res) => {
  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });

    const lead = await findLeadRow(sheets, req.params.phone);
    if (!lead) {
      return res.status(404).json({ error: "Lead not found." });
    }

    const { headers, row } = lead;

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

    res.json(details);
  } catch (error) {
    console.error("Failed to load lead detail:", error.message);
    res.status(500).json({ error: "Failed to load lead detail." });
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

  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });

    const lead = await findLeadRow(sheets, req.params.phone);
    if (!lead) {
      return res.status(404).json({ error: "Lead not found." });
    }

    const { headers, rowNumber } = lead;
    const stageCol = getColumnIndex(headers, "stage");

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_CONFIG.sheetId,
      range: `${columnIndexToLetter(stageCol)}${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[stage]] },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Failed to update stage:", error.message);
    res.status(500).json({ error: "Failed to update stage." });
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

  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });

    const lead = await findLeadRow(sheets, req.params.phone);
    if (!lead) {
      return res.status(404).json({ error: "Lead not found." });
    }

    const { headers, rowNumber } = lead;
    const notesCol = getColumnIndex(headers, "notes");

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_CONFIG.sheetId,
      range: `${columnIndexToLetter(notesCol)}${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[notes]] },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Failed to save notes:", error.message);
    res.status(500).json({ error: "Failed to save notes." });
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

  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });

    const lead = await findLeadRow(sheets, req.params.phone);
    if (!lead) {
      return res.status(404).json({ error: "Lead not found." });
    }

    const { headers, rowNumber } = lead;
    const callBackOnCol = getColumnIndex(headers, "callBackOn");

    // Store it the same friendly locale-formatted way as Last called / First
    // connected, so it reads nicely if you open the sheet directly. An empty
    // string clears it. new Date(callBackOn).toLocaleString() round-trips
    // fine back through new Date() when we later read it for the due check.
    const valueToStore = callBackOn ? new Date(callBackOn).toLocaleString() : "";

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_CONFIG.sheetId,
      range: `${columnIndexToLetter(callBackOnCol)}${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[valueToStore]] },
    });

    res.json({ success: true, callBackOn: valueToStore });
  } catch (error) {
    console.error("Failed to save call-back time:", error.message);
    res.status(500).json({ error: "Failed to save call-back time." });
  }
});

// POST /api/leads/:phone/draft-sms: asks the AI to draft a short follow-up
// SMS for this lead, based on their most recent call's transcript (still
// held in memory in callTranscripts - see further down this file) and the
// "AI Notes" summary already written to the sheet for that call. Does NOT
// send anything or touch the sheet - just returns the draft text for the
// rep to review/edit in the panel before sending.
app.post("/api/leads/:phone/draft-sms", async (req, res) => {
  const normalizedPhone = normalizePhoneNumber(req.params.phone);
  const transcriptLines = callTranscripts.get(normalizedPhone);

  if (!transcriptLines || transcriptLines.length === 0) {
    return res.status(404).json({
      error: "No call transcript available for this lead yet - place a call first (or the server may have restarted since the last one).",
    });
  }

  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });
    const lead = await findLeadRow(sheets, req.params.phone);

    if (!lead) {
      return res.status(404).json({ error: "Lead not found." });
    }

    const nameCol = getColumnIndex(lead.headers, "name");
    const aiNotesCol = getColumnIndex(lead.headers, "aiNotes");
    const leadName = lead.row[nameCol] || "";
    const aiNotes = lead.row[aiNotesCol] || "";

    const transcriptText = transcriptLinesToText(transcriptLines);
    const draft = await generateFollowUpSms(leadName, transcriptText, aiNotes);

    if (!draft) {
      // AI failed even after retries (e.g. rate-limited/quota) - the rep can
      // still write their own message in the panel and send that instead.
      return res.status(502).json({ error: "AI couldn't draft a message right now - you can still write your own and send it." });
    }

    res.json({ draft });
  } catch (error) {
    console.error("Failed to draft follow-up SMS:", error.message);
    res.status(500).json({ error: "Failed to draft follow-up SMS." });
  }
});

// Appends one line to the (human) "Notes" column recording that an SMS was
// sent, and when - so there's always a record of what went out, without
// needing a whole new sheet column. Clearly marked with a "[SMS sent ...]"
// prefix so it's easy to tell apart from the rep's own typed notes.
async function appendSmsLogToNotes(phone, message) {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  const lead = await findLeadRow(sheets, phone);
  if (!lead) {
    console.error("No lead found in the sheet to log the sent SMS against, phone:", phone);
    return;
  }

  const { headers, row, rowNumber } = lead;
  const notesCol = getColumnIndex(headers, "notes");

  const existingNotes = row[notesCol] || "";
  const logLine = `[SMS sent ${new Date().toLocaleString()}] ${message}`;
  const updatedNotes = existingNotes ? `${existingNotes}\n${logLine}` : logLine;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_CONFIG.sheetId,
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

  try {
    await sendSms(req.params.phone, message);
  } catch (error) {
    console.error("Failed to send SMS:", error.message);
    return res.status(500).json({ error: "Failed to send SMS: " + error.message });
  }

  // The SMS itself already went out successfully at this point - don't fail
  // the whole request just because the logging step had a problem. The rep
  // still needs to know the text actually sent.
  try {
    await appendSmsLogToNotes(req.params.phone, message);
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

// The public URL Twilio can reach us at (via ngrok). Twilio needs this
// because it calls OUR server from THEIR servers, not from your browser.
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

// Finds a lead's row by phone number. Returns null if no row matches, or
// { headers, row, rowNumber } if found. Both updateLeadAfterCall and the AI
// insights writer below need this, so the "find by phone" logic lives here
// in one place instead of being copied twice.
//
// TEMPORARY DIAGNOSTIC LOGGING: there's a bug where calls sometimes update
// the wrong lead's row. This logs every step of the matching process (the
// incoming number, every row it compares against, and which one it picks
// and why) so we can see exactly what's happening on a real call before
// changing any matching logic.
async function findLeadRow(sheets, phone) {
  const { headers, dataRows } = await loadSheetRows(sheets);
  const phoneCol = getColumnIndex(headers, "phone");
  const nameCol = getColumnIndex(headers, "name");
  const targetPhone = normalizePhoneNumber(phone);

  console.log(
    `[findLeadRow] Looking for phone raw="${phone}" normalized="${targetPhone}"`
  );

  let matchedIndex = -1;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rawRowPhone = row[phoneCol];
    const normalizedRowPhone = normalizePhoneNumber(rawRowPhone);
    const isMatch = normalizedRowPhone === targetPhone;

    console.log(
      `[findLeadRow]   row ${i} (sheet row ${i + 2}) name="${row[nameCol]}" ` +
        `phone raw="${rawRowPhone}" normalized="${normalizedRowPhone}" -> ${isMatch ? "MATCH" : "no match"}`
    );

    if (isMatch && matchedIndex === -1) {
      matchedIndex = i;
      // Not stopping the loop early on purpose - we want to see every row's
      // comparison in the log, including any OTHER rows that also match.
    }
  }

  if (matchedIndex === -1) {
    console.log(`[findLeadRow] No row matched phone "${targetPhone}" - returning null.`);
    return null;
  }

  const matchedRow = dataRows[matchedIndex];
  console.log(
    `[findLeadRow] Decided on row ${matchedIndex} (sheet row ${matchedIndex + 2}): ` +
      `name="${matchedRow[nameCol]}" phone="${matchedRow[phoneCol]}" (first row whose normalized phone matched)`
  );

  return {
    headers,
    row: matchedRow,
    rowNumber: matchedIndex + 2, // +1 for the header row, +1 to be 1-indexed
  };
}

// After a call finishes, updates that lead's row:
// - Last outcome always gets overwritten with the latest result.
// - Attempts always goes up by 1.
// - Last called is always set to right now.
// - First Connected is only ever set ONCE, the first time outcome is
//   "Connected" - it is never overwritten after that.
// - Stage and Notes are never touched.
// Returns the new Attempts count (used as the "call number" for AI insights),
// or null if no matching lead was found.
async function updateLeadAfterCall(phone, outcome) {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  const lead = await findLeadRow(sheets, phone);
  if (!lead) {
    console.error("No lead found in the sheet for phone:", phone);
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
    spreadsheetId: SHEET_CONFIG.sheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: updates.map((update) => ({
        range: `${columnIndexToLetter(update.col)}${rowNumber}`,
        values: [[update.value]],
      })),
    },
  });

  return newAttempts;
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
async function writeAiCells(phone, temperatureValue, notesValue) {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  const lead = await findLeadRow(sheets, phone);
  if (!lead) {
    console.error("No lead found in the sheet for AI insights, phone:", phone);
    return;
  }

  const { headers, rowNumber } = lead;
  const temperatureCol = getColumnIndex(headers, "temperature");
  const aiNotesCol = getColumnIndex(headers, "aiNotes");

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_CONFIG.sheetId,
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
async function writeAiInsightsToSheet(phone, insights) {
  const temperatureLabel = `${insights.temperature} (${temperatureWord(insights.temperature)})`;
  const notesBlock = buildAiNotesBlock(insights);

  await writeAiCells(phone, temperatureLabel, notesBlock);
  console.log(`AI insights written for ${phone}: Temperature = ${temperatureLabel}`);
}

// Used when AI insights fail even after every retry (see ai/index.js).
// Writes an obvious placeholder instead of leaving the cells looking blank
// or stale, so it's clear this call still needs insights generated - either
// automatically next time, or via POST /api/regenerate-insights.
async function writeAiInsightsFailurePlaceholder(phone) {
  await writeAiCells(phone, "—", "AI insights unavailable — will retry later");
  console.log(`AI insights failed for ${phone} - wrote placeholder to sheet`);
}

// Generates AI insights for one finished call and writes them to the sheet.
// Safe to call even if Gemini fails after all its retries - we still write
// a clear placeholder rather than silently leaving the row unchanged, and
// any sheet-writing error is caught here so it never breaks /call-status.
// Returns the insights object (or null if it failed) - the caller uses this
// to update the cross-call "Previous Calls" history, see below.
async function generateAndSaveInsights(phone, transcriptText, callNumber) {
  const insights = await generateCallInsights(transcriptText, callNumber);

  try {
    if (insights) {
      await writeAiInsightsToSheet(phone, insights);
    } else {
      await writeAiInsightsFailurePlaceholder(phone);
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

// Where the per-lead call history is persisted, so it survives a restart.
const CALL_HISTORY_FILE_PATH = path.join(__dirname, "call-history.json");

// Reads the whole history file. Returns {} if it doesn't exist yet (e.g.
// the very first call ever) or can't be parsed for some reason.
function loadCallHistory() {
  try {
    return JSON.parse(fs.readFileSync(CALL_HISTORY_FILE_PATH, "utf8"));
  } catch (error) {
    return {};
  }
}

// Adds one compact entry to a lead's history (keyed by normalized phone)
// and saves the whole file straight back to disk.
function appendCallHistoryEntry(phone, entry) {
  const history = loadCallHistory();
  const normalizedPhone = normalizePhoneNumber(phone);

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
//    objection/outcome) to call-history.json - persisted, survives restarts.
// 2. If this ISN'T the lead's first call, asks the AI to fold this call into
//    an updated "Previous Calls" narrative and writes it to the sheet.
// On the first call (callNumber === 1), "Previous Calls" is left blank, per
// the spec - there's no "relationship" to summarize yet.
// Safe to call even if insights is null (the per-call AI attempt failed) -
// there's nothing worth recording in that case, so this just does nothing.
async function updateRelationshipHistory(phone, insights, transcriptText, callNumber) {
  if (!insights) return; // per-call AI attempt failed - nothing to record

  appendCallHistoryEntry(phone, {
    callNumber,
    date: new Date().toLocaleString(),
    temperature: insights.temperature,
    headline: insights.headline,
    concern: insights.concerns,
    outcome: insights.suggestedStage,
  });

  if (callNumber <= 1) return; // first call - "Previous Calls" stays blank

  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });

    const lead = await findLeadRow(sheets, phone);
    if (!lead) {
      console.error("No lead found in the sheet for relationship summary, phone:", phone);
      return;
    }

    const previousCallsCol = getColumnIndex(lead.headers, "previousCalls");
    const existingSummary = lead.row[previousCallsCol] || "";

    const updatedSummary = await generateRelationshipSummary(existingSummary, transcriptText, callNumber);
    if (!updatedSummary) return; // already logged inside the AI provider

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_CONFIG.sheetId,
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

// Places a call to the given phone number and speaks the greeting when answered.
// Returns the Twilio call object (which includes a "sid" - the call's unique ID).
function placeCall(toNumber) {
  return twilioClient.calls.create({
    to: toNumber,
    from: process.env.TWILIO_FROM_NUMBER,
    twiml: buildGreetingTwiml(),
    // Tells Twilio to notify our /call-status endpoint once the call finishes
    statusCallback: CALL_STATUS_CALLBACK_URL,
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

  try {
    const call = await placeCall(to);
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
  const to = process.env.TEST_TO_NUMBER;

  if (!to) {
    return res.status(400).json({ error: "TEST_TO_NUMBER is not set in .env" });
  }

  try {
    const call = await placeCall(to);
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error("Twilio test call failed:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/token: creates a short-lived access token that lets the browser
// itself make calls through Twilio, using the "Voice SDK" (WebRTC).
app.get("/api/token", (req, res) => {
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
// caller ID.
app.post("/voice", (req, res) => {
  const to = req.body.To;
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
    stream.parameter({ name: "leadPhone", value: to });

    const dial = response.dial({ callerId: process.env.TWILIO_FROM_NUMBER });

    // Tells Twilio to notify our /call-status endpoint once this call finishes
    dial.number(
      {
        statusCallback: CALL_STATUS_CALLBACK_URL,
        statusCallbackEvent: ["completed"],
        statusCallbackMethod: "POST",
      },
      to
    );
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

// Where the per-call log is persisted, so it survives a restart.
const CALL_LOG_FILE_PATH = path.join(__dirname, "call-log.json");

// Reads the whole call log. Returns [] if it doesn't exist yet (e.g. the
// very first call ever) or can't be parsed for some reason.
function loadCallLog() {
  try {
    return JSON.parse(fs.readFileSync(CALL_LOG_FILE_PATH, "utf8"));
  } catch (error) {
    return [];
  }
}

// Adds one call record to the log and saves the whole file back to disk.
function appendCallLogEntry(entry) {
  const log = loadCallLog();
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
async function getLeadNameAndTemperature(phone) {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  const lead = await findLeadRow(sheets, phone);
  if (!lead) return { name: "", temperatureValue: null };

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

// GET /api/analytics: computes call-log-based analytics for the dashboard.
// Optional query params:
//   ?from=2026-07-01&to=2026-07-10   - date range (either end can be omitted)
//   ?hourFrom=14&hourTo=16           - time-of-day range, 0-23, BOTH required
//                                       together (e.g. 14-16 = 2pm-4pm)
app.get("/api/analytics", async (req, res) => {
  try {
    const log = loadCallLog();

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
    // so the date/time filters above don't apply to them.
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });
    const { headers, dataRows } = await loadSheetRows(sheets);

    const nameCol = getColumnIndex(headers, "name");
    const phoneCol = getColumnIndex(headers, "phone");
    const temperatureCol = getColumnIndex(headers, "temperature");
    const lastCalledCol = getColumnIndex(headers, "lastCalled");
    const callBackOnCol = getColumnIndex(headers, "callBackOn");
    const firstConnectedCol = getColumnIndex(headers, "firstConnected");

    let callbacksDueNow = 0;
    let callbacksUpcoming = 0;
    const now = new Date();

    dataRows.forEach((row) => {
      const name = row[nameCol] || "";
      const phone = row[phoneCol] || "";
      if (!name && !phone) return; // skip blank rows

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

    res.json({ ...analytics, callbacksDueNow, callbacksUpcoming });
  } catch (error) {
    console.error("Failed to compute analytics:", error.message);
    res.status(500).json({ error: "Failed to compute analytics." });
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
app.post("/call-status", async (req, res) => {
  const { To, CallStatus, SipResponseCode, CallDuration } = req.body;

  console.log("Call finished:", To, CallStatus, SipResponseCode);

  const outcome = mapCallStatusToOutcome(CallStatus, SipResponseCode);

  // Log this call as its own record FIRST, in its own try/catch. This way,
  // a problem further down (sheet update, AI insights) can never stop the
  // call from being recorded for analytics, and a logging hiccup here can
  // never stop the rest of the normal call-handling below.
  try {
    const { name, temperatureValue } = await getLeadNameAndTemperature(To);

    appendCallLogEntry({
      timestamp: new Date().toISOString(), // ISO so it sorts/parses reliably
      phone: normalizePhoneNumber(To),
      name,
      outcome,
      connected: outcome === "Connected",
      // Twilio includes CallDuration (seconds) on the "completed" event -
      // null if it's missing for some reason, rather than a fake 0.
      durationSeconds: CallDuration ? parseInt(CallDuration, 10) : null,
      temperature: temperatureValue,
    });
  } catch (error) {
    console.error("Failed to log call record:", error.message);
  }

  try {
    const callNumber = await updateLeadAfterCall(To, outcome);

    // Grab whatever transcript lines we recorded for this call. We deliberately
    // do NOT delete it here - we keep the most recent call's transcript around
    // in memory so POST /api/regenerate-insights can re-run insights later if
    // this attempt fails. (The next call to this same lead will replace it
    // with a fresh, empty transcript when it starts.)
    const normalizedPhone = normalizePhoneNumber(To);
    const transcriptLines = callTranscripts.get(normalizedPhone) || [];

    if (callNumber && transcriptLines.length > 0) {
      // Save it to a local file too, so it's easy to reuse for testing later
      // via POST /api/test-insights or GET /api/last-transcript - this is
      // "nice to have" only, so a failure here should never break the call.
      try {
        fs.writeFileSync(
          LAST_TRANSCRIPT_FILE_PATH,
          JSON.stringify(
            { phone: To, callNumber, savedAt: new Date().toISOString(), transcript: transcriptLines },
            null,
            2
          )
        );
      } catch (error) {
        console.error("Failed to save last-transcript.json:", error.message);
      }

      const transcriptText = transcriptLinesToText(transcriptLines);
      const insights = await generateAndSaveInsights(To, transcriptText, callNumber);
      await updateRelationshipHistory(To, insights, transcriptText, callNumber);
    }
  } catch (error) {
    console.error("Failed to update sheet after call:", error.message);
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

  const normalizedPhone = normalizePhoneNumber(phone);
  const transcriptLines = callTranscripts.get(normalizedPhone);

  if (!transcriptLines || transcriptLines.length === 0) {
    return res.status(404).json({
      error: "No stored transcript found for this phone number (it may be too old, or the server restarted since that call).",
    });
  }

  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });
    const lead = await findLeadRow(sheets, phone);

    if (!lead) {
      return res.status(404).json({ error: "No lead found in the sheet for this phone number." });
    }

    // Use the lead's current Attempts count as the "call number" - the same
    // number that call would have used the first time insights were generated.
    const attemptsCol = getColumnIndex(lead.headers, "attempts");
    const callNumber = parseInt(lead.row[attemptsCol], 10) || 1;

    const transcriptText = transcriptLinesToText(transcriptLines);
    const insights = await generateAndSaveInsights(phone, transcriptText, callNumber);
    await updateRelationshipHistory(phone, insights, transcriptText, callNumber);

    res.json({ success: true, message: "AI insights regenerated." });
  } catch (error) {
    console.error("Failed to regenerate AI insights:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/last-transcript: returns the most recently saved real call's
// transcript (see last-transcript.json), if one exists yet. Lets the test
// page load a real transcript with one click instead of copy/pasting it.
app.get("/api/last-transcript", (req, res) => {
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
  const { transcript, callNumber } = req.body;

  if (!transcript) {
    return res.status(400).json({ error: "Request body must include a 'transcript'." });
  }

  // Accept either an array of { speaker, text } lines or a plain text block.
  const transcriptText = Array.isArray(transcript)
    ? transcriptLinesToText(transcript)
    : transcript;

  const insights = await generateCallInsights(transcriptText, callNumber || 1);

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
// every browser page that's currently connected and listening.
function broadcastTranscriptLine(speaker, text) {
  const message = JSON.stringify({ speaker, text });

  for (const client of browserFeedClients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

// Sends one live coaching tip to every browser page currently connected.
// Uses a "type: tip" field (transcript-line messages have no "type" field)
// so the frontend can tell the two apart on the same /browser-feed socket.
function broadcastCoachingTip(text) {
  const message = JSON.stringify({ type: "tip", text });

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
// `getLabel` is a function we call to look up the current Rep/Lead label for
// this track (it starts out unknown and gets filled in dynamically - see
// assignSpeakerLabels below).
// `onSpeech` is called every time this track produces a real transcript, so
// the caller can notice "someone just spoke" and assign labels if needed.
// `onFinalLine` is called with the finished "Rep: ..."/"Lead: ..." line each
// time a FINAL result comes in, so the caller can save it for AI insights.
async function openDeepgramConnection(track, getLabel, onSpeech, onFinalLine) {
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
        broadcastTranscriptLine(label, transcript);
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

      const tip = await generateCoachingTip(recentText, lastCoachingTip);
      if (!tip) return; // the common case - AI decided nothing was worth flagging

      // Defensive check: even though the prompt tells the AI not to repeat
      // the last tip, don't trust it blindly - never show the exact same
      // tip twice in a row.
      if (tip.trim() === (lastCoachingTip || "").trim()) return;

      lastCoachingTip = tip;
      broadcastCoachingTip(tip);
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

  ws.on("message", async (message) => {
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
          openDeepgramConnection(track, getLabel, assignSpeakerLabels, recordFinalLine)
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

      if (connection) {
        // Twilio sends audio as base64 text - decode it back to raw bytes.
        const audioBytes = Buffer.from(data.media.payload, "base64");
        connection.sendMedia(audioBytes);
      }
    } else if (data.event === "stop") {
      console.log("Media stream event: stop (audio stream ended)");
      closeTrackConnections(trackConnections);
      clearInterval(coachingIntervalHandle);
    }
  });

  ws.on("close", () => {
    console.log("Media stream: connection closed");
    closeTrackConnections(trackConnections);
    clearInterval(coachingIntervalHandle);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
