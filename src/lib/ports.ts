// =========================================================================================================================================
// src/lib/ports.ts - Resolve, publish, and remember per-workspace host ports
// Identity-mapped, loopback-only (127.0.0.1:N:N) port publishing for tools running inside the container.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";

// --- Constants ---------------------------------------------------------------------------------------------------------------------------

// The CLI runs as a non-root user, so the availability probe (net bind) cannot bind ports below 1024.
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;
// How far above the configured port an ifTaken:next scan may reach before giving up.
export const PORT_SCAN_BOUND = 100;
// Publish and probe on loopback only - never 0.0.0.0. Nothing on the LAN may reach these sessions.
export const PORT_LOOPBACK_HOST = "127.0.0.1";

// --- Interfaces --------------------------------------------------------------------------------------------------------------------------

/** A single `ports` entry from totopo.yaml. */
export interface PortEntry {
    port: number; // Desired host port and the scan start (integer, 1024-65535)
    ifTaken?: "fail" | "next"; // On collision: "fail" (default) refuses to start; "next" scans upward
    env?: string; // Optional env var injected with the RESOLVED port number; required when ifTaken: next
}

/** An entry paired with the host port it resolved to (identity-mapped to the same container port). */
export interface ResolvedPort {
    entry: PortEntry;
    resolved: number;
}

// --- Config validation -------------------------------------------------------------------------------------------------------------------

/**
 * Validate semantic rules the JSON Schema cannot express, with clear messages. Throws on the first problem.
 * Structural rules (type, range, enum) are enforced by schema/totopo.schema.json at read time.
 */
export function validatePortsConfig(entries: PortEntry[]): void {
    const seenPorts = new Set<number>();
    const seenEnvs = new Set<string>();
    for (const entry of entries) {
        if (seenPorts.has(entry.port)) {
            throw new Error(`ports: duplicate port ${entry.port}. Each entry must use a distinct port.`);
        }
        seenPorts.add(entry.port);

        if (entry.env !== undefined) {
            if (seenEnvs.has(entry.env)) {
                throw new Error(`ports: duplicate env "${entry.env}". Each entry must inject a distinct env var.`);
            }
            seenEnvs.add(entry.env);
        }

        if ((entry.ifTaken ?? "fail") === "next" && !entry.env) {
            throw new Error(
                `ports: entry with port ${entry.port} uses ifTaken: next but has no env. A remapped port is unreachable ` +
                    "unless its number is injected - add an env (e.g. env: EXAMPLE_PORT) or use ifTaken: fail.",
            );
        }
    }
}

// --- Sticky planning (pure, no host I/O) -------------------------------------------------------------------------------------------------

/**
 * Decide each entry's intended host port before any host probing. Honors a remembered (sticky) allocation
 * only while its configured port is unchanged and the remembered value does not collide with another entry's
 * configured port or a port already assigned this run; otherwise falls back to the configured port (always
 * free for this entry, since duplicate configured ports are rejected upstream). The returned allocations map
 * is rebuilt from the current entries, so stale keys (ports no longer configured) are pruned.
 */
export function planPorts(
    entries: PortEntry[],
    remembered: Map<number, number>,
): { planned: ResolvedPort[]; allocations: Map<number, number> } {
    const configuredPorts = new Set(entries.map((e) => e.port));
    const assigned = new Set<number>();
    const planned: ResolvedPort[] = [];
    const allocations = new Map<number, number>();

    for (const entry of entries) {
        const prev = remembered.get(entry.port);
        let resolved = entry.port;
        if (prev !== undefined && prev !== entry.port && !assigned.has(prev) && !configuredPorts.has(prev)) {
            resolved = prev;
        }
        assigned.add(resolved);
        planned.push({ entry, resolved });
        allocations.set(entry.port, resolved);
    }

    return { planned, allocations };
}

// --- Availability probing (host I/O) -----------------------------------------------------------------------------------------------------

/** True if nothing on the host holds a loopback socket for this port (docker-proxy / userland-proxy=true, or a plain squatter). */
function canBind(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => server.close(() => resolve(true)));
        server.listen(port, PORT_LOOPBACK_HOST);
    });
}

/**
 * Host ports currently published by any running container. On native Linux with userland-proxy=false no host
 * socket exists (DNAT), so canBind alone would wrongly report a published port as free - this covers that case.
 * Returns an empty set when docker is unavailable (the bind probe still applies).
 */
