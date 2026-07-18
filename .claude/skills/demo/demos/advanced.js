#!/usr/bin/env node
// Generates advanced.cast - a synthetic asciicast v2 of an advanced totopo session:
// host audio server auto-start, AI CLI update (skip countdown + spinner), agent
// auto-start into claude, then exiting twice and the auto-shutdown flow.
// Every line mirrors the real CLI output (see SKILL.md: fidelity first).
// Render: ./render.sh advanced

import { B, BLUE, CURSOR, CYAN, createCast, GREEN, GREY, MAG, NL, ORANGE, R, rail } from "./lib.js";

const { out, type, save } = createCast({ title: "totopo advanced" });

// 1. Host prompt + command (same as quickstart)
// Hide agg's native cursor for the whole session; we draw our own aligned block cursor.
out(`\u001b[?25l${BLUE}~/p/my-project${R} ${GREEN}\u276f${R} `);
type("npx totopo", 0.5);
out(NL, 0.8);

// 2. Header line with left rail (single block, same as quickstart). The container
// is stopped, so no state is shown; with voice wiring on in automatic mode a
// stopped server prints no notice line either (src/commands/menu.ts), so the
// header matches the quickstart one - just version and workspace.
out(`${rail}${NL}`, 0.05);
out(`${rail}  ${B}totopo v3.15.0${R}${B}${GREY} \u00b7 ${R}${B}my-project${R}${NL}${rail}${NL}`, 0.7);

// 3. Menu, "Open session" selected, then collapsed (same as quickstart, shorter pause)
out(
    `${CYAN}\u25c6${R}  ${B}Menu:${R}${NL}` +
        `${rail}  ${GREEN}\u25cf${R} Open session ${GREY}(start or resume the dev container)${R}${NL}` +
        `${rail}  ${GREY}\u25cb Settings${R}${NL}` +
        `${rail}  ${GREY}\u25cb Advanced${R}${NL}` +
        `${rail}  ${GREY}\u25cb Help${R}${NL}` +
        `${rail}  ${GREY}\u25cb Quit${R}${NL}`,
    1.2,
);
out(`\u001b[6A\u001b[0J${GREEN}\u25c7${R}  ${B}Menu:${R}${NL}${rail}  ${GREY}Open session${R}${NL}${rail}${NL}`, 0.5);

// 4. Host audio server auto-start (automatic mode) - printed before the container starts
// (src/commands/dev.ts)
out(`${BLUE}\u25cf${R}  Host audio server started (voice input ready).${NL}${rail}${NL}`, 0.9);

// 5. Resume container (src/commands/dev.ts)
out(`${BLUE}\u25cf${R}  Resuming dev container...${NL}`, 1.0);

// 6. AI CLI update (templates/startup.mjs, summary mode): blank separator line,
// skip countdown, then the braille spinner, then npm's indented summary.
out(NL, 0.3);
// The skip window runs its full 3 seconds (nothing pressed), then the update starts.
out(`${BLUE}\u25cf${R} ${GREY}Updating AI CLIs in 3s... press SPACE to skip${R}`, 1.0);
out(`\r\u001b[K${BLUE}\u25cf${R} ${GREY}Updating AI CLIs in 2s... press SPACE to skip${R}`, 1.0);
out(`\r\u001b[K${BLUE}\u25cf${R} ${GREY}Updating AI CLIs in 1s... press SPACE to skip${R}`, 1.0);
out(`\r\u001b[K`, 0.05);
const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
for (let i = 0; i < 32; i++) {
    out(`\r${BLUE}${SPINNER[i % SPINNER.length]}${R} ${GREY}Updating AI CLIs to latest...${R}`, 0.11);
}
out(`\r\u001b[K${BLUE}\u25cf${R} ${GREY}Updating AI CLIs to latest...${R}${NL}` + `${GREY}   changed 3 packages in 14s${R}${NL}`, 1.0);

