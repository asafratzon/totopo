// =========================================================================================================================================
// src/lib/webterm.ts - Host-side logic for the web agent interface (webterm)
// Sticky per-workspace host-port assignment from the global web_range, plus the container hook that starts
// the baked webterm server once per container start. Whether there is a conversation to reopen is decided
// inside the container (templates/webterm/resume.js), where the session stores are.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { type AutoStartAgent, CONTAINER_USER, WEB_KEY_FILE_PATH } from "./constants.js";
import { canBind, containerPublishedPorts, dockerPublishedPorts, PORT_LOOPBACK_HOST, type WebRange } from "./ports.js";
import { listWorkspaceIds, readWebPort, writeWebPort } from "./workspace-identity.js";

// --- Port assignment (pure over the .lock files) -----------------------------------------------------------------------------------------

/** Every web port currently assigned to a workspace, optionally excluding one workspace's own assignment. */
export function collectAssignedWebPorts(excludeWorkspaceId?: string): Set<number> {
    const taken = new Set<number>();
    for (const id of listWorkspaceIds()) {
        if (id === excludeWorkspaceId) continue;
        const port = readWebPort(id);
        if (port !== null) taken.add(port);
    }
    return taken;
}

/** Lowest port in the range not already taken, or null when the range is exhausted. */
export function nextFreeWebPort(range: WebRange, taken: Set<number>): number | null {
    for (let port = range.start; port <= range.end; port++) {
        if (!taken.has(port)) return port;
    }
    return null;
}

/**
 * Why a workspace has no usable web port. "exhausted" means nothing in the range qualified; "unrecorded"
 * means a port was found but could not be written to the workspace .lock. They need different messages:
 * only the first is fixed by widening the range.
 */
export type WebPortFailure = "exhausted" | "unrecorded";

/** A sticky port assignment, or why one could not be made. */
export type WebPortResult = { ok: true; port: number } | { ok: false; reason: WebPortFailure };

/**
 * Return a workspace's sticky web port, assigning the lowest free port in the range when it has none.
 * An already-assigned port is returned as-is even when it falls outside the range - stickiness wins;
 * out-of-range ports move only when the user changes the range (reassignOutOfRangeWebPorts).
 * This is pure over the .lock files: it never probes the host, so it can say a port is assigned but not
 * that it can be published. resolveWebPort adds that.
 */
export function ensureWebPort(workspaceId: string, range: WebRange): WebPortResult {
    const existing = readWebPort(workspaceId);
    if (existing !== null) return { ok: true, port: existing };
    const port = nextFreeWebPort(range, collectAssignedWebPorts(workspaceId));
    if (port === null) return { ok: false, reason: "exhausted" };
    // A port that could not be recorded must not be used: it would be invisible to the next
    // workspace's scan and handed out twice.
    if (!writeWebPort(workspaceId, port)) return { ok: false, reason: "unrecorded" };
    return { ok: true, port };
}

/** Enable-time walk: give every known workspace a sticky port. Returns the assignments that were made or found. */
export function assignWebPortsToAllWorkspaces(range: WebRange): Array<{ workspaceId: string; port: number }> {
    const assigned: Array<{ workspaceId: string; port: number }> = [];
    for (const workspaceId of listWorkspaceIds()) {
        const result = ensureWebPort(workspaceId, range);
        if (result.ok) assigned.push({ workspaceId, port: result.port });
    }
    return assigned;
}

/**
 * The outcome of picking the port a session will actually publish. `movedFrom` is set when the sticky
 * assignment had to change; on failure `keptPort` is the assignment left in place, so the workspace
 * recovers on its own once the range is widened or whatever held the port goes away.
 */
export type WebPortResolution =
    | { ok: true; port: number; movedFrom?: number }
    | { ok: false; reason: WebPortFailure; keptPort: number | null };

/**
 * The host port this workspace's web interface should publish this session.
 *
 * `usable(port)` is the caller's test for "can this port carry the interface right now" - it covers both
 * the host-side probe and any host port the workspace already declares in totopo.yaml. When the sticky
 * assignment fails that test the port MOVES and the new one is persisted: sticky means it stays where it
 * was last put, not that it stays somewhere unusable and warns about the same conflict at every start.
 * When nothing in the range qualifies the old assignment is left alone rather than cleared, so the
 * workspace keeps its identity and picks the port back up once the conflict clears.
 */
