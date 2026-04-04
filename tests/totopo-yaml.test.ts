import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
    buildDefaultTotopoYaml,
    readTotopoYaml,
    repairTotopoYaml,
    slugifyForWorkspaceId,
    validateWorkspaceId,
    writeTotopoYaml,
} from "../src/lib/totopo-yaml.js";
import { cleanTempDir, createTempDir } from "./helpers.js";

// ---- validateWorkspaceId ----------------------------------------------------------------------------------------------------------------

describe("validateWorkspaceId", () => {
    test("accepts valid IDs", () => {
        assert.equal(validateWorkspaceId("my-project"), undefined);
        assert.equal(validateWorkspaceId("ab"), undefined);
        assert.equal(validateWorkspaceId("a".repeat(48)), undefined);
        assert.equal(validateWorkspaceId("abc-123"), undefined);
    });

    test("rejects too short", () => {
        assert.ok(validateWorkspaceId(""));
        assert.ok(validateWorkspaceId("a"));
    });

    test("rejects too long", () => {
        assert.ok(validateWorkspaceId("a".repeat(49)));
    });

    test("rejects uppercase", () => {
        assert.ok(validateWorkspaceId("MyProject"));
    });

    test("rejects special characters", () => {
        assert.ok(validateWorkspaceId("my_project"));
        assert.ok(validateWorkspaceId("my project"));
        assert.ok(validateWorkspaceId("my.project"));
    });

    test("rejects leading or trailing hyphen", () => {
        assert.ok(validateWorkspaceId("-my-project"));
        assert.ok(validateWorkspaceId("my-project-"));
    });
});

// ---- slugifyForWorkspaceId --------------------------------------------------------------------------------------------------------------

describe("slugifyForWorkspaceId", () => {
    test("lowercases", () => {
        assert.equal(slugifyForWorkspaceId("MyProject"), "myproject");
    });

    test("replaces spaces with hyphens", () => {
        assert.equal(slugifyForWorkspaceId("my project"), "my-project");
    });

    test("strips leading and trailing hyphens", () => {
        assert.equal(slugifyForWorkspaceId("--my-project--"), "my-project");
    });

    test("collapses consecutive non-alphanumeric to single hyphen", () => {
        assert.equal(slugifyForWorkspaceId("my___project"), "my-project");
    });

    test("truncates to 48 chars", () => {
        const long = "a".repeat(60);
        assert.equal(slugifyForWorkspaceId(long).length, 48);
    });

    test("falls back to my-workspace when result is empty", () => {
        assert.equal(slugifyForWorkspaceId("---"), "my-workspace");
        assert.equal(slugifyForWorkspaceId(""), "my-workspace");
    });
});

// ---- readTotopoYaml ---------------------------------------------------------------------------------------------------------------------

describe("readTotopoYaml", () => {
    let tmp: string;

    test("returns null when file is missing", () => {
        tmp = createTempDir();
        assert.equal(readTotopoYaml(tmp), null);
        cleanTempDir(tmp);
    });

    test("reads a valid minimal file", () => {
        tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "schema_version: 3\nworkspace_id: my-project\n");
        const config = readTotopoYaml(tmp);
        assert.equal(config?.schema_version, 3);
        assert.equal(config?.workspace_id, "my-project");
        cleanTempDir(tmp);
    });

    test("throws on empty file", () => {
        tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "");
        assert.throws(() => readTotopoYaml(tmp), /empty or not a valid YAML/);
        cleanTempDir(tmp);
    });

    test("throws on schema violation", () => {
        tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "schema_version: 3\n");
        assert.throws(() => readTotopoYaml(tmp), /Invalid totopo\.yaml/);
        cleanTempDir(tmp);
    });

    test("throws on unknown properties", () => {
        tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "schema_version: 3\nworkspace_id: my-project\nbogus_field: true\n");
        assert.throws(() => readTotopoYaml(tmp), /unknown property "bogus_field"/);
        cleanTempDir(tmp);
    });
});

