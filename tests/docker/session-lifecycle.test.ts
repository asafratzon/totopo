// =========================================================================================================================================
// tests/docker/session-lifecycle.test.ts - Full session lifecycle via startContainer()
// Tests container creation, label/mount/security assembly, mismatch detection, and resume
// against the real production Dockerfile so regressions in the image are caught here too.
// Run via: pnpm test:docker  (requires Docker, host-only)
// =========================================================================================================================================

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { StartContainerOpts } from "../../src/commands/dev.js";
import { audioStateLabel, startContainer } from "../../src/commands/dev.js";
import {
    AUDIO_COOKIE_CONTAINER_PATH,
    AUTO_START,
    CONTAINER_STARTUP,
    GIT_MODE,
    LABEL_AUDIO,
    LABEL_AUTOSTART,
    LABEL_GIT_MODE,
    LABEL_MANAGED,
    LABEL_PROFILE,
    LABEL_SHADOWS,
    PROFILE,
} from "../../src/lib/constants.js";
import { buildDockerfile, buildImageWithTempfile, computeBuildHash } from "../../src/lib/dockerfile-builder.js";
import { writeAutoStartAgent } from "../../src/lib/global-config.js";
import { isImageStale } from "../../src/lib/migrate-to-latest.js";
import { connectedSessionCount, containerSessionCount, loginShellExecArgs } from "../../src/lib/sessions.js";
import { expandShadowPatterns } from "../../src/lib/shadows.js";
import {
    cleanTempDir,
    cleanupAllTestArtifacts,
    createTempDir,
    dockerContainerLabel,
    dockerContainerStatus,
    dockerExec,
    dockerExtraHosts,
    forceRemoveContainer,
    forceRemoveImage,
    isolateGlobalConfigHome,
    MINIMAL_DOCKERFILE,
    MINIMAL_DOCKERFILE_TEMPLATE,
    requireDocker,
    uniqueName,
} from "./docker-helpers.js";

requireDocker();

// Real templates dir - session and shadow tests use the production Dockerfile so that regressions
// in devuser setup, permissions, or COPY instructions are caught here, not just in production.
const TEMPLATES_DIR = join(import.meta.dirname, "../../templates");

// Pre-build to warm the Docker layer cache. image-lifecycle.test.ts runs first and already
// builds the production image, so this is fast (all layers CACHED) on a warm daemon.
let prodImageName!: string;

before(async () => {
    prodImageName = uniqueName("prod");
    const result = await buildImageWithTempfile(
        buildDockerfile(join(TEMPLATES_DIR, "Dockerfile")),
        TEMPLATES_DIR,
        prodImageName,
        false,
        true, // quiet
    );
    assert.equal(result.status, 0, "production image build must succeed");
});

after(() => {
    forceRemoveImage(prodImageName);
    cleanupAllTestArtifacts();
});

// Helper: build a StartContainerOpts for a test container using the production Dockerfile.
function makeOpts(
    containerName: string,
    workspaceRoot: string,
    cacheDir: string,
    overrides?: Partial<StartContainerOpts>,
): StartContainerOpts {
    return {
        containerName,
        workspaceRoot,
        cacheDir,
        templatesDir: TEMPLATES_DIR,
        activeProfile: PROFILE.default,
        profileHook: undefined,
        expandedShadows: [],
        envFilePath: undefined,
        hasGit: false,
        gitMode: GIT_MODE.local,
        audio: false,
        shadowPatterns: [],
        workspaceName: "test-workspace",
        quiet: true,
        ...overrides,
    };
}

// =========================================================================================================================================
// Session lifecycle
// =========================================================================================================================================

