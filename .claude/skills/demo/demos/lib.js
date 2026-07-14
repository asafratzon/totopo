// Shared engine for the synthetic README demo casts. Each scenario file
// (quickstart.js, advanced.js) imports this to author an asciicast v2 file.
// NOTE: renderers may merge/drop events with identical timestamps - always
// emit multi-line blocks as a single out() call, or give each event a pause.

import fs from "node:fs";

// ANSI codes shared by all scenarios.
export const R = "\u001b[0m";
export const B = "\u001b[1m";
export const BLUE = "\u001b[34m";
export const CYAN = "\u001b[36m";
export const GREEN = "\u001b[32m";
export const GREY = "\u001b[38;5;245m";
export const MAG = "\u001b[35m";
export const ORANGE = "\u001b[38;5;173m";
export const NL = "\r\n";
export const rail = `${GREY}\u2502${R}`;

// Cursor glyph. agg vector-draws a full block to the top of the cell, so at
// line-height 1.0 it floats a few pixels above the text row. The lower seven
// eighths block trims that top sliver, so the block sits on the text row while
// staying full width and (nearly) full height - it reads as a proper cursor.
export const CURSOR = "\u2587";

export function createCast({ width = 90, height = 24, title }) {
    let t = 0.6;
    const events = [];
    const rnd = (min, max) => min + Math.random() * (max - min);

    // Emit raw output, then wait pauseAfter seconds before the next event.
    function out(text, pauseAfter = 0.05) {
        events.push([Number(t.toFixed(3)), "o", text]);
        t += pauseAfter;
    }

    // Simulate human typing at 40-90 ms per keystroke.
    function type(text, pauseAfter = 0.3) {
        for (const ch of text) {
            // Print the character, draw the block cursor after it, then step back
            // onto the block so the next keystroke overwrites it. We draw our own
            // cursor (agg's native one is hidden) so it uses the aligned CURSOR glyph.
            events.push([Number(t.toFixed(3)), "o", `${ch}${CURSOR}\b`]);
            t += rnd(0.04, 0.09);
        }
        t += pauseAfter;
        // Clear the resting cursor as the line is submitted.
        events.push([Number(t.toFixed(3)), "o", " "]);
        t += 0.05;
    }

    function save(castFile) {
        const header = {
            version: 2,
            width,
            height,
            timestamp: Math.floor(Date.now() / 1000),
            title,
            env: { TERM: "xterm-256color", SHELL: "/bin/zsh" },
        };
        const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
        fs.writeFileSync(castFile, `${lines.join("\n")}\n`);
        console.log(`Wrote ${castFile} (${events.length} events, ${t.toFixed(1)}s)`);
    }

    return { out, type, save };
}
