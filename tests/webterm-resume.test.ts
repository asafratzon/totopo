import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { CONTAINER_WORKSPACE } from "../src/lib/constants.js";
import { cleanTempDir, createTempDir } from "./helpers.js";

// resume.js ships inside the image as plain JS, because the decision it makes belongs where the session
// stores are: they are written by CLIs installed only in the container. It is loaded here the same way the
// server loads it, and the stores are passed in, which is what makes it testable from the host.
//
// The container-start claim reads PID 1's start time, so it needs a process table the host does not have.
// WEBTERM_PROC_ROOT is read when proc.js is imported, so it is set before the import below.

const WEBTERM_DIR = join(import.meta.dirname, "..", "templates", "webterm");
const PROC_ROOT = createTempDir();
process.env.WEBTERM_PROC_ROOT = PROC_ROOT;

// PID 1's start time is the name of this container start. Rewriting it is a `docker stop` and `docker start`.
function setContainerStart(start: number): void {
    mkdirSync(join(PROC_ROOT, "1"), { recursive: true });
    const fields = ["S", "0", ...Array.from({ length: 17 }, () => "0"), String(start)];
    writeFileSync(join(PROC_ROOT, "1", "stat"), `1 (bash) ${fields.join(" ")}\n`);
}

type Stores = { claudeProjects: string; codexSessions: string; opencodeSessions: string };

const { claimResumeChance, claudeProjectKey, CONTINUE, filesNewestFirst, resumeArgvFor } = (await import(
    pathToFileURL(join(WEBTERM_DIR, "resume.js")).href
)) as {
    claimResumeChance: (stampPath: string) => boolean;
    claudeProjectKey: (containerPath: string) => string;
    CONTINUE: Record<"codex" | "opencode", { argv: string[]; store: string; pattern: RegExp }>;
    filesNewestFirst: (dir: string, pattern: RegExp, maxDepth?: number) => string[];
    resumeArgvFor: (agent: string, cwd: string, stores: Stores) => string[] | null;
};

const OLDER = new Date("2026-08-01T10:00:00Z");
const NEWER = new Date("2026-08-01T12:00:00Z");
const AT_ROOT = "11111111-1111-4111-8111-111111111111";
const AT_NESTED = "22222222-2222-4222-8222-222222222222";
const NESTED = "/workspace/apps/api";

let home: string;
let stores: Stores;

// A transcript's one real user message, with or without the directory claude recorded on it (transcripts
// written before claude carried the field are the reason the fallback exists).
function userLine(cwd: string | null): string {
    const record: Record<string, unknown> = { type: "user", isSidechain: false, message: { role: "user", content: "hi" } };
    if (cwd !== null) record.cwd = cwd;
    return `${JSON.stringify(record)}\n`;
}

const CONTENTLESS = `${JSON.stringify({ type: "mode", mode: "normal" })}\n${JSON.stringify({ type: "system", subtype: "local_command" })}\n`;
const SIDECHAIN = `${JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: "sub task" } })}\n`;

function writeAt(path: string, content: string, mtime: Date): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    utimesSync(path, mtime, mtime);
}

function addTranscript(projectKey: string, sessionId: string, content: string, mtime: Date): void {
    writeAt(join(stores.claudeProjects, projectKey, `${sessionId}.jsonl`), content, mtime);
}

beforeEach(() => {
    home = createTempDir();
    stores = {
        claudeProjects: join(home, ".claude", "projects"),
        codexSessions: join(home, ".codex", "sessions"),
        opencodeSessions: join(home, ".local", "share", "opencode", "storage", "session"),
    };
});

afterEach(async () => {
    await cleanTempDir(home);
});

before(() => {
    setContainerStart(1000);
});

after(async () => {
    await cleanTempDir(PROC_ROOT);
});

// ---- Walking a store --------------------------------------------------------------------------------------------------------------------
// codex files its rollouts under dated subdirectories and opencode nests session storage under project
// directories, so a walk that does not recurse finds nothing in either and both silently never resume.