describe("session lifecycle", () => {
    let containerName: string;
    let workspaceRoot: string;
    let cacheDir: string;

    beforeEach(() => {
        containerName = uniqueName("sess");
        workspaceRoot = createTempDir();
        cacheDir = createTempDir();
    });

    afterEach(async () => {
        forceRemoveContainer(containerName);
        forceRemoveImage(containerName);
        await cleanTempDir(workspaceRoot);
        await cleanTempDir(cacheDir);
    });

    test("creates container and returns 'created'", async () => {
        const result = await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        assert.equal(result, "created");
        assert.equal(dockerContainerStatus(containerName), "running");
    });

    test("container has totopo labels set", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { activeProfile: PROFILE.extended }));
        assert.equal(dockerContainerLabel(containerName, LABEL_MANAGED), "true");
        assert.equal(dockerContainerLabel(containerName, LABEL_PROFILE), PROFILE.extended);
        assert.equal(dockerContainerLabel(containerName, LABEL_SHADOWS), "");
    });

    test("container runs as devuser and WORKDIR is /workspace", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        const whoami = dockerExec(containerName, ["whoami"]);
        assert.equal(whoami.stdout, "devuser");
        const pwd = dockerExec(containerName, ["pwd"]);
        assert.equal(pwd.stdout, "/workspace");
    });

    test("workspace bind mount is visible inside container", async () => {
        writeFileSync(join(workspaceRoot, "marker.txt"), "hello-from-host");
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        const cat = dockerExec(containerName, ["cat", "/workspace/marker.txt"]);
        assert.equal(cat.stdout, "hello-from-host");
    });

    test("pnpm-store bind mount is present, writable, and sourced from cache dir", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        // Mount target itself must be writable as devuser.
        const probe = dockerExec(containerName, ["sh", "-c", "touch /home/devuser/.local/share/pnpm/store/.totopo-mount-probe && echo OK"]);
        assert.equal(probe.stdout, "OK", "pnpm store mount must be writable as devuser");

        // The mount's parent directory must also be devuser-writable so pnpm can create siblings of
        // store/ at runtime (.tools/, .modules-yaml, ...). If the image does not pre-create
        // /home/devuser/.local/share/pnpm, Docker auto-creates it as root when materializing the
        // bind mount path, leaving devuser unable to write next to store/.
        const siblingProbe = dockerExec(containerName, [
            "sh",
            "-c",
            "touch /home/devuser/.local/share/pnpm/.totopo-sibling-probe && echo OK",
        ]);
        assert.equal(siblingProbe.stdout, "OK", "pnpm store mount's parent dir must be writable as devuser");

        // Source must be the per-workspace cache subdir so the store persists across rebuilds.
        // The store's same-device guarantee is provided by the explicit store-dir setting in pnpm's
        // baked config, not by the bind mount alone (each Docker -v can register as its own device).
        const inspect = spawnSync(
            "docker",
            [
                "inspect",
                "--format",
                '{{range .Mounts}}{{if eq .Destination "/home/devuser/.local/share/pnpm/store"}}{{.Source}}{{end}}{{end}}',
                containerName,
            ],
            { encoding: "utf8", stdio: "pipe" },
        );
        assert.equal(inspect.stdout.trim(), join(cacheDir, "pnpm-store"));
    });

    test("pnpm install runs cleanly and does not create .pnpm-store in the workspace", async () => {
        writeFileSync(join(workspaceRoot, "package.json"), JSON.stringify({ name: "totopo-test", version: "0.0.0", private: true }));
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));

        // Confirm the image-baked config is actually visible to pnpm. Without this, a config that
        // never gets read produces the same symptom as a config that doesn't work, and we cannot
        // tell the two failure modes apart. store-dir is the load-bearing setting: without it,
        // pnpm's volume-check relocation puts the store at /workspace/.pnpm-store regardless of
        // package-import-method.
        const storeDir = dockerExec(containerName, ["sh", "-c", "cd /workspace && pnpm config get store-dir"]);
        assert.equal(storeDir.stdout, "/home/devuser/.local/share/pnpm/store", `pnpm store-dir not honored; got '${storeDir.stdout}'`);
        const importMethod = dockerExec(containerName, ["sh", "-c", "cd /workspace && pnpm config get package-import-method"]);
        assert.equal(importMethod.stdout, "copy", `pnpm package-import-method not honored; got '${importMethod.stdout}'`);

        const install = dockerExec(containerName, ["sh", "-c", "cd /workspace && pnpm install --offline 2>&1"]);
        assert.equal(install.status, 0, `pnpm install must succeed; output:\n${install.stdout}`);

        if (existsSync(join(workspaceRoot, ".pnpm-store"))) {
            // Diagnostic dump - tell us exactly what pnpm decided to put in the workspace.
            const ls = dockerExec(containerName, [
                "sh",
                "-c",
                "ls -la /workspace/.pnpm-store && find /workspace/.pnpm-store -maxdepth 3 -print",
            ]);
            const cfg = dockerExec(containerName, ["sh", "-c", "pnpm config list 2>&1"]);
            assert.fail(
                `.pnpm-store appeared in the workspace.\n--- install output ---\n${install.stdout}\n--- .pnpm-store contents ---\n${ls.stdout}\n--- pnpm config list ---\n${cfg.stdout}`,
            );
        }
    });

    test("second call to running container returns 'connected'", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        const result = await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        assert.equal(result, "connected");
        assert.equal(dockerContainerStatus(containerName), "running");
    });

    test("stopped container resumes and returns 'resumed'", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
        assert.equal(dockerContainerStatus(containerName), "exited");

        const result = await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        assert.equal(result, "resumed");
        assert.equal(dockerContainerStatus(containerName), "running");
    });

    test("shadow change triggers container recreation", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { expandedShadows: [] }));
        assert.equal(dockerContainerLabel(containerName, LABEL_SHADOWS), "");

        // Simulate a shadow being added
        const shadowDir = join(workspaceRoot, "node_modules");
        mkdirSync(shadowDir, { recursive: true });
        const { paths: expanded } = expandShadowPatterns(["node_modules"], workspaceRoot);

        const result = await startContainer(
            makeOpts(containerName, workspaceRoot, cacheDir, { expandedShadows: expanded, shadowPatterns: ["node_modules"] }),
        );
        assert.equal(result, "created", "container should be recreated after shadow change");
        assert.ok(dockerContainerLabel(containerName, LABEL_SHADOWS).includes("node_modules"), "shadow label should reflect new shadow");
    });

    test("profile change triggers image rebuild and container recreation", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { activeProfile: PROFILE.default }));
        assert.equal(dockerContainerLabel(containerName, LABEL_PROFILE), PROFILE.default);

        const result = await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { activeProfile: PROFILE.extended }));
        assert.equal(result, "created", "container should be recreated after profile change");
        assert.equal(dockerContainerLabel(containerName, LABEL_PROFILE), PROFILE.extended);
    });

    test("env_file is passed to container", async () => {
        const envFile = join(workspaceRoot, ".env");
        writeFileSync(envFile, "TOTOPO_TEST_VAR=hello123\n");
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { envFilePath: envFile }));
        const result = dockerExec(containerName, ["sh", "-c", "echo $TOTOPO_TEST_VAR"]);
        assert.equal(result.stdout, "hello123");
    });

    test("git mode label and env var reflect the active mode", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { gitMode: GIT_MODE.strict }));
        assert.equal(dockerContainerLabel(containerName, LABEL_GIT_MODE), GIT_MODE.strict);
        const env = dockerExec(containerName, ["printenv", "TOTOPO_GIT_MODE"]);
        assert.equal(env.stdout, GIT_MODE.strict);
    });

    test("git mode change triggers container recreation", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { gitMode: GIT_MODE.local }));
        assert.equal(dockerContainerLabel(containerName, LABEL_GIT_MODE), GIT_MODE.local);

        const result = await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { gitMode: GIT_MODE.strict }));
        assert.equal(result, "created", "container should be recreated when git mode changes");
        assert.equal(dockerContainerLabel(containerName, LABEL_GIT_MODE), GIT_MODE.strict);
    });

    // Auto-start is a host-global setting read from ~/.totopo/global/config, so these tests isolate HOME to
    // a temp dir rather than passing it through makeOpts. isolateGlobalConfigHome also pins DOCKER_CONFIG so
    // the inherited-env docker build keeps its warm cache instead of rebuilding the whole image.
    test("auto-start off by default: label is off and no launch env var", async () => {
        const home = createTempDir();
        const restore = isolateGlobalConfigHome(home);
        try {
            await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
            assert.equal(dockerContainerLabel(containerName, LABEL_AUTOSTART), AUTO_START.off);
            assert.equal(
                dockerExec(containerName, ["printenv", "TOTOPO_AUTOSTART"]).stdout,
                "",
                "TOTOPO_AUTOSTART must be unset when auto-start is off",
            );
        } finally {
            restore();
            await cleanTempDir(home);
        }
    });

    test("auto-start on: label and env reflect the chosen agent, and a change recreates the container", async () => {
        const home = createTempDir();
        const restore = isolateGlobalConfigHome(home);
        try {
            await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
            assert.equal(dockerContainerLabel(containerName, LABEL_AUTOSTART), AUTO_START.off);

            writeAutoStartAgent(AUTO_START.claude);
            const result = await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
            assert.equal(result, "created", "container should be recreated when the auto-start agent changes");
            assert.equal(dockerContainerLabel(containerName, LABEL_AUTOSTART), AUTO_START.claude);
            assert.equal(dockerExec(containerName, ["printenv", "TOTOPO_AUTOSTART"]).stdout, AUTO_START.claude);
        } finally {
            restore();
            await cleanTempDir(home);
        }
    });

    test("audio off by default: no label flag, no PulseAudio env, no extra host", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        assert.equal(dockerContainerLabel(containerName, LABEL_AUDIO), "false");
        assert.equal(dockerExec(containerName, ["sh", "-c", "echo $PULSE_SERVER"]).stdout, "");
        assert.ok(!dockerExtraHosts(containerName).includes("host.docker.internal"), "no --add-host when audio is off");
    });

    test("audio on: label, PulseAudio env, and host-gateway are wired", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { audio: true }));
        assert.equal(dockerContainerLabel(containerName, LABEL_AUDIO), audioStateLabel(true, undefined));
        assert.equal(dockerExec(containerName, ["printenv", "PULSE_SERVER"]).stdout, "tcp:host.docker.internal:4713");
        assert.equal(dockerExec(containerName, ["printenv", "AUDIODRIVER"]).stdout, "pulseaudio");
        assert.ok(
            dockerExtraHosts(containerName).includes("host.docker.internal:host-gateway"),
            "--add-host should map host.docker.internal",
        );
        // No cookie path provided -> no PULSE_COOKIE and no cookie mount.
        assert.equal(dockerExec(containerName, ["sh", "-c", "echo $PULSE_COOKIE"]).stdout, "");
    });

    test("audio on with cookie: PULSE_COOKIE env and cookie mounted read-only", async () => {
        const cookieFile = join(cacheDir, "pulse-cookie");
        const secret = "totopo-test-cookie-secret";
        writeFileSync(cookieFile, secret);
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { audio: true, audioCookiePath: cookieFile }));
        assert.equal(dockerExec(containerName, ["printenv", "PULSE_COOKIE"]).stdout, AUDIO_COOKIE_CONTAINER_PATH);
        assert.equal(dockerExec(containerName, ["cat", AUDIO_COOKIE_CONTAINER_PATH]).stdout, secret);
    });

    test("audio toggle triggers container recreation", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { audio: false }));
        assert.equal(dockerContainerLabel(containerName, LABEL_AUDIO), "false");

        const result = await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { audio: true }));
        assert.equal(result, "created", "container should be recreated when audio is toggled");
        assert.equal(dockerContainerLabel(containerName, LABEL_AUDIO), audioStateLabel(true, undefined));
    });

    test("audio cookie path change triggers container recreation", async () => {
        // Reproduces the v3.10.0 cookie relocation: same audio bool, different host cookie path. The path
        // is part of the audio identity label, so the container must be recreated (rebinding the mount)
        // rather than resumed against the now-dangling old mount.
        const cookieA = join(cacheDir, "cookie-a");
        const cookieB = join(cacheDir, "cookie-b");
        writeFileSync(cookieA, "cookie-a-bytes");
        writeFileSync(cookieB, "cookie-b-bytes");

        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { audio: true, audioCookiePath: cookieA }));
        const labelA = dockerContainerLabel(containerName, LABEL_AUDIO);
        assert.equal(labelA, audioStateLabel(true, cookieA));

        const result = await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { audio: true, audioCookiePath: cookieB }));
        assert.equal(result, "created", "container should be recreated when the cookie path changes");
        assert.equal(dockerContainerLabel(containerName, LABEL_AUDIO), audioStateLabel(true, cookieB));
        assert.notEqual(dockerContainerLabel(containerName, LABEL_AUDIO), labelA, "audio label must reflect the new cookie path");
    });
});

