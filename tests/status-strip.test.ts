import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { blockAfter, cleanTempDir, createTempDir, readWebtermClient } from "./helpers.js";

// The status strip is drawn from the snapshot claude's status line writes, and the match between a snapshot
// and a session is a question about processes: the pid that wrote it has to be inside that session's tree,
// and it has to still be the process that wrote it. Neither is testable against the host's own /proc - the
// tree shapes these cases need are not there - so a fixture tree is written and the reader is pointed at it
// through WEBTERM_PROC_ROOT. That variable is read when proc.js is imported, so it is set before the import
// below and the whole file shares one fake process table.

const WEBTERM_DIR = join(import.meta.dirname, "..", "templates", "webterm");
const PROC_ROOT = createTempDir();
process.env.WEBTERM_PROC_ROOT = PROC_ROOT;

// One process in the fake table: its parent, and when it started. /proc/<pid>/stat with the command name
// parenthesised, the parent second after it and the start time twentieth.
function writeProcess(pid: number, ppid: number, start = 1000): void {
    mkdirSync(join(PROC_ROOT, String(pid)), { recursive: true });
    const fields = ["S", String(ppid), ...Array.from({ length: 17 }, () => "0"), String(start)];
    writeFileSync(join(PROC_ROOT, String(pid), "stat"), `${pid} (node (deleted)) ${fields.join(" ")}\n`);
}

type Snapshot = Record<string, unknown>;
type Status = {
    model: string | null;
    effort: string | null;
    tokens: number | null;
    windowSize: number | null;
    contextPct: number | null;
    quotaPct: number | null;
    quotaResetsAt: number | null;
    version: string | null;
    updatedAt: number | null;
};

const { snapshotFor, statusFor, writesSnapshots } = (await import(pathToFileURL(join(WEBTERM_DIR, "snapshot.js")).href)) as {
    snapshotFor: (session: { pid: number }, dir: string) => Snapshot | null;
    statusFor: (session: { pid: number }, dir: string) => Status | null;
    writesSnapshots: (agent: string) => boolean;
};

// The session's PTY leader, and the tree under it: claude is a child, and the status line script a child of
// that (it is what actually writes the file). A second, unrelated session sits beside them.
const LEADER = 100;
const CLAUDE = 101;
const STATUSLINE = 102;
const OTHER_LEADER = 200;
const OTHER_CLAUDE = 201;
const START = 4242;

let snapDir: string;

function addSnapshot(name: string, snapshot: Snapshot, mtime?: Date): void {
    const path = join(snapDir, `${name}.json`);
    writeFileSync(path, JSON.stringify(snapshot));
    if (mtime) utimesSync(path, mtime, mtime);
}

function claudeSnapshot(overrides: Snapshot = {}): Snapshot {
    return {
        session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        claude_pid: CLAUDE,
        claude_pid_start: START,
        updated_at: 1_780_000_000,
        context_tokens: 45_000,
        context_used_pct: 12,
        context_window_size: 1_000_000,
        model: "Opus 5",
        effort: "high",
        quota_left_pct: 84,
        quota_resets_at: 9_999_999_999,
        version: "2.1.241",
        ...overrides,
    };
}

before(() => {
    writeProcess(1, 0, 7);
    writeProcess(LEADER, 1, START);
    writeProcess(CLAUDE, LEADER, START);
    writeProcess(STATUSLINE, CLAUDE, START);
    writeProcess(OTHER_LEADER, 1, START);
    writeProcess(OTHER_CLAUDE, OTHER_LEADER, START);
});

after(async () => {
    await cleanTempDir(PROC_ROOT);
});

// ---- Which session a snapshot belongs to ------------------------------------------------------------------------------------------------

