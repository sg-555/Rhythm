// Standalone auth test - isolates Google Sheets authentication from the rest
// of the app. Loads the same google-key.json (or GOOGLE_KEY_JSON env var),
// authenticates, and tries to read a single cell. Run with: node test-auth.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");
const { google } = require("googleapis");

const KEY_FILE_PATH = path.join(__dirname, "..", "google-key.json");
const SHEET_ID = process.env.DEFAULT_SHEET_ID;

async function main() {
  const rawKey = process.env.GOOGLE_KEY_JSON
    ? process.env.GOOGLE_KEY_JSON
    : fs.readFileSync(KEY_FILE_PATH, "utf8");
  const parsedKey = JSON.parse(rawKey);

  const auth = new GoogleAuth({
    credentials: parsedKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "A1",
    });
    console.log("AUTH OK");
    console.log("A1 value:", response.data.values);
  } catch (err) {
    console.log("AUTH FAILED");
    console.error(err);
  }
}

main();
