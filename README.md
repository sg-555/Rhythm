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
- **Data store:** Google Sheets (via a service account), used as the lead/CRM database
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

**Requirements:** Node.js, a Twilio account, a Deepgram account, a Google Gemini API key, a Google Cloud project (OAuth + a service account with Sheets access), and a Google Sheet to use as the lead database.

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
DEFAULT_SHEET_ID=
```

You'll also need a Google service account key saved as `google-key.json` in the project root, with access to the Google Sheet you're using as the data store.

Then run the server:

```bash
npm start
```

The app serves the frontend and API from `http://localhost:3000`.
