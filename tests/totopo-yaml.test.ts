import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
        assert.equal(read?.profiles, undefined, "minimal default has no profiles block");
        assert.equal(read?.env_file, undefined, "minimal default has no env_file");
        await cleanTempDir(tmp);
    });

    test("generated default is minimal: workspace_id + shadow_paths, a Help pointer, and no scaffolding", async () => {
        const tmp = createTempDir();
        writeTotopoYaml(tmp, buildDefaultTotopoYaml("minimal-test"));
        const raw = readFileSync(join(tmp, "totopo.yaml"), "utf8");

        // Present: the two default keys and a pointer to the docs / Help menu.
        assert.ok(raw.includes("workspace_id: minimal-test"));
        assert.ok(raw.includes("shadow_paths:"));
        assert.ok(raw.includes("Choose Help"), "header should point users at the Help menu for docs");

        // Absent: every scaffold we deliberately stopped shipping.
        assert.ok(!raw.includes("env_file:"), "no env_file in the minimal default");
        assert.ok(!raw.includes("profiles:"), "no profiles block in the minimal default");
        assert.ok(!raw.includes("# extended:"), "no commented extended profile");
        assert.ok(!raw.includes("Uncomment to enable additional runtimes"), "no extended-profile prompt");
        assert.ok(!raw.includes("# ports:"), "no commented ports example");
        assert.ok(!raw.includes("EXAMPLE_PORT"), "no ports example env name");
        assert.ok(!raw.includes("Add more profiles here"), "no profiles footer when there is no profiles block");

        // And it round-trips cleanly through the schema validator.
        assert.doesNotThrow(() => readTotopoYaml(tmp));
        await cleanTempDir(tmp);
    });

    test("emits the profiles footer only when a profiles block is present", async () => {
        const tmp = createTempDir();
        writeTotopoYaml(tmp, { workspace_id: "with-profiles", profiles: { default: { description: "Base image" } } });
        const raw = readFileSync(join(tmp, "totopo.yaml"), "utf8");
        assert.ok(raw.includes("profiles:"));
        assert.ok(raw.includes("Add more profiles here"), "footer hint should follow a profiles block");
        await cleanTempDir(tmp);
    });
});

// ---- ports config -----------------------------------------------------------------------------------------------------------------------

describe("ports config", () => {
    test("reads a valid ports block", async () => {
        const tmp = createTempDir();
        writeFileSync(
            join(tmp, "totopo.yaml"),
            "workspace_id: my-project\nports:\n  - port: 4820\n    ifTaken: next\n    env: EXAMPLE_PORT\n  - port: 5432\n",
        );
        const config = readTotopoYaml(tmp);
        assert.equal(config?.ports?.length, 2);
        assert.deepEqual(config?.ports?.[0], { port: 4820, ifTaken: "next", env: "EXAMPLE_PORT" });
        assert.deepEqual(config?.ports?.[1], { port: 5432 });
        await cleanTempDir(tmp);
    });

    test("rejects a bad ifTaken value", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: my-project\nports:\n  - port: 4820\n    ifTaken: bogus\n");
        assert.throws(() => readTotopoYaml(tmp), /Invalid totopo\.yaml/);
        await cleanTempDir(tmp);
    });

    test("rejects an out-of-range port", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: my-project\nports:\n  - port: 80\n");
        assert.throws(() => readTotopoYaml(tmp), /Invalid totopo\.yaml/);
        await cleanTempDir(tmp);
    });

    test("rejects an unknown field on a ports item", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: my-project\nports:\n  - port: 4820\n    bogus: true\n");
        assert.throws(() => readTotopoYaml(tmp), /unknown property "bogus"/);
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

    test("is minimal: no profiles and no env_file (they are optional and documented via Help)", () => {
        const config = buildDefaultTotopoYaml("test-ws");
        assert.equal(config.profiles, undefined, "no profiles scaffolded into the minimal default");
        assert.equal(config.env_file, undefined, "no env_file scaffolded into the minimal default");
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

    test("does not backfill a profiles block on repair (minimal files stay minimal)", async () => {
        const tmp = createTempDir();
        // A file missing profiles, with an unknown field to force a repair pass.
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: minimal-repair\nbogus: true\n");
        const result = repairTotopoYaml(tmp);
        assert.ok(result.repairedYaml);
        assert.equal(result.repairedYaml.profiles, undefined, "repair must not re-add a profiles block");
        assert.ok(!result.message?.includes("profiles"), "repair should not report adding profiles");
        await cleanTempDir(tmp);
    });

    test("restores the shadow_paths isolation default when absent", async () => {
        const tmp = createTempDir();
        writeFileSync(join(tmp, "totopo.yaml"), "workspace_id: shadow-repair\nbogus: true\n");
        const result = repairTotopoYaml(tmp);
        assert.ok(result.repairedYaml);
        assert.deepEqual(result.repairedYaml.shadow_paths, ["node_modules", ".env*"]);
        assert.ok(result.message?.includes("shadow_paths"));
        await cleanTempDir(tmp);
    });
});