export async function resolveWebPort(
    workspaceId: string,
    range: WebRange,
    usable: (port: number) => Promise<boolean>,
): Promise<WebPortResolution> {
    const assigned = ensureWebPort(workspaceId, range);
    if (!assigned.ok) return { ok: false, reason: assigned.reason, keptPort: readWebPort(workspaceId) };
    if (await usable(assigned.port)) return { ok: true, port: assigned.port };
    const taken = collectAssignedWebPorts(workspaceId);
    for (let port = range.start; port <= range.end; port++) {
        if (port === assigned.port || taken.has(port)) continue;
        if (!(await usable(port))) continue;
        // Same rule as the first assignment: a port that could not be recorded must not be handed out.
        if (!writeWebPort(workspaceId, port)) return { ok: false, reason: "unrecorded", keptPort: assigned.port };
        return { ok: true, port, movedFrom: assigned.port };
    }
    return { ok: false, reason: "exhausted", keptPort: assigned.port };
}

/**
 * Range-change walk: move only the sticky ports that fall outside the new range to the lowest free
 * in-range port. In-range assignments are never touched. Returns the moves that were made.
 */
export function reassignOutOfRangeWebPorts(range: WebRange): Array<{ workspaceId: string; from: number; to: number }> {
    const moves: Array<{ workspaceId: string; from: number; to: number }> = [];
    for (const workspaceId of listWorkspaceIds()) {
        const current = readWebPort(workspaceId);
        if (current === null || (current >= range.start && current <= range.end)) continue;
        const port = nextFreeWebPort(range, collectAssignedWebPorts(workspaceId));
        if (port === null) continue; // Range exhausted; leave the old assignment rather than dropping it.
        if (!writeWebPort(workspaceId, port)) continue; // Not recorded - keep the old port rather than report a move that did not happen.
        moves.push({ workspaceId, from: current, to: port });
    }
    return moves;
}

// --- Host-port and live-session probing ---------------------------------------------------------------------------------------------------

/**
 * True when this workspace can publish its sticky web port right now: either the port is free on the
 * host, or this workspace's own running container is the one already publishing it (the normal case on
 * the connect path). Anything else holding it - another container, an unrelated host process - means
 * the mapping has to be dropped for this session, because the web interface is a convenience and must
 * never block the session the way a totopo.yaml port does.
 */
export async function webPortUsable(webPort: number, containerName: string): Promise<boolean> {
    if (containerPublishedPorts(containerName).has(webPort)) return true;
    return !dockerPublishedPorts().has(webPort) && (await canBind(webPort));
}

/** What the web interface reports about itself: live agent sessions, and how many a browser is watching. */
export type WebSessionInfo = { sessions: number; attached: number };

/**
 * The key this container's web interface is currently demanding, read from the file its server publishes
 * before binding the port. A new key is minted at every server start and nothing on the host stores one,
 * so it is always read fresh, right before it is used.
 * Returns null when there is nothing to read: no container, no interface running, or a container built
 * before the key existed. Callers then probe without a key, which is exactly what such an older server
 * (which ignores the query parameter) expects.
 */
export function readWebKey(containerName: string): string | null {
    const result = spawnSync("docker", ["exec", "-u", CONTAINER_USER, containerName, "cat", WEB_KEY_FILE_PATH], { stdio: "pipe" });
    if (result.status !== 0) return null;
    const key = result.stdout?.toString().trim();
    return key ? key : null;
}

/**
 * Ask this workspace's web interface what it is running, over the published loopback port. `sessions` is
 * how many agents are alive in the container - they outlive every browser connection and only end with
 * the container - and `attached` how many of them a browser window is watching right now.
 * `key` is what the interface demands of every caller (readWebKey); a wrong or missing one is answered
 * with 403, which reads here like any other non-answer.
 * Returns null when the interface did not answer at all, so callers can tell "running, nothing open"
 * from "not running": the connect path relaunches the server on null, and the stop prompt warns only
 * when sessions would be lost.
 */