// =========================================================================================================================================
// Shadow path mounts
// =========================================================================================================================================

describe("shadow path mounts", () => {
    let containerName: string;
    let workspaceRoot: string;
    let cacheDir: string;

    beforeEach(() => {
        containerName = uniqueName("shadow");
        workspaceRoot = createTempDir();
        cacheDir = createTempDir();
    });

    afterEach(async () => {
        forceRemoveContainer(containerName);
        forceRemoveImage(containerName);
        await cleanTempDir(workspaceRoot);
        await cleanTempDir(cacheDir);
    });

    test("shadow mount overlays workspace directory with empty container-local copy", async () => {
        // Host workspace has node_modules with a secret file
        const hostNodeModules = join(workspaceRoot, "node_modules");
        mkdirSync(hostNodeModules, { recursive: true });
        writeFileSync(join(hostNodeModules, "secret.txt"), "should-not-be-visible");

        const { paths: expanded } = expandShadowPatterns(["node_modules"], workspaceRoot);

        await startContainer(
            makeOpts(containerName, workspaceRoot, cacheDir, { expandedShadows: expanded, shadowPatterns: ["node_modules"] }),
        );

        // Container should see an empty node_modules (shadow overlay hides host content)
        const ls = dockerExec(containerName, ["sh", "-c", "ls /workspace/node_modules 2>/dev/null | wc -l"]);
        assert.equal(ls.stdout, "0", "shadow-overlaid node_modules should appear empty");
    });

    test("shadow mount for glob pattern hides matching files", async () => {
        writeFileSync(join(workspaceRoot, ".env"), "SECRET=supersecret\n");

        const { paths: expanded } = expandShadowPatterns([".env*"], workspaceRoot);

        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { expandedShadows: expanded, shadowPatterns: [".env*"] }));

        const cat = dockerExec(containerName, ["sh", "-c", "cat /workspace/.env 2>/dev/null || echo EMPTY"]);
        assert.ok(cat.stdout === "EMPTY" || cat.stdout === "", "shadowed .env should not expose host content");
    });

    test("workspace files outside shadow paths remain visible", async () => {
        const hostNodeModules = join(workspaceRoot, "node_modules");
        mkdirSync(hostNodeModules, { recursive: true });
        writeFileSync(join(workspaceRoot, "README.md"), "visible-file");

        const { paths: expanded } = expandShadowPatterns(["node_modules"], workspaceRoot);

        await startContainer(
            makeOpts(containerName, workspaceRoot, cacheDir, { expandedShadows: expanded, shadowPatterns: ["node_modules"] }),
        );

        const cat = dockerExec(containerName, ["cat", "/workspace/README.md"]);
        assert.equal(cat.stdout, "visible-file", "files outside shadow paths must remain accessible");
    });

    test("multiple shadow mounts coexist independently", async () => {
        mkdirSync(join(workspaceRoot, "node_modules"), { recursive: true });
        writeFileSync(join(workspaceRoot, ".env"), "SECRET=1\n");
        writeFileSync(join(workspaceRoot, "keep.txt"), "keep");

        const { paths: expanded } = expandShadowPatterns(["node_modules", ".env*"], workspaceRoot);

        await startContainer(
            makeOpts(containerName, workspaceRoot, cacheDir, { expandedShadows: expanded, shadowPatterns: ["node_modules", ".env*"] }),
        );

        const nmCount = dockerExec(containerName, ["sh", "-c", "ls /workspace/node_modules 2>/dev/null | wc -l"]);
        assert.equal(nmCount.stdout, "0", "node_modules shadow should be empty");

        const envCat = dockerExec(containerName, ["sh", "-c", "cat /workspace/.env 2>/dev/null || echo EMPTY"]);
        assert.ok(envCat.stdout === "EMPTY" || envCat.stdout === "", ".env shadow should hide content");

        const keep = dockerExec(containerName, ["cat", "/workspace/keep.txt"]);
        assert.equal(keep.stdout, "keep", "non-shadowed file must remain visible");
    });
});

