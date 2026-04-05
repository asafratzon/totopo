// =========================================================================================================================================
// tests/docker/session-lifecycle.test.ts - Full session lifecycle via startContainer()
// Tests container creation, label/mount/security assembly, mismatch detection, and resume
// against the real production Dockerfile so regressions in the image are caught here too.
// Run via: pnpm test:docker  (requires Docker, host-only)
// =========================================================================================================================================

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { StartContainerOpts } from "../../src/commands/dev.js";
import { startContainer } from "../../src/commands/dev.js";
import { buildDockerfile, buildImageWithTempfile } from "../../src/lib/dockerfile-builder.js";
import { expandShadowPatterns } from "../../src/lib/shadows.js";
import {
    cleanTempDir,
    cleanupAllTestArtifacts,
    createTempDir,
    dockerContainerLabel,
    dockerContainerStatus,
    dockerExec,
    forceRemoveContainer,
    forceRemoveImage,
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

before(() => {
    prodImageName = uniqueName("prod");
    const result = buildImageWithTempfile(
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
        activeProfile: "default",
        profileHook: undefined,
        expandedShadows: [],
        envFilePath: undefined,
        hasGit: false,
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

    afterEach(() => {
        forceRemoveContainer(containerName);
        forceRemoveImage(containerName);
        cleanTempDir(workspaceRoot);
        cleanTempDir(cacheDir);
    });

    test("creates container and returns 'created'", () => {
        const result = startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        assert.equal(result, "created");
        assert.equal(dockerContainerStatus(containerName), "running");
    });

    test("container has totopo labels set", () => {
        startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { activeProfile: "slim" }));
        assert.equal(dockerContainerLabel(containerName, "totopo.managed"), "true");
        assert.equal(dockerContainerLabel(containerName, "totopo.profile"), "slim");
        assert.equal(dockerContainerLabel(containerName, "totopo.shadows"), "");
    });

    test("container runs as devuser and WORKDIR is /workspace", () => {
        startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        const whoami = dockerExec(containerName, ["whoami"]);
        assert.equal(whoami.stdout, "devuser");
        const pwd = dockerExec(containerName, ["pwd"]);
        assert.equal(pwd.stdout, "/workspace");
    });

    test("workspace bind mount is visible inside container", () => {
        writeFileSync(join(workspaceRoot, "marker.txt"), "hello-from-host");
        startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        const cat = dockerExec(containerName, ["cat", "/workspace/marker.txt"]);
        assert.equal(cat.stdout, "hello-from-host");
    });

    test("second call to running container returns 'connected'", () => {
        startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        const result = startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        assert.equal(result, "connected");
        assert.equal(dockerContainerStatus(containerName), "running");
    });

    test("stopped container resumes and returns 'resumed'", () => {
        startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
        assert.equal(dockerContainerStatus(containerName), "exited");

        const result = startContainer(makeOpts(containerName, workspaceRoot, cacheDir));
        assert.equal(result, "resumed");
        assert.equal(dockerContainerStatus(containerName), "running");
    });

    test("shadow change triggers container recreation", () => {
        startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { expandedShadows: [] }));
        assert.equal(dockerContainerLabel(containerName, "totopo.shadows"), "");

        // Simulate a shadow being added
        const shadowDir = join(workspaceRoot, "node_modules");
        mkdirSync(shadowDir, { recursive: true });
        const expanded = expandShadowPatterns(["node_modules"], workspaceRoot);

        const result = startContainer(
            makeOpts(containerName, workspaceRoot, cacheDir, { expandedShadows: expanded, shadowPatterns: ["node_modules"] }),
        );
        assert.equal(result, "created", "container should be recreated after shadow change");
        assert.ok(dockerContainerLabel(containerName, "totopo.shadows").includes("node_modules"), "shadow label should reflect new shadow");
    });

    test("profile change triggers image rebuild and container recreation", () => {
        startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { activeProfile: "default" }));
        assert.equal(dockerContainerLabel(containerName, "totopo.profile"), "default");

        const result = startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { activeProfile: "slim" }));
        assert.equal(result, "created", "container should be recreated after profile change");
        assert.equal(dockerContainerLabel(containerName, "totopo.profile"), "slim");
    });

    test("env_file is passed to container", () => {
        const envFile = join(workspaceRoot, ".env");
        writeFileSync(envFile, "TOTOPO_TEST_VAR=hello123\n");
        startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { envFilePath: envFile }));
        const result = dockerExec(containerName, ["sh", "-c", "echo $TOTOPO_TEST_VAR"]);
        assert.equal(result.stdout, "hello123");
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

    afterEach(() => {
        forceRemoveContainer(containerName);
        forceRemoveImage(containerName);
        cleanTempDir(workspaceRoot);
        cleanTempDir(cacheDir);
    });

    test("shadow mount overlays workspace directory with empty container-local copy", () => {
        // Host workspace has node_modules with a secret file
        const hostNodeModules = join(workspaceRoot, "node_modules");
        mkdirSync(hostNodeModules, { recursive: true });
        writeFileSync(join(hostNodeModules, "secret.txt"), "should-not-be-visible");

        const expanded = expandShadowPatterns(["node_modules"], workspaceRoot);

        startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { expandedShadows: expanded, shadowPatterns: ["node_modules"] }));

        // Container should see an empty node_modules (shadow overlay hides host content)
        const ls = dockerExec(containerName, ["sh", "-c", "ls /workspace/node_modules 2>/dev/null | wc -l"]);
        assert.equal(ls.stdout, "0", "shadow-overlaid node_modules should appear empty");
    });

    test("shadow mount for glob pattern hides matching files", () => {
        writeFileSync(join(workspaceRoot, ".env"), "SECRET=supersecret\n");

        const expanded = expandShadowPatterns([".env*"], workspaceRoot);

        startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { expandedShadows: expanded, shadowPatterns: [".env*"] }));

        const cat = dockerExec(containerName, ["sh", "-c", "cat /workspace/.env 2>/dev/null || echo EMPTY"]);
        assert.ok(cat.stdout === "EMPTY" || cat.stdout === "", "shadowed .env should not expose host content");
    });

    test("workspace files outside shadow paths remain visible", () => {
        const hostNodeModules = join(workspaceRoot, "node_modules");
        mkdirSync(hostNodeModules, { recursive: true });
        writeFileSync(join(workspaceRoot, "README.md"), "visible-file");

        const expanded = expandShadowPatterns(["node_modules"], workspaceRoot);

        startContainer(makeOpts(containerName, workspaceRoot, cacheDir, { expandedShadows: expanded, shadowPatterns: ["node_modules"] }));

        const cat = dockerExec(containerName, ["cat", "/workspace/README.md"]);
        assert.equal(cat.stdout, "visible-file", "files outside shadow paths must remain accessible");
    });

    test("multiple shadow mounts coexist independently", () => {
        mkdirSync(join(workspaceRoot, "node_modules"), { recursive: true });
        writeFileSync(join(workspaceRoot, ".env"), "SECRET=1\n");
        writeFileSync(join(workspaceRoot, "keep.txt"), "keep");

        const expanded = expandShadowPatterns(["node_modules", ".env*"], workspaceRoot);

        startContainer(
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

    afterEach(() => {
        forceRemoveContainer(containerName);
        forceRemoveImage(containerName);
        cleanTempDir(workspaceRoot);
        cleanTempDir(cacheDir);
        cleanTempDir(profileTemplatesDir);
    });

    test("profile hook creates a file visible inside the container", () => {
        startContainer(
            makeOpts(containerName, workspaceRoot, cacheDir, {
                templatesDir: profileTemplatesDir,
                profileHook: 'RUN echo "hook-test" > /etc/totopo-hook-marker',
            }),
        );
        const cat = dockerExec(containerName, ["cat", "/etc/totopo-hook-marker"]);
        assert.equal(cat.status, 0, "hook-created file should be readable");
        assert.equal(cat.stdout, "hook-test");
    });

    test("empty profile hook produces a working container", () => {
        const result = startContainer(
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
