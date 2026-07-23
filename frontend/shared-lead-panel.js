// ── Shared calling + lead detail panel logic ──────────────────────────────
// Used by BOTH index.html (Leads) and callbacks.html (Call-backs) - loaded
// via <script src="shared-lead-panel.js"></script> BEFORE each page's own
// inline <script>, so this is the ONE place all of this logic lives instead
// of being copy-pasted twice. If you're fixing a calling or lead-panel bug,
// fix it here - it applies to both pages automatically.
//
// What THIS file owns (declared here, not in either page):
//   - The Twilio Device / active-call state (device, activeCall, ...)
//   - The Live Transcript / AI Coach panels and the WebSocket feed
//   - The workspace split-layout (full-width list <-> list+call-panels)
//   - The full lead detail side panel (temperature, AI notes, previous
//     calls, stage, call-back, notes, follow-up SMS)
//
// What EACH PAGE still owns (must already exist as a global before any of
// this file's functions are actually CALLED - not before this file loads,
// since everything below is a function body, evaluated lazily):
//   - `demoMode` (boolean) and `currentUserEmail` (string) - set by that
//     page's own checkSignedIn()
//   - `allLeads` (array) - that page's own full lead list, used only for
//     the call-back spacing suggestion's cross-lead check
//
// Both pages' HTML must have the SAME element IDs this file looks up below
// (deviceStatus, transcriptPanel, coachTips, workspace, panelOverlay,
// leadPanel, panelContent, panelCloseButton) - see each page's markup.

const deviceStatus = document.getElementById("deviceStatus");
const transcriptPanel = document.getElementById("transcriptPanel");
const coachTips = document.getElementById("coachTips");
const workspace = document.getElementById("workspace");
const panelOverlay = document.getElementById("panelOverlay");
const leadPanel = document.getElementById("leadPanel");
const panelContent = document.getElementById("panelContent");
const panelCloseButton = document.getElementById("panelCloseButton");

