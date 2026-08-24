// resume.js - What reopens this workspace's last conversation, if anything, and who gets to.
//
// Two questions, and they are separate on purpose. "What reopens the last conversation here?" is answered by
// reading the agent's own session store - which lives in this container, written by CLIs installed only here,
// so this is the only side that can honestly answer it. "Does this session get to?" is the once-per-container-
// start chance, claimed through a stamp file, because a resume is what the first session after a container
// start does and every session after it starts fresh.
//
// Both doors ask: the web interface through server.js, and the shell auto-start hook through resume-cli.js.
// They never run at the same time - the hook only fires when the interface is off - and the claim is
// synchronous, so nothing here can double-spend the chance.
//
// The honest answer is often null: a workspace that has never run an agent has nothing to reopen, and saying
// so is what lets the session start fresh instead of being handed a resume command with nothing behind it.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { processStart } from "./proc.js";

// A claude transcript is named after the conversation it holds, which is also the id claude resumes by.
export const CLAUDE_TRANSCRIPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

// A codex rollout: rollout-<timestamp>-<uuid>.jsonl, where the uuid is the conversation id it resumes by.
// The .zst is not optional dressing - codex compresses rollouts once they go cold, so a store whose history
// has all been compressed would otherwise read as empty and never resume.
export const CODEX_ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/;

// How far below a store's root a conversation can sit, per store, because the shapes are not alike and a walk
// deep enough for the deepest is wasted on the others. codex files rollouts under dated subdirectories
// (sessions/2026/08/01/); opencode nests everything under storage/session/{info,message,part}/, where part/
// holds one file per message part and is the reason a bound matters at all; claude's transcripts sit exactly
// one level down, in a dir named after the directory the session ran in. A flat listing finds nothing in the
// first two, so the walk has to recurse - it just must not recurse further than the store actually goes.
const STORE_DEPTH = { claudeProjects: 1, claudeProjectDir: 0, codexSessions: 3, opencodeSessions: 2 };

/**
 * Claude Code files its transcripts per directory, in a dir named after the directory it ran in with every
 * character that is not a letter or a digit turned into "-": /workspace -> -workspace, /workspace/apps/api ->
 * -workspace-apps-api. So a session in a sub-directory reads and writes a different dir from one at the root,
 * and a resume that names an id from the wrong one hands claude something it cannot find.
 * Only the fallback below relies on this naming; the main path reads what a transcript says about itself.
 */
export function claudeProjectKey(containerPath) {
    return containerPath.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Every matching file under `dir`, in no order, each visited through `onFile`. Returning true from `onFile`
 * stops the walk, which is what lets a caller that only needs to know whether there is one at all stop at the
 * first.
 *
 * Symlinks are skipped rather than followed: a store is a directory of files an agent wrote, and a link out of
 * it leads somewhere this has no business walking. A directory that is not there contributes nothing, which is
 * the ordinary case for an agent that has never run here.
 */
function walkStore(dir, pattern, maxDepth, onFile) {
    const walk = (current, depth) => {
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            return false; // Missing, or not readable.
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const path = join(current, entry.name);
            if (entry.isDirectory()) {
                if (depth < maxDepth && walk(path, depth + 1)) return true;
                continue;
            }
            if (!entry.isFile() || !pattern.test(entry.name)) continue;
            if (onFile(path)) return true;
        }
        return false;
    };
    walk(dir, 0);
}

/** Every file under `dir` whose name matches `pattern`, newest first. */
export function filesNewestFirst(dir, pattern, maxDepth = 1) {
    const found = [];
    walkStore(dir, pattern, maxDepth, (path) => {
        try {
            found.push({ path, mtime: statSync(path).mtimeMs });
        } catch {
            // Vanished between the listing and the stat.
        }
        return false;
    });
    return found.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.path);
}

/**
 * Whether the store holds anything at all that matches, stopping at the first one it finds.
 *
 * codex and opencode are resumed by their own flag rather than by id, so all that is asked of their stores is
 * whether there is a conversation in them. Answering that by listing and stat-ing everything first is what
 * would make a heavy opencode store - one file per message part - a pause on the way to a new session.
 */
function hasAnyFile(dir, pattern, maxDepth) {
    let found = false;
    walkStore(dir, pattern, maxDepth, () => {
        found = true;
        return true;
    });
    return found;
}

/**
 * What a transcript says about itself, in one pass: whether it holds a real user message, and the directory
 * that message was typed in. Sessions that only recorded UI state (mode changes, slash commands) have nothing
 * to resume; sidechain records belong to subagents. isSidechain is a field we do not own, so only an explicit
 * true excludes a record: a record that stopped carrying the field still counts as resumable, which fails on
 * the safe side. `cwd` is null for transcripts written before claude recorded it.
 */
function transcriptFacts(transcriptPath) {
    let content;
    try {
        content = readFileSync(transcriptPath, "utf8");
    } catch {
        return { resumable: false, cwd: null };
    }
    // Walked by index rather than split("\n") so a multi-MB transcript is not copied into an array of lines.
    let start = 0;
    while (start <= content.length) {
        const end = content.indexOf("\n", start);
        const line = content.slice(start, end === -1 ? content.length : end);
        start = (end === -1 ? content.length : end) + 1;
        // Cheap pre-filter so multi-MB transcripts are not JSON.parsed line by line.
        if (!line.includes('"type":"user"')) continue;
        try {
            const record = JSON.parse(line);
            if (record.type === "user" && record.isSidechain !== true) {
                return { resumable: true, cwd: typeof record.cwd === "string" ? record.cwd : null };
            }
        } catch {
            // Skip malformed lines.
        }
    }
    return { resumable: false, cwd: null };
}

