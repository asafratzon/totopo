import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";

// The registry ships inside the image as plain JS (the container runs it with the baked node-pty), so it
// is loaded here the same way the server loads it. The PTY is injected, which is what makes it testable:
// no node-pty on the host, and no real agent processes started by the test run.
const WEBTERM_DIR = join(import.meta.dirname, "..", "templates", "webterm");

type Registry = {
    attach: (sid: string, client: FakeSocket) => "attached" | "busy" | "gone";
    attachedCount: () => number;
    attachedSid: (client: FakeSocket) => string | null;
    close: (sid: string) => boolean;
    count: () => number;
    create: () => { ok: true; session: Session } | { ok: false; error: string };
    detach: (client: FakeSocket) => void;
    get: (sid: string) => Session | undefined;
    list: () => WireEntry[];
    pickForClient: (client: FakeSocket, wantSid?: string) => string | null;
    rename: (sid: string, rawName: string) => boolean;
    sessionFor: (client: FakeSocket) => Session | undefined;
    takeover: (sid: string, client: FakeSocket) => "attached" | "gone";
};
type Session = { id: string; label: string; name: string | null; colorIndex: number; term: FakeTerm };
type WireEntry = {
    id: string;
    label: string;
    name: string | null;
    colorIndex: number;
    createdAt: number;
    attached: boolean;
    unread: boolean;
};
type Event = { t: string; sid?: string; client?: FakeSocket; data?: string; label?: string };

const { createRegistry, PALETTE_SIZE, MAX_NAME_LENGTH, cleanName } = (await import(
    pathToFileURL(join(WEBTERM_DIR, "sessions.js")).href
)) as {
    createRegistry: (options: {
        spawn: () => FakeTerm;
        maxSessions: number;
        agent: string;
        maxBuffer: number;
        onEvent: (event: Event) => void;
    }) => Registry;
    PALETTE_SIZE: number;
    MAX_NAME_LENGTH: number;
    cleanName: (raw: unknown) => string | null;
};

// A browser window: the registry only ever asks whether its socket is still open (1 = WebSocket.OPEN).
class FakeSocket {
    readyState = 1;
    die() {
        this.readyState = 3;
    }
}

// A PTY that records what it was told, so a test can assert a kill happened - or, more importantly, did not.
class FakeTerm {
    killed = false;
    written: string[] = [];
    #data: (chunk: string) => void = () => {};
    #exit: () => void = () => {};

    onData(fn: (chunk: string) => void) {
        this.#data = fn;
    }
    onExit(fn: () => void) {
        this.#exit = fn;
    }
    write(chunk: string) {
        this.written.push(chunk);
    }
    resize() {}
    kill() {
        this.killed = true;
    }

    /** The agent printed something. */
    say(chunk: string) {
        this.#data(chunk);
    }
    /** The agent exited on its own (/exit, a crash). */
    quit() {
        this.#exit();
    }
}

function setup(maxSessions = 8) {
    const events: Event[] = [];
    const terms: FakeTerm[] = [];
    const registry = createRegistry({
        spawn: () => {
            const term = new FakeTerm();
            terms.push(term);
            return term;
        },
        maxSessions,
        agent: "claude",
        maxBuffer: 64,
        onEvent: (event) => events.push(event),
    });
    return { events, registry, terms };
}

// Create a session and fail loudly rather than returning a union the tests would have to narrow.
function start(registry: Registry): Session {
    const created = registry.create();
    assert.ok(created.ok, "create() should have succeeded here");
    return created.session;
}

function entryFor(registry: Registry, sid: string): WireEntry {
    const entry = registry.list().find((e) => e.id === sid);
    assert.ok(entry, `session ${sid} should be in the list`);
    return entry;
}

// ---- Persistence: what does and does not end a session ----------------------------------------------------------------------------------
// This is the whole point of the session model. A closed browser, dropped wifi and a slept laptop are
// indistinguishable from the server, so none of them may end a conversation.

