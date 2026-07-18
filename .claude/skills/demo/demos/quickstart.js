#!/usr/bin/env node
// Generates quickstart.cast - a synthetic asciicast v2 of a basic totopo session:
// open a session from the menu, land in the sandbox, start claude by hand.
// Render: ./render.sh quickstart

import { B, BLUE, CURSOR, CYAN, createCast, GREEN, GREY, MAG, NL, ORANGE, R, rail } from "./lib.js";

const { out, type, save } = createCast({ title: "totopo quickstart" });

// 1. Host prompt + command
// Hide agg's native cursor for the whole session; we draw our own aligned block
// cursor (see type() in lib.js and the input box below) so it sits on the text row.
out(`\u001b[?25l${BLUE}~/p/my-project${R} ${GREEN}\u276f${R} `);
type("npx totopo", 0.5);
out(NL, 0.8);

// 2. Header line with left rail (single block): the bold status header from the
// workspace menu (src/commands/menu.ts). A spacer rail line precedes it. The
// container is stopped here, so the state is omitted (only "up" is shown, while
// running) and no notice line follows - just version and workspace.
out(`${rail}${NL}`, 0.05);
out(`${rail}  ${B}totopo v3.15.0${R}${B}${GREY} \u00b7 ${R}${B}my-project${R}${NL}${rail}${NL}`, 0.7);

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
out(`\u001b[6A\u001b[0J${GREEN}\u25c7${R}  ${B}Menu:${R}${NL}${rail}  ${GREY}Open session${R}${NL}${rail}${NL}`, 0.5);

// 4. Container startup (basic)
out(`${BLUE}\u25cf${R}  Resuming dev container...${NL}${rail}${NL}`, 1.5);
out(
    `${GREEN}\u25cf${R}  ${B}You're now in a totopo sandbox${R} ${GREY}\u00b7${R} ${B}my-project${R}${NL}${NL}` +
        `   ${GREY}\u25b8${R} Run ${ORANGE}claude${R}, ${ORANGE}opencode${R}, or ${ORANGE}codex${R} to start an agent.${NL}` +
        `   ${GREY}\u25b8${R} Run ${B}status${R} to see container details & installed versions.${NL}` +
        `   ${GREY}\u25b8${R} Run ${B}exit${R} to end the session and return to the host.${NL}${NL}`,
    1.4,
);

// 5. Run claude inside the sandbox (the real PS1 from the generated .bashrc)
out(`${B}${GREEN}[totopo@my-project]${R} ${B}${BLUE}/${R} ${B}${GREEN}\u276f${R} `, 0.4);
type("claude", 0.4);
out(NL, 0.9);

// Claude Code header (logo + text), input box, status line (single blocks)
out(
    `${NL}` +
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
    3.0,
);

save("quickstart.cast");
