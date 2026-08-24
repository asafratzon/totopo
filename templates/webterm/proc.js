// proc.js - The few things the container side needs to know about processes, read from /proc.
//
// Two callers, both asking about identity rather than about process control. The status strip asks "is this
// snapshot this session's?" - the pid recorded in the snapshot is walked up the tree to the session's PTY
// leader, and the start time recorded beside it is what tells a live pid from a recycled one on a directory
// that outlived the container that wrote it. The resume decision asks "when did this container start?" - the
// start time of PID 1, which is a different number on every `docker start` and unchanged by anything inside.
//
// Everything here fails towards "no": an unreadable /proc entry, a pid that is gone, a tree deeper than any
// real one - all of them answer null or false rather than throwing, because the caller's next move is always
// to refuse.

import { readFileSync } from "node:fs";

// A process tree in a container is a handful of levels deep. The cap is what keeps a malformed /proc, or a
// cycle that should not exist, from spinning here.
const MAX_ANCESTRY_DEPTH = 64;

// Where the process table is read from. Always /proc in the container; a fixture tree in the tests, which is
// the only way to exercise a tree shape the test host does not happen to have.
const PROC_ROOT = process.env.WEBTERM_PROC_ROOT || "/proc";

/**
 * The fields of /proc/<pid>/stat after the command name, or null when the process is gone.
 *
 * The command name is the reason this is not a plain split: it is wrapped in parentheses and may itself hold
 * spaces and parentheses ("(node (deleted))"), so everything up to the LAST ") " is skipped. What is left
 * starts at the state field, which makes the parent pid field 2 and the start time field 20 - the same
 * offsets claude-statusline.sh uses, counted the same way.
 */
function statFields(pid) {
    let line;
    try {
        line = readFileSync(`${PROC_ROOT}/${pid}/stat`, "utf8");
    } catch {
        return null;
    }
    const end = line.lastIndexOf(") ");
    if (end === -1) return null;
    return line
        .slice(end + 2)
        .trim()
        .split(/\s+/);
}

/** The pid that started this one, or null when it is gone or unreadable. */
export function parentPid(pid) {
    const fields = statFields(pid);
    const parent = Number(fields?.[1]);
    return Number.isInteger(parent) && parent > 0 ? parent : null;
}

/**
 * When a process started, in jiffies since boot (/proc/<pid>/stat field 22), or null when it is gone.
 * Pids are recycled; a pid plus its start time is not, which is what makes this worth reading.
 */
export function processStart(pid) {
    const fields = statFields(pid);
    const started = Number(fields?.[19]);
    return Number.isInteger(started) ? started : null;
}

/** True when `pid` is `ancestor` itself or anything it started, however many levels down. */
export function isSelfOrDescendant(pid, ancestor) {
    if (!Number.isInteger(pid) || !Number.isInteger(ancestor) || pid < 1 || ancestor < 1) return false;
    let current = pid;
    for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
        if (current === ancestor) return true;
        if (current <= 1) return false;
        const parent = parentPid(current);
        if (parent === null) return false;
        current = parent;
    }
    return false;
}

/**
 * Whether a process that recorded itself as `pid` started at `start` is still that same process. A snapshot
 * written before a container restart can name a pid that something else holds now, and the start time is
 * what tells the two apart. A record with no start time is taken at face value: it is older than the field,
 * not suspect.
 */
export function isSameProcess(pid, start) {
    if (!Number.isInteger(pid) || pid < 1) return false;
    if (start === null || start === undefined) return processStart(pid) !== null;
    const live = processStart(pid);
    return live !== null && live === Number(start);
}
