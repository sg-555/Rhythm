// Talks to Google Gemini to generate AI insights for a finished call, the
// running "Previous Calls" relationship summary, live in-call coaching tips,
// and drafted post-call SMS follow-ups.
//
// This file implements the interface described in ai/index.js: it exports
// generateCallInsights(transcript, callNumber), generateRelationshipSummary(...),
// generateCoachingTip(recentTranscript, lastTip), and generateFollowUpSms(
// leadName, transcript, aiNotes) - all of which THROW on failure instead of
// swallowing errors, so ai/index.js's retry logic can see what went wrong -
// plus isRetryableError(error), which tells ai/index.js whether a given
// failure is worth retrying (e.g. "server overloaded") or is a permanent
// problem (e.g. a bad API key) that should fail fast instead.
//
// To swap in a different AI provider later (e.g. Claude, OpenAI), write a
// new file that exports all of these functions with the same shapes, then
// point ai/index.js at it instead - the retry behavior automatically applies
// to whichever provider is plugged in, since it only relies on this
// isRetryableError() function, not on anything Gemini-specific.

const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Builds the instructions we send Gemini, telling it exactly what to look
// for and exactly what JSON shape we need back.
function buildPrompt(transcript, callNumber) {
  return `You are a sales call analyst helping a busy salesperson scan call notes FAST. Below is a transcript of call number ${callNumber} with this lead. Lines are labelled "Rep" (the salesperson) or "Lead" (the prospect).

READING TIME RULE: keep the salesperson's total reading time roughly the same no matter how long the call was.
- Short/simple call: plain, brief lines are fine.
- Long or information-dense call: be MORE concise per field, not less - use short fragments instead of full sentences, since there's more ground to cover in the same reading time.

Respond with ONLY a JSON object (no markdown formatting, no extra commentary) with exactly these fields:

{
  "temperature": <integer from 0 to 5, where 0-1 = Cold, 2-3 = Warm, 4-5 = Hot>,
  "suggestedStage": <one of exactly: "New", "Interested", "Follow-up", "Not Interested", "Closed/Won">,
  "headline": "<a punchy 2-3 word verdict capturing the single most important takeaway, e.g. 'ready to close', 'price-sensitive', 'wrong fit' - do NOT include the words Cold/Warm/Hot, those get added separately>",
  "positives": "<one short line: buying signals / what went well>",
  "concerns": "<one short line: objections / concerns raised>",
  "commitments": "<one short line: what was agreed / next actions the lead committed to>",
  "nextCall": "<one short line: what the rep should DO on the next call - what to lead with, how to address their SPECIFIC objection, what to have ready. Base this ONLY on what was actually said in the transcript>",
  "researchPrep": "<one short line: a small checklist of useful things to find out BEFORE the next call that were NOT covered in this transcript (e.g. their schedule, timezone, budget authority) - things to go find out, not things to assume>"
}

EMPHASIS RULE: in exactly ONE field above - whichever contains the single most critical point - put ONE key word or short phrase in UPPERCASE so it jumps out when scanned. Use this only once in the whole response; do not overuse it. This text goes straight into a plain spreadsheet cell, so use UPPERCASE letters only - do NOT wrap it in asterisks or any other markdown formatting.

CRITICAL RULE: never invent or assume facts about the lead (their job, lifestyle, timezone, schedule, budget, etc.) that were not explicitly stated in the transcript. If something relevant wasn't discussed, it belongs in "researchPrep" as something to go find out - never state it elsewhere as if it were already known.

Transcript:
${transcript}`;
}

// Gemini sometimes wraps its JSON in ```json ... ``` markdown fences, or
// adds a stray sentence before/after it. This pulls out just the { ... }
// part and parses that, instead of trusting the whole response is clean JSON.
// Throws (instead of returning null) on failure, so a bad/unparseable
// response is treated the same way as any other failed attempt.
function parseInsightsJson(responseText) {
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Gemini response did not contain any JSON: ${responseText}`);
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    throw new Error(`Could not parse Gemini's JSON: ${error.message}`);
  }
}

