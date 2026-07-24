// Handles "Sign in with Google": exchanging the OAuth2 code for tokens,
// persisting each user's tokens/profile to a local JSON file, and simple
// cookie-based sessions so the app knows who's currently signed in.
//
// This is a separate small file (like ai/ and sms/) so server.js doesn't
// need to know HOW sign-in works - it just calls the functions exported here.
//
// NOTE FOR LATER: user storage below is a plain JSON file, and sessions are
// just an in-memory list - both are placeholders for a real database and a
// proper session store. They're written so swapping either one out later
// only touches this one file, not server.js or the frontend.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { google } = require("googleapis");
const db = require("./db");

// ── Google OAuth2 client ─────────────────────────────────────────────────
// This is what talks to Google to build the sign-in URL and exchange the
// one-time code Google sends back for real access/refresh tokens.
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// The narrowest scopes that still let us create a Google Sheet for each
// user and read/write it:
// - userinfo.email / userinfo.profile: just enough to know who signed in
//   (their email + name) - not their whole Google identity.
// - drive.file: only gives access to files THIS APP creates or opens, not
//   the user's entire Drive - covers "Create my Rhythm sheet" fully. The
//   broader "spreadsheets"/"drive" scopes would ALSO let us read/write an
//   existing sheet the user just pastes a URL/ID for, but those are
//   Google-restricted scopes (a scarier consent screen, and required
//   verification for public use) - not worth it for a feature that isn't
//   built yet. See the onboarding screen's "coming soon" note.
const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/drive.file",
];

// Builds the URL we send the browser to, to start "Sign in with Google".
function getGoogleAuthUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: "offline", // "offline" is what makes Google hand us a refresh token
    prompt: "consent", // always re-show the consent screen, so we reliably GET that refresh token
    scope: GOOGLE_OAUTH_SCOPES,
  });
}

// Exchanges the one-time "code" Google sent back (in the callback URL) for
// real tokens, then asks Google whose tokens they are (email/name). Throws
// if anything goes wrong - server.js's callback route catches that.
async function exchangeCodeForUser(code) {
  const { tokens } = await oauth2Client.getToken(code);

  // A short-lived client, just so we can ask Google "whose tokens are these?"
  const authedClient = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  authedClient.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: "v2", auth: authedClient });
  const { data: profile } = await oauth2.userinfo.get();

  return { tokens, profile };
}

// ── User storage ─────────────────────────────────────────────────────────
// Dual-mode: a real Postgres database (db.isDatabaseMode - see db.js) when
// DATABASE_URL is set, or a local users.json file otherwise. This matters
// because Render's filesystem is EPHEMERAL - it's wiped on every restart,
// so a deployed instance storing sheetId/tokens/theme in a plain file would
// quietly lose them every time the instance sleeps or redeploys. The
// database survives that; the JSON file is only for running locally
// without needing Postgres installed.
//
// Every function below has the SAME signature and return shape regardless
// of which mode is active - callers in server.js never need to know or
// care which one they're talking to. All of them are now async (even the
// JSON-file path), since a real database call always is - this keeps the
// two modes interchangeable instead of one being sync and one async.
const USERS_FILE_PATH = path.join(__dirname, "users.json");

// Reads every stored user from the JSON file. Returns {} if it doesn't
// exist yet (e.g. nobody has ever signed in) or can't be parsed for some
// reason. Only ever used in JSON-file mode.
function loadUsersFile() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE_PATH, "utf8"));
  } catch (error) {
    return {};
  }
}

function saveUsersFile(users) {
  fs.writeFileSync(USERS_FILE_PATH, JSON.stringify(users, null, 2));
}

