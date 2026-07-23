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

// ── User storage (a simple JSON file, keyed by email) ────────────────────
const USERS_FILE_PATH = path.join(__dirname, "users.json");

// Reads every stored user. Returns {} if the file doesn't exist yet (e.g.
// nobody has ever signed in) or can't be parsed for some reason.
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE_PATH, "utf8"));
  } catch (error) {
    return {};
  }
}

// Saves (or updates) one user's record from a fresh sign-in, and returns it.
function saveUser(email, tokens, profile) {
  const users = loadUsers();
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

  fs.writeFileSync(USERS_FILE_PATH, JSON.stringify(users, null, 2));
  return users[email];
}

// Looks up one user by email. Returns null if we've never seen them.
function getUser(email) {
  return loadUsers()[email] || null;
}

// Updates just the company/organisation field for one user (the profile
// menu's editable field). Returns the updated user, or null if we've never
// seen this email before.
function updateUserCompany(email, company) {
  const users = loadUsers();
  if (!users[email]) return null;

  users[email].company = company;
  fs.writeFileSync(USERS_FILE_PATH, JSON.stringify(users, null, 2));
  return users[email];
}

// Saves which Google Sheet this user's Rhythm data lives in - set once,
// either by creating a brand-new sheet or connecting an existing one (see
// the /api/onboarding/* routes in server.js). Returns the updated user, or
// null if we've never seen this email before.
function updateUserSheetId(email, sheetId) {
  const users = loadUsers();
  if (!users[email]) return null;

  users[email].sheetId = sheetId;
  fs.writeFileSync(USERS_FILE_PATH, JSON.stringify(users, null, 2));
  return users[email];
}

// Updates just the theme preference for one user (the profile panel's
// toggle). Pass null to go back to "follow system preference". Returns the
// updated user, or null if we've never seen this email before.
function updateUserTheme(email, theme) {
  const users = loadUsers();
  if (!users[email]) return null;

  users[email].theme = theme || null;
  fs.writeFileSync(USERS_FILE_PATH, JSON.stringify(users, null, 2));
  return users[email];
}

// Marks the Phone-column plain-text fix-up as done for one user, so it
// never runs again for them - see applyPhoneColumnPlainTextFormat() and
// getSheetsContextForUser() in server.js.
function updateUserPhoneColumnFormatted(email) {
  const users = loadUsers();
  if (!users[email]) return null;

  users[email].phoneColumnFormatted = true;
  fs.writeFileSync(USERS_FILE_PATH, JSON.stringify(users, null, 2));
  return users[email];
}

// Persists a freshly-refreshed access token (and its new expiry) for one
// user. Called automatically whenever getUserOAuthClient()'s client
// refreshes itself behind the scenes - see below - so the NEXT request
// doesn't have to refresh again right away. Silently does nothing if the
// user has since been removed (e.g. users.json was hand-edited) - losing
// one refreshed token is harmless, since the next request just refreshes again.
function updateUserTokens(email, accessToken, expiryDate) {
  const users = loadUsers();
  if (!users[email]) return;

  users[email].accessToken = accessToken;
  users[email].tokenExpiryDate = expiryDate || null;
  fs.writeFileSync(USERS_FILE_PATH, JSON.stringify(users, null, 2));
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
      updateUserTokens(user.email, tokens.access_token, tokens.expiry_date);
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
function getCurrentUser(req) {
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
  getUserOAuthClient,
  createSession,
  destroySession,
  readSessionIdFromRequest,
  getCurrentUser,
  setSessionCookie,
  clearSessionCookie,
};
