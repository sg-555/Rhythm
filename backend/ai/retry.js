// A small, provider-agnostic retry helper used by ai/index.js. It doesn't
// know anything about Gemini (or any other AI service) - it just calls the
// function it's given, and if that function throws an error the CALLER says
// is worth retrying, it waits a bit and tries again.

// How long to wait before each retry: ~1s, then ~2s, then ~4s.
// That's 3 retries on top of the first attempt = 4 tries total.
const RETRY_DELAYS_MS = [1000, 2000, 4000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calls fn() and retries it if it throws an error that isRetryableError()
// says is worth retrying. Waits longer between each attempt. Gives up (and
// re-throws the last error) once every retry has been used, or immediately
// if an error isn't retryable (e.g. a bad API key should fail fast).
// `label` is just used to make the retry log messages readable.
async function withRetry(fn, isRetryableError, label) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const attemptsSoFar = attempt + 1;
      const totalAttempts = RETRY_DELAYS_MS.length + 1;
      const isLastAttempt = attemptsSoFar === totalAttempts;

      if (isLastAttempt || !isRetryableError(error)) {
        throw error; // out of retries, or this error will never succeed anyway
      }

      const delay = RETRY_DELAYS_MS[attempt];
      console.error(
        `${label} failed (attempt ${attemptsSoFar}/${totalAttempts}): ${error.message} - retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }
}

module.exports = { withRetry };