describe("a session outlives the browser", () => {
    test("a window going away leaves the agent running and buffering", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, window);

        registry.detach(window);

        assert.equal(session.term.killed, false, "the agent must not be killed because a browser went away");
        assert.equal(registry.count(), 1);
        assert.equal(registry.attachedCount(), 0, "but nothing is watching it");
        assert.equal(entryFor(registry, session.id).attached, false);
    });

    test("what the agent said while nobody watched is replayed on the next connect", () => {
        const { events, registry } = setup();
        const first = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, first);
        registry.detach(first);

        session.term.say("what is 2+2?");

        const later = new FakeSocket();
        assert.equal(registry.attach(session.id, later), "attached");
        const replay = events.filter((e) => e.t === "replay").at(-1);
        assert.equal(replay?.client, later);
        assert.equal(replay?.data, "what is 2+2?", "the question asked before the laptop slept is still there");
    });

    test("the replay buffer keeps the tail once it is full", () => {
        const { events, registry } = setup();
        const session = start(registry);
        session.term.say("x".repeat(60));
        session.term.say("TAIL");

        registry.attach(session.id, new FakeSocket());

        const replay = events.filter((e) => e.t === "replay").at(-1);
        assert.equal(replay?.data?.length, 64, "buffer must be capped at maxBuffer");
        assert.ok(replay?.data?.endsWith("TAIL"), "and it is the newest output that is kept");
    });

    test("an explicit close ends exactly one session and kills only its agent", () => {
        const { registry } = setup();
        const one = start(registry);
        const two = start(registry);

        assert.equal(registry.close(one.id), true);

        assert.equal(one.term.killed, true);
        assert.equal(two.term.killed, false);
        assert.equal(registry.count(), 1);
        assert.equal(registry.get(one.id), undefined);
        assert.equal(registry.close(one.id), false, "closing it twice is not an error, just nothing to do");
    });

    test("closing does not report the session as having exited on its own", () => {
        const { events, registry } = setup();
        const session = start(registry);
        registry.close(session.id);
        // The PTY's own exit callback fires after the kill; the registry has to stay quiet, or the browser
        // would print "claude exited" for a session the user closed on purpose.
        session.term.quit();

        assert.equal(events.filter((e) => e.t === "exit").length, 0, "a deliberate close must not look like the agent quitting");
        assert.equal(registry.count(), 0);
    });

    test("an agent that exits takes its own session away and says so", () => {
        const { events, registry } = setup();
        const session = start(registry);

        session.term.quit();

        assert.equal(registry.count(), 0);
        const exited = events.find((e) => e.t === "exit");
        assert.equal(exited?.sid, session.id);
        assert.equal(exited?.label, "claude 1", "the log line names the session, so the label travels with the event");
    });
});

// ---- Where a close leaves you -----------------------------------------------------------------------------------------------------------
// Closing the session you are in should land you on its neighbour, the way closing a browser tab does -
// not on a dead screen. The registry does not know which window asked, so this also covers the case where
// another window closes the session you were watching.

