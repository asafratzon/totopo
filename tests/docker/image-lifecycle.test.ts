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

    test("builds minimal image successfully", () => {
        const contextDir = createTempDir();
        try {
            const result = buildImageWithTempfile(MINIMAL_DOCKERFILE, contextDir, imageName, false, true);
            assert.equal(result.status, 0, "build should succeed");
            assert.ok(dockerImageExists(imageName), "image should exist after build");
        } finally {
            cleanTempDir(contextDir);
        }
    });

    test("buildDockerfile with profile hook produces buildable image", () => {
        // Verifies buildDockerfile() assembles a valid Dockerfile with a profile hook.
        // Uses the minimal template (not the full production Dockerfile) to keep the build fast.
        const contextDir = createTempDir();
        try {
            writeFileSync(join(contextDir, "Dockerfile"), MINIMAL_DOCKERFILE_TEMPLATE);
            const dockerfileContent = buildDockerfile(join(contextDir, "Dockerfile"), 'RUN echo "hook-test" > /etc/totopo-hook-marker');
            const result = buildImageWithTempfile(dockerfileContent, contextDir, imageName, false, true);
            assert.equal(result.status, 0, "build with profile hook should succeed");
            assert.ok(dockerImageExists(imageName));
        } finally {
            cleanTempDir(contextDir);
        }
    });

    test("noCache flag triggers full rebuild without error", () => {
        const contextDir = createTempDir();
        try {
            const first = buildImageWithTempfile(MINIMAL_DOCKERFILE, contextDir, imageName, false, true);
            assert.equal(first.status, 0, "first build should succeed");
            const second = buildImageWithTempfile(MINIMAL_DOCKERFILE, contextDir, imageName, true, true);
            assert.equal(second.status, 0, "rebuild with noCache should succeed");
        } finally {
            cleanTempDir(contextDir);
        }
    });

    test("invalid Dockerfile returns non-zero status", () => {
        const broken = "FROM debian:bookworm-slim\nRUN this_command_does_not_exist_at_all_xyz_abc\n";
        const contextDir = createTempDir();
        try {
            const result = buildImageWithTempfile(broken, contextDir, imageName, false, true);
            assert.notEqual(result.status, 0, "build with invalid Dockerfile should fail");
            assert.ok(!dockerImageExists(imageName), "image should not exist after failed build");
        } finally {
            cleanTempDir(contextDir);
        }
    });

    test("image can be removed after build", () => {
        const contextDir = createTempDir();
        try {
            buildImageWithTempfile(MINIMAL_DOCKERFILE, contextDir, imageName, false, true);
            assert.ok(dockerImageExists(imageName));
            forceRemoveImage(imageName);
            assert.ok(!dockerImageExists(imageName), "image should be gone after removal");
        } finally {
            cleanTempDir(contextDir);
        }
    });
});

// =========================================================================================================================================
// Production Dockerfile validation
// =========================================================================================================================================

describe("production dockerfile", () => {
    // Validates that templates/Dockerfile is syntactically correct and that all COPY
    // instructions resolve (e.g. post-start.mjs exists in the build context).
    // Fast on repeated runs due to Docker layer caching; slow on first cold run.
    test("templates/Dockerfile builds successfully", () => {
        const prodImageName = uniqueName("prod");
        try {
            const dockerfileContent = buildDockerfile(join(TEMPLATES_DIR, "Dockerfile"));
            const result = buildImageWithTempfile(dockerfileContent, TEMPLATES_DIR, prodImageName, false, true);
            assert.equal(result.status, 0, "production Dockerfile must build without errors");
            assert.ok(dockerImageExists(prodImageName));
        } finally {
            forceRemoveImage(prodImageName);
        }
    });
});
