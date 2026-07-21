// This is the "swappable AI provider" entry point. Everywhere else in the
// app calls generateCallInsights() / generateRelationshipSummary() / etc
// through this file, without knowing (or needing to know) which AI service
// is actually behind it, or that retries happen at all.
//
// To switch providers later (e.g. to Claude or OpenAI): write a new file
// next to this one (e.g. claudeProvider.js) that exports the same functions
// as geminiProvider.js - generateCallInsights(transcript, callNumber),
// generateRelationshipSummary(previousSummary, latestTranscript, callNumber),
// generateCoachingTip(recentTranscript, lastTip), generateFollowUpSms(
// leadName, transcript, aiNotes), and isRetryableError(error) - then change
// the line below to point at that file instead. The retry behavior below
// applies automatically to whichever provider is plugged in, since it only
// depends on that provider's own isRetryableError() function.

const provider = require("./geminiProvider");
const { withRetry } = require("./retry");

// Generates AI insights for one call, retrying a few times if the provider
// fails with a transient error (e.g. "server overloaded", rate limited).
// Never throws: if every attempt fails (or the failure is permanent, like a
// bad API key), this logs the reason and returns null, so the rest of the
// app can carry on without the AI enrichment instead of crashing.
async function generateCallInsights(transcript, callNumber) {
  try {
    return await withRetry(
      () => provider.generateCallInsights(transcript, callNumber),
      provider.isRetryableError,
      "AI call insights"
    );
  } catch (error) {
    console.error("AI insights permanently failed:", error.message);
    return null;
  }
}

// Updates the collective "Previous Calls" relationship summary. Same retry
// and graceful-failure behavior as generateCallInsights - returns null
// (instead of throwing) if every attempt fails, so a provider hiccup never
// breaks the call flow or corrupts the stored history.
async function generateRelationshipSummary(previousSummary, latestTranscript, callNumber) {
  try {
    return await withRetry(
      () => provider.generateRelationshipSummary(previousSummary, latestTranscript, callNumber),
      provider.isRetryableError,
      "AI relationship summary"
    );
  } catch (error) {
    console.error("AI relationship summary permanently failed:", error.message);
    return null;
  }
}

// Generates a live coaching tip for a call in progress, if the AI decides
// one is warranted right now (see geminiProvider's REACTIVE-only rules).
// Same retry + graceful-failure behavior as the calls above: returns null
// (never throws) if every attempt fails, so a slow/failing AI call can never
// disrupt the live call or its transcript - the rep just doesn't get a tip
// that cycle, and the next periodic check tries again.
async function generateCoachingTip(recentTranscript, lastTip) {
  try {
    return await withRetry(
      () => provider.generateCoachingTip(recentTranscript, lastTip),
      provider.isRetryableError,
      "AI coaching tip"
    );
  } catch (error) {
    console.error("AI coaching tip permanently failed:", error.message);
    return null;
  }
}

// Drafts a short SMS follow-up for a lead, based on that call's transcript
// and our own "AI Notes" summary. Same retry + graceful-failure behavior as
// the calls above: returns null (never throws) if every attempt fails - the
// rep can still type their own message and send that instead (see the
// "Send follow-up SMS" section in the lead panel).
async function generateFollowUpSms(leadName, transcript, aiNotes) {
  try {
    return await withRetry(
      () => provider.generateFollowUpSms(leadName, transcript, aiNotes),
      provider.isRetryableError,
      "AI SMS draft"
    );
  } catch (error) {
    console.error("AI SMS draft permanently failed:", error.message);
    return null;
  }
}

module.exports = {
  generateCallInsights,
  generateRelationshipSummary,
  generateCoachingTip,
  generateFollowUpSms,
};
