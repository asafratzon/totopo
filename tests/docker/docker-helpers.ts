// =========================================================================================================================================
// tests/docker/docker-helpers.ts - Utilities for Docker integration tests
// Provides unique naming, container/image inspection helpers, and cleanup.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { LABEL_MANAGED } from "../../src/lib/constants.js";
import { overrideEnv } from "../helpers.js";

// Re-export temp dir helpers for use in docker tests
export { cleanTempDir, createTempDir } from "../helpers.js";

// --- Docker availability check -----------------------------------------------------------------------------------------------------------

// Call at the top of each docker test file (outside describe/test).
// Exits with code 0 and a clear message if Docker is not reachable, so the suite
// does not produce false failures when run inside the totopo container or on machines without Docker.
export function requireDocker(): void {
    const result = spawnSync("docker", ["info"], { stdio: "pipe" });
    if (result.status !== 0 || result.error) {
        console.log("Docker not available - skipping docker integration tests.");
        process.exit(0);
    }
}

// --- Unique name generation --------------------------------------------------------------------------------------------------------------

// One random ID per test file process. All artifacts created in this run are namespaced under
// totopo-test-<RUN_ID>-* so that cleanupAllTestArtifacts() can filter by exact prefix and never
// accidentally match a real workspace container (e.g. totopo-test-ws).
const RUN_ID = randomBytes(4).toString("hex");

export function uniqueName(prefix: string): string {
    return `totopo-test-${RUN_ID}-${prefix}-${randomBytes(2).toString("hex")}`;
}

// --- Global-config isolation (keeps the docker build cache warm) --------------------------------------------------------------------------

/**
 * Override HOME to isolate reads/writes of the host-global totopo config (~/.totopo/global/config, resolved
 * via os.homedir()) WITHOUT sending the docker CLI to an empty ~/.docker. startContainer() shells out to
 * `docker build`, which inherits process.env, so a bare HOME override points docker at an empty config dir:
 * it misses the warm BuildKit layer cache and rebuilds the whole production image (~3 min) on every call.
 * Pinning DOCKER_CONFIG to the ambient config dir keeps the builder and its cache resolution intact.
 * Returns a restore function that reverts both overrides.
 */
export function isolateGlobalConfigHome(home: string): () => void {
    // Resolve the docker config dir from the ambient env BEFORE overriding HOME, mirroring what docker
    // would have used without the override: an explicit DOCKER_CONFIG wins, else the real ~/.docker.
    const dockerConfig = process.env.DOCKER_CONFIG ?? join(homedir(), ".docker");
    const restoreHome = overrideEnv("HOME", home);
    const restoreDockerConfig = overrideEnv("DOCKER_CONFIG", dockerConfig);
    return () => {
        restoreDockerConfig();
        restoreHome();
    };
}

// --- Container and image inspection ------------------------------------------------------------------------------------------------------

export function dockerImageExists(name: string): boolean {
    const result = spawnSync("docker", ["images", "-q", name], { encoding: "utf8", stdio: "pipe" });
    return result.status === 0 && result.stdout.trim().length > 0;
}

export function dockerContainerStatus(name: string): string | null {
    const result = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", name], {
        encoding: "utf8",
        stdio: "pipe",
    });
    if (result.status !== 0) return null;
    return result.stdout.trim() || null;
}

export function dockerContainerLabel(name: string, label: string): string {
    const result = spawnSync("docker", ["inspect", "--format", `{{index .Config.Labels "${label}"}}`, name], {
        encoding: "utf8",
        stdio: "pipe",
    });
    if (result.status !== 0) return "";
    const val = result.stdout.trim();
    return val === "<no value>" ? "" : val;
}

export function dockerExtraHosts(name: string): string {
    const result = spawnSync("docker", ["inspect", "--format", "{{json .HostConfig.ExtraHosts}}", name], {
        encoding: "utf8",
        stdio: "pipe",
    });
    if (result.status !== 0) return "";
    return result.stdout.trim();
}

export function dockerExec(containerName: string, cmd: string[]): { stdout: string; status: number } {
    const result = spawnSync("docker", ["exec", containerName, ...cmd], { encoding: "utf8", stdio: "pipe" });
    return { stdout: result.stdout.trim(), status: result.status ?? 1 };
}

// --- Cleanup -----------------------------------------------------------------------------------------------------------------------------

export function forceRemoveContainer(name: string): void {
    spawnSync("docker", ["rm", "-f", name], { stdio: "pipe" });
}

export function forceRemoveImage(name: string): void {
    spawnSync("docker", ["rmi", "-f", name], { stdio: "pipe" });
}

export function cleanupAllTestArtifacts(): void {
    const runPrefix = `totopo-test-${RUN_ID}`;

    // Remove containers created by this test run only - filter is exact to RUN_ID
    const containers = spawnSync("docker", ["ps", "-a", "--filter", `name=${runPrefix}`, "--format", "{{.Names}}"], {
        encoding: "utf8",
        stdio: "pipe",
    });
    const containerNames = containers.stdout.split("\n").filter(Boolean);
    if (containerNames.length > 0) {
        spawnSync("docker", ["rm", "-f", ...containerNames], { stdio: "pipe" });
    }

    // Remove images created by this test run only
    const images = spawnSync("docker", ["images", "--filter", `reference=${runPrefix}*`, "--format", "{{.Repository}}:{{.Tag}}"], {
        encoding: "utf8",
        stdio: "pipe",
    });
    const imageNames = images.stdout.split("\n").filter(Boolean);
    if (imageNames.length > 0) {
        spawnSync("docker", ["rmi", "-f", ...imageNames], { stdio: "pipe" });
    }
}

// --- Minimal Dockerfiles for fast test image builds (~5s) --------------------------------------------------------------------------------
// Preserves the structural elements totopo cares about: devuser, /workspace WORKDIR.
// Does not include the AI CLIs or heavy dependencies - only used for image/container lifecycle tests.

// Complete standalone Dockerfile - used when building an image directly (not via buildDockerfile()).
export const MINIMAL_DOCKERFILE = `FROM debian:trixie-slim
LABEL ${LABEL_MANAGED}=true
RUN groupadd --gid 1001 devuser && useradd --uid 1001 --gid devuser --shell /bin/bash --create-home devuser
WORKDIR /workspace
USER devuser
CMD ["sleep", "infinity"]
`;

// Base template for use with buildDockerfile() - no USER or CMD, matching the real templates/Dockerfile
// convention. buildDockerfile() appends the profile hook (runs as root), then adds USER devuser.
export const MINIMAL_DOCKERFILE_TEMPLATE = `FROM debian:trixie-slim
LABEL ${LABEL_MANAGED}=true
RUN groupadd --gid 1001 devuser && useradd --uid 1001 --gid devuser --shell /bin/bash --create-home devuser
WORKDIR /workspace
`;