export async function webSessionInfo(webPort: number, key: string | null): Promise<WebSessionInfo | null> {
    const query = key === null ? "" : `?k=${encodeURIComponent(key)}`;
    try {
        const response = await fetch(`http://${PORT_LOOPBACK_HOST}:${webPort}/status${query}`, {
            signal: AbortSignal.timeout(WEB_STATUS_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { sessions?: unknown; attached?: unknown };
        if (typeof body.sessions !== "number" || typeof body.attached !== "number") return null;
        return { sessions: body.sessions, attached: body.attached };
    } catch {
        return null; // Not listening, wrong thing listening, or too slow to matter.
    }
}

/**
 * Point an already-running interface at the directory this session was started from, so its new sessions open
 * where a terminal session would. The interface takes that directory from the launcher, which only runs once
 * per container start - so on a container that has been up since yesterday the default is yesterday's
 * directory, and this is what moves it.
 * `key` is what the interface demands of every caller (readWebKey); without one it answers 403, which reads
 * here like any other refusal. Best-effort: a false only means the browser's "+ New session" still opens
 * where it did, and the picker can be used instead.
 */
export async function setWebDefaultCwd(webPort: number, key: string | null, workdir: string): Promise<boolean> {
    const query = key === null ? "" : `?k=${encodeURIComponent(key)}`;
    try {
        const response = await fetch(`http://${PORT_LOOPBACK_HOST}:${webPort}/cwd${query}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd: workdir }),
            signal: AbortSignal.timeout(WEB_STATUS_TIMEOUT_MS),
        });
        return response.ok;
    } catch {
        return false; // Not listening, an interface too old to know the route, or too slow to matter.
    }
}

// The interface is on loopback in the same machine, so a slow answer means something is wrong, not far.
const WEB_STATUS_TIMEOUT_MS = 1500;

/**
 * Whether the interface is serving at all. Any HTTP answer counts, including the 403 a keyless probe gets:
 * refusing a caller without a key is still proof that the server is up. Used where only liveness matters
 * (did the launch work, is the interface still there), so those paths need no key and no docker exec.
 */
export async function webInterfaceAnswers(webPort: number): Promise<boolean> {
    try {
        await fetch(`http://${PORT_LOOPBACK_HOST}:${webPort}/status`, { signal: AbortSignal.timeout(WEB_STATUS_TIMEOUT_MS) });
        return true;
    } catch {
        return false; // Not listening, or too slow to matter.
    }
}

// --- Container hooks (docker I/O, best-effort) --------------------------------------------------------------------------------------------

/**
 * The `docker exec` argv that starts the baked webterm server, with the given agent as the one its new
 * sessions start with, opening them in `workdir`. The server runs every agent it knows, one per session, so
 * this is a default rather than the only agent it will run. It is always passed explicitly - `webterm` on its
 * own only prints usage.
 *
 * The directory travels as an env var rather than as `docker exec -w`: `-w` on a path docker cannot use
 * fails the whole exec, which would cost the user the interface over something the server itself can just
 * refuse and fall back to the workspace root.
 */
export function webtermExecArgs(containerName: string, agent: Exclude<AutoStartAgent, "off">, workdir: string): string[] {
    return ["exec", "-d", "-u", CONTAINER_USER, "-e", `WEBTERM_CWD=${workdir}`, containerName, "webterm", agent];
}

/**
 * Start the baked webterm server detached, once per container start, defaulting to the given agent.
 * The launcher is idempotent (exits quietly when the port is already bound).
 * Best-effort - the user can always run `webterm <agent>` by hand.
 */
function startWebtermDetached(containerName: string, agent: Exclude<AutoStartAgent, "off">, workdir: string): void {
    spawnSync("docker", webtermExecArgs(containerName, agent, workdir), { stdio: "pipe" });
}

// How long to wait for a just-launched interface to answer, and how often to ask. `docker exec -d` returns
// as soon as the process is detached, so these cover node starting up and binding the port.
const WEB_START_TIMEOUT_MS = 8000;
const WEB_START_POLL_MS = 250;

/**
 * Start the interface and wait until it actually answers on its port. `docker exec -d` reports success the
 * moment the process detaches, which says nothing about whether the server came up, so without this a
 * crashed launch would leave the greeting advertising a URL that never responds. Returns false when the
 * interface never answered - the caller reports that and starts nothing in its place, leaving the user to
 * retry `webterm <agent>` or run the agent in the terminal.
 */
export async function startWebtermAndVerify(
    containerName: string,
    agent: Exclude<AutoStartAgent, "off">,
    webPort: number,
    workdir: string,
): Promise<boolean> {
    startWebtermDetached(containerName, agent, workdir);
    const deadline = Date.now() + WEB_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await webInterfaceAnswers(webPort)) return true;
        await new Promise((r) => setTimeout(r, WEB_START_POLL_MS));
    }
    return false;
}
