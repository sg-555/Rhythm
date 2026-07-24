# Rhythm

**An AI-powered sales-calling assistant that dials, transcribes, coaches, and updates your CRM — so you can just talk.**

## The problem

Sales calling is repetitive and exhausting in all the wrong ways. You dial manually, scramble to take notes mid-conversation, then spend the time after every call updating a CRM by hand — logging the outcome, writing a summary, remembering to follow up. That overhead adds up fast, and it's a big part of why reps burn out and give up on leads early. The actual selling — the conversation — is a small fraction of the work.

Rhythm strips away the grind around the call so the rep can focus on the one thing that matters: the conversation.

## Features

- **Browser-based calling** — dial straight from the browser using the Twilio Voice SDK, no separate phone needed.
- **Live, speaker-labelled transcription** — both sides of the call are transcribed in real time via Deepgram, clearly separating rep and lead.
- **Post-call AI insights** — after every call, Gemini analyzes the transcript for interest temperature, objections raised, and a suggested next step, plus live coaching cues.
- **Evolving per-lead relationship summary** — each new call is folded into a running summary of the relationship, so context builds across every interaction instead of resetting each time.
- **Automatic outcome logging** — call outcomes are written back to the CRM without manual data entry.
- **Smart call-back reminders** — leads that need a follow-up surface automatically with reminder toasts, so nothing falls through the cracks.
- **AI-drafted SMS follow-ups** — Rhythm drafts a follow-up text based on how the call actually went; the rep reviews and sends.
- **Analytics dashboard** — a Chart.js-powered view into call volume, outcomes, and pipeline trends over time.
- **Google sign-in** — simple, secure sign-in via Google OAuth.

## Tech stack

- **Backend:** Node.js + Express
- **Frontend:** Vanilla HTML/CSS/JS (no framework, no build step)
- **Telephony:** Twilio (Voice SDK for browser calling, SMS API for follow-ups)
- **Transcription:** Deepgram (live, speaker-diarized streaming transcription)
- **AI:** Google Gemini, for call analysis, coaching, and SMS drafting
- **Data store:** Google Sheets, used as the lead/CRM database — each signed-in user creates or connects their own sheet (read/written with their own OAuth tokens, never a shared service account); a service account is only used to serve the seeded demo sheet in Demo Mode
- **Auth:** Google OAuth 2.0

A design highlight: telephony, SMS, AI, and the CRM data layer are all built behind small swappable provider abstractions rather than called directly. Swapping Gemini for another model, or Twilio for another telephony provider, or the Sheet-backed store for a real database, means writing a new provider module — the rest of the app doesn't change.

## How it works

1. **Dial** — the rep picks a lead and calls from the browser.
2. **Talk** — the call connects over Twilio as a normal voice call.
3. **Transcribe** — Deepgram streams a live, speaker-labelled transcript of both sides as the call happens.
4. **Understand and record** — once the call ends, Gemini reads the transcript, extracts interest level, objections, and next steps, and writes the outcome back to the CRM.
5. **Remember** — that call's summary is merged into the lead's ongoing relationship history, so the next call starts with full context instead of a blank slate.

## Status

Actively in development. This is a personal project, built solo to sharpen a real sales workflow — not a polished commercial product, and it shows in places (single-user assumptions, a Google Sheet as the database, minimal frontend tooling). Expect rough edges.

## Setup

**Requirements:** Node.js, a Twilio account, a Deepgram account, a Google Gemini API key, and a Google Cloud project (OAuth credentials, plus a service account for Demo Mode's seeded sheet). You don't need to prepare a lead sheet yourself — the first time you sign in, Rhythm walks you through creating one (in your own Drive) or connecting one you already have.

```bash
git clone <this-repo>
cd Rhythm/backend
npm install
```

Create `backend/.env` with your own credentials:

```
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
TWILIO_API_KEY_SID=
TWILIO_API_KEY_SECRET=
TWILIO_TWIML_APP_SID=
PUBLIC_BASE_URL=
DEEPGRAM_API_KEY=
GEMINI_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
DATABASE_URL=
```

You'll also need a Google service account key saved as `google-key.json` in the project root - this is only used to serve Demo Mode's seeded sheet, not any real user's data.

`DATABASE_URL` is **optional locally** - if it's unset, the app falls back to storing users/call history in local JSON files (`users.json`, `call-log.json`, `call-history.json`), which is fine for running on your own machine. In deployment (e.g. Render), set `DATABASE_URL` to a real Postgres instance - Render's disk is wiped on every restart, so without a database, sheetId/tokens/theme/call history would silently disappear each time the instance sleeps or redeploys. The server logs which mode it's using at startup either way. Demo Mode never uses either one - its seeded data always comes from `call-log.demo.json`, committed to the repo.

Then run the server:

```bash
npm start
```

The app serves the frontend and API from `http://localhost:3000`.
