// Talks to Google Gemini to generate AI insights for a finished call, the
// running "Previous Calls" relationship summary, live in-call coaching tips,
// and drafted post-call SMS follow-ups.
//
// This file implements the interface described in ai/index.js: it exports
// generateCallInsights(transcript, callNumber, sellerContext),
// generateRelationshipSummary(previousSummary, latestTranscript, callNumber,
// sellerContext), generateCoachingTip(recentTranscript, lastTip,
// sellerContext), and generateFollowUpSms(leadName, transcript, aiNotes,
// sellerContext) - all of which THROW on failure instead of swallowing
// errors, so ai/index.js's retry logic can see what went wrong - plus
// isRetryableError(error), which tells ai/index.js whether a given failure
// is worth retrying (e.g. "server overloaded") or is a permanent problem
// (e.g. a bad API key) that should fail fast instead.
//
// sellerContext: see ai/index.js's own comment - the calling rep's "sells X
// to Y" profile as one plain-English string, or "" if they've never filled
// it in. Every prompt below treats "" as "omit the context block entirely,"
// so output is IDENTICAL to before this parameter existed.
//
// To swap in a different AI provider later (e.g. Claude, OpenAI), write a
// new file that exports all of these functions with the same shapes, then
// point ai/index.js at it instead - the retry behavior automatically applies
// to whichever provider is plugged in, since it only relies on this
// isRetryableError() function, not on anything Gemini-specific.