// =========================================================================================================================================
// Profile hooks
// =========================================================================================================================================

describe("profile hooks", () => {
    let containerName: string;
    let workspaceRoot: string;
    let cacheDir: string;
    let profileTemplatesDir: string;

    beforeEach(() => {
        containerName = uniqueName("hook");
        workspaceRoot = createTempDir();
        cacheDir = createTempDir();
        // Profile hook tests use the base template (no USER/CMD) so buildDockerfile() appends the
        // hook before USER devuser, matching how the real Dockerfile works. Hooks run as root.
        profileTemplatesDir = createTempDir();
        writeFileSync(join(profileTemplatesDir, "Dockerfile"), MINIMAL_DOCKERFILE_TEMPLATE);
    });

    afterEach(async () => {
        forceRemoveContainer(containerName);
        forceRemoveImage(containerName);
        await cleanTempDir(workspaceRoot);
        await cleanTempDir(cacheDir);
        await cleanTempDir(profileTemplatesDir);
    });

    test("profile hook creates a file visible inside the container", async () => {
        await startContainer(
            makeOpts(containerName, workspaceRoot, cacheDir, {
                templatesDir: profileTemplatesDir,
                profileHook: 'RUN echo "hook-test" > /etc/totopo-hook-marker',
            }),
        );
        const cat = dockerExec(containerName, ["cat", "/etc/totopo-hook-marker"]);
        assert.equal(cat.status, 0, "hook-created file should be readable");
        assert.equal(cat.stdout, "hook-test");
    });

    test("empty profile hook produces a working container", async () => {
        const result = await startContainer(
            makeOpts(containerName, workspaceRoot, cacheDir, {
                templatesDir: profileTemplatesDir,
                profileHook: "",
            }),
        );
        assert.equal(result, "created");
        const whoami = dockerExec(containerName, ["whoami"]);
        assert.equal(whoami.stdout, "devuser");
    });
});