// 7. Sandbox welcome (same as quickstart)
out(
    `${NL}${GREEN}\u25cf${R}  ${B}You're now in a totopo sandbox${R} ${GREY}\u00b7${R} ${B}my-project${R}${NL}${NL}` +
        `   ${GREY}\u25b8${R} Run ${ORANGE}claude${R}, ${ORANGE}opencode${R}, or ${ORANGE}codex${R} to start an agent.${NL}` +
        `   ${GREY}\u25b8${R} Run ${B}status${R} to see container details & installed versions.${NL}` +
        `   ${GREY}\u25b8${R} Run ${B}exit${R} to end the session and return to the host.${NL}${NL}`,
    1.2,
);

// 8. Auto-start launches the configured agent - no typed command (generated .bashrc,
// src/lib/dockerfile-builder.ts)
out(`${GREEN}\u25cf${R}  ${GREY}Auto-start enabled: launching ${ORANGE}claude${GREY}.${R}${NL}${NL}`, 1.1);

// 9. Claude Code header, input box, status line (same as quickstart)
out(
    ` ${ORANGE}\u2590\u259b\u2588\u2588\u2588\u259c\u258c${R}   ${B}Claude Code${R} ${GREY}v2.1.207${R}${NL}` +
        `${ORANGE}\u259d\u259c\u2588\u2588\u2588\u2588\u2588\u259b\u2598${R}  Fable 5 (1M context) with high effort ${GREY}\u00b7${R} Claude Team${NL}` +
        `  ${ORANGE}\u2598\u2598 \u259d\u259d${R}    ${GREY}/workspace${R}${NL}${NL}`,
    0.9,
);
out(
    `${GREY}${"\u2500".repeat(88)}${R}${NL}` +
        ` ${GREY}\u276f${R} ${CURSOR}${NL}` +
        `${GREY}${"\u2500".repeat(88)}${R}${NL}` +
        ` ${BLUE}Fable 5${R} ${MAG}high${R}${GREY} \u00b7 ${R}${GREEN}0k${R}${GREY} / 1M (0%) \u00b7 Claude Code v2.1.207${R}${NL}`,
    1.6,
);

// 10. Type /exit in the input box: cursor up 3 rows to the input line, column 4
// (over the resting block cursor), type, then move back below the status line.
out(`\u001b[3A\r\u001b[3C`, 0.2);
type("/exit", 0.4);
out(`\u001b[3B\r${NL}`, 0.4);

// 11. Back in the container shell (the real PS1 from the generated .bashrc), exit to host
out(`${B}${GREEN}[totopo@my-project]${R} ${B}${BLUE}/${R} ${B}${GREEN}\u276f${R} `, 0.5);
type("exit", 0.35);
// Spacer rail line after the shell exits, like the one after `npx totopo`
out(`${NL}${rail}${NL}`, 0.7);

// 12. Auto-shutdown on the host (src/commands/dev.ts): audio server stops first
out(`${BLUE}\u25cf${R}  Host audio server stopped (no active sessions).${NL}${rail}${NL}`, 0.9);

// 13. Stop-container confirm, then collapsed with the answer (cursor up 3, clear down)
out(
    `${CYAN}\u25c6${R}  Last session to this container closed. Stop it? (resumes fast)${NL}` +
        `${rail}  ${GREEN}\u25cf${R} Yes ${GREY}/ \u25cb No${R}${NL}` +
        `${GREY}\u2514${R}${NL}`,
    1.6,
);
out(
    `\u001b[3A\u001b[0J` +
        `${GREEN}\u25c7${R}  Last session to this container closed. Stop it? (resumes fast)${NL}` +
        `${rail}  ${GREY}Yes${R}${NL}` +
        `${rail}${NL}`,
    0.7,
);

// 14. Container stops; totopo prints a trailing blank line and exits to the host prompt
out(`${BLUE}\u25cf${R}  Stopping container...${NL}${rail}${NL}`, 0.9);
out(`${BLUE}\u25cf${R}  Container stopped.${NL}${NL}`, 0.8);
out(`${BLUE}~/p/my-project${R} ${GREEN}\u276f${R} `, 2.0);

save("advanced.cast");