describe("closing moves the window that was driving it", () => {
    test("to the next session along", () => {
        const { events, registry } = setup();
        const window = new FakeSocket();
        const first = start(registry);
        const second = start(registry);
        start(registry);
        registry.attach(second.id, window);
        events.length = 0;

        registry.close(second.id);

        assert.equal(registry.attachedSid(window), registry.list()[1]?.id, "the tab that was to its right");
        assert.notEqual(registry.attachedSid(window), first.id);
        const replay = events.find((e) => e.t === "replay");
        assert.equal(replay?.client, window, "and the window is sent that session's screen");
    });

    test("to the previous one when the closed session was the last", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const first = start(registry);
        const last = start(registry);
        registry.attach(last.id, window);

        registry.close(last.id);

        assert.equal(registry.attachedSid(window), first.id);
    });

    test("skipping any session another window is watching", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const free = start(registry);
        const mine = start(registry);
        const theirs = start(registry);
        registry.attach(mine.id, window);
        registry.attach(theirs.id, new FakeSocket());

        registry.close(mine.id);

        // The one to the right is taken, so it falls back to the left rather than prompting a takeover.
        assert.equal(registry.attachedSid(window), free.id);
    });

    test("and leaves it where it is when some other session was closed", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const mine = start(registry);
        const other = start(registry);
        registry.attach(mine.id, window);

        registry.close(other.id);

        assert.equal(registry.attachedSid(window), mine.id, "closing a background session must not move you");
    });

    test("nowhere when that was the only session", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const only = start(registry);
        registry.attach(only.id, window);

        registry.close(only.id);

        assert.equal(registry.attachedSid(window), null);
        assert.equal(registry.count(), 0);
    });

    test("nowhere when the window that was driving it is gone", () => {
        const { events, registry } = setup();
        const gone = new FakeSocket();
        const session = start(registry);
        start(registry);
        registry.attach(session.id, gone);
        gone.die();
        events.length = 0;

        registry.close(session.id);

        assert.equal(events.filter((e) => e.t === "replay").length, 0, "nothing to send to a socket that is gone");
        assert.equal(registry.attachedCount(), 0);
    });
});

// ---- The cap ----------------------------------------------------------------------------------------------------------------------------

describe("the session cap", () => {
    test("refuses past the limit, and lets a close make room again", () => {
        const { registry } = setup(3);
        const first = start(registry);
        start(registry);
        start(registry);

        const refused = registry.create();
        assert.deepEqual(refused, { ok: false, error: "cap" });
        assert.equal(registry.count(), 3, "a refused create must not spawn anything");

        registry.close(first.id);
        assert.ok(registry.create().ok, "one closed session frees one slot");
    });
});

// ---- Labels and colours -----------------------------------------------------------------------------------------------------------------

describe("labels and colours follow one counter", () => {
    test("numbers count up, colours rotate through the palette", () => {
        const { registry } = setup(PALETTE_SIZE + 2);
        const sessions = Array.from({ length: PALETTE_SIZE + 2 }, () => start(registry));

        assert.deepEqual(
            sessions.map((s) => s.label),
            Array.from({ length: PALETTE_SIZE + 2 }, (_, i) => `claude ${i + 1}`),
        );
        assert.deepEqual(
            sessions.map((s) => s.colorIndex),
            Array.from({ length: PALETTE_SIZE + 2 }, (_, i) => i % PALETTE_SIZE),
        );
    });

    test("a number is never reused, so a label always means the same session", () => {
        const { registry } = setup();
        const first = start(registry);
        registry.close(first.id);

        assert.equal(start(registry).label, "claude 2", "the next session is 2, not 1 again");
    });
});

// ---- Renaming a session -----------------------------------------------------------------------------------------------------------------
// A user-chosen name replaces the "claude N" label so a long-lived conversation reads by what it is about.
// The default label is always kept underneath, so clearing the name brings the number back.

