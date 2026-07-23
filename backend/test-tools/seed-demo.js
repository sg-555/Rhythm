// Populates a DEMO Google Sheet + backend/call-log.demo.json with a large,
// realistic-looking batch of fake sales data - leads across every stage and
// temperature, and several hundred call-log records spread over the last 30
// days - so DEMO MODE (see demo.js) and its Analytics dashboard look like a
// real, active sales operation for a portfolio demo.
//
// Usage:
//   node test-tools/seed-demo.js <DEMO_SHEET_ID>
//
// Safety:
// - Refuses to run if <DEMO_SHEET_ID> matches DEFAULT_SHEET_ID from .env -
//   this script clears and rewrites the WHOLE first sheet of whatever ID
//   you give it, so it must never be pointed at your real sheet.
// - Writes to call-log.demo.json, a completely separate file from the real
//   call-log.json - your real call history is never read or touched.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");
const { google } = require("googleapis");

// ── Safety guard ─────────────────────────────────────────────────────────
const demoSheetId = process.argv[2];
if (!demoSheetId) {
  console.error("Usage: node test-tools/seed-demo.js <DEMO_SHEET_ID>");
  process.exit(1);
}
if (process.env.DEFAULT_SHEET_ID && demoSheetId === process.env.DEFAULT_SHEET_ID) {
  console.error(
    "Refusing to run: that ID matches DEFAULT_SHEET_ID in your .env (your real sheet).\n" +
      "Pass a separate, dedicated demo sheet's ID instead."
  );
  process.exit(1);
}

// ── Auth (same pattern as server.js) ────────────────────────────────────
const KEY_FILE_PATH = path.join(__dirname, "..", "..", "google-key.json");
const googleAuthOptions = {
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
};
if (process.env.GOOGLE_KEY_JSON) {
  googleAuthOptions.credentials = JSON.parse(process.env.GOOGLE_KEY_JSON);
} else {
  googleAuthOptions.keyFile = KEY_FILE_PATH;
}
const auth = new GoogleAuth(googleAuthOptions);

// ── Column layout (must match SHEET_CONFIG.columns in server.js) ───────
const COLUMNS = [
  "Name",
  "Phone",
  "Stage",
  "Last outcome",
  "Attempts",
  "Last called",
  "First Connected",
  "Notes",
  "Temperature",
  "AI Notes",
  "Previous Calls",
  "Call Back On",
];

const STAGES = ["New", "Interested", "Follow-up", "Not Interested", "Closed/Won"];

// Real outcome strings, exactly as mapCallStatusToOutcome() in server.js
// produces them - the analytics dashboard groups by this exact text.
const OUTCOMES = ["Connected", "No answer", "Busy", "Switched off / unreachable", "Invalid number", "Failed"];

// Base share of calls landing in each outcome bucket, tuned to sit inside
// the ranges a real (if fairly successful) solo sales operation sees.
// These are adjusted per-call below by time-of-day and lead temperature,
// then renormalized - so the FINAL mix drifts a little from these exact
// numbers, which is itself realistic.
const BASE_OUTCOME_WEIGHTS = {
  Connected: 42,
  "No answer": 30,
  Busy: 10,
  "Switched off / unreachable": 8,
  "Invalid number": 3,
  Failed: 7,
};

