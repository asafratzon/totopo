// dictation.js - the microphone button (Web Speech API, best-effort).
//
// Note: this needs a real Chromium browser (Chrome/Edge/Brave/Arc). Embedded webviews such as the
// VS Code / Codium "Simple Browser" have no microphone access, so dictation cannot work there.

import { insertAtCursor } from "./composer.js";
import { input } from "./dom.js";
import { captureDraft, schedulePersist } from "./drafts.js";
import { noteMsg } from "./note.js";
import { attachedSid } from "./state.js";

const micBtn = document.getElementById("mic");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const MIC_HELP = "dictation needs a real browser (Chrome/Edge) with mic access - it cannot work in the editor's embedded browser";
let recognition = null;
let recording = false;
// The session dictation was started in. Recognition results arrive a moment after the speech, so a switch in
// between would otherwise drop a sentence meant for one agent into another one's box.
let dictationSid = null;

// Dictation is this window talking, not session state, so switching sessions ends it rather than carrying a
// half-finished transcript into the next conversation.
export function stopDictation() {
    if (!recording || !recognition) return;
    try {
        recognition.stop();
    } catch {
        // Not running after all; onend clears the flag either way.
    }
}

if (!SpeechRecognition) {
    micBtn.disabled = true;
    micBtn.title = "Dictation not supported in this browser";
} else {
    recognition = new SpeechRecognition();
    recognition.interimResults = false;
    recognition.continuous = true;

    recognition.onresult = (e) => {
        // A result that outlived the session it was dictated for is dropped rather than misfiled.
        if (dictationSid && dictationSid !== attachedSid) return;
        let transcript = "";
        for (let i = e.resultIndex; i < e.results.length; i++) transcript += e.results[i][0].transcript;
        if (!transcript) return;
        insertAtCursor(transcript.trim());
        captureDraft(attachedSid);
        schedulePersist();
    };
    recognition.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
            noteMsg(MIC_HELP, true);
        } else if (e.error === "no-speech") {
            noteMsg("dictation: no speech detected", true);
        } else {
            noteMsg(`dictation: ${e.error}`, true);
        }
    };
    recognition.onend = () => {
        recording = false;
        dictationSid = null;
        micBtn.classList.remove("recording");
    };

    // Prime the mic permission via getUserMedia first: SpeechRecognition on its own often fails
    // straight to "not-allowed" without prompting. In an embedded webview getUserMedia is missing
    // or blocked, so we surface the "use a real browser" hint.
    async function startDictation() {
        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                noteMsg(MIC_HELP, true);
                return;
            }
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            for (const track of stream.getTracks()) track.stop();
        } catch {
            noteMsg(MIC_HELP, true);
            return;
        }
        try {
            recognition.start();
            recording = true;
            dictationSid = attachedSid;
            micBtn.classList.add("recording");
            input.focus();
        } catch {
            // start() throws if already running; ignore.
        }
    }

    micBtn.addEventListener("click", () => {
        if (recording) {
            recognition.stop();
            return;
        }
        startDictation();
    });
}