describe("matching a snapshot to a session", () => {
    let dir: string;

    before(() => {
        dir = createTempDir();
    });

    after(async () => {
        await cleanTempDir(dir);
    });

    test("a snapshot written anywhere inside the session's tree is that session's", () => {
        snapDir = join(dir, "inside");
        mkdirSync(snapDir);
        // Written by the status line script, two levels below the leader - the depth is the point.
        addSnapshot("deep", claudeSnapshot({ claude_pid: STATUSLINE }));
        assert.equal(snapshotFor({ pid: LEADER }, snapDir)?.claude_pid, STATUSLINE);
    });

    test("a snapshot from another session's tree is nobody else's", () => {
        snapDir = join(dir, "other-tree");
        mkdirSync(snapDir);
        addSnapshot("theirs", claudeSnapshot({ claude_pid: OTHER_CLAUDE }));
        assert.equal(snapshotFor({ pid: LEADER }, snapDir), null);
        assert.equal(snapshotFor({ pid: OTHER_LEADER }, snapDir)?.claude_pid, OTHER_CLAUDE);
    });

    test("a pid something else holds now is refused", () => {
        snapDir = join(dir, "recycled");
        mkdirSync(snapDir);
        // Written before a container restart: the pid is inside the tree, but the process that holds it now
        // started at a different moment, so it is not the one that wrote this.
        addSnapshot("stale", claudeSnapshot({ claude_pid_start: START - 1 }));
        assert.equal(snapshotFor({ pid: LEADER }, snapDir), null);
    });

    test("a snapshot too old to record a start time is taken at face value", () => {
        snapDir = join(dir, "no-start");
        mkdirSync(snapDir);
        addSnapshot("old", claudeSnapshot({ claude_pid_start: null }));
        assert.equal(snapshotFor({ pid: LEADER }, snapDir)?.claude_pid, CLAUDE);
    });

    test("a process that is gone is not shown", () => {
        snapDir = join(dir, "gone");
        mkdirSync(snapDir);
        addSnapshot("dead", claudeSnapshot({ claude_pid: 9999, claude_pid_start: START }));
        assert.equal(snapshotFor({ pid: LEADER }, snapDir), null);
    });

    test("the newest matching snapshot wins, so /clear does not leave the old one up", () => {
        snapDir = join(dir, "newest");
        mkdirSync(snapDir);
        addSnapshot("before-clear", claudeSnapshot({ model: "Sonnet 5" }), new Date("2026-08-01T10:00:00Z"));
        addSnapshot("after-clear", claudeSnapshot({ model: "Opus 5" }), new Date("2026-08-01T12:00:00Z"));
        assert.equal(snapshotFor({ pid: LEADER }, snapDir)?.model, "Opus 5");
    });

    test("an empty directory and a missing one both answer nothing", () => {
        snapDir = join(dir, "empty");
        mkdirSync(snapDir);
        assert.equal(snapshotFor({ pid: LEADER }, snapDir), null);
        assert.equal(snapshotFor({ pid: LEADER }, join(dir, "never-created")), null);
    });

    test("a file too big to be one of these is not read into memory", () => {
        snapDir = join(dir, "oversized");
        mkdirSync(snapDir);
        // Valid JSON with a matching pid, and 64k+ of padding: refused on size before it is parsed.
        addSnapshot("huge", claudeSnapshot({ padding: "x".repeat(70 * 1024) }));
        assert.equal(snapshotFor({ pid: LEADER }, snapDir), null);
    });

    test("a session with no pid, and an agent that writes no snapshots", () => {
        assert.equal(snapshotFor({ pid: Number.NaN }, snapDir), null);
        assert.equal(writesSnapshots("claude"), true);
        assert.equal(writesSnapshots("codex"), false);
        assert.equal(writesSnapshots("opencode"), false);
    });
});

// ---- What the strip is handed -----------------------------------------------------------------------------------------------------------

describe("the status the server sends", () => {
    let dir: string;

    before(() => {
        dir = createTempDir();
    });

    after(async () => {
        await cleanTempDir(dir);
    });

    test("every field the strip draws comes across, already normalised", () => {
        snapDir = join(dir, "full");
        mkdirSync(snapDir);
        addSnapshot("full", claudeSnapshot());
        assert.deepEqual(statusFor({ pid: LEADER }, snapDir), {
            model: "Opus 5",
            effort: "high",
            tokens: 45_000,
            windowSize: 1_000_000,
            contextPct: 12,
            quotaPct: 84,
            quotaResetsAt: 9_999_999_999,
            version: "2.1.241",
            updatedAt: 1_780_000_000,
        });
    });

    test("a field that went missing becomes null, which takes its segment off rather than showing NaN", () => {
        snapDir = join(dir, "partial");
        mkdirSync(snapDir);
        // A free account carries no rate limits, and an older snapshot carries no window size or version.
        addSnapshot("partial", {
            claude_pid: CLAUDE,
            claude_pid_start: START,
            model: "Opus 5",
            effort: "",
            context_tokens: 45_000,
            context_used_pct: 12,
            quota_left_pct: null,
        });
        const status = statusFor({ pid: LEADER }, snapDir);
        assert.equal(status?.effort, null, "an empty string is not a value the strip can draw");
        assert.equal(status?.windowSize, null);
        assert.equal(status?.quotaPct, null);
        assert.equal(status?.quotaResetsAt, null);
        assert.equal(status?.version, null);
        assert.equal(status?.tokens, 45_000);
    });

    test("no snapshot at all is null, not an object of nulls", () => {
        snapDir = join(dir, "none");
        mkdirSync(snapDir);
        assert.equal(statusFor({ pid: LEADER }, snapDir), null);
    });
});

// ---- The server side --------------------------------------------------------------------------------------------------------------------

