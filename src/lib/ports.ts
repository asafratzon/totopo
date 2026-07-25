// =========================================================================================================================================
// src/lib/ports.ts - Publish static, loopback-only host ports into the container
// A `ports` entry is either a bare integer (identity map, 127.0.0.1:N:N) or a "HOST:CONTAINER" string. Config is the
// source of truth: a host port already in use is a clear, hard failure that names the offending entry.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { WEB_CONTAINER_PORT } from "./constants.js";

// --- Constants ---------------------------------------------------------------------------------------------------------------------------

// The CLI runs as a non-root user, so the availability probe (net bind) cannot bind ports below 1024.
export const PORT_MIN = 1024;
export const PORT_MAX = 65535;
// Publish and probe on loopback only - never 0.0.0.0. Nothing on the LAN may reach these sessions.
export const PORT_LOOPBACK_HOST = "127.0.0.1";

// --- Interfaces --------------------------------------------------------------------------------------------------------------------------

/** A single `ports` entry from totopo.yaml, as parsed. `port` is a bare integer (identity) or a "HOST:CONTAINER" string. */
export interface PortEntry {
    port: number | string;
    env?: string; // Optional env var injected with the host port number; identity entries only (host === container)
}

/** A validated, normalized mapping. `env` is present only on identity entries (host === container). */
export interface PortMapping {
    host: number;
    container: number;
    env?: string;
}

// --- Config validation and normalization -------------------------------------------------------------------------------------------------

/** A single port number is a usable, unprivileged host/container port. */
export function inRange(port: number): boolean {
    return Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX;
}

/** Human-readable label for an entry, used in error and notice messages. */
function describe(m: PortMapping): string {
    return m.host === m.container ? `port ${m.host}` : `mapping "${m.host}:${m.container}"`;
}

/**
 * Validate and normalize the raw `ports` entries into host->container mappings. This is the single source of
 * truth for ports semantics (unit-testable without the JSON Schema). Throws on the first problem with a clear,
 * actionable message. The JSON Schema enforces coarse structure (types, the env pattern, no unknown keys); the
 * range and cross-entry rules live here.
 */
export function validatePortsConfig(entries: PortEntry[]): PortMapping[] {
    const mappings: PortMapping[] = [];
    const seenHosts = new Set<number>();
    const seenEnvs = new Set<string>();

    for (const entry of entries) {
        let host: number;
        let container: number;

        if (typeof entry.port === "number") {
            // Bare integer -> identity map (host === container).
            if (!inRange(entry.port)) {
                throw new Error(
                    `ports: port ${entry.port} must be between ${PORT_MIN} and ${PORT_MAX}. ` +
                        'Did you mean a "HOST:CONTAINER" mapping? Quote it, e.g. "8080:3000".',
                );
            }
            host = entry.port;
            container = entry.port;
        } else {
            // "HOST:CONTAINER" string -> explicit map, same order as docker (host first).
            const match = /^(\d+):(\d+)$/.exec(entry.port);
            if (!match) {
                throw new Error(
                    `ports: invalid port "${entry.port}". Use a bare integer (e.g. 4820) or a "HOST:CONTAINER" mapping (e.g. "8080:3000").`,
                );
            }
            host = Number(match[1]);
            container = Number(match[2]);
            if (!inRange(host) || !inRange(container)) {
                throw new Error(
                    `ports: mapping "${entry.port}" is out of range - host and container ports must both be between ${PORT_MIN} and ${PORT_MAX}.`,
                );
            }
        }

        // The web agent interface always binds this port inside the container, so a second publisher would
        // make whichever bound first win and the web URL could front the user's service. Reserved whether or
        // not the interface is enabled: web_enabled and web_range are host-global, so gating the rule on them
        // would make the same totopo.yaml valid on one machine and invalid on another.
        if (container === WEB_CONTAINER_PORT) {
            throw new Error(
                `ports: container port ${WEB_CONTAINER_PORT} is reserved for the totopo web agent interface. ` +
                    "Publish your service on a different container port.",
            );
        }

        if (seenHosts.has(host)) {
            throw new Error(`ports: duplicate host port ${host}. Each entry must publish a distinct host port.`);
        }
        seenHosts.add(host);

        const mapping: PortMapping = { host, container };

        if (entry.env !== undefined) {
            if (host !== container) {
                throw new Error(
                    `ports: ${describe(mapping)} declares env "${entry.env}", but env is only allowed on identity entries (a bare port number).`,
                );
            }
            if (seenEnvs.has(entry.env)) {
                throw new Error(`ports: duplicate env "${entry.env}". Each entry must inject a distinct env var.`);
            }
            seenEnvs.add(entry.env);
            mapping.env = entry.env;
        }

        mappings.push(mapping);
    }

    return mappings;
}

// --- Web interface port range ------------------------------------------------------------------------------------------------------------

/** An inclusive host-port range for the web interface, e.g. { start: 3900, end: 3999 }. */
export interface WebRange {
    start: number;
    end: number;
}

/**
 * Parse a "START-END" range string. Returns null when the shape is wrong, either bound is out of the
 * usable port range, or start is not strictly below end. The settings menu turns each null into a
 * specific validation message; readWebRange falls back to the default.
 */
export function parseWebRange(value: string): WebRange | null {
    const match = /^(\d+)-(\d+)$/.exec(value.trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!inRange(start) || !inRange(end)) return null;
    if (start >= end) return null;
    return { start, end };
}