// =========================================================================================================================================
// Startup script (AI CLI update + readiness checks)
// =========================================================================================================================================

describe("startup script", () => {
    let containerName: string;
    let workspaceRoot: string;
    let cacheDir: string;

    beforeEach(() => {
        containerName = uniqueName("startup");
        workspaceRoot = createTempDir();
        cacheDir = createTempDir();
    });

    afterEach(async () => {
        forceRemoveContainer(containerName);
        forceRemoveImage(containerName);
        await cleanTempDir(workspaceRoot);
        await cleanTempDir(cacheDir);
    });

    test("build-time timestamp file exists in production image", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        const cat = dockerExec(containerName, ["cat", "/home/devuser/.ai-cli-updated"]);
        assert.equal(cat.status, 0, ".ai-cli-updated should exist");
        const timestamp = new Date(cat.stdout);
        assert.ok(!Number.isNaN(timestamp.getTime()), "timestamp should be a valid date");
    });

    test("startup.mjs script exists in production image", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        const stat = dockerExec(containerName, ["test", "-f", CONTAINER_STARTUP]);
        assert.equal(stat.status, 0, "startup.mjs should exist in the image");
    });

    test("startup script reports CLIs up to date when timestamp is fresh", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        // Write a fresh timestamp so the test is not affected by image age
        const freshDate = new Date().toISOString();
        spawnSync("docker", ["exec", "-u", "root", containerName, "sh", "-c", `echo '${freshDate}' > /home/devuser/.ai-cli-updated`], {
            stdio: "pipe",
        });
        // Run as root since startup.mjs is designed to run as root
        const result = spawnSync("docker", ["exec", "-u", "root", containerName, "node", CONTAINER_STARTUP], {
            encoding: "utf8",
            stdio: "pipe",
        });
        assert.equal(result.status, 0, "script should exit 0");
        assert.ok(result.stdout.includes("up to date"), "should report CLIs are up to date");
    });

    test("startup script skips update as non-root when timestamp is stale", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        // Write a stale timestamp (48h ago) as root
        const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        spawnSync("docker", ["exec", "-u", "root", containerName, "sh", "-c", `echo '${staleDate}' > /home/devuser/.ai-cli-updated`], {
            stdio: "pipe",
        });
        // Run as devuser -- should skip CLI update (not fail) and pass readiness checks
        const result = dockerExec(containerName, ["node", CONTAINER_STARTUP]);
        assert.equal(result.status, 0, "should pass when run as devuser (CLI update skipped)");
        assert.ok(result.stdout.includes("update skipped"), "should report update was skipped");
    });
});