// The first of these transcripts that can be resumed, in the order given. `requiredCwd` of null asks only that
// the conversation has messages; a directory asks that it recorded that one too. Transcripts are read in order
// and the walk stops at the first hit, so the usual case reads a single file.
function newestResumableId(transcriptPaths, requiredCwd) {
    for (const path of transcriptPaths) {
        const facts = transcriptFacts(path);
        if (!facts.resumable) continue;
        if (requiredCwd !== null && facts.cwd !== requiredCwd) continue;
        return basename(path).slice(0, -".jsonl".length);
    }
    return null;
}

/**
 * The most recent Claude Code conversation that can be resumed in `cwd`: the newest transcript with a real
 * (non-sidechain) user message that ran in that directory.
 *
 * The directory is matched on what the transcript records, not on which dir it sits in, so however claude names
 * those dirs we never hand back a conversation from somewhere else - resuming it would either fail or drop the
 * user into another directory's history. Transcripts old enough to record no directory at all are the fallback,
 * and for those the dir name is the only evidence there is. Null when nothing qualifies.
 */
function claudeResumeId(cwd, stores) {
    const projects = stores.claudeProjects;
    const all = filesNewestFirst(projects, CLAUDE_TRANSCRIPT, STORE_DEPTH.claudeProjects);
    const byRecordedDir = newestResumableId(all, cwd);
    if (byRecordedDir !== null) return byRecordedDir;
    const dir = join(projects, claudeProjectKey(cwd));
    return newestResumableId(filesNewestFirst(dir, CLAUDE_TRANSCRIPT, STORE_DEPTH.claudeProjectDir), null);
}

// What reopens a stored conversation, per agent, and where to look to know there is one. claude is not here: it
// is resumed by id above, because `claude --continue` takes the newest transcript by mtime and can land on one
// that holds no real messages. Pinned against the real CLIs by the drift test in tests/webterm.test.ts, which
// checks each flag and subcommand against the CLI's own help.
export const CONTINUE = {
    opencode: { argv: ["opencode", "--continue"], store: "opencodeSessions", pattern: /\.json$/ },
    codex: { argv: ["codex", "resume", "--last"], store: "codexSessions", pattern: CODEX_ROLLOUT },
};

/**
 * The argv that reopens this workspace's last conversation for `agent` in `cwd`, or null when there is none.
 * `stores` is AGENT_STORES from config.js, passed in so this is testable against a fixture tree.
 */
export function resumeArgvFor(agent, cwd, stores) {
    try {
        if (agent === "claude") {
            const id = claudeResumeId(cwd, stores);
            return id === null ? null : ["claude", "--resume", id];
        }
        const known = CONTINUE[agent];
        if (!known) return null;
        return hasAnyFile(stores[known.store], known.pattern, STORE_DEPTH[known.store]) ? [...known.argv] : null;
    } catch {
        // A store that changed shape under us must never take the session down with it - starting fresh is a
        // worse session than the user asked for, but it is a session.
        return null;
    }
}

// --- The once-per-container-start chance -------------------------------------------------------------------------------------------------

/**
 * The name of this container start: the start time of PID 1.
 *
 * PID 1 is the keep-alive totopo runs the container with, so it starts when the container does and its start
 * time is a different number on every `docker start`. That makes it exactly the span a resume belongs to - not
 * this process (one crash and relaunch would resume a second time) and not this workspace (then it would only
 * ever happen once). Null when /proc cannot be read.
 */
export function containerStartId() {
    const started = processStart(1);
    return started === null ? null : String(started);
}

// Whether this process has already handed out a resume. Only consulted when the stamp is no help - a
// container start it cannot name, or a stamp it cannot write - because the stamp is what carries the answer
// across processes and this only carries it within one.
let resumeSpent = false;

// One resume per process: the weakest honest answer, for when there is no stamp to lean on. A relaunched
// server would offer another, but a container that cannot be named or written to is already not behaving,
// and a spare resume is a better failure than every session resuming.
function spendOnce() {
    if (resumeSpent) return false;
    resumeSpent = true;
    return true;
}

/**
 * Whether this session is the one that gets to reopen the last conversation, spending the chance if so.
 *
 * Read-then-write rather than an atomic claim, which is safe here because the two callers never overlap: the
 * shell hook only runs when the web interface is off, and inside the server this whole function is synchronous,
 * so two sessions created in the same tick cannot interleave.
 */
export function claimResumeChance(stampPath) {
    const startId = containerStartId();
    if (startId === null) return spendOnce();
    let stamped = null;
    try {
        stamped = readFileSync(stampPath, "utf8").trim();
    } catch {
        // Never stamped, or the file is gone - either way this container start has not had its resume.
    }
    if (stamped === startId) return false;
    try {
        writeFileSync(stampPath, `${startId}\n`);
    } catch (err) {
        // Nothing was recorded, so the file cannot refuse the next session and the per-process fallback is all
        // that is left. Said out loud, because otherwise the only sign is every session resuming.
        console.warn(`[webterm] could not write ${stampPath}: ${err instanceof Error ? err.message : String(err)}`);
        return spendOnce();
    }
    resumeSpent = true;
    return true;
}