describe("renaming a session", () => {
    test("sets a name the whole list can see, and tells every window", () => {
        const { events, registry } = setup();
        const session = start(registry);
        events.length = 0;

        assert.equal(registry.rename(session.id, "refactor auth"), true);

        assert.equal(entryFor(registry, session.id).name, "refactor auth");
        assert.equal(entryFor(registry, session.id).label, "claude 1", "the default label stays, so the number is still there");
        assert.equal(events.filter((e) => e.t === "changed").length, 1, "the bar is rebroadcast once");
    });

    test("an empty or whitespace-only name clears back to the default", () => {
        const { registry } = setup();
        const session = start(registry);
        registry.rename(session.id, "temporary");

        registry.rename(session.id, "   ");

        assert.equal(entryFor(registry, session.id).name, null, "a blank name means no name, not a blank one");
    });

    test("names are cut to the cap and stripped of control characters", () => {
        const { registry } = setup();
        const session = start(registry);

        registry.rename(session.id, `${"x".repeat(MAX_NAME_LENGTH + 20)}`);
        assert.equal(entryFor(registry, session.id).name?.length, MAX_NAME_LENGTH, "a runaway name is cut to the cap");

        registry.rename(session.id, "line one\nline\ttwo");
        assert.equal(entryFor(registry, session.id).name, "line onelinetwo", "newlines and tabs are dropped, so a name is one clean line");
    });

    test("renaming a session that is gone says so and does not throw", () => {
        const { registry } = setup();
        assert.equal(registry.rename("no-such-sid", "whatever"), false);
    });

    test("renaming touches nothing but the label", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, window);

        registry.rename(session.id, "still mine");

        assert.equal(registry.attachedSid(window), session.id, "the driver is unchanged");
        assert.equal(session.term.killed, false, "the agent is untouched");
    });

    // cleanName is the single source of truth for what a name may be; the frame handler and the client both
    // lean on it, so a couple of direct checks pin the edges.
    test("cleanName rejects non-strings and yields null for nothing usable", () => {
        assert.equal(cleanName(undefined), null);
        assert.equal(cleanName(42), null);
        assert.equal(cleanName(""), null);
        assert.equal(cleanName("  hi  "), "hi", "surrounding whitespace is trimmed");
    });
});

// ---- One driver per session --------------------------------------------------------------------------------------------------------------
// A PTY has a single size, so two windows on one session would fight over resize. Hence: one driver, and
// a deliberate takeover. But a window must never have to take a session over from itself.

describe("who may drive a session", () => {
    test("a different window that is really watching has to be asked about", () => {
        const { registry } = setup();
        const first = new FakeSocket();
        const second = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, first);

        assert.equal(registry.attach(session.id, second), "busy");
        assert.equal(registry.sessionFor(first)?.id, session.id, "the refused attach changed nothing");
    });

    test("a window whose socket died is not asked about - that is the sleep case", () => {
        const { registry } = setup();
        const asleep = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, asleep);
        asleep.die();

        assert.equal(registry.attach(session.id, new FakeSocket()), "attached");
    });

    test("a duplicated tab cannot silently take a live session", () => {
        const { registry } = setup();
        const original = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, original);
        // Browsers copy sessionStorage into a duplicated tab, so any id the page holds is shared by the
        // duplicate. Only the live socket decides, which makes the duplicate ask like anyone else - two
        // windows on one PTY would otherwise fight over its size with no prompt shown.
        const duplicate = new FakeSocket();
        assert.equal(registry.attach(session.id, duplicate), "busy");
        assert.equal(registry.attachedSid(original), session.id);
        // Asking deliberately still works, and displaces the original.
        assert.equal(registry.takeover(session.id, duplicate), "attached");
        assert.equal(registry.attachedSid(duplicate), session.id);
    });

    test("a reloaded window takes its session back once the old socket has closed", () => {
        const { registry } = setup();
        const before = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, before);
        // A reload closes the socket, so detach has already run by the time the new one says hello.
        before.die();
        registry.detach(before);

        const after = new FakeSocket();
        assert.equal(registry.attach(session.id, after), "attached");
        assert.equal(registry.attachedSid(after), session.id);
    });

    test("attaching to a session that is gone says so", () => {
        const { registry } = setup();
        assert.equal(registry.attach("nope", new FakeSocket()), "gone");
    });

    test("a window drives one session at a time", () => {
        const { registry } = setup();
        const window = new FakeSocket();
        const one = start(registry);
        const two = start(registry);
        registry.attach(one.id, window);

        registry.attach(two.id, window);

        assert.equal(registry.attachedSid(window), two.id);
        assert.equal(entryFor(registry, one.id).attached, false, "the session it left has no driver");
        assert.equal(registry.attachedCount(), 1);
    });

    test("takeover moves the session and tells the window that lost it", () => {
        const { events, registry } = setup();
        const first = new FakeSocket();
        const second = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, first);

        assert.equal(registry.takeover(session.id, second), "attached");

        assert.equal(registry.attachedSid(second), session.id);
        assert.equal(registry.attachedSid(first), null);
        const taken = events.find((e) => e.t === "taken");
        assert.equal(taken?.client, first, "the displaced window is told, so it can take it back");
        assert.equal(taken?.sid, session.id);
    });

    test("taking over a session nobody is watching tells nobody", () => {
        const { events, registry } = setup();
        const session = start(registry);

        registry.takeover(session.id, new FakeSocket());

        assert.equal(events.filter((e) => e.t === "taken").length, 0);
    });

    test("a dead socket counts as nobody watching", () => {
        const { registry } = setup();
        const asleep = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, asleep);
        asleep.die();

        assert.equal(registry.attachedCount(), 0);
        assert.equal(entryFor(registry, session.id).attached, false);
    });
});