// Generates AI insights for one finished call.
// Returns { temperature, suggestedStage, headline, positives, concerns,
// commitments, nextCall, researchPrep }. Throws if the call to Gemini fails
// or its response can't be parsed - ai/index.js is responsible for catching
// this, retrying if appropriate, and deciding what happens after that.
async function generateCallInsights(transcript, callNumber) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: buildPrompt(transcript, callNumber),
    config: {
      // Asking Gemini for JSON directly makes clean output more likely -
      // parseInsightsJson() below still double-checks it, just in case.
      responseMimeType: "application/json",
    },
  });

  return parseInsightsJson(response.text);
}

// Builds the instructions for updating the running "Previous Calls" summary.
// We feed Gemini the summary as it stands so far (empty if this is only the
// 2nd call) plus the newest call's transcript, and ask it to fold the new
// call in - not just append to it - so the summary stays a short narrative
// instead of growing forever.
function buildRelationshipPrompt(previousSummary, latestTranscript, callNumber) {
  return `You maintain a running relationship summary across MULTIPLE sales calls with the same lead. This is call number ${callNumber}.

Here is the summary of the relationship so far (based on all earlier calls):
${previousSummary ? previousSummary : "(none yet - this is only the 2nd call, so there is no earlier summary)"}

Here is the transcript of the NEWEST call (call number ${callNumber}), labelled "Rep" (the salesperson) and "Lead" (the prospect):
${latestTranscript}

Write an UPDATED summary that folds this newest call into the story so far. Requirements:
- Write it as a few lines of flowing PROSE describing the arc of the relationship - NOT a list, and NOT one entry per call.
- Cover: how they started, how sentiment/temperature has shifted over time, any recurring objections, commitments made, and where things stand now.
- Keep it concise and scannable - a salesperson should be able to read it in a few seconds. As more calls happen, COMPRESS older details rather than piling on more text, so the total reading time stays roughly constant no matter how many calls have happened.
- CRITICAL: never invent or assume facts that were not actually said in the summary so far or in this transcript. Only summarize what was really said.

Respond with ONLY the updated summary text - no JSON, no markdown, no headings, just the plain prose paragraph(s).`;
}

// Generates (or updates) the collective "Previous Calls" relationship
// summary. Returns a plain text string. Throws on failure, same as
// generateCallInsights - ai/index.js handles retries and graceful failure.
async function generateRelationshipSummary(previousSummary, latestTranscript, callNumber) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: buildRelationshipPrompt(previousSummary, latestTranscript, callNumber),
  });

  return response.text.trim();
}

// Builds the instructions for a LIVE coaching tip - this runs periodically
// WHILE a call is happening (see server.js's coaching check loop), so it
// only gets a recent slice of the conversation, not the whole call.
function buildCoachingPrompt(recentTranscript, lastTip) {
  return `You are a live sales coaching assistant, watching a phone call in progress in REAL TIME. Below is the MOST RECENT slice of the conversation (not the whole call so far). Lines are labelled "Rep" (the salesperson) or "Lead" (the prospect).

Your job: decide if the rep needs a coaching tip RIGHT NOW. Most of the time they don't - only suggest a tip if something meaningful JUST happened in this slice:
- the lead raised an objection or concern
- the lead gave a buying signal (interest, urgency, readiness)
- the lead asked a question the rep should answer well
- the lead seems hesitant or is going quiet on a topic
- there's a clear opening to advance or close

If none of these just happened, respond with tip: null - do NOT invent a tip just to have something to say.

${lastTip ? `The last tip you gave was: "${lastTip}" - do not repeat the same advice again.` : "No tip has been given yet this call."}

Respond with ONLY a JSON object (no markdown formatting, no extra commentary):
{ "tip": "<ONE short, actionable sentence (or just a few words) the rep can glance at mid-call, or null if nothing noteworthy just happened>" }

Recent conversation:
${recentTranscript}`;
}

