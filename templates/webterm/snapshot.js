// snapshot.js - What claude wrote down about a session, and which session it belongs to.
//
// The status line script runs on every prompt render and writes one small file per conversation: the model,
// how much context it is holding, what is left of the five-hour quota, and the pid of the claude process that
// wrote it. That file is the only place any of this exists - nothing here asks claude anything, and there is
// nothing to ask - so it is what the strip above the composer is drawn from.
//
// The pid is what turns a directory of files into a per-session fact. A snapshot belongs to a session when the
// process that wrote it is that session's PTY leader or something it started. The start time recorded beside
// the pid is the other half: the directory lives in the workspace's mounted agent home, so it holds files
// written by containers that are gone, and their pids can be live again as something else entirely. A snapshot
// whose process is not the one that wrote it is nobody's.
//
// What the pid does not do is authenticate the writer. Everything in the container runs as the same user, so a
// process that wanted to could write a snapshot naming a pid in another session's tree, and that session's
// strip would draw its numbers. That reaches no further than what a process running as this user can already
// do to those files directly. The check is against honest mistakes: one session's real snapshot showing up
// under another, or a recycled pid resurrecting a dead conversation.
//
// Every read here fails towards null. A file half-written, a field that changed shape in a Claude Code
// release, a directory that does not exist yet - all of them mean "no snapshot for this session", which is an
// ordinary answer: a session gets one a second after its agent starts, and never at all when it runs an agent
// that writes none.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSameProcess, isSelfOrDescendant } from "./proc.js";

// The largest a snapshot can be and still be read. The script writes a few hundred bytes; the cap only keeps
// an unrelated file that happens to sit in the directory from being pulled into memory.
const MAX_SNAPSHOT_BYTES = 64 * 1024;

// How many files one lookup will consider, newest first. A home directory that has been through many
// conversations accumulates them, and the one being looked for was written seconds ago.
const MAX_CANDIDATES = 40;

/**
 * Whether an agent writes snapshots at all. Only claude does - the status line is a Claude Code feature, and
 * the file is a side effect of it. A session running anything else has no status to show, which is why the
 * server never sends it a frame rather than sending an empty one.
 */
export function writesSnapshots(agent) {
    return agent === "claude";
}

/** The snapshot files in `dir`, newest first and capped. A directory that is not there contributes nothing. */
function snapshotFiles(dir) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const found = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const path = join(dir, entry.name);
        try {
            found.push({ path, mtime: statSync(path).mtimeMs });
        } catch {
            // Vanished between the listing and the stat.
        }
    }
    return found
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, MAX_CANDIDATES)
        .map((entry) => entry.path);
}

/** One snapshot as an object, or null. Size-checked first: a file this big is not one of these. */
function readSnapshot(path) {
    try {
        if (statSync(path).size > MAX_SNAPSHOT_BYTES) return null;
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

/** A finite number, or null for anything else - including a field that is missing or has gone null. */
function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A non-empty string, or null. */
function text(value) {
    return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The newest snapshot that belongs to this session, or null when it has not written one yet.
 *
 * `session` is `{ pid }` - the PTY leader, the root of the process tree the agent runs in - and `dir` is the
 * directory the status line writes to. The two checks are the whole of the match: the writer is inside this
 * session's tree, and it is still the process that wrote it.
 */
export function snapshotFor(session, dir) {
    const leader = Number(session?.pid);
    if (!Number.isInteger(leader)) return null;
    for (const path of snapshotFiles(dir)) {
        const snapshot = readSnapshot(path);
        const claudePid = Number(snapshot?.claude_pid);
        if (!Number.isInteger(claudePid)) continue;
        if (!isSelfOrDescendant(claudePid, leader)) continue;
        if (!isSameProcess(claudePid, snapshot.claude_pid_start ?? null)) continue;
        return snapshot;
    }
    return null;
}

/**
 * What the status strip draws for this session, or null when there is no snapshot for it.
 *
 * Every field is normalised here rather than in the browser: a field the strip cannot use is null, and a null
 * is what the strip leaves out. That way a Claude Code release that renames something takes a segment off the
 * strip instead of putting a "NaN%" on it.
 */
export function statusFor(session, dir) {
    const snapshot = snapshotFor(session, dir);
    if (snapshot === null) return null;
    return {
        model: text(snapshot.model),
        effort: text(snapshot.effort),
        tokens: num(snapshot.context_tokens),
        windowSize: num(snapshot.context_window_size),
        contextPct: num(snapshot.context_used_pct),
        quotaPct: num(snapshot.quota_left_pct),
        quotaResetsAt: num(snapshot.quota_resets_at),
        version: text(snapshot.version),
        updatedAt: num(snapshot.updated_at),
    };
}