/** Format a range back to its stored "START-END" form. */
export function formatWebRange(range: WebRange): string {
    return `${range.start}-${range.end}`;
}

// --- Availability probing (host I/O) -----------------------------------------------------------------------------------------------------

/** True if nothing on the host holds a loopback socket for this port (docker-proxy / userland-proxy=true, or a plain squatter). */
export function canBind(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => server.close(() => resolve(true)));
        server.listen(port, PORT_LOOPBACK_HOST);
    });
}

/** Host ports in a `docker ps` {{.Ports}} column: "127.0.0.1:4820->4820/tcp", "[::]:5432->5432/tcp". */
export function parsePublishedPorts(psOutput: string): Set<number> {
    const ports = new Set<number>();
    // The host port precedes "->".
    for (const match of psOutput.matchAll(/:(\d+)->/g)) {
        const n = Number(match[1]);
        if (Number.isInteger(n)) ports.add(n);
    }
    return ports;
}

/**
 * Host ports currently published by any running container. On native Linux with userland-proxy=false no host
 * socket exists (DNAT), so canBind alone would wrongly report a published port as free - this covers that case.
 * Returns an empty set when docker is unavailable (the bind probe still applies).
 */
export function dockerPublishedPorts(): Set<number> {
    const result = spawnSync("docker", ["ps", "--format", "{{.Ports}}"], { encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0 || !result.stdout) return new Set<number>();
    return parsePublishedPorts(result.stdout);
}

/**
 * Host ports published by one named container, and only while it is running - a stopped container holds no
 * port even though its config still declares one. Lets a caller tell "this port is taken by my own live
 * container" (fine) from "taken by something else" (not fine). Empty when docker is unavailable.
 */
export function containerPublishedPorts(containerName: string): Set<number> {
    const result = spawnSync("docker", ["ps", "--filter", `name=^${containerName}$`, "--format", "{{.Ports}}"], {
        encoding: "utf8",
        stdio: "pipe",
    });
    if (result.status !== 0 || !result.stdout) return new Set<number>();
    return parsePublishedPorts(result.stdout);
}

/**
 * Check that every mapped host port is free before we create the container. Called only on the create path - the
 * old container has already been removed, so we never probe our own live port. Throws a clear error naming the taken
 * host port and its entry on the first collision. Doing this here, rather than letting `docker run` fail, buys two
 * things: the error names the offending entry (docker's raw message does not), and no doomed `created` container is
 * left behind on a clash.
 *
 * `webPort` names the totopo-assigned web interface mapping, which is skipped: the interface is optional, so the
 * caller drops its mapping and runs the session without it rather than failing a session over it. Only totopo.yaml
 * ports - config the user wrote and expects to be honoured - are hard failures here.
 */
export async function assertHostPortsAvailable(mappings: PortMapping[], webPort?: number): Promise<void> {
    if (mappings.length === 0) return;
    const dockerPorts = dockerPublishedPorts();
    for (const m of mappings) {
        // Matched on both sides, so only totopo's own mapping is skipped - never a user entry that happens
        // to sit on the same host port.
        if (webPort !== undefined && m.host === webPort && m.container === WEB_CONTAINER_PORT) continue;
        const free = !dockerPorts.has(m.host) && (await canBind(m.host));
        if (!free) {
            const via = m.host === m.container ? "" : ` (from the "${m.host}:${m.container}" mapping)`;
            throw new Error(
                `ports: host port ${m.host}${via} is already in use on the host. ` +
                    "Free it, or pick a different host port in totopo.yaml.",
            );
        }
    }
}

// --- Docker argument builders (pure) -----------------------------------------------------------------------------------------------------

/** Loopback-only publish flags: 127.0.0.1:HOST:CONTAINER per mapping. */
export function portPublishArgs(mappings: PortMapping[]): string[] {
    return mappings.flatMap((m) => ["-p", `${PORT_LOOPBACK_HOST}:${m.host}:${m.container}`]);
}

/** Env injection flags carrying the host port number, only for identity entries that declare an env var. */
export function portEnvArgs(mappings: PortMapping[]): string[] {
    return mappings.flatMap((m) => (m.env ? ["-e", `${m.env}=${m.host}`] : []));
}

// --- Fingerprint -------------------------------------------------------------------------------------------------------------------------

/**
 * Deterministic fingerprint over the normalized mappings (host, container, env), used as the container LABEL_PORTS.
 * Editing a port, mapping, or env recreates the container; a workspace with no ports fingerprints to "" so a
 * container without published ports never recreates on account of this label.
 */
export function portsLabel(mappings: PortMapping[]): string {
    if (mappings.length === 0) return "";
    const parts = mappings.map((m) => `${m.host}:${m.container}:${m.env ?? ""}`).sort();
    return createHash("sha256").update(parts.join(",")).digest("hex").slice(0, 12);
}

// --- Session notice ----------------------------------------------------------------------------------------------------------------------

/**
 * One-line startup notice per mapping. Identity: `port 4820 open` (plus ` (ENV)` when an env is injected).
 * Mapping: `port 8080 -> 3000 open` (ASCII arrow - a UI string literal, no Unicode).
 */
export function formatPortNotice(m: PortMapping): string {
    if (m.host === m.container) return `port ${m.host} open${m.env ? ` (${m.env})` : ""}`;
    return `port ${m.host} -> ${m.container} open`;
}