describe("who hears about a session's status", () => {
    const server = readFileSync(join(WEBTERM_DIR, "server.js"), "utf8");

    test("nothing is sent for an agent that writes no snapshots, or a session nobody is watching", () => {
        const body = blockAfter(server, "function sendStatus(sid, { force = false } = {})");
        assert.match(body, /writesSnapshots\(session\.agent\)/, "a codex tab must get no frame rather than an empty one");
        assert.match(body, /session\?\.client/, "a session no window is watching has nobody to tell");
        assert.match(body, /Number\.isInteger\(pid\)/, "the match is against the PTY leader, so there has to be one");
    });

    test("an unchanged snapshot costs no frame, while an attach forces one", () => {
        const body = blockAfter(server, "function sendStatus(sid, { force = false } = {})");
        assert.match(body, /if \(!force && lastStatus\.get\(sid\) === serialised\) return;/);
        // The one event that means "this window is now looking at this session" - switch, reload, reconnect.
        assert.match(server, /sendStatus\(event\.sid, \{ force: true \}\);/);
    });

    test("a window only ever hears about the session it is driving", () => {
        const body = blockAfter(server, 'case "snapshot":');
        assert.match(body, /registry\.attachedSid\(ws\)/, "the frame must not be able to name a session");
        assert.ok(!body.includes("msg.sid"), "a sid off the socket would let a window read another session's numbers");
    });

    test("sessions that are gone drop out of the map the sweep keeps", () => {
        const body = blockAfter(server, "function sweepStatus()");
        assert.match(body, /lastStatus\.delete\(sid\)/);
    });
});

// ---- The page ---------------------------------------------------------------------------------------------------------------------------

describe("the strip on the page", () => {
    const app = readWebtermClient();

    test("the element sits between the terminal and the composer, and starts hidden", () => {
        const page = readFileSync(join(WEBTERM_DIR, "public", "index.html"), "utf8");
        const strip = page.indexOf('<div id="strip" hidden>');
        assert.ok(strip !== -1, "the page needs an element for the strip");
        assert.ok(strip > page.indexOf('id="termwrap"'), "the strip belongs below the terminal");
        assert.ok(strip < page.indexOf('id="composer"'), "and above the composer");
    });

    test("an empty strip is no strip: a session with nothing to show has no element", () => {
        const body = blockAfter(app, "function render()");
        assert.match(body, /strip\.hidden = shown\.length === 0;/);
    });

    test("the numbers belong to the attached session, and the ones that are gone are dropped", () => {
        assert.match(app, /export function pruneStatuses\(live\)/);
        assert.match(app, /pruneStatuses\(new Set\(sessions\.map\(\(entry\) => entry\.id\)\)\);/);
        const body = blockAfter(app, "export function applySnapshot(msg)");
        assert.match(body, /if \(msg\.sid === attachedSid\) render\(\);/, "another session's frame must not redraw this one");
    });

    test("a session that will never have a snapshot is not asked about twice", () => {
        const body = blockAfter(app, "export function refreshStrip()");
        assert.match(body, /!asked\.has\(attachedSid\)/);
        assert.match(body, /asked\.add\(attachedSid\)/);
    });

    test("the module is reachable from the entry, so the page really loads it", () => {
        const main = readFileSync(join(WEBTERM_DIR, "public", "app", "main.js"), "utf8");
        assert.match(main, /import "\.\/status-strip\.js";/);
    });

    test("the styles the strip draws with exist", () => {
        const css = readFileSync(join(WEBTERM_DIR, "public", "styles.css"), "utf8");
        // Scoped under #strip on purpose: seg, bar, name and fill are ordinary words, and left global they
        // would be the first thing a later rule elsewhere on the page collided with.
        for (const selector of ["#strip", "#strip .seg", "#strip .sep", "#strip .bar", "#strip .bar .fill"]) {
            assert.ok(css.includes(`${selector} {`), `styles.css must style ${selector}`);
        }
        for (const selector of ["#strip .bar.warn .fill", "#strip .bar.low .fill", "#strip .dim"]) {
            assert.ok(css.includes(selector), `styles.css must style ${selector}`);
        }
        // Every class the drawing code hands out is styled somewhere in the strip's own block, so an unstyled
        // one reads as a bug rather than as something that only happens to inherit what it wanted.
        const block = css.slice(css.indexOf("---- Status strip ----"), css.indexOf("---- Composer ----"));
        assert.ok(block.length > 0, "the strip needs its own block in styles.css");
        for (const [, cls] of app.matchAll(/span\("([a-z]+)"/g)) {
            assert.ok(block.includes(`.${cls}`), `span("${cls}") has no rule in the strip's styles`);
        }
    });
});
