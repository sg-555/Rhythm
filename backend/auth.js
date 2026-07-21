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

// The narrowest scopes that still let us (in a LATER step) create a Google
// Sheet for each user and read/write it:
// - userinfo.email / userinfo.profile: just enough to know who signed in
//   (their email + name) - not their whole Google identity.
// - drive.file: only gives access to files THIS APP creates or opens, not
//   the user's entire Drive. That's both safer for the user, and easier to
//   get verified by Google later than the broader "drive"/"spreadsheets"
//   scopes would be.
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
function setSessionCookie(res, sessionId) {
  const maxAgeSeconds = 30 * 24 * 60 * 60; // 30 days
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`
  );
}

// Clears the session cookie (used on sign-out) by making it expire immediately.
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

module.exports = {
  getGoogleAuthUrl,
  exchangeCodeForUser,
  saveUser,
  getUser,
  createSession,
  destroySession,
  readSessionIdFromRequest,
  getCurrentUser,
  setSessionCookie,
  clearSessionCookie,
};