// Shows/hides the right-hand Live Transcript/AI Coach column. Called every
// time isInCall changes (call start/end, demo or real).
function updateWorkspaceLayout() {
  workspace.classList.toggle("call-active", isInCall);
}

    // Call-backs must be spaced at least this many minutes apart - a rep
    // can't realistically make two calls back-to-back. Used when SETTING a
    // manual call-back time (see renderCallbackSection further down).
    const MIN_CALLBACK_GAP_MINUTES = 10;

    const MAX_VISIBLE_TIPS = 2;

    // These hold the current Twilio "Device" (our virtual phone) and the
    // call currently in progress, if any. Only one call can be active at a time.
    let device = null;
    let activeCall = null;

    // Which lead's phone number is currently being called (or null if no
    // call is active). This is what lets every Call/Hang Up button for that
    // SAME lead show "Hang Up" together, and every button for a DIFFERENT
    // lead show as disabled - see callButtonInstances/refreshAllCallButtons
    // below.
    let activeCallPhone = null;

    // True from the moment a call starts connecting until it ends. Used to
    // switch call-back reminders to a subtle in-page strip instead of a
    // floating toast, so they never cover the AI Coach / Live Transcript
    // panels while the rep is actually on a call.
    let isInCall = false;

    // Every Call/Hang Up button pair we've created anywhere on the page
    // (table rows, the lead detail panel, reminder toasts) - kept here so
    // starting or ending a call can update ALL of them together, not just
    // whichever one was clicked. See attachCallHandlers below.
    const callButtonInstances = [];

    // Holds the WebSocket connection to our backend's /browser-feed, which
    // pushes live transcript lines to us while a call is active.
    let transcriptSocket = null;

    // Empties the transcript panel and shows a "listening" placeholder -
    // called each time a new call starts, so old lines don't linger.
    function resetTranscriptPanel() {
      transcriptPanel.innerHTML = '<p class="message">Listening...</p>';
    }

    // Adds one transcript line to the panel, styled by speaker, and scrolls
    // down so the newest line is always visible.
    function addTranscriptLine(speaker, text) {
      // The first real line should replace the "Listening..." placeholder
      const placeholder = transcriptPanel.querySelector(".message");
      if (placeholder) placeholder.remove();

      const line = document.createElement("div");
      // "Rep" -> "rep", "Lead" -> "lead" (used as the CSS class below)
      line.className = "transcript-line " + speaker.toLowerCase();
      line.innerHTML = `<span class="speaker-label">${speaker}:</span> ${text}`;

      transcriptPanel.appendChild(line);
      transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
    }

    // Empties the coach panel and shows a placeholder - called each time a
    // new call starts, so a tip from a previous call doesn't linger.
    function resetCoachingPanel() {
      coachTips.innerHTML = '<p class="message">No tips yet.</p>';
    }

    // Adds one coaching tip to the panel (newest on top), styled distinctly
    // from transcript lines (see .coach-tip). Keeps at most MAX_VISIBLE_TIPS
    // tips on screen at once, so they never pile up.
    function addCoachingTip(text) {
      const placeholder = coachTips.querySelector(".message");
      if (placeholder) placeholder.remove();

      const tip = document.createElement("div");
      tip.className = "coach-tip";

      const icon = document.createElement("span");
      icon.textContent = "💡";
      tip.appendChild(icon);

      const label = document.createElement("span");
      label.textContent = text;
      tip.appendChild(label);

      coachTips.insertBefore(tip, coachTips.firstChild);

      while (coachTips.children.length > MAX_VISIBLE_TIPS) {
        coachTips.removeChild(coachTips.lastChild);
      }
    }

    // Opens the connection to our backend's live transcript feed. Called
    // when a call starts.
    function startTranscriptFeed() {
      resetTranscriptPanel();
      resetCoachingPanel();

      // Same host the page itself was loaded from (works whether that's
      // localhost or your ngrok URL) - "wss://" if the page is on https.
      const protocol = location.protocol === "https:" ? "wss://" : "ws://";
      transcriptSocket = new WebSocket(protocol + location.host + "/browser-feed");

      transcriptSocket.addEventListener("message", (event) => {
        const data = JSON.parse(event.data);

        // Coaching tips arrive with a "type: tip" field; transcript lines
        // don't have a "type" field at all - that's how we tell them apart.
        if (data.type === "tip") {
          addCoachingTip(data.text);
        } else {
          addTranscriptLine(data.speaker, data.text);
        }
      });
    }

    // Closes the transcript feed connection. Called when a call ends.
    function stopTranscriptFeed() {
      if (transcriptSocket) {
        transcriptSocket.close();
        transcriptSocket = null;
      }
    }

    // Asks the browser for microphone access. A call can't work without this.
    async function requestMicrophonePermission() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // We only needed this to trigger the permission prompt - stop it right away.
        // Twilio will request its own microphone stream when a call actually starts.
        stream.getTracks().forEach((track) => track.stop());
        return true;
      } catch (error) {
        deviceStatus.textContent = "Microphone permission is required to make calls.";
        return false;
      }
    }

    // Sets up the Twilio Device using a token from our backend, so the
    // browser itself can place calls (no page reload needed per call).
    async function setupCallingDevice() {
      const micGranted = await requestMicrophonePermission();
      if (!micGranted) return;

      try {
        const response = await fetch("/api/token");
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Could not get a calling token");
        }

        device = new Twilio.Device(data.token);

        // Catches any calling problems that happen after setup (e.g. dropped connection)
        device.on("error", (error) => {
          deviceStatus.textContent = "Calling error: " + error.message;
        });

        await device.register();
        deviceStatus.textContent = "Ready to make calls.";
      } catch (error) {
        deviceStatus.textContent = "Could not set up calling: " + error.message;
      }
    }

    // ── Keeping every Call/Hang Up button in sync ───────────────────────
    // Only one call can be active at a time (enforced by `activeCall`
    // above), but the SAME lead can have a Call button in more than one
    // place at once - e.g. their table row AND their open detail panel.
    // These two functions make sure ALL of a lead's buttons show the same
    // thing, and every OTHER lead's button is disabled instead of quietly
    // doing nothing if clicked.

    // Updates ONE button instance to match whatever is currently true:
    // - no call active anywhere -> back to its own normal label (some
    //   buttons say "Call", the reminder toast's says "Call now" - we
    //   remember each one's own label in instance.originalCallLabel so we
    //   never accidentally overwrite it with a different button's wording)
    // - this IS the lead being called -> "Hang Up"
    // - a DIFFERENT lead is being called -> disabled "Call in progress"
    function refreshOneCallButton(instance) {
      if (!activeCallPhone) {
        instance.callButton.disabled = false;
        instance.callButton.textContent = instance.originalCallLabel;
        instance.callButton.style.display = "inline-block";
        instance.hangupButton.style.display = "none";
      } else if (instance.phone === activeCallPhone) {
        instance.callButton.style.display = "none";
        instance.hangupButton.style.display = "inline-block";
      } else {
        instance.callButton.disabled = true;
        instance.callButton.textContent = "Call in progress";
        instance.callButton.style.display = "inline-block";
        instance.hangupButton.style.display = "none";
      }
    }

    // Updates EVERY registered button at once (used whenever a call starts,
    // changes state, or ends). `statusMessage`, if given, is shown on the
    // status text of every button that belongs to the lead being called -
    // e.g. "Connecting...", "In Call" - so the message appears wherever
    // that lead's Call button happens to be, not just where it was clicked.
    function refreshAllCallButtons(statusMessage) {
      callButtonInstances.forEach((instance) => {
        refreshOneCallButton(instance);
        if (statusMessage !== undefined && instance.phone === activeCallPhone) {
          instance.callStatus.textContent = statusMessage;
        }
      });
    }

    // Runs once, whenever the active call finishes, however it finished
    // (hung up, the other side hung up, cancelled, or an error). Shows the
    // final message on the lead's buttons, then resets everything - the
    // shared state AND every button on the page - back to normal.
    function endActiveCall(message) {
      callButtonInstances
        .filter((instance) => instance.phone === activeCallPhone)
        .forEach((instance) => {
          instance.callStatus.textContent = message;
        });

      activeCall = null;
      activeCallPhone = null;
      isInCall = false;
      updateWorkspaceLayout(); // back to full-width leads, no call panels reserved
      stopTranscriptFeed();
      refreshAllCallButtons();
    }

    // ── DEMO MODE call simulation ────────────────────────────────────────
    // A canned back-and-forth used to fake a "live" call - no Twilio, no
    // Deepgram, no real audio, no cost. Reuses the SAME transcript/coaching
    // panel functions a real call uses, so it looks identical on screen.
    const DEMO_CALL_TRANSCRIPT = [
      { speaker: "Rep", text: "Hi, this is Sanjay from Rhythm - is now an OK time to chat?" },
      { speaker: "Lead", text: "Sure, I've got a few minutes." },
      { speaker: "Rep", text: "Great! I wanted to follow up on the proposal we sent over last week." },
      { speaker: "Lead", text: "Yes, we've been reviewing it - the pricing looks reasonable." },
      { speaker: "Rep", text: "Glad to hear it. Any open questions I can answer?" },
      { speaker: "Lead", text: "Just wondering about onboarding timelines, but otherwise we're close to deciding." },
      { speaker: "Rep", text: "Onboarding usually takes about a week - I can send over a detailed timeline." },
      { speaker: "Lead", text: "That would help a lot. Let's talk again once I've shared this internally." },
    ];
    const DEMO_COACHING_TIP = "Lead sounds close to deciding - confirm a concrete next step before ending the call.";
    const DEMO_LINE_DELAY_MS = 1600;
    const DEMO_FIRST_LINE_DELAY_MS = 2400;

    // Runs an entirely fake, client-side "call" for demo-mode visitors -
    // see the demoMode check in the click handler below, which calls this
    // INSTEAD of ever touching device.connect() or any backend endpoint
    // that could place a real call.
    function startDemoCall(phone) {
      activeCallPhone = phone;
      isInCall = true;
      updateWorkspaceLayout(); // opens the right-hand call panels
      // If a call is started from INSIDE the lead detail panel (or the
      // profile panel happens to be open), either one would otherwise sit
      // on top of (and hide) the Live Transcript/AI Coach columns this just
      // opened - close both so the split layout is fully visible. Neither
      // reopens when the call ends - see endActiveCall() below, which
      // deliberately does NOT call either of these.
      closeLeadPanel();
      if (typeof closeProfilePanel === "function") closeProfilePanel();
      resetTranscriptPanel();
      resetCoachingPanel();
      refreshAllCallButtons("Connecting...");

      setTimeout(() => {
        if (isInCall) refreshAllCallButtons("Ringing...");
      }, 900);
      setTimeout(() => {
        if (isInCall) refreshAllCallButtons("In Call (demo)");
      }, DEMO_FIRST_LINE_DELAY_MS);

      DEMO_CALL_TRANSCRIPT.forEach((line, index) => {
        setTimeout(() => {
          if (!isInCall || activeCallPhone !== phone) return; // hung up early
          addTranscriptLine(line.speaker, line.text);
          if (index === 3) addCoachingTip(DEMO_COACHING_TIP);
        }, DEMO_FIRST_LINE_DELAY_MS + index * DEMO_LINE_DELAY_MS);
      });

      const totalDurationMs = DEMO_FIRST_LINE_DELAY_MS + DEMO_CALL_TRANSCRIPT.length * DEMO_LINE_DELAY_MS + 1200;
      setTimeout(() => {
        if (!isInCall || activeCallPhone !== phone) return;
        addCoachingTip("📋 Post-call (demo): Connected - Warm interest, wants an onboarding timeline before deciding.");
        endActiveCall("Call ended (demo) — Connected");
      }, totalDurationMs);
    }

    // Wires up a Call/Hang Up button pair for one phone number, and
    // registers it in callButtonInstances so it stays in sync with every
    // other button for the same (or a different) lead. The leads table, the
    // lead detail panel, reminder toasts, and the call-backs page all call
    // this same function, so the syncing logic only ever lives here once.
    function attachCallHandlers(phone, callButton, hangupButton, callStatus) {
      // Remember this button's own label (e.g. "Call" or the toast's
      // "Call now") BEFORE anything else touches it, so refreshOneCallButton
      // can restore the right wording later instead of a generic "Call".
      const instance = { phone, callButton, hangupButton, callStatus, originalCallLabel: callButton.textContent };
      callButtonInstances.push(instance);

      // Match reality immediately - e.g. if a call to this exact lead (or a
      // different one) is already in progress when this button is created,
      // such as opening the panel mid-call.
      refreshOneCallButton(instance);

      callButton.addEventListener("click", async (event) => {
        // Stops the click from also bubbling up to the row's own click
        // handler, which would otherwise open the side panel at the same time.
        event.stopPropagation();

        if (activeCall || (demoMode && isInCall)) {
          // Shouldn't normally happen, since every other lead's button is
          // disabled while a call is active - kept as a safety net.
          callStatus.textContent = "Finish your current call first.";
          return;
        }

        // DEMO MODE: run the fake call instead - never touches device,
        // Twilio, or any backend endpoint that could place a real call.
        if (demoMode) {
          startDemoCall(phone);
          return;
        }

        if (!device) {
          callStatus.textContent = "Calling isn't ready yet - please wait a moment.";
          return;
        }

        activeCallPhone = phone;
        isInCall = true;
        updateWorkspaceLayout(); // opens the right-hand call panels
        // Same reason as startDemoCall() above - don't let the lead panel
        // (or the profile panel, if that's what's open) sit on top of the
        // Live Transcript/AI Coach columns this just opened.
        closeLeadPanel();
        if (typeof closeProfilePanel === "function") closeProfilePanel();
        refreshAllCallButtons("Connecting...");
        startTranscriptFeed();

        try {
          // Start a real WebRTC call. The "To" param is read by our backend's
          // POST /voice endpoint, which tells Twilio which number to dial.
          // "callerEmail" rides along the same way - /voice forwards it into
          // /call-status's callback URL, since Twilio calls that with no
          // browser session at all, so it needs another way to know WHICH
          // signed-in user's sheet this call belongs to.
          activeCall = await device.connect({ params: { To: phone, callerEmail: currentUserEmail || "" } });

          activeCall.on("accept", () => refreshAllCallButtons("In Call"));
          activeCall.on("disconnect", () => endActiveCall("Call ended"));
          activeCall.on("cancel", () => endActiveCall("Call cancelled"));
          activeCall.on("error", (error) => endActiveCall("Call error: " + error.message));
        } catch (error) {
          endActiveCall("Could not start call: " + error.message);
        }
      });

      // Ends the call early when the user clicks "Hang Up" - works from
      // WHICHEVER copy of this lead's Hang Up button was clicked.
      hangupButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (demoMode) {
          endActiveCall("Call ended (demo)");
        } else if (activeCall) {
          activeCall.disconnect();
        }
      });
    }
    // ── Lead detail side panel ──────────────────────────────────────────
    // Opens when a lead row is clicked. Shows read-only AI-generated info
    // (Temperature, AI Notes, Previous Calls) plus two things the rep can
    // edit: accepting the suggested Stage, and their own human Notes.
    // (panelOverlay/leadPanel/panelContent/panelCloseButton are declared at
    // the top of this file, alongside deviceStatus etc.)

    function closeLeadPanel() {
      leadPanel.classList.remove("open");
      panelOverlay.classList.remove("open");
    }

    panelCloseButton.addEventListener("click", closeLeadPanel);
    panelOverlay.addEventListener("click", closeLeadPanel);

    // Builds one small uppercase section heading, e.g. "AI NOTES"
    function makeSectionTitle(text) {
      const title = document.createElement("h3");
      title.className = "panel-section-title";
      title.textContent = text;
      return title;
    }

    // Wraps a title + its content in one consistently-spaced <section>, with
    // a thin divider line from the section before it (see .panel-section
    // CSS). Every section in the panel is built through this one function,
    // so the spacing between all of them stays consistent.
    function makeSection(titleText, contentEl) {
      const section = document.createElement("section");
      section.className = "panel-section";
      section.appendChild(makeSectionTitle(titleText));
      section.appendChild(contentEl);
      return section;
    }

    // A single compact, muted line of call-history context. Deliberately
    // small and grey (see .call-stats-strip) so it gives context without
    // competing with the AI insights below it.
    function renderCallStatsStrip(lead) {
      const strip = document.createElement("p");
      strip.className = "call-stats-strip";

      const parts = [];
      if (lead.attempts) parts.push(`${lead.attempts} attempt${lead.attempts === "1" ? "" : "s"}`);
      if (lead.lastCalled) parts.push(`Last called ${lead.lastCalled}`);
      if (lead.firstConnected) parts.push(`First connected ${lead.firstConnected}`);

      strip.textContent = parts.length > 0 ? parts.join(" · ") : "No calls yet";
      return strip;
    }

    // Builds the header: Name, Phone, and this lead's own Call/Hang Up controls
    function renderPanelHeader(lead) {
      const header = document.createElement("div");
      header.className = "panel-header";

      const name = document.createElement("h2");
      name.textContent = lead.name || "(no name)";
      header.appendChild(name);

      const phone = document.createElement("p");
      phone.className = "panel-phone";
      phone.textContent = lead.phone;
      header.appendChild(phone);

      const callButton = document.createElement("button");
      callButton.className = "call-button";
      callButton.textContent = "Call";

      const hangupButton = document.createElement("button");
      hangupButton.className = "hangup-button";
      hangupButton.textContent = "Hang Up";
      hangupButton.style.display = "none";

      const callStatus = document.createElement("span");
      callStatus.className = "call-status";

      // Reuses the exact same calling logic as the leads table (see above).
      attachCallHandlers(lead.phone, callButton, hangupButton, callStatus);

      header.appendChild(callButton);
      header.appendChild(hangupButton);
      header.appendChild(callStatus);

      return header;
    }

    // Turns a 0-5 temperature number into a coloured badge (Cold/Warm/Hot).
    // Shows a neutral "No calls yet" badge if this lead has no temperature yet.
    function renderTemperatureBadge(lead) {
      const badge = document.createElement("span");

      if (lead.temperatureValue === null) {
        badge.className = "temp-badge temp-none";
        badge.textContent = "No calls yet";
        return badge;
      }

      const value = lead.temperatureValue;
      let word, colorClass;
      if (value <= 1) {
        word = "Cold";
        colorClass = "temp-cold";
      } else if (value <= 3) {
        word = "Warm";
        colorClass = "temp-warm";
      } else {
        word = "Hot";
        colorClass = "temp-hot";
      }

      badge.className = "temp-badge " + colorClass;
      badge.textContent = `${word} (${value}/5)`;
      return badge;
    }

    // Builds one "emoji Label: value" line. ONLY the label itself is wrapped
    // in <strong> - the emoji and the value are always plain text nodes, so
    // there's no way for any part of the content to accidentally end up bold.
    function makeNoteLine(emoji, label, value) {
      const line = document.createElement("p");
      line.className = "ai-note-line";

      line.appendChild(document.createTextNode(emoji + " "));

      const strong = document.createElement("strong");
      strong.textContent = label + ": ";
      line.appendChild(strong);

      line.appendChild(document.createTextNode(value));

      return line;
    }

    // Renders the read-only "AI Notes" section using the already-parsed
    // fields the backend sent us (see parseAiNotesBlock in server.js). Each
    // line is built through makeNoteLine, so labels are always bold and
    // content is always normal weight - never the other way round.
    function renderAiNotesSection(lead) {
      const container = document.createElement("div");
      const parsed = lead.aiNotesParsed;

      if (!lead.aiNotes) {
        const empty = document.createElement("p");
        empty.className = "message";
        empty.textContent = "No AI notes yet - this lead hasn't had a call analyzed.";
        container.appendChild(empty);
        return container;
      }

      const hasParsedFields =
        parsed.positives || parsed.concerns || parsed.commitments || parsed.nextCall || parsed.researchPrep;

      if (!hasParsedFields) {
        // Doesn't match the expected labelled format (e.g. the "AI insights
        // unavailable" placeholder) - just show the raw text as a fallback.
        const raw = document.createElement("p");
        raw.className = "ai-note-line";
        raw.textContent = lead.aiNotes;
        container.appendChild(raw);
        return container;
      }

      if (parsed.headline) {
        const headline = document.createElement("p");
        headline.className = "ai-headline";
        headline.textContent = parsed.headline;
        container.appendChild(headline);
      }

      if (parsed.positives) container.appendChild(makeNoteLine("✅", "Positives", parsed.positives));
      if (parsed.concerns) container.appendChild(makeNoteLine("⚠️", "Concerns", parsed.concerns));
      if (parsed.commitments) container.appendChild(makeNoteLine("🤝", "Agreed", parsed.commitments));
      if (parsed.nextCall) container.appendChild(makeNoteLine("👉", "Next call", parsed.nextCall));
      if (parsed.researchPrep) container.appendChild(makeNoteLine("🔍", "Research/Prep", parsed.researchPrep));
      if (parsed.suggestedStage) container.appendChild(makeNoteLine("📌", "Suggested stage", parsed.suggestedStage));

      return container;
    }

    // Renders the current Stage plus, if the latest AI insight suggested a
    // different one, a one-click "Accept" button that writes it to the sheet.
    function renderSuggestedStageSection(lead) {
      const container = document.createElement("div");

      const currentStageLine = document.createElement("p");
      currentStageLine.className = "current-stage-line";
      const currentStrong = document.createElement("strong");
      currentStrong.textContent = "Current stage: ";
      currentStageLine.appendChild(currentStrong);
      const currentStageValue = document.createElement("span");
      currentStageValue.textContent = lead.stage || "(none)";
      currentStageLine.appendChild(currentStageValue);
      container.appendChild(currentStageLine);

      const suggestedStage = lead.aiNotesParsed.suggestedStage;

      // Nothing to suggest, or it already matches the current stage.
      if (!suggestedStage || suggestedStage === lead.stage) {
        return container;
      }

      const row = document.createElement("div");
      row.className = "suggested-stage-row";

      const label = document.createElement("span");
      label.textContent = `Suggested: ${suggestedStage}`;
      row.appendChild(label);

      const acceptButton = document.createElement("button");
      acceptButton.className = "accept-button";
      acceptButton.textContent = "Accept";
      row.appendChild(acceptButton);

      const status = document.createElement("span");
      status.className = "call-status";
      row.appendChild(status);

      acceptButton.addEventListener("click", async () => {
        acceptButton.disabled = true;
        status.textContent = "Saving...";

        try {
          const response = await fetch(`/api/leads/${encodeURIComponent(lead.phone)}/stage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stage: suggestedStage }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Could not update stage.");

          currentStageValue.textContent = suggestedStage;
          status.textContent = "Saved.";
          acceptButton.remove();
        } catch (error) {
          acceptButton.disabled = false;
          status.textContent = "Error: " + error.message;
        }
      });

      container.appendChild(row);
      return container;
    }

    // Renders the editable Human Notes box, pre-filled from the sheet's
    // "Notes" column, with a Save button that writes it straight back there.
    // This never reads or writes AI Notes or Previous Calls.
    function renderHumanNotesSection(lead) {
      const container = document.createElement("div");

      const textarea = document.createElement("textarea");
      textarea.className = "notes-textarea";
      textarea.value = lead.notes || "";
      container.appendChild(textarea);

      const saveButton = document.createElement("button");
      saveButton.className = "call-button save-button";
      saveButton.textContent = "Save";
      container.appendChild(saveButton);

      const status = document.createElement("span");
      status.className = "call-status";
      container.appendChild(status);

      saveButton.addEventListener("click", async () => {
        status.textContent = "Saving...";

        try {
          const response = await fetch(`/api/leads/${encodeURIComponent(lead.phone)}/notes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notes: textarea.value }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Could not save notes.");

          status.textContent = "Saved.";
        } catch (error) {
          status.textContent = "Error: " + error.message;
        }
      });

      return container;
    }

    // Converts a date/time TEXT the sheet stores (e.g. "7/15/2026, 2:30:00
    // PM") into the "YYYY-MM-DDTHH:MM" format an <input type="datetime-local">
    // needs to pre-fill with. Returns "" if there's nothing set, or the text
    // doesn't parse as a real date.
    function toDatetimeLocalValue(dateText) {
      if (!dateText) return "";

      const date = new Date(dateText);
      if (isNaN(date)) return "";

      return dateToDatetimeLocalValue(date);
    }

    // Same conversion as above, but starting from a real Date object instead
    // of text - used when we already have a Date (e.g. a suggested slot).
    function dateToDatetimeLocalValue(date) {
      const pad = (n) => String(n).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    // A short, friendly time for the spacing-suggestion message, e.g. "2:45 PM".
    function formatTimeForSuggestion(date) {
      return date.toLocaleString([], { hour: "numeric", minute: "2-digit" });
    }

    // ── Smart spacing between call-backs ────────────────────────────────
    // A rep can't realistically make two calls back-to-back, so call-backs
    // should sit at least MIN_CALLBACK_GAP_MINUTES apart. We already have
    // every OTHER lead's call-back time in allLeads (see /api/leads's
    // CallBackOn field), so this check runs entirely client-side - no extra
    // request needed.

    // Finds the earliest time >= candidateDate that is at least the gap away
    // from EVERY time in existingDates. Works by repeatedly nudging the
    // candidate forward past whichever existing time it's currently too
    // close to, until it doesn't conflict with any of them.
    function findNextFreeCallbackTime(candidateDate, existingDates, gapMinutes) {
      const gapMs = gapMinutes * 60 * 1000;
      let candidateMs = candidateDate.getTime();

      let movedForward = true;
      while (movedForward) {
        movedForward = false;

        for (const existing of existingDates) {
          const diff = Math.abs(candidateMs - existing.getTime());
          if (diff < gapMs) {
            // Too close to this one - jump forward to just past its "gap
            // zone" and check everything again (jumping past one time
            // might land us inside another one, if they're close together).
            const pastThisZone = existing.getTime() + gapMs;
            if (pastThisZone > candidateMs) {
              candidateMs = pastThisZone;
              movedForward = true;
            }
          }
        }
      }

      return new Date(candidateMs);
    }

    // Updates the "Call-back: ..." line to show the current saved value (or
    // "Not set"). Only ever contains our own elements, so clearing via
    // innerHTML here is safe.
    function updateCurrentCallbackLine(lineEl, callBackOnText) {
      lineEl.innerHTML = "";

      const strong = document.createElement("strong");
      strong.textContent = "Call-back: ";
      lineEl.appendChild(strong);
      lineEl.appendChild(document.createTextNode(callBackOnText || "Not set"));
    }

    // Renders the manual "Set call-back" control: a date/time picker + Save,
    // plus a Clear button to remove a previously-set time. This is the ONLY
    // place that writes the "Call Back On" column.
    //
    // Gated on First Connected: call-backs only make sense once we've
    // actually reached this lead at least once, so if they've never
    // connected, we show a short note instead of the control.
    function renderCallbackSection(lead) {
      const container = document.createElement("div");

      if (!lead.firstConnected) {
        const note = document.createElement("p");
        note.className = "message";
        note.textContent = "Call-back available after first connection.";
        container.appendChild(note);
        return container;
      }

      const currentLine = document.createElement("p");
      currentLine.className = "current-stage-line";
      updateCurrentCallbackLine(currentLine, lead.callBackOn);
      container.appendChild(currentLine);

      const row = document.createElement("div");
      row.className = "callback-row";

      const input = document.createElement("input");
      input.type = "datetime-local";
      input.value = toDatetimeLocalValue(lead.callBackOn);
      row.appendChild(input);

      const saveButton = document.createElement("button");
      saveButton.className = "call-button";
      saveButton.textContent = "Save";
      row.appendChild(saveButton);

      const clearButton = document.createElement("button");
      clearButton.className = "btn-secondary";
      clearButton.textContent = "Clear";
      row.appendChild(clearButton);

      container.appendChild(row);

      // Gentle "that's close to another call-back" suggestion - hidden
      // until (if ever) the spacing check below finds a conflict.
      const suggestion = document.createElement("div");
      suggestion.className = "callback-suggestion";
      container.appendChild(suggestion);

      const status = document.createElement("span");
      status.className = "call-status";
      container.appendChild(status);

      // Shared by both buttons below - `value` is either the datetime-local
      // input's value (to set it) or "" (to clear it).
      async function saveCallback(value) {
        status.textContent = "Saving...";

        try {
          const response = await fetch(`/api/leads/${encodeURIComponent(lead.phone)}/callback`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callBackOn: value }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Could not save call-back time.");

          lead.callBackOn = data.callBackOn;
          updateCurrentCallbackLine(currentLine, data.callBackOn);
          input.value = toDatetimeLocalValue(data.callBackOn);
          status.textContent = "Saved.";
        } catch (error) {
          status.textContent = "Error: " + error.message;
        }
      }

      // Shows the gentle spacing suggestion with two buttons: use the
      // suggested time, or keep the one the rep originally picked.
      function showSpacingSuggestion(suggestedDate, originalDate) {
        suggestion.innerHTML = "";
        suggestion.style.display = "flex";

        const text = document.createElement("span");
        text.textContent = `That's close to another call-back. How about ${formatTimeForSuggestion(suggestedDate)}?`;
        suggestion.appendChild(text);

        const useSuggestedButton = document.createElement("button");
        useSuggestedButton.className = "btn-secondary";
        useSuggestedButton.textContent = "Use this time";
        suggestion.appendChild(useSuggestedButton);

        const keepOriginalButton = document.createElement("button");
        keepOriginalButton.className = "btn-secondary";
        keepOriginalButton.textContent = "Keep my time";
        suggestion.appendChild(keepOriginalButton);

        useSuggestedButton.addEventListener("click", () => {
          suggestion.style.display = "none";
          input.value = dateToDatetimeLocalValue(suggestedDate);
          saveCallback(input.value);
        });

        keepOriginalButton.addEventListener("click", () => {
          suggestion.style.display = "none";
          saveCallback(dateToDatetimeLocalValue(originalDate));
        });
      }

      saveButton.addEventListener("click", () => {
        if (!input.value) {
          status.textContent = "Pick a date/time first (or use Clear).";
          return;
        }

        // Check the chosen time against every OTHER lead's call-back time
        // (allLeads already has this - see /api/leads's CallBackOn field).
        const candidateDate = new Date(input.value);
        const existingDates = allLeads
          .filter((otherLead) => otherLead.Phone !== lead.phone && otherLead.CallBackOn)
          .map((otherLead) => new Date(otherLead.CallBackOn))
          .filter((date) => !isNaN(date));

        const gapMs = MIN_CALLBACK_GAP_MINUTES * 60 * 1000;
        const tooClose = existingDates.some((date) => Math.abs(candidateDate - date) < gapMs);

        if (tooClose) {
          const suggested = findNextFreeCallbackTime(candidateDate, existingDates, MIN_CALLBACK_GAP_MINUTES);
          showSpacingSuggestion(suggested, candidateDate);
        } else {
          saveCallback(input.value);
        }
      });

      clearButton.addEventListener("click", () => {
        input.value = "";
        suggestion.style.display = "none";
        saveCallback("");
      });

      return container;
    }

    // Builds the whole panel's contents for one lead and drops them into
    // #panelContent. Every titled block goes through makeSection(), so
    // spacing and dividers between sections stay consistent throughout.
    // Renders the "Send Follow-up SMS" section: a "Draft with AI" button
    // that fills the text box with an AI-drafted message (which the rep can
    // freely edit), the recipient number, and a "Send" button that actually
    // sends it via the backend's swappable SMS abstraction. Draft and Send
    // are fully independent - if drafting fails (e.g. AI quota), the rep can
    // still type their own message and send it.
    function renderSmsSection(lead) {
      const container = document.createElement("div");

      const recipientLine = document.createElement("p");
      recipientLine.className = "current-stage-line";
      const recipientStrong = document.createElement("strong");
      recipientStrong.textContent = "To: ";
      recipientLine.appendChild(recipientStrong);
      recipientLine.appendChild(document.createTextNode(lead.phone));
      container.appendChild(recipientLine);

      const textarea = document.createElement("textarea");
      textarea.className = "notes-textarea";
      textarea.placeholder = 'Click "Draft with AI", or type your own message...';
      container.appendChild(textarea);

      const buttonRow = document.createElement("div");
      buttonRow.className = "callback-row"; // reuses the same button-row spacing style

      const draftButton = document.createElement("button");
      draftButton.className = "btn-secondary";
      draftButton.textContent = "Draft with AI";
      buttonRow.appendChild(draftButton);

      const sendButton = document.createElement("button");
      sendButton.className = "call-button";
      sendButton.textContent = "Send";
      buttonRow.appendChild(sendButton);

      container.appendChild(buttonRow);

      const status = document.createElement("span");
      status.className = "call-status";
      container.appendChild(status);

      draftButton.addEventListener("click", async () => {
        draftButton.disabled = true;
        status.textContent = "Drafting...";

        try {
          const response = await fetch(`/api/leads/${encodeURIComponent(lead.phone)}/draft-sms`, {
            method: "POST",
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Could not draft a message.");

          textarea.value = data.draft;
          status.textContent = "Draft ready - feel free to edit before sending.";
        } catch (error) {
          // Drafting failed (e.g. no transcript yet, or the AI is out of
          // quota) - the textarea is still there, so the rep can just type
          // their own message and send it instead.
          status.textContent = "Error: " + error.message;
        } finally {
          draftButton.disabled = false;
        }
      });

      sendButton.addEventListener("click", async () => {
        if (!textarea.value.trim()) {
          status.textContent = "Write or draft a message first.";
          return;
        }

        sendButton.disabled = true;
        status.textContent = "Sending...";

        try {
          const response = await fetch(`/api/leads/${encodeURIComponent(lead.phone)}/send-sms`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: textarea.value }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Could not send the message.");

          status.textContent = "Sent!";
        } catch (error) {
          status.textContent = "Error: " + error.message;
        } finally {
          sendButton.disabled = false;
        }
      });

      return container;
    }

    function renderLeadPanel(lead) {
      panelContent.innerHTML = ""; // clear the "Loading..." placeholder

      panelContent.appendChild(renderPanelHeader(lead));
      panelContent.appendChild(renderCallStatsStrip(lead));

      panelContent.appendChild(makeSection("Temperature", renderTemperatureBadge(lead)));
      panelContent.appendChild(makeSection("AI Notes", renderAiNotesSection(lead)));

      const previousCalls = document.createElement("p");
      previousCalls.className = "previous-calls-text";
      previousCalls.textContent = lead.previousCalls || "No call history yet.";
      panelContent.appendChild(makeSection("Previous Calls", previousCalls));

      panelContent.appendChild(makeSection("Suggested Stage", renderSuggestedStageSection(lead)));
      panelContent.appendChild(makeSection("Call-back", renderCallbackSection(lead)));
      panelContent.appendChild(makeSection("Notes", renderHumanNotesSection(lead)));
      panelContent.appendChild(makeSection("Send Follow-up SMS", renderSmsSection(lead)));
    }

    // Opens the panel for one lead (looked up fresh by phone number, so it
    // always shows the latest sheet data - not just whatever the table had
    // loaded when the page first opened).
    async function openLeadPanel(phone) {
      leadPanel.classList.add("open");
      panelOverlay.classList.add("open");
      panelContent.innerHTML = '<p class="message">Loading...</p>';

      try {
        const response = await fetch(`/api/leads/${encodeURIComponent(phone)}`);
        const lead = await response.json();
        if (!response.ok) throw new Error(lead.error || "Could not load lead.");

        renderLeadPanel(lead);
      } catch (error) {
        panelContent.textContent = "Couldn't load this lead: " + error.message;
      }
    }
