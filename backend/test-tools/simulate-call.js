// A small dev-only helper: simulates ONE real call (audio streaming +
// transcription + call-status webhook) WITHOUT actually placing a phone
// call. Useful for testing multi-call features (like the "Previous Calls"
// relationship summary) by running this 2-3 times in a row for the same
// phone number, instead of placing 2-3 real calls.
//
// Mirrors /voice's actual shape: TWO separate /media-stream connections
// (one per leg), each sending its own "role" custom parameter, sharing one
// callSessionId - see server.js's /voice handler and its "start" handler
// for the real thing this is standing in for.
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

// Opens one leg's /media-stream connection and sends its "connected" +
// "start" events, exactly like Twilio would for a stream carrying only
// that leg's inbound_track. `role` ("rep"/"lead") and `callSessionId` are
// the two custom parameters the real fix's whole determinism rests on -
// see /voice in server.js.
function openLegConnection(role, callSessionId, phone) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://localhost:3000/media-stream");
    const callSid = `CAsim-${role}-${Date.now()}`;

    ws.on("open", () => {
      ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
      ws.send(
        JSON.stringify({
          event: "start",
          start: {
            callSid,
            customParameters: { leadPhone: phone, callerEmail: "", role, callSessionId },
          },
        })
      );
      resolve(ws);
    });

    ws.on("error", (error) => reject(error));
  });
}

// Sends one leg's audio to its WebSocket in real-time-sized 20ms chunks,
// starting after `delayMs` (so the two legs can be staggered like a real
// call, where the rep speaks first and the lead answers a moment later).
// `track` is just what real Twilio would label it ("inbound", since every
// stream now requests track: "inbound_track") - the server no longer reads
// this field at all (each connection has exactly one Deepgram connection),
// it's included only for realism.
function sendTrack(ws, audio, delayMs) {
  setTimeout(() => {
    const chunkSize = 160; // 20ms of audio at 8000Hz, 1 byte/sample
    let offset = 0;
    const interval = setInterval(() => {
      if (offset >= audio.length) {
        clearInterval(interval);
        return;
      }
      const chunk = audio.slice(offset, offset + chunkSize);
      ws.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: chunk.toString("base64") } }));
      offset += chunkSize;
    }, 20);
  }, delayMs);
}

(async () => {
  console.log(`Generating speech audio for rep line: "${repLine}"`);
  const repAudio = textToMulaw(repLine, "simulate-call-rep.wav");
  console.log(`Generating speech audio for lead line: "${leadLine}"`);
  const leadAudio = textToMulaw(leadLine, "simulate-call-lead.wav");

  const callSessionId = "CAsim-session-" + Date.now();

  let repWs;
  let leadWs;
  try {
    [repWs, leadWs] = await Promise.all([
      openLegConnection("rep", callSessionId, phone),
      openLegConnection("lead", callSessionId, phone),
    ]);
  } catch (error) {
    console.error("Could not connect to ws://localhost:3000/media-stream - is the server running?");
    console.error(error.message);
    process.exit(1);
  }

  console.log(`Streaming simulated call (session ${callSessionId}) to /media-stream...`);

  // Rep speaks first (from the start); lead "answers" a beat later.
  const repDurationMs = (repAudio.length / 8000) * 1000;
  sendTrack(repWs, repAudio, 0);
  sendTrack(leadWs, leadAudio, repDurationMs + 500);

  // Wait for both legs to finish playing, plus buffer time for Deepgram to
  // finalize, before ending the stream.
  const totalAudioMs = repDurationMs + (leadAudio.length / 8000) * 1000;
  await new Promise((resolve) => setTimeout(resolve, totalAudioMs + 4000));

  repWs.send(JSON.stringify({ event: "stop" }));
  leadWs.send(JSON.stringify({ event: "stop" }));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  repWs.close();
  leadWs.close();

  console.log("Media stream finished - triggering /call-status (as Twilio would when the call ends)...");
  const response = await fetch("http://localhost:3000/call-status", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `To=${encodeURIComponent(phone)}&CallStatus=completed`,
  });
  console.log("call-status response:", await response.text());
  console.log("Done! Check the Google Sheet and the server's terminal log.");
})();