const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Builds the instructions we send Gemini, telling it exactly what to look
// for and exactly what JSON shape we need back. sellerContext (optional):
// the rep's own "sells X to Y" profile (see buildSellerContextString() in
// server.js) - "" if they haven't filled any of it in, in which case the
// whole CONTEXT block below is omitted and this prompt is identical to
// before sellerContext existed.
function buildPrompt(transcript, callNumber, sellerContext) {
  return `You are a sales call analyst helping a busy salesperson scan call notes FAST. Below is a transcript of call number ${callNumber} with this lead. Lines are labelled "Rep" (the salesperson) or "Lead" (the prospect).

${sellerContext ? `CONTEXT ABOUT THE SALESPERSON'S BUSINESS (use this to interpret the call and judge fit/interest more accurately; do NOT restate it in your output, and do NOT treat it as facts the lead said):
${sellerContext}
` : ""}READING TIME RULE: keep the salesperson's total reading time roughly the same no matter how long the call was. Short call: brief plain lines. Long/dense call: MORE concise per field, short fragments not full sentences.

Respond with ONLY a JSON object (no markdown, no commentary) with exactly these fields:
{
  "temperature": <integer 0 to 5, where 0-1 = Cold, 2-3 = Warm, 4-5 = Hot. Base this on what the LEAD actually said and did, not optimism>,
  "suggestedStage": <exactly one of: "New", "Interested", "Follow-up", "Not Interested", "Closed/Won">,
  "headline": "<a punchy 2-3 word verdict of the single most important takeaway, e.g. 'ready to close', 'price-sensitive', 'wrong fit'. Do NOT include the words Cold/Warm/Hot>",
  "positives": "<one short line: concrete buying signals the lead actually gave, or what genuinely went well. If none, say so plainly>",
  "concerns": "<one short line: objections or concerns the lead actually raised. If none, say 'none raised'>",
  "commitments": "<one short line: what was explicitly agreed / what the lead actually committed to. If nothing concrete, say 'no firm commitment'>",
  "nextCall": "<one short line: what the rep should DO on the next call to address the lead's SPECIFIC situation - what to lead with, how to handle their actual objection, what to bring. Base ONLY on what was said>",
  "researchPrep": "<one short line: a small checklist of useful things to find out BEFORE the next call that were NOT covered in this transcript. Things to go find out - never things to assume>"
}

EMPHASIS RULE: in exactly ONE field - whichever holds the single most critical point - put ONE key word or short phrase in UPPERCASE so it jumps out. Use this only once. Plain spreadsheet cell: UPPERCASE letters only, no asterisks or markdown.

GROUNDING RULE (most important): every statement must trace to something explicitly said in the transcript. Never invent or assume the lead's job, budget, timeline, authority, schedule, or situation. When tempted to state something that "seems likely" but wasn't said, either leave it out or put it in "researchPrep" as something to find out. Better to say less than to state something the lead didn't say.

NO EMOJIS anywhere in the output.

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
async function generateCallInsights(transcript, callNumber, sellerContext) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: buildPrompt(transcript, callNumber, sellerContext),
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
// instead of growing forever. sellerContext (optional) - see buildPrompt above.
function buildRelationshipPrompt(previousSummary, latestTranscript, callNumber, sellerContext) {
  return `You are maintaining a running summary of a salesperson's relationship with one lead, across multiple calls.

${sellerContext ? `CONTEXT ABOUT THE SALESPERSON'S BUSINESS (background to interpret the relationship; do NOT restate it, do NOT treat it as facts the lead said):
${sellerContext}
` : ""}Summary of the relationship so far (from earlier calls):
${previousSummary ? previousSummary : "(none yet - this is an early call, so there is no earlier summary)"}

Transcript of the NEWEST call (call number ${callNumber}), labelled "Rep" and "Lead":
${latestTranscript}

Write an UPDATED summary folding this newest call into the story so far:
- A few lines of flowing PROSE describing the arc of the relationship - NOT a list, NOT one entry per call.
- Cover: how it started, how the lead's sentiment has shifted, recurring objections, commitments made, and where things stand now.
- Keep it concise and scannable - readable in a few seconds. As more calls happen, COMPRESS older details rather than adding text, so total reading time stays roughly constant.
- GROUNDING RULE: only include what was actually said in the prior summary or this transcript. Never invent sentiment, progress, or facts. If the relationship is thin or unclear, say so honestly rather than inflating it.
- NO EMOJIS.

Respond with ONLY the updated summary prose - no JSON, no markdown, no headings.`;
}

// Generates (or updates) the collective "Previous Calls" relationship
// summary. Returns a plain text string. Throws on failure, same as
// generateCallInsights - ai/index.js handles retries and graceful failure.
async function generateRelationshipSummary(previousSummary, latestTranscript, callNumber, sellerContext) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: buildRelationshipPrompt(previousSummary, latestTranscript, callNumber, sellerContext),
  });

  return response.text.trim();
}

// Builds the instructions for a LIVE coaching tip - this runs periodically
// WHILE a call is happening (see server.js's coaching check loop), so it
// only gets a recent slice of the conversation, not the whole call.
// sellerContext (optional) - see buildPrompt above; here it's a single
// short line rather than a whole block, since this prompt runs on a tight
// interval and should stay cheap/fast.
function buildCoachingPrompt(recentTranscript, lastTip, sellerContext) {
  return `You are a live sales coaching assistant watching a phone call in progress in REAL TIME. Below is the MOST RECENT slice of the conversation (not the whole call). Lines are labelled "Rep" and "Lead".

${sellerContext ? `The rep sells: ${sellerContext}. Use this to make tips relevant, but never assume the lead said something they didn't.
` : ""}Your job: decide if the rep needs a tip RIGHT NOW. Usually they do NOT. Only give a tip if, in THIS slice, one of these clearly just happened:
- the lead raised an objection or concern
- the lead gave a buying signal (interest, urgency, readiness)
- the lead asked something the rep should answer well
- the lead went hesitant or quiet on a topic
- there's a clear opening to advance or close

If none just happened, return tip: null. Never invent a tip to fill space.
${lastTip ? `Your last tip was: "${lastTip}" - do not repeat it or reword it.` : "No tip given yet this call."}

RULES for the tip if you give one:
- ONE short, glanceable instruction the rep can read mid-call (a few words to one sentence).
- It must respond to what the LEAD actually just said in this slice - never to something you imagine or predict.
- Tell the rep what to DO or SAY next, concretely. No vague encouragement like "stay positive".
- NO EMOJIS.

Respond with ONLY a JSON object (no markdown, no commentary):
{ "tip": "<one short actionable instruction, or null if nothing noteworthy just happened>" }

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
async function generateCoachingTip(recentTranscript, lastTip, sellerContext) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: buildCoachingPrompt(recentTranscript, lastTip, sellerContext),
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
// sellerContext (optional) - see buildPrompt above.
function buildFollowUpSmsPrompt(leadName, transcript, aiNotes, sellerContext) {
  return `You are drafting a short SMS follow-up for a salesperson to send a lead RIGHT AFTER a call.

${sellerContext ? `The rep sells: ${sellerContext}.
` : ""}Lead's name: ${leadName || "the lead"}
Our notes summarizing the call:
${aiNotes ? aiNotes : "(no summary available)"}
Full transcript, labelled "Rep" and "Lead":
${transcript}

Write a short, warm, professional SMS from the rep to the lead:
- Reference something SPECIFIC actually discussed or agreed (a question they asked, info they wanted, a next step agreed) - personal, not generic.
- SMS-length: 1-3 short sentences, well under 320 characters.
- Warm and professional - not pushy, not overly casual.
- GROUNDING RULE: never invent a fact, number, date, or detail not actually said on the call. If unsure of a specific (exact price/date), phrase it generally. Better vague than wrong.
- Do NOT add a signature/sign-off line - just the message body.
- NO EMOJIS.

Respond with ONLY the SMS text - no quotes, no labels, no commentary.`;
}

// Drafts one follow-up SMS. Returns a plain text string (the message body).
// Throws on failure, same as the other functions above - ai/index.js's
// retry wrapper handles that.
async function generateFollowUpSms(leadName, transcript, aiNotes, sellerContext) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: buildFollowUpSmsPrompt(leadName, transcript, aiNotes, sellerContext),
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
