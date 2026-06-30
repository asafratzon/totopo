// =========================================================================================================================================
// src/lib/sessions.ts - Host-side detection of live interactive container sessions.
// dev.ts connects each session with `docker exec -it ... <container> bash --login`. The host-side exec
// client process is the proxy for one live session: it dies on clean exit, closed terminal, or kill, but
// survives a sleep-freeze. Orphaned in-container shells (host side gone, PTY left open by dockerd) have no
// host client and are correctly ignored - which is why counting on the host, not inside the container, is
// the reliable signal for "last session closed".
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { CONTAINER_NAME_PREFIX } from "./constants.js";

// The interactive session shell, as argv. Single source of truth: both the connect command and the
// detector's match needle derive from this, so they cannot drift apart.
export const CONTAINER_LOGIN_SHELL = ["bash", "--login"] as const;

// --- Connect -----------------------------------------------------------------------------------------------------------------------------

// Build the `docker exec` argv that opens an interactive session in `containerName` at `workdir`.
// dev.ts spawns exactly this; sessionMatchNeedle matches against it, so detection stays in lockstep.
export function loginShellExecArgs(workdir: string, containerName: string): string[] {
    return ["exec", "-it", "-w", workdir, containerName, ...CONTAINER_LOGIN_SHELL];
}

// --- Detection ---------------------------------------------------------------------------------------------------------------------------

// The substring identifying one container's session client in a host `pgrep -f` scan: the container name
// followed by the login shell args (e.g. "totopo-orot-io bash --login"). Specific enough to exclude other
// `docker exec <c> ...` shapes. Container ids are kebab-case (schema-constrained), so there are no regex
// metacharacters to escape.
export function sessionMatchNeedle(containerName: string): string {
    return `${containerName} ${CONTAINER_LOGIN_SHELL.join(" ")}`;
}

// Count live interactive sessions to a single container by scanning HOST processes for the exec client.
// `pgrep -f` (portable across macOS/BSD and Linux; `-c` is Linux-only) excludes its own PID. A missing or
// errored pgrep yields no stdout -> 0, preserving the old "errored -> 0" safety. At a clean exit the just-
// left client is already reaped before this runs, so the last exit reaches 0.
export function containerSessionCount(containerName: string): number {
    const r = spawnSync("pgrep", ["-f", sessionMatchNeedle(containerName)], { encoding: "utf8", stdio: "pipe" });
    return (r.stdout ?? "").split("\n").filter(Boolean).length;
}

// Sum live interactive sessions across ALL totopo containers (delegates to containerSessionCount).
// The host audio server is shared by every workspace, so automatic-mode auto-stop fires only at 0 - no
// session anywhere. A non-zero/errored `docker ps` (Docker unavailable) returns 0.
export function connectedSessionCount(): number {
    const ps = spawnSync("docker", ["ps", "--filter", `name=${CONTAINER_NAME_PREFIX}`, "--format", "{{.Names}}"], {
        encoding: "utf8",
        stdio: "pipe",
    });
    if (ps.status !== 0) return 0;
    const names = (ps.stdout ?? "").trim().split("\n").filter(Boolean);
    let total = 0;
    for (const name of names) {
        total += containerSessionCount(name);
    }
    return total;
}