// =========================================================================================================================================
// Image staleness detection
// =========================================================================================================================================

describe("image staleness", () => {
    let containerName: string;
    let workspaceRoot: string;
    let cacheDir: string;

    beforeEach(() => {
        containerName = uniqueName("stale");
        workspaceRoot = createTempDir();
        cacheDir = createTempDir();
    });

    afterEach(async () => {
        forceRemoveContainer(containerName);
        forceRemoveImage(containerName);
        await cleanTempDir(workspaceRoot);
        await cleanTempDir(cacheDir);
    });

    // Production hash derived from the real Dockerfile + templates dir. Recomputed once per test
    // so any change to the assembled content is reflected without test setup leaking state.
    function productionHash(): string {
        return computeBuildHash(buildDockerfile(join(TEMPLATES_DIR, "Dockerfile")), TEMPLATES_DIR);
    }

    test("isImageStale returns false when the stamped hash matches the expected hash", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        assert.equal(isImageStale(containerName, productionHash()), false);
    });

    test("isImageStale returns true when the expected hash differs from the stamped hash", async () => {
        // Simulates source-side drift: the package on disk has changed (Dockerfile or any baked
        // template file edited) so the hash recomputed at session start no longer matches the
        // label stamped on the running container at build time.
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        const wrong = "0".repeat(64);
        assert.equal(isImageStale(containerName, wrong), true);
    });

    test("isImageStale returns true when the container's stamped hash differs from the expected hash", async () => {
        // Simulates a user on an older image: builds a minimal image (different Dockerfile content
        // -> different stamped hash), then asks "is this stale relative to production?" -> yes.
        const contextDir = createTempDir();
        try {
            const result = await buildImageWithTempfile(MINIMAL_DOCKERFILE, contextDir, containerName, false, true);
            assert.equal(result.status, 0);
            spawnSync("docker", ["run", "-d", "--name", containerName, containerName, "sleep", "infinity"], { stdio: "pipe" });
            assert.equal(isImageStale(containerName, productionHash()), true);
        } finally {
            await cleanTempDir(contextDir);
        }
    });

    test("startup script fails on stale container (startup.mjs missing)", async () => {
        // Minimal image has no startup.mjs -- docker exec should fail
        const contextDir = createTempDir();
        try {
            const result = await buildImageWithTempfile(MINIMAL_DOCKERFILE, contextDir, containerName, false, true);
            assert.equal(result.status, 0);
            spawnSync("docker", ["run", "-d", "--name", containerName, containerName, "sleep", "infinity"], { stdio: "pipe" });
            const startup = spawnSync("docker", ["exec", "-u", "root", containerName, "node", CONTAINER_STARTUP], {
                encoding: "utf8",
                stdio: "pipe",
            });
            assert.notEqual(startup.status, 0, "startup should fail when script is missing");
        } finally {
            await cleanTempDir(contextDir);
        }
    });
});

