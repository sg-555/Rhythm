// A small dev-only helper: simulates ONE real call (audio streaming +
// transcription + call-status webhook) WITHOUT actually placing a phone
// call. Useful for testing multi-call features (like the "Previous Calls"
// relationship summary) by running this 2-3 times in a row for the same
// phone number, instead of placing 2-3 real calls.
//
// Usage:
//   node test-tools/simulate-call.js "<phone>" "<rep line>" "<lead line>"
//
// Requires the server to already be running (node server.js) and macOS's
// built-in `say` command (used to turn the lines into real speech audio, so
// Deepgram has something real to transcribe - same as our other manual tests).

const WebSocket = require("ws");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const [, , phone, repLine, leadLine] = process.argv;

if (!phone || !repLine || !leadLine) {
  console.error('Usage: node simulate-call.js "<phone>" "<rep line>" "<lead line>"');
  process.exit(1);
}

// Turns a line of text into real speech, encoded the same way Twilio sends
// call audio (mulaw, 8000Hz, mono), with a bit of trailing silence appended
// so Deepgram's voice-activity detection reliably finalizes the transcript.
function textToMulaw(text, tmpFileName) {
  const wavPath = path.join(os.tmpdir(), tmpFileName);
  const escapedText = text.replace(/"/g, '\\"');
  execSync(`say -o "${wavPath}" --file-format=WAVE --data-format="ulaw@8000" "${escapedText}"`);

  const buf = fs.readFileSync(wavPath);
  let offset = 12;
  let dataStart = null;
  let dataLen = null;
  while (offset < buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      dataStart = offset + 8;
      dataLen = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  const speech = buf.slice(dataStart, dataStart + dataLen);
  const trailingSilence = Buffer.alloc(8000, 0xff); // ~1 second of mulaw silence
  return Buffer.concat([speech, trailingSilence]);
}

// Sends one track's audio to the WebSocket in real-time-sized 20ms chunks,
// starting after `delayMs` (so the two tracks can be staggered like a real
// call, where the rep speaks first and the lead answers a moment later).
function sendTrack(ws, audio, track, delayMs) {
  setTimeout(() => {
    const chunkSize = 160; // 20ms of audio at 8000Hz, 1 byte/sample
    let offset = 0;
    const interval = setInterval(() => {
      if (offset >= audio.length) {
        clearInterval(interval);
        return;
      }
      const chunk = audio.slice(offset, offset + chunkSize);
      ws.send(JSON.stringify({ event: "media", media: { track, payload: chunk.toString("base64") } }));
      offset += chunkSize;
    }, 20);
  }, delayMs);
}

(async () => {
  console.log(`Generating speech audio for rep line: "${repLine}"`);
  const repAudio = textToMulaw(repLine, "simulate-call-rep.wav");
  console.log(`Generating speech audio for lead line: "${leadLine}"`);
  const leadAudio = textToMulaw(leadLine, "simulate-call-lead.wav");

  const ws = new WebSocket("ws://localhost:3000/media-stream");

  ws.on("open", async () => {
    const callSid = "CAsim" + Date.now();
    console.log(`Streaming simulated call ${callSid} to /media-stream...`);

    ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    ws.send(JSON.stringify({ event: "start", start: { callSid, customParameters: { leadPhone: phone } } }));

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Rep speaks first (from the start); lead "answers" a beat later.
    const repDurationMs = (repAudio.length / 8000) * 1000;
    sendTrack(ws, repAudio, "inbound", 0);
    sendTrack(ws, leadAudio, "outbound", repDurationMs + 500);

    // Wait for both tracks to finish playing, plus buffer time for Deepgram
    // to finalize, before ending the stream.
    const totalAudioMs = repDurationMs + (leadAudio.length / 8000) * 1000;
    await new Promise((resolve) => setTimeout(resolve, totalAudioMs + 4000));

    ws.send(JSON.stringify({ event: "stop" }));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    ws.close();

    console.log("Media stream finished - triggering /call-status (as Twilio would when the call ends)...");
    const response = await fetch("http://localhost:3000/call-status", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `To=${encodeURIComponent(phone)}&CallStatus=completed`,
    });
    console.log("call-status response:", await response.text());
    console.log("Done! Check the Google Sheet and the server's terminal log.");
  });

  ws.on("error", (error) => {
    console.error("Could not connect to ws://localhost:3000/media-stream - is the server running?");
    console.error(error.message);
    process.exit(1);
  });
})();
