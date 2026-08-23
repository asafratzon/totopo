// theme.js - one palette, used for two different jobs.
//
// The workspace takes one slot of it and keeps it: the composer border, the terminal's edge, the active tab's
// edge and the buttons are all that one colour, so a window is recognisable across a screen full of them
// before a single word is read. The slot comes from the published port, which totopo assigns per workspace,
// so two containers open side by side are almost never the same colour and nothing has to be configured.
//
// The sessions inside that window then rotate through the slots the workspace did not take. That is what
// makes a tab's own dot mean "this session" rather than "this workspace", and it is why a dot can never come
// out the same colour as the window it lives in.

// Cyberpunk neons on a near-black bar, spaced around the wheel and deliberately free of yellow and orange -
// those read as a warning here, and the bar has enough to say without one. Keep the length one longer than
// PALETTE_SIZE in sessions.js (a test pins it): the workspace eats one slot, sessions rotate the rest.
const PALETTE = [
    "#2fe58a", // spring green
    "#1fe0cf", // turquoise
    "#f24bff", // magenta
    "#b45cff", // neon violet
    "#29b6ff", // azure
    "#ff2e88", // rose
];

// A stable number for this window when there is no port to read (a proxy, or the default 80/443). Not a
// hash worth defending - it only has to be the same on every reload of the same address.
function hostSeed() {
    let seed = 0;
    for (const ch of location.host) seed = (seed * 31 + ch.codePointAt(0)) % 100_000;
    return seed;
}

// The workspace's slot in the palette. Ports are handed out lowest-free-first per workspace, so neighbours
// land on different colours.
const WORKSPACE_SLOT = (Number(location.port) || hostSeed()) % PALETTE.length;
export const WORKSPACE_COLOR = PALETTE[WORKSPACE_SLOT];
// Every slot except the workspace's own, in palette order. A session index maps into this, so "never the
// workspace colour" is a property of the list rather than a rule someone has to remember.
const SESSION_COLORS = PALETTE.filter((_, slot) => slot !== WORKSPACE_SLOT);

// Handed to the stylesheet once, before anything is drawn: everything that carries the window's identity
// reads it from there, so there is one line in the page that decides what colour this workspace is.
document.documentElement.style.setProperty("--ws", WORKSPACE_COLOR);

export function colorFor(entry) {
    return SESSION_COLORS[(entry.colorIndex ?? 0) % SESSION_COLORS.length];
}