// =========================================================================================================================================
// Host-side session detection
// =========================================================================================================================================

// Detection counts the live `docker exec ... <container> bash --login` CLIENT processes on the host (see
// src/lib/sessions.ts), not processes inside the container. Only the host client's command line carries the
// container name next to "bash --login"; the in-container shell's own command line does not. That is why an
// orphaned in-container shell (host client gone) is correctly invisible to the count - the bug where
// in-container counting kept the ghost and suppressed the "stop the container?" prompt forever.
describe("host-side session detection", () => {
    let containerName: string;
    let workspaceRoot: string;
    let cacheDir: string;
    const clients: ReturnType<typeof spawn>[] = [];

    beforeEach(() => {
        containerName = uniqueName("detect");
        workspaceRoot = createTempDir();
        cacheDir = createTempDir();
    });

    afterEach(async () => {
        for (const c of clients) c.kill("SIGKILL");
        clients.length = 0;
        forceRemoveContainer(containerName);
        forceRemoveImage(containerName);
        await cleanTempDir(workspaceRoot);
        await cleanTempDir(cacheDir);
    });

    // Open a long-lived host-side exec client. Uses the real connect argv from loginShellExecArgs, with
    // `-it` swapped to `-i`: the test process has no controlling TTY, so `-t` would make docker exit at once.
    // The argv still contains "<container> bash --login" - exactly what detection matches. bash reads from the
    // open stdin pipe and blocks, so the client stays alive until we kill it.
    function openClient(): void {
        const args = loginShellExecArgs("/workspace", containerName).map((a) => (a === "-it" ? "-i" : a));
        clients.push(spawn("docker", args, { stdio: ["pipe", "ignore", "ignore"] }));
    }

    // Poll until predicate holds or timeout. A host exec client takes a moment to appear in / leave the host
    // process table after spawn / kill, so reading the count immediately after is racy.
    async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (predicate()) return true;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return predicate();
    }

    test("counts a live session and drops to zero after it exits", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        assert.equal(containerSessionCount(containerName), 0, "no sessions before any client connects");

        openClient();
        assert.ok(await waitUntil(() => containerSessionCount(containerName) === 1), "a live session must be counted");
        // connectedSessionCount sums every totopo container, so it is at least our one open session.
        assert.ok(connectedSessionCount() >= 1, "connectedSessionCount must see the open session");

        const client = clients[0];
        assert.ok(client);
        client.kill("SIGKILL");
        assert.ok(await waitUntil(() => containerSessionCount(containerName) === 0), "count must drop to zero after the session exits");
    });

    test("two sessions: count drops to zero only after the last exits", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        openClient();
        openClient();
        assert.ok(await waitUntil(() => containerSessionCount(containerName) === 2), "both sessions must be counted");

        clients[0]?.kill("SIGKILL");
        assert.ok(await waitUntil(() => containerSessionCount(containerName) === 1), "one session remains after the first exits");

        clients[1]?.kill("SIGKILL");
        assert.ok(await waitUntil(() => containerSessionCount(containerName) === 0), "count reaches zero after the last exits");
    });

    test("orphaned in-container shell is not counted", async () => {
        await startContainer(makeOpts(containerName, workspaceRoot, cacheDir));

        // Create an orphaned `bash --login` INSIDE the container with no lingering host client: `-d`
        // (detached) returns immediately, so the host exec process exits while the in-container shell lives
        // on. This is exactly the ghost a laptop sleep / closed terminal leaves behind. The unique sleep
        // duration is a sentinel we can find via `docker top` (host-side, needs no in-container tooling).
        const sentinel = "987654";
        const ghost = spawnSync("docker", ["exec", "-d", containerName, "bash", "--login", "-c", `sleep ${sentinel}`], { stdio: "pipe" });
        assert.equal(ghost.status, 0, "ghost shell must start");

        // Confirm the ghost really is alive inside the container (host-side view via docker top).
        assert.ok(
            await waitUntil(() => {
                const top = spawnSync("docker", ["top", containerName], { encoding: "utf8", stdio: "pipe" });
                return (top.stdout ?? "").includes(sentinel);
            }),
            "orphaned in-container bash --login must be present",
        );

        // The old in-container detection would have counted this ghost and suppressed the stop prompt.
        // Host-side detection has no client process for it, so it correctly reports zero.
        assert.equal(containerSessionCount(containerName), 0, "an orphaned in-container shell must not be counted");
    });
});