// ── Small helpers ────────────────────────────────────────────────────────
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}
function weightedPick(weights) {
  // weights: { key: number, ... }
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, w]) => sum + Math.max(w, 0), 0);
  let roll = Math.random() * total;
  for (const [key, w] of entries) {
    roll -= Math.max(w, 0);
    if (roll <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

// Relative call VOLUME by hour of day - shaped like a real calling day:
// nothing overnight, ramping up through the morning, a small lunch dip,
// a second (bigger) push in the afternoon, tapering into the evening.
const HOUR_VOLUME_WEIGHTS = [
  0, 0, 0, 0, 0, 0, // 0-5
  1, 3, 6, 10, 14, 15, // 6-11
  8, 8, 12, 15, 14, 10, // 12-17
  6, 3, 2, 1, 0, 0, // 18-23
];

// Relative PICK-UP likelihood by hour - people are more reachable
// mid-morning and mid/late afternoon than very early or after dinner.
const HOUR_PICKUP_MULTIPLIER = [
  1, 1, 1, 1, 1, 1, // 0-5 (unused - no volume there anyway)
  0.5, 0.6, 0.7, 0.9, 1.2, 1.3, // 6-11
  0.9, 0.9, 1.1, 1.3, 1.2, 1.0, // 12-17
  0.8, 0.6, 0.5, 0.4, 1, 1, // 18-23
];

function pickHour() {
  const weights = {};
  HOUR_VOLUME_WEIGHTS.forEach((w, hour) => (weights[hour] = w));
  return parseInt(weightedPick(weights), 10);
}

// Picks an outcome for one call, given the hour it happened and the lead's
// temperature - both nudge the Connected chance up or down, then whatever
// probability mass that frees up (or removes) is redistributed across the
// other outcomes proportionally to their base weights.
function pickOutcome(hour, temperatureValue) {
  let connectMultiplier = HOUR_PICKUP_MULTIPLIER[hour] || 1;
  if (temperatureValue >= 4) connectMultiplier *= 1.15; // hot leads pick up more
  else if (temperatureValue <= 1) connectMultiplier *= 0.85; // cold leads less

  const weights = { ...BASE_OUTCOME_WEIGHTS };
  weights.Connected = BASE_OUTCOME_WEIGHTS.Connected * connectMultiplier;

  return weightedPick(weights);
}

// Weekdays get far more call volume than weekends, like a real solo rep's
// week. Returns a day offset (0 = today, 29 = 29 days ago).
function pickDayOffset() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const offset = randInt(0, 29);
    const day = new Date();
    day.setDate(day.getDate() - offset);
    const isWeekend = day.getDay() === 0 || day.getDay() === 6;
    if (!isWeekend || Math.random() < 0.2) return offset; // ~20% of weekend days kept
  }
  return randInt(0, 29); // fallback, just in case
}

function durationForConnectedCall() {
  // A mix of short calls (quick "not interested" / gatekeeper) and real
  // conversations, roughly 45/55.
  return Math.random() < 0.45 ? randInt(12, 90) : randInt(90, 620);
}

function temperatureWord(temperature) {
  if (temperature <= 1) return "Cold";
  if (temperature <= 3) return "Warm";
  return "Hot";
}

// ── Fake lead identity data ──────────────────────────────────────────────
const FIRST_NAMES = [
  "Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Reyansh", "Krishna", "Ishaan",
  "Rohan", "Kabir", "Ananya", "Diya", "Saanvi", "Aadhya", "Myra", "Anika",
  "Priya", "Neha", "Riya", "Kavya", "Karan", "Rahul", "Sanjay", "Vikram",
  "Nikhil", "Amit", "Pooja", "Shreya", "Meera", "Divya",
];
const LAST_NAMES = [
  "Sharma", "Verma", "Gupta", "Mehta", "Nair", "Iyer", "Reddy", "Rao",
  "Kapoor", "Malhotra", "Chopra", "Bose", "Das", "Joshi", "Kulkarni",
  "Patil", "Shah", "Agarwal", "Bhatia", "Chauhan",
];

function buildLeadNames(count) {
  const combos = [];
  for (const first of FIRST_NAMES) {
    for (const last of LAST_NAMES) combos.push(`${first} ${last}`);
  }
  // Shuffle and take the first `count` - guarantees no repeats up to 600 combos.
  for (let i = combos.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [combos[i], combos[j]] = [combos[j], combos[i]];
  }
  return combos.slice(0, count);
}

// Synthetic Indian mobile numbers. Not real subscriber numbers - just
// enough unique fake digits, formatted the way this app expects.
function buildFakePhones(count) {
  const phones = [];
  const used = new Set();
  while (phones.length < count) {
    const number = "9" + String(randInt(0, 999999999)).padStart(9, "0");
    if (used.has(number)) continue;
    used.add(number);
    phones.push(`+91 ${number.slice(0, 5)}-${number.slice(5)}`);
  }
  return phones;
}

