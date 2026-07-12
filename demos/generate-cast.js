#!/usr/bin/env node
// Generates quickstart.cast — a synthetic asciicast v2 of a basic totopo session.
// NOTE: svg-term merges/drops events with identical timestamps — always emit
// multi-line blocks as a single out() call, or give each event a small pause.
// Render: npx svg-term-cli --in quickstart.cast --out quickstart.svg --window --width 90 --height 24

const fs = require("fs");

const WIDTH = 90;
const HEIGHT = 24;

let t = 0.6;
const events = [];
const rnd = (min, max) => min + Math.random() * (max - min);

function out(text, pauseAfter = 0.05) {
    events.push([Number(t.toFixed(3)), "o", text]);
    t += pauseAfter;
}
function type(text, pauseAfter = 0.3) {
    for (const ch of text) {
        events.push([Number(t.toFixed(3)), "o", ch]);
        t += rnd(0.04, 0.09);
    }
    t += pauseAfter;
}

// ANSI
const R = "\u001b[0m";
const B = "\u001b[1m";
const BLUE = "\u001b[34m";
const CYAN = "\u001b[36m";
const GREEN = "\u001b[32m";
const GREY = "\u001b[38;5;245m";
const MAG = "\u001b[35m";
const ORANGE = "\u001b[38;5;173m";
const NL = "\r\n";
const rail = `${GREY}\u2502${R}`;

// 1. Host prompt + command
out(`${BLUE}~/p/my-project${R} ${GREEN}main${R} ${GREEN}\u276f${R} `);
type("npx totopo", 0.5);
out(NL, 0.8);

// 2. Header box with left rail (single block)
// v3.13.2: a spacer rail line is printed right before the box
out(`${rail}${NL}`, 0.05);

// NOTE: every box line must be exactly the same column width (here: 30),
// or the right border and corners will not line up.
out(
    `${rail}  ${GREY}\u250c${"\u2500".repeat(6)}${R} ${B}totopo v3.13.2${R} ${GREY}${"\u2500".repeat(6)}\u2510${R}${NL}` +
        `${rail}  ${GREY}\u2502${R}  workspace:   ${B}my-project${R}   ${GREY}\u2502${R}${NL}` +
        `${rail}  ${GREY}\u2502${R}  container:   stopped      ${GREY}\u2502${R}${NL}` +
        `${rail}  ${GREY}\u2514${"\u2500".repeat(28)}\u2518${R}${NL}` +
        `${rail}${NL}`,
    0.7,
);

// 3. Menu, "Open session" selected (single block)
out(
    `${CYAN}\u25c6${R}  ${B}Menu:${R}${NL}` +
        `${rail}  ${GREEN}\u25cf${R} Open session ${GREY}(start or resume the dev container)${R}${NL}` +
        `${rail}  ${GREY}\u25cb Settings${R}${NL}` +
        `${rail}  ${GREY}\u25cb Advanced${R}${NL}` +
        `${rail}  ${GREY}\u25cb Help${R}${NL}` +
        `${rail}  ${GREY}\u25cb Quit${R}${NL}`,
    1.8,
);

// user presses Enter -> redraw collapsed menu (cursor up 6, clear down)
out(`\u001b[6A\u001b[0J` + `${GREEN}\u25c7${R}  ${B}Menu:${R}${NL}` + `${rail}  ${GREY}Open session${R}${NL}` + `${rail}${NL}`, 0.5);

// 4. Container startup (basic)
out(`${BLUE}\u25cf${R}  Resuming dev container...${NL}${rail}${NL}`, 1.5);
out(
    `${GREEN}\u25cf${R}  ${B}You're now in a totopo sandbox${R} ${GREY}\u00b7${R} ${B}my-project${R}${NL}${NL}` +
        `   ${GREY}\u25b8${R} Run ${ORANGE}claude${R}, ${ORANGE}opencode${R}, or ${ORANGE}codex${R} to start an agent.${NL}` +
        `   ${GREY}\u25b8${R} Run ${B}status${R} to see container details & installed versions.${NL}` +
        `   ${GREY}\u25b8${R} Run ${B}exit${R} to end the session and return to the host.${NL}${NL}`,
    1.4,
);

// 5. Run claude inside the sandbox
out(`${BLUE}/workspace${R} ${GREEN}\u276f${R} `, 0.4);
type("claude", 0.4);
out(NL, 0.9);

// Claude Code header (logo + text), input box, status line (single blocks)
out(
    `${NL}` +
        `${ORANGE}\u2597\u2588\u2588\u2584\u2584\u2588\u2588\u2596${R}   ${B}Claude Code${R} ${GREY}v2.1.207${R}${NL}` +
        `${ORANGE}\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588${R}   Opus 4.8 (1M context) with xhigh effort ${GREY}\u00b7${R} Claude Team${NL}` +
        `${ORANGE}\u259d\u2580\u2598\u2598\u2580\u2596${R}    ${GREY}/workspace${R}${NL}${NL}`,
    0.9,
);
out(
    `${GREY}${"\u2500".repeat(88)}${R}${NL}` +
        ` ${GREY}\u276f${R} \u2588${NL}` +
        `${GREY}${"\u2500".repeat(88)}${R}${NL}` +
        `${GREY} 0k (0%) \u00b7 ${R}${BLUE}Opus 4.8 (1M context)${R} ${MAG}xhigh${R}${GREY} \u00b7 Claude Code v2.1.207${R}${NL}`,
    3.0,
);

const header = {
    version: 2,
    width: WIDTH,
    height: HEIGHT,
    timestamp: Math.floor(Date.now() / 1000),
    title: "totopo quickstart",
    env: { TERM: "xterm-256color", SHELL: "/bin/zsh" },
};
const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
fs.writeFileSync("quickstart.cast", lines.join("\n") + "\n");
console.log(`Wrote quickstart.cast (${events.length} events, ${t.toFixed(1)}s)`);
