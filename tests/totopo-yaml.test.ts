import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { load as loadYaml } from "js-yaml";
import { PROFILE } from "../src/lib/constants.js";
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

    test("returns null when file is missing", async () => {
        tmp = createTempDir();
        assert.equal(readTotopoYaml(tmp), null);
        await cleanTempDir(tmp);
    });

    test("reads a valid minimal file", async () => {
        tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: my-project\n");
        const config = readTotopoYaml(tmp);
        assert.equal(config?.workspace_id, "my-project");
        await cleanTempDir(tmp);
    });

    test("throws on empty file", async () => {
        tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "");
        assert.throws(() => readTotopoYaml(tmp), /empty or not a valid YAML/);
        await cleanTempDir(tmp);
    });

    test("throws on schema violation (missing workspace_id)", async () => {
        tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "env_file: .env\n");
        assert.throws(() => readTotopoYaml(tmp), /Invalid totopo\.yaml/);
        await cleanTempDir(tmp);
    });

    test("throws on unknown properties", async () => {
        tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: my-project\nbogus_field: true\n");
        assert.throws(() => readTotopoYaml(tmp), /unknown property "bogus_field"/);
        await cleanTempDir(tmp);
    });
});

// ---- writeTotopoYaml / roundtrip --------------------------------------------------------------------------------------------------------

describe("writeTotopoYaml", () => {
    test("write then read roundtrip preserves config", async () => {
        const tmp = createTempDir();
        const config = buildDefaultTotopoYaml("roundtrip-test");
        writeTotopoYaml(tmp, config);
        const read = readTotopoYaml(tmp);
        assert.equal(read?.workspace_id, "roundtrip-test");
        assert.deepEqual(read?.shadow_paths, ["node_modules", ".env*"]);
        assert.ok(read?.profiles?.default);
        assert.equal(read?.profiles?.extended, undefined);
        await cleanTempDir(tmp);
    });

    test("includeExtendedTemplate emits a commented extended block that can be uncommented to a valid profile", async () => {
        const tmp = createTempDir();
        const config = buildDefaultTotopoYaml("template-test");
        writeTotopoYaml(tmp, config, { includeExtendedTemplate: true });

        const raw = readFileSync(join(tmp, "totopo.yaml"), "utf8");
        assert.ok(raw.includes("# Uncomment to enable additional runtimes"), "prompt line should be present");
        assert.ok(raw.includes("# extended:"), "commented extended profile should be present");

        // Uncomment only the lines between the `# extended:` marker and the trailing footer comment,
        // then verify the full file parses with both profiles. This proves the commented block is
        // structurally valid YAML once a user strips the leading "# ".
        const lines = raw.split("\n");
        const extStart = lines.findIndex((l) => l.includes("# extended:"));
        const footIdx = lines.findIndex((l) => l.includes("# Add more profiles here"));
        assert.ok(extStart >= 0 && footIdx > extStart, "expected commented extended block before footer");

        const uncommented = lines.map((l, i) => (i >= extStart && i < footIdx ? l.replace(/^ {2}# ?/, "  ") : l)).join("\n");
        const parsed = loadYaml(uncommented) as { profiles?: Record<string, { description?: string; dockerfile_hook?: string }> };
        assert.ok(parsed.profiles?.default, "default profile should still be present");
        assert.ok(parsed.profiles?.extended, "uncommenting should yield an extended profile entry");
        assert.equal(parsed.profiles?.extended?.description, "Base image + Go, Java, Rust, and Bun");
        assert.ok(parsed.profiles?.extended?.dockerfile_hook?.includes("golang-go"), "extended hook should include the Go install line");

        await cleanTempDir(tmp);
    });

    test("does not emit a commented extended block without the option (no clippy behavior)", async () => {
        const tmp = createTempDir();
        const config = buildDefaultTotopoYaml("no-clippy-test");
        writeTotopoYaml(tmp, config);
        const raw = readFileSync(join(tmp, "totopo.yaml"), "utf8");
        assert.ok(!raw.includes("# extended:"), "commented extended block must not appear when option is omitted");
        assert.ok(!raw.includes("Uncomment to enable additional runtimes"), "prompt line must not appear when option is omitted");
        await cleanTempDir(tmp);
    });
});

// ---- buildDefaultTotopoYaml -------------------------------------------------------------------------------------------------------------

describe("buildDefaultTotopoYaml", () => {
    test("returns correct workspace_id", () => {
        const config = buildDefaultTotopoYaml("test-ws");
        assert.equal(config.workspace_id, "test-ws");
    });

    test("includes default shadow_paths", () => {
        const config = buildDefaultTotopoYaml("test-ws");
        assert.deepEqual(config.shadow_paths, ["node_modules", ".env*"]);
    });

    test("includes only the default profile (extended is shipped as a commented template, not a live entry)", () => {
        const config = buildDefaultTotopoYaml("test-ws");
        const profileNames = Object.keys(config.profiles ?? {});
        assert.deepEqual(profileNames, [PROFILE.default]);
        assert.ok(config.profiles?.default?.description, "default profile should have a description");
    });
});

// ---- repairTotopoYaml -------------------------------------------------------------------------------------------------------------------

describe("repairTotopoYaml", () => {
    test("returns null when file is missing", async () => {
        const tmp = createTempDir();
        const result = repairTotopoYaml(tmp);
        assert.equal(result.repairedYaml, null);
        assert.equal(result.error, undefined);
        await cleanTempDir(tmp);
    });

    test("returns null when file is already valid", async () => {
        const tmp = createTempDir();
        const config = buildDefaultTotopoYaml("valid-ws");
        writeTotopoYaml(tmp, config);
        const result = repairTotopoYaml(tmp);
        assert.equal(result.repairedYaml, null);
        await cleanTempDir(tmp);
    });

    test("repairs missing workspace_id using dirname", async () => {
        const tmp = createTempDir();
        const sub = join(tmp, "my-cool-project");
        mkdirSync(sub);
        writeFileSync(join(sub, "totopo.yaml"), "env_file: .env\n");
        const result = repairTotopoYaml(sub);
        assert.ok(result.repairedYaml);
        assert.ok(result.repairedYaml.workspace_id.length > 0);
        assert.ok(result.message?.includes("workspace_id"));
        await cleanTempDir(tmp);
    });

    test("strips unknown fields", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: strip-test\nbogus: true\n");
        const result = repairTotopoYaml(tmp);
        assert.ok(result.repairedYaml);
        assert.ok(result.message?.includes('removed unknown field "bogus"'));
        // Verify it was actually stripped - re-read should succeed
        const read = readTotopoYaml(tmp);
        assert.equal(read?.workspace_id, "strip-test");
        await cleanTempDir(tmp);
    });
});