// Same "pull the {...} out of the response" approach as parseInsightsJson
// above - Gemini sometimes wraps JSON in markdown fences even when told not to.
function parseCoachingJson(responseText) {
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Gemini coaching response did not contain any JSON: ${responseText}`);
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    throw new Error(`Could not parse Gemini's coaching JSON: ${error.message}`);
  }
}

// Generates (or withholds) one live coaching tip for a call in progress.
// Returns a short tip string, or null if the AI decided nothing was worth
// flagging right now (this is the expected, common case - REACTIVE only).
// Throws on failure, same as generateCallInsights - ai/index.js's retry
// wrapper handles that.
async function generateCoachingTip(recentTranscript, lastTip) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: buildCoachingPrompt(recentTranscript, lastTip),
    config: {
      responseMimeType: "application/json",
    },
  });

  const { tip } = parseCoachingJson(response.text);
  return tip || null; // treat missing/empty/false-y values as "no tip"
}

// Builds the instructions for drafting a short SMS follow-up right after a
// call. We give it BOTH the full transcript (the ground truth of what was
// said) and our own already-generated "AI Notes" summary (the same labelled
// block stored in the sheet) - the summary makes it easy for the AI to spot
// the headline/commitments quickly, while the transcript is there so it can
// pull a specific detail or quote if that makes the message feel more personal.
function buildFollowUpSmsPrompt(leadName, transcript, aiNotes) {
  return `You are drafting a short SMS follow-up text message for a salesperson to send to a lead RIGHT AFTER a phone call.

Lead's name: ${leadName || "the lead"}

Our own notes summarizing the call:
${aiNotes ? aiNotes : "(no summary available)"}

Full transcript of the call, labelled "Rep" (the salesperson) and "Lead" (the prospect):
${transcript}

Write a short, warm, professional SMS follow-up message from the rep to the lead. Requirements:
- Reference something SPECIFIC that was actually discussed or agreed on the call (a question they asked, information they wanted, a next step both sides agreed to) - make it feel personal, not generic.
- Keep it SMS-length: 1-3 short sentences, well under 320 characters.
- Warm and professional in tone - not pushy, not overly casual.
- CRITICAL: never invent or assume any fact, number, date, or detail that wasn't actually said in the transcript. If you're unsure of a specific detail (like an exact price or date), phrase it generally instead of guessing.
- Do NOT add a signature/sign-off line (e.g. "- John from Acme") - just the message body itself.

Respond with ONLY the SMS message text - no quotes, no labels, no extra commentary.`;
}

// Drafts one follow-up SMS. Returns a plain text string (the message body).
// Throws on failure, same as the other functions above - ai/index.js's
// retry wrapper handles that.
async function generateFollowUpSms(leadName, transcript, aiNotes) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: buildFollowUpSmsPrompt(leadName, transcript, aiNotes),
  });

  return response.text.trim();
}

// Tells ai/index.js whether a given error is worth retrying.
// Gemini's SDK throws an ApiError with a real HTTP-style `.status` when the
// request reaches Google's servers:
//   - 429 (rate limited) and 5xx (server overloaded / temporarily down) are
//     transient - the exact same request will often succeed a moment later.
//   - Anything else with a status (400 bad request/invalid key, 403
//     forbidden, 404 unknown model, etc.) is a permanent problem - retrying
//     won't change the outcome, so we fail fast instead of wasting time.
// Errors with NO status at all (e.g. a dropped network connection) didn't
// even reach Google's servers, so we give those the benefit of the doubt
// and retry too.
function isRetryableError(error) {
  if (!error || typeof error.status !== "number") {
    return true;
  }

  return error.status === 429 || error.status >= 500;
}

module.exports = {
  generateCallInsights,
  generateRelationshipSummary,
  generateCoachingTip,
  generateFollowUpSms,
  isRetryableError,
};