// ---- writeTotopoYaml / roundtrip --------------------------------------------------------------------------------------------------------

describe("writeTotopoYaml", () => {
    test("write then read roundtrip preserves config", () => {
        const tmp = createTempDir();
        const config = buildDefaultTotopoYaml("roundtrip-test", "Roundtrip Test");
        writeTotopoYaml(tmp, config);
        const read = readTotopoYaml(tmp);
        assert.equal(read?.workspace_id, "roundtrip-test");
        assert.equal(read?.name, "Roundtrip Test");
        assert.equal(read?.schema_version, 3);
        assert.deepEqual(read?.shadow_paths, ["node_modules", ".env*"]);
        assert.ok(read?.profiles?.default);
        assert.ok(read?.profiles?.slim);
        assert.ok(read?.profiles?.custom);
        cleanTempDir(tmp);
    });
});

// ---- buildDefaultTotopoYaml -------------------------------------------------------------------------------------------------------------

describe("buildDefaultTotopoYaml", () => {
    test("returns correct schema_version and workspace_id", () => {
        const config = buildDefaultTotopoYaml("test-ws");
        assert.equal(config.schema_version, 3);
        assert.equal(config.workspace_id, "test-ws");
    });

    test("includes default shadow_paths", () => {
        const config = buildDefaultTotopoYaml("test-ws");
        assert.deepEqual(config.shadow_paths, ["node_modules", ".env*"]);
    });

    test("includes three default profiles", () => {
        const config = buildDefaultTotopoYaml("test-ws");
        const profileNames = Object.keys(config.profiles ?? {});
        assert.deepEqual(profileNames, ["default", "slim", "custom"]);
    });

    test("includes name when provided", () => {
        const config = buildDefaultTotopoYaml("test-ws", "My Workspace");
        assert.equal(config.name, "My Workspace");
    });

    test("omits name when not provided", () => {
        const config = buildDefaultTotopoYaml("test-ws");
        assert.equal(config.name, undefined);
    });
});

// ---- repairTotopoYaml -------------------------------------------------------------------------------------------------------------------

describe("repairTotopoYaml", () => {
    test("returns null when file is missing", () => {
        const tmp = createTempDir();
        const result = repairTotopoYaml(tmp);
        assert.equal(result.repairedYaml, null);
        assert.equal(result.error, undefined);
        cleanTempDir(tmp);
    });

    test("returns null when file is already valid", () => {
        const tmp = createTempDir();
        const config = buildDefaultTotopoYaml("valid-ws");
        writeTotopoYaml(tmp, config);
        const result = repairTotopoYaml(tmp);
        assert.equal(result.repairedYaml, null);
        cleanTempDir(tmp);
    });

    test("repairs missing schema_version", () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: fix-me\n");
        const result = repairTotopoYaml(tmp);
        assert.ok(result.repairedYaml);
        assert.equal(result.repairedYaml.schema_version, 3);
        assert.ok(result.message?.includes("schema_version"));
        cleanTempDir(tmp);
    });

    test("repairs missing workspace_id using dirname", () => {
        const tmp = createTempDir();
        const sub = join(tmp, "my-cool-project");
        mkdirSync(sub);
        writeFileSync(join(sub, "totopo.yaml"), "schema_version: 3\n");
        const result = repairTotopoYaml(sub);
        assert.ok(result.repairedYaml);
        assert.ok(result.repairedYaml.workspace_id.length > 0);
        assert.ok(result.message?.includes("workspace_id"));
        cleanTempDir(tmp);
    });

    test("strips unknown fields", () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "schema_version: 3\nworkspace_id: strip-test\nbogus: true\n");
        const result = repairTotopoYaml(tmp);
        assert.ok(result.repairedYaml);
        assert.ok(result.message?.includes('removed unknown field "bogus"'));
        // Verify it was actually stripped - re-read should succeed
        const read = readTotopoYaml(tmp);
        assert.equal(read?.workspace_id, "strip-test");
        cleanTempDir(tmp);
    });
});