// ── AI Notes / Previous Calls copy pools (kept short + plausible) ───────
const HEADLINES = {
  hot: ["Ready to move, just needs final sign-off", "Very engaged, comparing final terms", "Strong buying signals, wants next steps"],
  warm: ["Interested but still deciding", "Cautiously positive, has open questions", "Warming up, needs more convincing"],
  cold: ["Lukewarm at best, low urgency", "Politely non-committal", "Hard to gauge real interest"],
};
const POSITIVES = [
  "liked the pricing flexibility", "responded well to the case study", "engaged actively and asked good questions",
  "confirmed budget is available this quarter", "seemed relieved to find a simpler option",
];
const CONCERNS = [
  "still comparing against a competitor", "worried about onboarding time", "needs sign-off from a manager",
  "hesitant about contract length", "unsure if timing is right",
];
const COMMITMENTS = [
  "will review the proposal and call back", "agreed to a follow-up demo", "will loop in their manager",
  "asked for a written quote", "will confirm budget internally",
];
const NEXT_CALLS = [
  "Follow up on the proposal review", "Check in after they've spoken to their manager", "Send the written quote and follow up",
  "Confirm if budget was approved", "Re-engage with a case study relevant to their industry",
];
const RESEARCH_PREPS = [
  "Look up their company's recent funding news", "Prepare a comparison vs their current vendor",
  "Have pricing tiers ready to discuss", "None needed, straightforward follow-up",
];
const PREVIOUS_CALLS_TEMPLATES = [
  (name) => `${name} has been contacted multiple times. Interest has grown gradually across calls, with each conversation clarifying requirements a bit further.`,
  (name) => `Relationship with ${name} started lukewarm but has warmed up steadily. They've become more responsive and specific about their needs over recent calls.`,
  (name) => `${name} remains cautious across all calls so far, engaging but not yet committing. Consistent follow-up has kept the door open.`,
  (name) => `${name} has gone back and forth on urgency. Some calls were promising, others noncommittal - a longer sales cycle than most leads.`,
];

function buildAiNotesBlock(temperatureValue) {
  const band = temperatureValue >= 4 ? "hot" : temperatureValue >= 2 ? "warm" : "cold";
  const headline = pick(HEADLINES[band]);
  return [
    `🌡️ ${temperatureValue} (${temperatureWord(temperatureValue)}) — ${headline}`,
    `✅ Positives: ${pick(POSITIVES)}`,
    `⚠️ Concerns: ${pick(CONCERNS)}`,
    `🤝 Agreed: ${pick(COMMITMENTS)}`,
    `👉 Next call: ${pick(NEXT_CALLS)}`,
    `🔍 Research/Prep: ${pick(RESEARCH_PREPS)}`,
  ].join("\n");
}

// Picks a stage that's logically consistent with a temperature - Hot leads
// skew toward Interested/Follow-up/Closed-Won, Cold toward New/Not
// Interested, Warm mostly in the middle - not a hard rule, just weighted.
function pickStageForTemperature(temperatureValue) {
  if (temperatureValue >= 4) {
    return weightedPick({ Interested: 35, "Follow-up": 35, "Closed/Won": 25, New: 5 });
  }
  if (temperatureValue >= 2) {
    return weightedPick({ Interested: 30, "Follow-up": 35, New: 20, "Closed/Won": 5, "Not Interested": 10 });
  }
  return weightedPick({ New: 35, "Not Interested": 45, "Follow-up": 15, Interested: 5 });
}

// Attempts (= number of call-log entries we'll generate for this lead)
// ranges by stage - reflects the "many calls to close" reality: Closed/Won
// and Not Interested leads have the most calls invested, brand New leads
// the fewest.
function attemptsRangeForStage(stage) {
  switch (stage) {
    case "New":
      return [1, 3];
    case "Interested":
      return [4, 12];
    case "Follow-up":
      return [5, 14];
    case "Not Interested":
      return [6, 16];
    case "Closed/Won":
      return [8, 20];
    default:
      return [1, 5];
  }
}