describe("finding what an agent wrote", () => {
    test("a nested store is walked, newest first", () => {
        writeAt(
            join(stores.codexSessions, "2026", "08", "01", "rollout-2026-08-01T10-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"),
            "{}\n",
            OLDER,
        );
        writeAt(
            join(stores.codexSessions, "2026", "08", "02", "rollout-2026-08-02T10-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"),
            "{}\n",
            NEWER,
        );
        const found = filesNewestFirst(stores.codexSessions, CONTINUE.codex.pattern, 3);
        assert.equal(found.length, 2, "a flat listing would find none of these");
        assert.match(found[0] ?? "", /2026-08-02/, "newest first");
    });

    test("the walk stops at the depth the store actually goes", () => {
        // The bound is what keeps a store that grew a deep tree from being walked to the bottom on every
        // session start - opencode files one JSON per message part, so the tree is the reason it exists.
        const deep = join(stores.codexSessions, "2026", "08", "01", "extra");
        writeAt(join(deep, "rollout-x-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"), "{}\n", NEWER);
        assert.deepEqual(filesNewestFirst(stores.codexSessions, CONTINUE.codex.pattern, 3), [], "one level too deep");
        assert.equal(filesNewestFirst(stores.codexSessions, CONTINUE.codex.pattern, 4).length, 1);
    });

    test("a missing store contributes nothing rather than throwing", () => {
        assert.deepEqual(filesNewestFirst(join(home, "never-created"), /\.json$/), []);
    });

    test("names that do not match the pattern are not conversations", () => {
        writeAt(join(stores.codexSessions, "notes.txt"), "hi\n", NEWER);
        writeAt(join(stores.codexSessions, "rollout-broken.jsonl"), "{}\n", NEWER);
        assert.deepEqual(filesNewestFirst(stores.codexSessions, CONTINUE.codex.pattern), []);
    });

    test("a link out of the store is not followed", () => {
        const outside = join(home, "outside");
        writeAt(join(outside, "escaped.json"), "{}\n", NEWER);
        mkdirSync(stores.opencodeSessions, { recursive: true });
        symlinkSync(outside, join(stores.opencodeSessions, "link"));
        assert.deepEqual(filesNewestFirst(stores.opencodeSessions, /\.json$/), []);
    });
});

// ---- Which conversation reopens ---------------------------------------------------------------------------------------------------------

