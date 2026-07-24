// Postgres connection + schema setup, used by auth.js (users) and server.js
// (call_log/call_history) - the ONE place that knows how to talk to the
// database, so those other files just call query() and don't need to know
// connection details.
//
// LOCAL DEVELOPMENT: if DATABASE_URL isn't set, isDatabaseMode is false and
// nobody should call query() at all - auth.js/server.js fall back to their
// existing users.json/call-log.json/call-history.json file logic instead.
// See server.js's startup log for which mode is actually active.
//
// WHY THIS EXISTS AT ALL: Render's filesystem is ephemeral - it's wiped on
// every restart/redeploy, so anything written to a plain JSON file on disk
// (sheetId, tokens, theme, call history) would quietly vanish. A real
// database survives restarts.

const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";

// True when we should use Postgres; false means "fall back to JSON files"
// (see auth.js/server.js). Computed once at startup, not re-checked per
// request - the mode doesn't change while the server is running.
const isDatabaseMode = !!DATABASE_URL;

// Render's managed Postgres needs SSL from outside its own network, with a
// self-signed cert chain (hence rejectUnauthorized: false) - but a LOCAL
// Postgres you might run for testing usually has no SSL set up at all, so
// we skip it there. This is just a convenience heuristic, not a security
// boundary - "local Postgres" here just means the connection string points
// at localhost.
const isLocalDatabase = /^postgres(ql)?:\/\/[^/]*@?(localhost|127\.0\.0\.1)/.test(DATABASE_URL);

let pool = null;
if (isDatabaseMode) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isLocalDatabase ? false : { rejectUnauthorized: false },
  });

  // Fires if an already-connected, currently-idle client in the pool dies
  // (e.g. the database restarts, or a brief network blip) - without this
  // handler, that's an uncaught 'error' event, which crashes the whole
  // Node process. Logging and moving on is what "don't crash the server if
  // the database is briefly unavailable" means for this specific case - the
  // pool just opens a new connection next time a query needs one.
  pool.on("error", (error) => {
    console.error("Postgres pool error (an idle connection dropped) - server keeps running:", error.message);
  });
}

// Runs one SQL query against the pool. Every caller in auth.js/server.js
// wraps this in its own try/catch (so a query failure degrades that ONE
// operation - e.g. "couldn't load this user" - rather than crashing the
// request, let alone the server).
function query(text, params) {
  if (!pool) {
    return Promise.reject(new Error("db.query() called but DATABASE_URL isn't set - check isDatabaseMode first."));
  }
  return pool.query(text, params);
}

// Creates the three tables this app needs, if they don't already exist -
// called once at startup (see server.js). Safe to run every time the
// server starts, even against a database that already has them.
async function createTablesIfNotExist() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT,
      picture TEXT,
      company TEXT,
      sheet_id TEXT,
      theme TEXT,
      phone_column_formatted BOOLEAN NOT NULL DEFAULT FALSE,
      access_token TEXT,
      refresh_token TEXT,
      token_expiry BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // One row per completed call - what the Analytics dashboard is built
  // from. Scoped by user_email so each rep only ever sees their own calls
  // (previously a single shared call-log.json meant everyone's stats were
  // mixed together).
  await query(`
    CREATE TABLE IF NOT EXISTS call_log (
      id SERIAL PRIMARY KEY,
      user_email TEXT,
      "timestamp" TIMESTAMPTZ NOT NULL,
      phone TEXT,
      name TEXT,
      outcome TEXT,
      connected BOOLEAN,
      duration_seconds INTEGER,
      temperature INTEGER
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS call_log_user_email_idx ON call_log (user_email)`);

  // Per-lead relationship history (used for the "Previous Calls" narrative
  // and, longer-term, other relationship-arc features) - also scoped by
  // user_email, since two different reps could otherwise have leads that
  // happen to share a phone number.
  await query(`
    CREATE TABLE IF NOT EXISTS call_history (
      id SERIAL PRIMARY KEY,
      user_email TEXT,
      phone TEXT NOT NULL,
      call_number INTEGER,
      "date" TEXT,
      temperature INTEGER,
      headline TEXT,
      concern TEXT,
      outcome TEXT
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS call_history_user_phone_idx ON call_history (user_email, phone)`);

  // Every Rhythm sheet a user has ever created, so they can switch between
  // them (e.g. one per quarter's lead list) instead of being stuck with a
  // single sheet forever. WHICH one is currently active is still just
  // users.sheet_id (unchanged) - this table is only the list to pick FROM.
  // See auth.js's getSheetsForUser()/addSheetForUser()/renameSheetForUser().
  await query(`
    CREATE TABLE IF NOT EXISTS sheets (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      sheet_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS sheets_user_email_idx ON sheets (user_email)`);
}

module.exports = { query, isDatabaseMode, createTablesIfNotExist };
