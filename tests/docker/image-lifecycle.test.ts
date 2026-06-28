// =========================================================================================================================================
// tests/docker/image-lifecycle.test.ts - Docker image build, inspect, and remove
// Exercises buildImageWithTempfile() and buildDockerfile() against a real Docker daemon.
// Run via: pnpm test:docker  (requires Docker, host-only)
// =========================================================================================================================================

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";

const TEMPLATES_DIR = join(import.meta.dirname, "../../templates");

import { buildDockerfile, buildImageWithTempfile } from "../../src/lib/dockerfile-builder.js";
import {
    cleanTempDir,
    cleanupAllTestArtifacts,
    createTempDir,
    dockerImageExists,
    forceRemoveImage,
    MINIMAL_DOCKERFILE,
    MINIMAL_DOCKERFILE_TEMPLATE,
    requireDocker,
    uniqueName,
} from "./docker-helpers.js";

requireDocker();

describe("image lifecycle", () => {
    let imageName: string;

    beforeEach(() => {
        imageName = uniqueName("img");
    });

    afterEach(() => {
        forceRemoveImage(imageName);
    });

    after(() => {
        cleanupAllTestArtifacts();
    });

    test("builds minimal image successfully", async () => {
        const contextDir = createTempDir();
        try {
            const result = await buildImageWithTempfile(MINIMAL_DOCKERFILE, contextDir, imageName, false, true);
            assert.equal(result.status, 0, "build should succeed");
            assert.ok(dockerImageExists(imageName), "image should exist after build");
        } finally {
            await cleanTempDir(contextDir);
        }
    });

    test("buildDockerfile with profile hook produces buildable image", async () => {
        // Verifies buildDockerfile() assembles a valid Dockerfile with a profile hook.
        // Uses the minimal template (not the full production Dockerfile) to keep the build fast.
        const contextDir = createTempDir();
        try {
            writeFileSync(join(contextDir, "Dockerfile"), MINIMAL_DOCKERFILE_TEMPLATE);
            const dockerfileContent = buildDockerfile(join(contextDir, "Dockerfile"), 'RUN echo "hook-test" > /etc/totopo-hook-marker');
            const result = await buildImageWithTempfile(dockerfileContent, contextDir, imageName, false, true);
            assert.equal(result.status, 0, "build with profile hook should succeed");
            assert.ok(dockerImageExists(imageName));
        } finally {
            await cleanTempDir(contextDir);
        }
    });

    test("noCache flag triggers full rebuild without error", async () => {
        const contextDir = createTempDir();
        try {
            const first = await buildImageWithTempfile(MINIMAL_DOCKERFILE, contextDir, imageName, false, true);
            assert.equal(first.status, 0, "first build should succeed");
            const second = await buildImageWithTempfile(MINIMAL_DOCKERFILE, contextDir, imageName, true, true);
            assert.equal(second.status, 0, "rebuild with noCache should succeed");
        } finally {
            await cleanTempDir(contextDir);
        }
    });

    test("invalid Dockerfile returns non-zero status", async () => {
        const broken = "FROM debian:trixie-slim\nRUN this_command_does_not_exist_at_all_xyz_abc\n";
        const contextDir = createTempDir();
        try {
            const result = await buildImageWithTempfile(broken, contextDir, imageName, false, true);
            assert.notEqual(result.status, 0, "build with invalid Dockerfile should fail");
            assert.ok(!dockerImageExists(imageName), "image should not exist after failed build");
        } finally {
            await cleanTempDir(contextDir);
        }
    });

    test("image can be removed after build", async () => {
        const contextDir = createTempDir();
        try {
            await buildImageWithTempfile(MINIMAL_DOCKERFILE, contextDir, imageName, false, true);
            assert.ok(dockerImageExists(imageName));
            forceRemoveImage(imageName);
            assert.ok(!dockerImageExists(imageName), "image should be gone after removal");
        } finally {
            await cleanTempDir(contextDir);
        }
    });
});

// =========================================================================================================================================
// Production Dockerfile validation
// =========================================================================================================================================

describe("production dockerfile", () => {
    // Validates that templates/Dockerfile is syntactically correct and that all COPY
    // instructions resolve (e.g. startup.mjs exists in the build context).
    // Fast on repeated runs due to Docker layer caching; slow on first cold run.
    test("templates/Dockerfile builds successfully", async () => {
        const prodImageName = uniqueName("prod");
        try {
            const dockerfileContent = buildDockerfile(join(TEMPLATES_DIR, "Dockerfile"));
            const result = await buildImageWithTempfile(dockerfileContent, TEMPLATES_DIR, prodImageName, false, true);
            assert.equal(result.status, 0, "production Dockerfile must build without errors");
            assert.ok(dockerImageExists(prodImageName));
        } finally {
            forceRemoveImage(prodImageName);
        }
    });
});