describe("what reopens the last conversation", () => {
    test("claudeProjectKey names a directory's transcript dir the way claude does", () => {
        // The fallback path is the only thing that leans on this naming, and it is the path a workspace whose
        // transcripts predate the recorded cwd depends on entirely - so the convention is pinned on its own.
        assert.equal(claudeProjectKey(CONTAINER_WORKSPACE), "-workspace");
        assert.equal(claudeProjectKey(NESTED), "-workspace-apps-api");
        assert.equal(claudeProjectKey("/workspace/a_b.c"), "-workspace-a-b-c", "every non-alphanumeric becomes a dash");
    });

    test("nothing at all, for a workspace that has never run an agent", () => {
        // The whole point of the move: null is the honest answer, and a session with no history starts fresh
        // instead of being handed a resume command with nothing behind it.
        assert.equal(resumeArgvFor("claude", CONTAINER_WORKSPACE, stores), null);
        assert.equal(resumeArgvFor("codex", CONTAINER_WORKSPACE, stores), null);
        assert.equal(resumeArgvFor("opencode", CONTAINER_WORKSPACE, stores), null);
        assert.equal(resumeArgvFor("bash", CONTAINER_WORKSPACE, stores), null, "an agent this does not know");
    });

    test("claude is resumed by id, from the newest transcript with a real message", () => {
        addTranscript("-workspace", AT_ROOT, userLine(CONTAINER_WORKSPACE), OLDER);
        addTranscript("-workspace", AT_NESTED, userLine(CONTAINER_WORKSPACE), NEWER);
        assert.deepEqual(resumeArgvFor("claude", CONTAINER_WORKSPACE, stores), ["claude", "--resume", AT_NESTED]);
    });

    test("a newer transcript with nothing in it is skipped, and so is a subagent's", () => {
        addTranscript("-workspace", AT_ROOT, userLine(CONTAINER_WORKSPACE), OLDER);
        addTranscript("-workspace", AT_NESTED, CONTENTLESS, NEWER);
        assert.deepEqual(resumeArgvFor("claude", CONTAINER_WORKSPACE, stores), ["claude", "--resume", AT_ROOT]);

        addTranscript("-workspace", "33333333-3333-4333-8333-333333333333", SIDECHAIN, NEWER);
        assert.deepEqual(resumeArgvFor("claude", CONTAINER_WORKSPACE, stores), ["claude", "--resume", AT_ROOT]);
    });

    test("the directory it recorded is what decides, not the directory it sits in", () => {
        // A dir name this code would never derive: if claude's naming ever changes, what the transcript says
        // about itself still matches.
        addTranscript("-workspace-apps-api-2", AT_NESTED, userLine(NESTED), NEWER);
        assert.deepEqual(resumeArgvFor("claude", NESTED, stores), ["claude", "--resume", AT_NESTED]);
        assert.equal(resumeArgvFor("claude", CONTAINER_WORKSPACE, stores), null, "the root has no history of its own");
    });

    test("a transcript below the project dir is not this workspace's history", () => {
        // claude's transcripts sit exactly one level under projects/. Everything deeper is a session's own
        // scratch - subagents/, tool-results/ - and a resume must never be built out of one.
        addTranscript(join("-workspace", "subagents"), AT_NESTED, userLine(CONTAINER_WORKSPACE), NEWER);
        assert.equal(resumeArgvFor("claude", CONTAINER_WORKSPACE, stores), null);
    });

    test("transcripts too old to record a directory fall back to the dir name", () => {
        addTranscript("-workspace-apps-api", AT_NESTED, userLine(null), OLDER);
        addTranscript("-workspace", AT_ROOT, userLine(null), NEWER);
        assert.deepEqual(
            resumeArgvFor("claude", NESTED, stores),
            ["claude", "--resume", AT_NESTED],
            "the root's newer history is not this directory's",
        );
        assert.deepEqual(resumeArgvFor("claude", CONTAINER_WORKSPACE, stores), ["claude", "--resume", AT_ROOT]);
    });

    test("codex and opencode carry their own flag, once there is something to reopen", () => {
        writeAt(join(stores.codexSessions, "2026", "08", "rollout-x-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"), "{}\n", NEWER);
        writeAt(join(stores.opencodeSessions, "info", "ses_1.json"), "{}\n", NEWER);
        assert.deepEqual(resumeArgvFor("codex", CONTAINER_WORKSPACE, stores), ["codex", "resume", "--last"]);
        assert.deepEqual(resumeArgvFor("opencode", CONTAINER_WORKSPACE, stores), ["opencode", "--continue"]);
    });

    test("a codex history that has all been compressed is still a history", () => {
        // codex compresses rollouts once they go cold. A pattern that only knew .jsonl would read a store of
        // nothing but cold sessions as empty, and every session would start fresh with the history right there.
        writeAt(join(stores.codexSessions, "2026", "08", "rollout-x-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl.zst"), "", NEWER);
        assert.deepEqual(resumeArgvFor("codex", CONTAINER_WORKSPACE, stores), ["codex", "resume", "--last"]);
    });

    test("the argv handed back is a copy, so a caller cannot edit the constant", () => {
        writeAt(join(stores.opencodeSessions, "proj", "ses_1.json"), "{}\n", NEWER);
        const argv = resumeArgvFor("opencode", CONTAINER_WORKSPACE, stores) as string[];
        argv.push("--dangerous");
        assert.deepEqual(CONTINUE.opencode.argv, ["opencode", "--continue"]);
    });
});

// ---- The once-per-container-start chance ------------------------------------------------------------------------------------------------

describe("who gets to reopen it", () => {
    // The per-process fallback is module state, spent by the first successful claim and never reset (a real
    // server is one process per container start). So the fallback case goes first, while it is still unspent.
    test("a stamp that cannot be written falls back to one resume per process, not one per session", () => {
        setContainerStart(3000);
        const unwritable = join(home, "no-such-dir", "stamp");
        assert.equal(claimResumeChance(unwritable), true);
        assert.equal(claimResumeChance(unwritable), false, "nothing was recorded, so this process is the only memory left");
    });

    test("one session per container start, and another after a restart", () => {
        const stamp = join(home, ".totopo-resume-stamp");
        setContainerStart(1000);
        assert.equal(claimResumeChance(stamp), true, "the first session after a container start");
        assert.equal(claimResumeChance(stamp), false, "the second session in the same container start");
        assert.equal(readFileSync(stamp, "utf8").trim(), "1000", "the stamp names the container start it spent");

        // A relaunched server inside the same container reads the same stamp and is still refused: the file is
        // the memory, not this process. And a docker stop/start gives PID 1 a new start time, so the next
        // session does reopen the conversation.
        setContainerStart(2000);
        assert.equal(claimResumeChance(stamp), true);
        assert.equal(claimResumeChance(stamp), false);
        assert.equal(readFileSync(stamp, "utf8").trim(), "2000");
    });
});