export function dockerPublishedPorts(): Set<number> {
    const ports = new Set<number>();
    const result = spawnSync("docker", ["ps", "--format", "{{.Ports}}"], { encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0 || !result.stdout) return ports;
    // Published mappings look like "127.0.0.1:4820->4820/tcp" or "[::]:5432->5432/tcp"; the host port precedes "->".
    for (const match of result.stdout.matchAll(/:(\d+)->/g)) {
        const n = Number(match[1]);
        if (Number.isInteger(n)) ports.add(n);
    }
    return ports;
}

/** A port is available iff no running container publishes it AND a loopback bind succeeds. */
async function isPortAvailable(port: number, dockerPorts: Set<number>): Promise<boolean> {
    if (dockerPorts.has(port)) return false;
    return canBind(port);
}

/** Scan upward from startPort for the first available port, bounded by PORT_SCAN_BOUND. Throws when exhausted. */
async function scanForFreePort(startPort: number, dockerPorts: Set<number>, assigned: Set<number>): Promise<number> {
    const end = Math.min(PORT_MAX, startPort + PORT_SCAN_BOUND);
    for (let candidate = startPort; candidate <= end; candidate++) {
        if (assigned.has(candidate)) continue;
        if (await isPortAvailable(candidate, dockerPorts)) return candidate;
    }
    throw new Error(
        `ports: no free host port in range ${startPort}-${end} for the entry with port ${startPort}. ` +
            "Free a port in that range or lower the configured port.",
    );
}

/**
 * Turn planned (sticky/configured) ports into final host ports by probing the host. Run only on the create
 * path (the container has already been removed, so we never probe our own live port). For each entry: keep the
 * intended port if free; on collision throw for ifTaken:fail, or scan upward from the configured port for
 * ifTaken:next. `exclude` seeds the taken set so a create retry (after a "port is already allocated" race)
 * skips ports that just lost the race.
 */
export async function finalizePorts(planned: ResolvedPort[], exclude: Set<number> = new Set()): Promise<ResolvedPort[]> {
    const dockerPorts = dockerPublishedPorts();
    const assigned = new Set<number>(exclude);
    const finalized: ResolvedPort[] = [];

    for (const { entry, resolved } of planned) {
        const ifTaken = entry.ifTaken ?? "fail";
        let chosen = resolved;
        const free = !assigned.has(chosen) && (await isPortAvailable(chosen, dockerPorts));
        if (!free) {
            if (ifTaken === "fail") {
                throw new Error(
                    `ports: port ${entry.port} is already in use on the host. Free it, choose a different port, ` +
                        "or set ifTaken: next to scan for a free port.",
                );
            }
            // Sticky value was taken - resolve fresh by scanning upward from the configured port.
            chosen = await scanForFreePort(entry.port, dockerPorts, assigned);
        }
        assigned.add(chosen);
        finalized.push({ entry, resolved: chosen });
    }

    return finalized;
}

// --- Docker argument builders (pure) -----------------------------------------------------------------------------------------------------

/** Identity-mapped, loopback-only publish flags: 127.0.0.1:R:R per resolved port. */
export function portPublishArgs(resolved: ResolvedPort[]): string[] {
    return resolved.flatMap(({ resolved: r }) => ["-p", `${PORT_LOOPBACK_HOST}:${r}:${r}`]);
}

/** Env injection flags carrying the resolved number, only for entries that declare an env var. */
export function portEnvArgs(resolved: ResolvedPort[]): string[] {
    return resolved.flatMap(({ entry, resolved: r }) => (entry.env ? ["-e", `${entry.env}=${r}`] : []));
}

// --- Fingerprint -------------------------------------------------------------------------------------------------------------------------

/**
 * Deterministic fingerprint over the full entry (port, ifTaken normalized, env) plus the resolved port, used as
 * the container LABEL_PORTS. Editing ifTaken or env recreates the container; a no-ports workspace fingerprints
 * to "" so it never churns and pre-feature containers are not spuriously recreated.
 */
export function portsLabel(resolved: ResolvedPort[]): string {
    if (resolved.length === 0) return "";
    const parts = resolved.map(({ entry, resolved: r }) => `${entry.port}:${entry.ifTaken ?? "fail"}:${entry.env ?? ""}:${r}`).sort();
    return createHash("sha256").update(parts.join(",")).digest("hex").slice(0, 12);
}

// --- Allocation map (de)serialization for the .lock sticky store -------------------------------------------------------------------------

/** Build a configured-port -> resolved-port map from finalized entries, for persisting as the sticky store. */
export function allocationsOf(resolved: ResolvedPort[]): Map<number, number> {
    const map = new Map<number, number>();
    for (const { entry, resolved: r } of resolved) map.set(entry.port, r);
    return map;
}

/** Parse the .lock ports value (e.g. "4820:4821,5432:5432") into a map. Ignores malformed pairs. */
export function parsePortAllocations(str: string): Map<number, number> {
    const map = new Map<number, number>();
    for (const pair of str.split(",")) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const [k, v] = trimmed.split(":");
        const key = Number(k);
        const val = Number(v);
        if (Number.isInteger(key) && Number.isInteger(val)) map.set(key, val);
    }
    return map;
}

/** Serialize an allocation map to the .lock value form "cfg:resolved,cfg:resolved" (safe - contains no "="). */
export function formatPortAllocations(map: Map<number, number>): string {
    return [...map.entries()].map(([k, v]) => `${k}:${v}`).join(",");
}