// Turns one database row (snake_case columns) into the same camelCase
// shape the JSON-file path already returns, so the rest of the app never
// has to know which mode produced a given user object.
function rowToUser(row) {
  if (!row) return null;
  return {
    email: row.email,
    name: row.name || "",
    picture: row.picture || null,
    company: row.company || "",
    sheetId: row.sheet_id || null,
    phoneColumnFormatted: row.phone_column_formatted || false,
    theme: row.theme || null,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    // Postgres returns BIGINT columns as strings (so huge values never
    // silently lose precision in JS) - this one's a millisecond timestamp,
    // safely within a normal JS number, so converting back is fine.
    tokenExpiryDate: row.token_expiry === null || row.token_expiry === undefined ? null : Number(row.token_expiry),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

// Saves (or updates) one user's record from a fresh sign-in, and returns it.
async function saveUser(email, tokens, profile) {
  if (db.isDatabaseMode) {
    try {
      // A single INSERT ... ON CONFLICT is atomic - no separate "read the
      // existing row first" step needed (unlike the JSON path below), and
      // no race window where a concurrent write could clobber another
      // field. Columns NOT listed in DO UPDATE SET (company, sheet_id,
      // theme, phone_column_formatted) are simply left alone on conflict -
      // that's what "never touched here, so re-signing in never loses it"
      // means for each of those fields.
      const result = await db.query(
        `INSERT INTO users (email, name, picture, company, sheet_id, theme, phone_column_formatted, access_token, refresh_token, token_expiry)
         VALUES ($1, $2, $3, '', NULL, NULL, FALSE, $4, $5, $6)
         ON CONFLICT (email) DO UPDATE SET
           name = EXCLUDED.name,
           picture = COALESCE(EXCLUDED.picture, users.picture),
           access_token = EXCLUDED.access_token,
           refresh_token = COALESCE(EXCLUDED.refresh_token, users.refresh_token),
           token_expiry = EXCLUDED.token_expiry
         RETURNING *`,
        [email, profile.name || "", profile.picture || null, tokens.access_token, tokens.refresh_token || null, tokens.expiry_date || null]
      );
      return rowToUser(result.rows[0]);
    } catch (error) {
      console.error("Failed to save user to database:", error.message);
      throw error; // the OAuth callback needs to know sign-in didn't actually persist
    }
  }

  const users = loadUsersFile();
  const existing = users[email] || {};

  users[email] = {
    email,
    name: profile.name || "",
    // Google's profile photo URL, shown in the profile menu - null if
    // Google didn't send one (rare, but not every account has a photo).
    picture: profile.picture || existing.picture || null,
    // The rep's own company/organisation, set via POST /api/profile - never
    // touched here, so re-signing in doesn't erase it.
    company: existing.company || "",
    // This user's OWN Google Sheet ID (see server.js's onboarding
    // endpoints) - null until they create or connect one. Never touched
    // here either, so re-signing in never loses it.
    sheetId: existing.sheetId || null,
    // True once the Phone column has been set to plain-text format (so a
    // leading "+" is never misread as a formula) - see
    // applyPhoneColumnPlainTextFormat() in server.js. Lets that fix-up run
    // at most once per user instead of on every request.
    phoneColumnFormatted: existing.phoneColumnFormatted || false,
    // "light", "dark", or null (= follow system preference) - set via the
    // profile panel's theme toggle. Never touched here, so re-signing in
    // never loses it.
    theme: existing.theme || null,
    accessToken: tokens.access_token,
    // Google only sends a refresh_token the FIRST time you consent (or
    // whenever we force prompt=consent, like we do above) - if THIS sign-in
    // didn't include one, keep whatever we already had saved instead of
    // losing it.
    refreshToken: tokens.refresh_token || existing.refreshToken || null,
    tokenExpiryDate: tokens.expiry_date || null,
    createdAt: existing.createdAt || new Date().toISOString(),
  };

  saveUsersFile(users);
  return users[email];
}

// Looks up one user by email. Returns null if we've never seen them.
async function getUser(email) {
  if (db.isDatabaseMode) {
    try {
      const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
      return rowToUser(result.rows[0]);
    } catch (error) {
      console.error("Failed to read user from database:", error.message);
      return null;
    }
  }

  return loadUsersFile()[email] || null;
}

// Updates just the company/organisation field for one user (the profile
// menu's editable field). Returns the updated user, or null if we've never
// seen this email before.
async function updateUserCompany(email, company) {
  if (db.isDatabaseMode) {
    try {
      const result = await db.query("UPDATE users SET company = $1 WHERE email = $2 RETURNING *", [company, email]);
      return rowToUser(result.rows[0]);
    } catch (error) {
      console.error("Failed to update company in database:", error.message);
      return null;
    }
  }

  const users = loadUsersFile();
  if (!users[email]) return null;

  users[email].company = company;
  saveUsersFile(users);
  return users[email];
}

// Saves which Google Sheet this user's Rhythm data lives in - set once,
// either by creating a brand-new sheet or connecting an existing one (see
// the /api/onboarding/* routes in server.js). Returns the updated user, or
// null if we've never seen this email before.
async function updateUserSheetId(email, sheetId) {
  if (db.isDatabaseMode) {
    try {
      const result = await db.query("UPDATE users SET sheet_id = $1 WHERE email = $2 RETURNING *", [sheetId, email]);
      return rowToUser(result.rows[0]);
    } catch (error) {
      console.error("Failed to update sheetId in database:", error.message);
      return null;
    }
  }

  const users = loadUsersFile();
  if (!users[email]) return null;

  users[email].sheetId = sheetId;
  saveUsersFile(users);
  return users[email];
}

// Updates just the theme preference for one user (the profile panel's
// toggle). Pass null to go back to "follow system preference". Returns the
// updated user, or null if we've never seen this email before.
async function updateUserTheme(email, theme) {
  if (db.isDatabaseMode) {
    try {
      const result = await db.query("UPDATE users SET theme = $1 WHERE email = $2 RETURNING *", [theme || null, email]);
      return rowToUser(result.rows[0]);
    } catch (error) {
      console.error("Failed to update theme in database:", error.message);
      return null;
    }
  }

  const users = loadUsersFile();
  if (!users[email]) return null;

  users[email].theme = theme || null;
  saveUsersFile(users);
  return users[email];
}

// Marks the Phone-column plain-text fix-up as done for one user, so it
// never runs again for them - see applyPhoneColumnPlainTextFormat() and
// getSheetsContextForUser() in server.js.
async function updateUserPhoneColumnFormatted(email) {
  if (db.isDatabaseMode) {
    try {
      const result = await db.query(
        "UPDATE users SET phone_column_formatted = TRUE WHERE email = $1 RETURNING *",
        [email]
      );
      return rowToUser(result.rows[0]);
    } catch (error) {
      console.error("Failed to update phoneColumnFormatted in database:", error.message);
      return null;
    }
  }

  const users = loadUsersFile();
  if (!users[email]) return null;

  users[email].phoneColumnFormatted = true;
  saveUsersFile(users);
  return users[email];
}

// Persists a freshly-refreshed access token (and its new expiry) for one
// user. Called automatically whenever getUserOAuthClient()'s client
// refreshes itself behind the scenes - see below - so the NEXT request
// doesn't have to refresh again right away. Silently does nothing if the
// user has since been removed (e.g. hand-edited data) - losing one
// refreshed token is harmless, since the next request just refreshes again.
async function updateUserTokens(email, accessToken, expiryDate) {
  if (db.isDatabaseMode) {
    try {
      await db.query("UPDATE users SET access_token = $1, token_expiry = $2 WHERE email = $3", [
        accessToken,
        expiryDate || null,
        email,
      ]);
    } catch (error) {
      console.error("Failed to update tokens in database:", error.message);
    }
    return;
  }

  const users = loadUsersFile();
  if (!users[email]) return;

  users[email].accessToken = accessToken;
  users[email].tokenExpiryDate = expiryDate || null;
  saveUsersFile(users);
}

// ── Multiple sheets per user ─────────────────────────────────────────────
// A user can now have MORE than one Rhythm sheet (e.g. one per quarter's
// lead list) and switch between them. WHICH one is active is still just
// users.sheetId, completely unchanged - every existing sheet-reading code
// path in server.js keeps working exactly as before, since it only ever
// reads user.sheetId. This section is only the LIST to switch between, and
// the handful of operations on it (add one, rename one).

function rowToSheet(row) {
  if (!row) return null;
  return {
    sheetId: row.sheet_id,
    name: row.name,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

// Returns every sheet this user has, oldest first. MIGRATION: anyone who
// connected their (single) sheet before this feature existed has a
// sheetId on their user record but no rows here yet - the first time this
// is called for them, it backfills ONE entry from that existing sheetId,
// named "Rhythm Leads" (the name every sheet gets at creation anyway), so
// their existing sheet becomes their first, active sheet in the new list -
// exactly what "migrate existing users" means here. After that first
// backfill, this table is the real source of truth.
async function getSheetsForUser(email) {
  if (db.isDatabaseMode) {
    try {
      let result = await db.query(
        "SELECT sheet_id, name, created_at FROM sheets WHERE user_email = $1 ORDER BY created_at",
        [email]
      );

      if (result.rows.length === 0) {
        const user = await getUser(email);
        if (user && user.sheetId) {
          // "WHERE NOT EXISTS" makes this insert safe to run more than once
          // (e.g. two requests racing to backfill at the same moment) -
          // whichever runs second just does nothing instead of creating a
          // duplicate row for the same sheet.
          await db.query(
            `INSERT INTO sheets (user_email, sheet_id, name, created_at)
             SELECT $1, $2, $3, $4::timestamptz
             WHERE NOT EXISTS (SELECT 1 FROM sheets WHERE user_email = $1 AND sheet_id = $2)`,
            [email, user.sheetId, "Rhythm Leads", user.createdAt || new Date().toISOString()]
          );
          result = await db.query(
            "SELECT sheet_id, name, created_at FROM sheets WHERE user_email = $1 ORDER BY created_at",
            [email]
          );
        }
      }

      return result.rows.map(rowToSheet);
    } catch (error) {
      console.error("Failed to load sheets list from database:", error.message);
      return [];
    }
  }

  const users = loadUsersFile();
  const user = users[email];
  if (!user) return [];

  if (!user.sheets) user.sheets = [];

  if (user.sheets.length === 0 && user.sheetId) {
    user.sheets.push({ sheetId: user.sheetId, name: "Rhythm Leads", createdAt: user.createdAt || new Date().toISOString() });
    saveUsersFile(users);
  }

  return user.sheets;
}

// Adds a newly-created sheet to a user's list (does NOT make it active -
// call updateUserSheetId() separately for that, same as onboarding does).
// Returns the new entry, or null if we've never seen this email before.
async function addSheetForUser(email, sheetId, name) {
  if (db.isDatabaseMode) {
    try {
      const result = await db.query(
        "INSERT INTO sheets (user_email, sheet_id, name) VALUES ($1, $2, $3) RETURNING sheet_id, name, created_at",
        [email, sheetId, name]
      );
      return rowToSheet(result.rows[0]);
    } catch (error) {
      console.error("Failed to add sheet to database:", error.message);
      return null;
    }
  }

  const users = loadUsersFile();
  if (!users[email]) return null;

  if (!users[email].sheets) users[email].sheets = [];
  const entry = { sheetId, name, createdAt: new Date().toISOString() };
  users[email].sheets.push(entry);
  saveUsersFile(users);
  return entry;
}

// Renames one of a user's sheets WITHIN RHYTHM ONLY - this is just the
// display name shown in "My sheets", never the underlying Google file's own
// title. Returns the updated entry, or null if that sheetId isn't actually
// one of this user's sheets.
async function renameSheetForUser(email, sheetId, newName) {
  if (db.isDatabaseMode) {
    try {
      const result = await db.query(
        "UPDATE sheets SET name = $1 WHERE user_email = $2 AND sheet_id = $3 RETURNING sheet_id, name, created_at",
        [newName, email, sheetId]
      );
      return rowToSheet(result.rows[0]);
    } catch (error) {
      console.error("Failed to rename sheet in database:", error.message);
      return null;
    }
  }

  const users = loadUsersFile();
  const user = users[email];
  if (!user || !user.sheets) return null;

  const entry = user.sheets.find((sheet) => sheet.sheetId === sheetId);
  if (!entry) return null;

  entry.name = newName;
  saveUsersFile(users);
  return entry;
}

// Builds a Google API client authenticated as ONE specific user, using
// THEIR OWN stored OAuth tokens - never the service account. This is what
// makes per-user sheets possible: every Sheets API call made with this
// client only ever touches files that user themselves has authorised
// (their own "Rhythm Leads" sheet, or one they've explicitly connected).
//
// If the access token has expired, the underlying google-auth-library
// client automatically uses the refresh token to get a new one the next
// time it's used - we just listen for that ("tokens" event) and persist the
// new access token back to users.json via updateUserTokens above, so it's
// ready to reuse next time without refreshing again. If the refresh token
// itself has been revoked (e.g. the user removed Rhythm's access in their
// Google Account settings), that first real API call will fail with an
// auth error - server.js's handleSheetsError() turns that into a "please
// sign in again" response rather than a silent/generic failure.
function getUserOAuthClient(user) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  client.setCredentials({
    access_token: user.accessToken,
    refresh_token: user.refreshToken,
    expiry_date: user.tokenExpiryDate,
  });

  client.on("tokens", (tokens) => {
    if (tokens.access_token) {
      // Fire-and-forget: this listener isn't async, and nothing needs to
      // wait for the persisted copy before continuing to use the client -
      // updateUserTokens() already catches its own errors internally, this
      // is just a safety net for anything unexpected slipping through.
      updateUserTokens(user.email, tokens.access_token, tokens.expiry_date).catch((error) => {
        console.error("Failed to persist a refreshed token:", error.message);
      });
    }
  });

  return client;
}

// ── Sessions ──────────────────────────────────────────────────────────────
// A signed-in browser gets a random session ID in a cookie; we keep a
// simple in-memory map from that ID to the user's email. Sessions don't
// survive a server restart yet (you'd just sign in again) - that's a fine
// trade-off for now, per the "keep it simple" instruction.
const sessions = new Map(); // sessionId -> email

const SESSION_COOKIE_NAME = "rhythm_session";

// Creates a new session for this email and returns its ID (to put in a cookie).
function createSession(email) {
  const sessionId = crypto.randomBytes(24).toString("hex");
  sessions.set(sessionId, email);
  return sessionId;
}

// Ends one session (used on sign-out).
function destroySession(sessionId) {
  sessions.delete(sessionId);
}

// Pulls the session cookie's value straight out of the raw "Cookie" request
// header - simple enough that we don't need an extra npm package for it.
function readSessionIdFromRequest(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const match = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(SESSION_COOKIE_NAME + "="));

  return match ? match.slice((SESSION_COOKIE_NAME + "=").length) : null;
}

// Looks up the currently signed-in user (or null) from a request's cookie.
async function getCurrentUser(req) {
  const sessionId = readSessionIdFromRequest(req);
  if (!sessionId) return null;

  const email = sessions.get(sessionId);
  if (!email) return null;

  return getUser(email);
}

// Writes the session cookie onto the response. HttpOnly means page
// JavaScript can't read it - only the browser itself sends it back to us
// automatically on future requests.
//
// Uses res.append() rather than res.setHeader() - Set-Cookie is a
// multi-value header, and setHeader() would silently REPLACE any other
// cookie already queued on this same response (e.g. demo.js clearing the
// demo cookie in the same request that signs someone in for real) instead
// of adding to it.
function setSessionCookie(res, sessionId) {
  const maxAgeSeconds = 30 * 24 * 60 * 60; // 30 days
  res.append(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`
  );
}

// Clears the session cookie (used on sign-out) by making it expire immediately.
function clearSessionCookie(res) {
  res.append("Set-Cookie", `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

module.exports = {
  getGoogleAuthUrl,
  exchangeCodeForUser,
  saveUser,
  getUser,
  updateUserCompany,
  updateUserTheme,
  updateUserSheetId,
  updateUserPhoneColumnFormatted,
  updateUserTokens,
  getSheetsForUser,
  addSheetForUser,
  renameSheetForUser,
  getUserOAuthClient,
  createSession,
  destroySession,
  readSessionIdFromRequest,
  getCurrentUser,
  setSessionCookie,
  clearSessionCookie,
};