// ── Build one lead + its call-log entries ───────────────────────────────
function buildLead(name, phone) {
  const temperatureValue = randInt(0, 5);
  const stage = pickStageForTemperature(temperatureValue);
  const [minAttempts, maxAttempts] = attemptsRangeForStage(stage);
  const attempts = randInt(minAttempts, maxAttempts);

  const normalizedPhone = phone.replace(/\D/g, "");
  const calls = [];
  for (let i = 0; i < attempts; i++) {
    const hour = pickHour();
    const dayOffset = pickDayOffset();
    const callDate = new Date();
    callDate.setDate(callDate.getDate() - dayOffset);
    callDate.setHours(hour, randInt(0, 59), randInt(0, 59), 0);

    const outcome = pickOutcome(hour, temperatureValue);
    calls.push({
      timestamp: callDate,
      outcome,
      connected: outcome === "Connected",
      durationSeconds: outcome === "Connected" ? durationForConnectedCall() : null,
    });
  }

  // Stages beyond "New" imply we've actually spoken to this lead before -
  // force at least one Connected call so that's never contradicted.
  const hasConnect = calls.some((c) => c.connected);
  if (stage !== "New" && !hasConnect) {
    const forced = pick(calls);
    forced.outcome = "Connected";
    forced.connected = true;
    forced.durationSeconds = durationForConnectedCall();
  }

  calls.sort((a, b) => a.timestamp - b.timestamp);

  const connectedCalls = calls.filter((c) => c.connected);
  const lastCall = calls[calls.length - 1];
  const firstConnectedCall = connectedCalls[0];

  const lastOutcome = lastCall.outcome;
  const lastCalledText = lastCall.timestamp.toLocaleString();
  const firstConnectedText = firstConnectedCall ? firstConnectedCall.timestamp.toLocaleString() : "";

  // Call Back On: only possible for leads we've actually connected with -
  // matches computeCallbackDue()'s gate in server.js. About 40% of those
  // get one, split between overdue, later today, and later this week.
  let callBackOnText = "";
  if (firstConnectedCall && Math.random() < 0.4) {
    const callBack = new Date();
    const bucket = weightedPick({ overdue: 35, today: 25, thisWeek: 40 });
    if (bucket === "overdue") callBack.setDate(callBack.getDate() - randInt(1, 5));
    else if (bucket === "today") callBack.setHours(callBack.getHours() + randInt(1, 6));
    else callBack.setDate(callBack.getDate() + randInt(1, 6));
    callBackOnText = callBack.toLocaleString();
  }

  const aiNotes = firstConnectedCall ? buildAiNotesBlock(temperatureValue) : "";
  const previousCalls = connectedCalls.length >= 2 ? pick(PREVIOUS_CALLS_TEMPLATES)(name) : "";
  const notes = Math.random() < 0.35 ? pick(["Prefers WhatsApp for follow-ups", "Best reached after 3pm", "Referred by an existing customer", "Asked not to be called before 11am"]) : "";

  const row = [
    name,
    phone,
    stage,
    lastOutcome,
    attempts,
    lastCalledText,
    firstConnectedText,
    notes,
    `${temperatureValue} (${temperatureWord(temperatureValue)})`,
    aiNotes,
    previousCalls,
    callBackOnText,
  ];

  const callLogEntries = calls.map((call) => ({
    timestamp: call.timestamp.toISOString(),
    phone: normalizedPhone,
    name,
    outcome: call.outcome,
    connected: call.connected,
    durationSeconds: call.durationSeconds,
    temperature: temperatureValue,
  }));

  return { row, callLogEntries };
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const LEAD_COUNT = randInt(40, 60);
  const names = buildLeadNames(LEAD_COUNT);
  const phones = buildFakePhones(LEAD_COUNT);

  const rows = [];
  let callLog = [];

  for (let i = 0; i < LEAD_COUNT; i++) {
    const { row, callLogEntries } = buildLead(names[i], phones[i]);
    rows.push(row);
    callLog = callLog.concat(callLogEntries);
  }

  // Keep the overall call-log volume in the requested 400-800 range
  // regardless of how the per-lead random draws landed.
  if (callLog.length < 400 || callLog.length > 800) {
    const target = randInt(450, 750);
    const scale = target / callLog.length;
    if (scale < 1) {
      // Trim down to target, spread across leads rather than all from one.
      callLog.sort(() => Math.random() - 0.5);
      callLog = callLog.slice(0, target);
    } else {
      // Duplicate a random subset with fresh, slightly-jittered timestamps
      // to reach the target without just cloning identical entries.
      const extra = target - callLog.length;
      for (let i = 0; i < extra; i++) {
        const source = pick(callLog);
        const jittered = new Date(source.timestamp);
        jittered.setMinutes(jittered.getMinutes() + randInt(-90, 90));
        callLog.push({ ...source, timestamp: jittered.toISOString() });
      }
    }
  }

  callLog.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  console.log(`Generated ${rows.length} leads and ${callLog.length} call-log entries.`);

  // ── Write the demo sheet ──────────────────────────────────────────────
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  await sheets.spreadsheets.values.clear({
    spreadsheetId: demoSheetId,
    range: "A1:Z10000",
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: demoSheetId,
    range: "A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [COLUMNS, ...rows] },
  });

  console.log(`Wrote ${rows.length} leads to demo sheet ${demoSheetId}.`);

  // ── Write call-log.demo.json (a separate file - never the real one) ────
  const demoCallLogPath = path.join(__dirname, "..", "call-log.demo.json");
  fs.writeFileSync(demoCallLogPath, JSON.stringify(callLog, null, 2));
  console.log(`Wrote ${callLog.length} call-log entries to ${demoCallLogPath}`);

  console.log("\nDone. Visit /demo (or click \"View Demo\" on the sign-in screen) to see the seeded demo data.");
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