// ---- Where a fresh window lands ---------------------------------------------------------------------------------------------------------

describe("pickForClient", () => {
    test("prefers the session this window was last looking at", () => {
        const { registry } = setup();
        start(registry);
        const wanted = start(registry);

        assert.equal(registry.pickForClient(new FakeSocket(), wanted.id), wanted.id);
    });

    test("falls back to the oldest session nobody is watching", () => {
        const { registry } = setup();
        const oldest = start(registry);
        start(registry);

        assert.equal(registry.pickForClient(new FakeSocket(), "long-gone-sid"), oldest.id);
    });

    test("skips the ones another window is driving", () => {
        const { registry } = setup();
        const driven = start(registry);
        const free = start(registry);
        registry.attach(driven.id, new FakeSocket());

        assert.equal(registry.pickForClient(new FakeSocket(), driven.id), free.id);
    });

    test("nothing when every session is driven elsewhere, so the user picks from the bar", () => {
        const { registry } = setup();
        const session = start(registry);
        registry.attach(session.id, new FakeSocket());

        assert.equal(registry.pickForClient(new FakeSocket()), null);
    });
});

// ---- Unread ------------------------------------------------------------------------------------------------------------------------------

describe("the unread mark", () => {
    test("is set by output nobody is watching, and announced once", () => {
        const { events, registry } = setup();
        const session = start(registry);
        events.length = 0;

        session.term.say("done!");
        session.term.say("anything else?");

        assert.equal(entryFor(registry, session.id).unread, true);
        assert.equal(
            events.filter((e) => e.t === "changed").length,
            1,
            "a chatty background agent must not turn into a broadcast per chunk",
        );
        assert.equal(events.filter((e) => e.t === "out").length, 0, "and no output is sent to nobody");
    });

    test("clears when a window looks at the session", () => {
        const { registry } = setup();
        const session = start(registry);
        session.term.say("done!");

        registry.attach(session.id, new FakeSocket());

        assert.equal(entryFor(registry, session.id).unread, false);
    });

    test("output goes to the window that is watching, and is not marked unread", () => {
        const { events, registry } = setup();
        const window = new FakeSocket();
        const session = start(registry);
        registry.attach(session.id, window);
        events.length = 0;

        session.term.say("thinking...");

        const out = events.find((e) => e.t === "out");
        assert.equal(out?.client, window);
        assert.equal(out?.data, "thinking...");
        assert.equal(entryFor(registry, session.id).unread, false);
    });
});

// ---- Cross-file literal sync -------------------------------------------------------------------------------------------------------------

describe("the palette the browser draws matches the indexes the registry hands out", () => {
    test("app.js defines exactly PALETTE_SIZE colours", () => {
        const app = readFileSync(join(WEBTERM_DIR, "public", "app.js"), "utf8");
        const match = /SESSION_COLORS = \[([^\]]*)\]/.exec(app);
        assert.ok(match, "app.js must define SESSION_COLORS");
        const colors = (match?.[1] ?? "").match(/"#[0-9a-f]{3,8}"/gi) ?? [];
        // colorIndex is (seq - 1) % PALETTE_SIZE, so a shorter list would leave sessions with no colour.
        assert.equal(colors.length, PALETTE_SIZE, "SESSION_COLORS drifted from PALETTE_SIZE in sessions.js");
    });
});
