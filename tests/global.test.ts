import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { removeWorkspaceFiles } from "../src/commands/global.js";
import { cleanTempDir, createTempDir } from "./helpers.js";

describe("removeWorkspaceFiles", () => {
    test("removes workspaceDir and totopo.yaml when removeTotopoYaml is true", () => {
        const workspaceRoot = createTempDir();
        const workspaceDir = createTempDir();
        const yamlPath = join(workspaceRoot, "totopo.yaml");

        writeFileSync(yamlPath, "workspace_id: test\n");
        mkdirSync(join(workspaceDir, "agents"), { recursive: true });

        removeWorkspaceFiles(workspaceRoot, workspaceDir, true);

        assert.ok(!existsSync(workspaceDir), "workspaceDir should be removed");
        assert.ok(!existsSync(yamlPath), "totopo.yaml should be removed");

        cleanTempDir(workspaceRoot);
    });

    test("removes workspaceDir but keeps totopo.yaml when removeTotopoYaml is false", () => {
        const workspaceRoot = createTempDir();
        const workspaceDir = createTempDir();
        const yamlPath = join(workspaceRoot, "totopo.yaml");

        writeFileSync(yamlPath, "workspace_id: test\n");

        removeWorkspaceFiles(workspaceRoot, workspaceDir, false);

        assert.ok(!existsSync(workspaceDir), "workspaceDir should be removed");
        assert.ok(existsSync(yamlPath), "totopo.yaml should be kept");

        cleanTempDir(workspaceRoot);
    });

    test("does not throw when totopo.yaml is absent and removeTotopoYaml is true", () => {
        const workspaceRoot = createTempDir();
        const workspaceDir = createTempDir();

        assert.doesNotThrow(() => removeWorkspaceFiles(workspaceRoot, workspaceDir, true));

        cleanTempDir(workspaceRoot);
    });
});
