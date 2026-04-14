import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import yaml from "js-yaml";
import {
    bumpMajor,
    bumpMinor,
    bumpPatch,
    CHANGELOG_PATH,
    type Changelog,
    type ChangelogEntry,
    directPromote,
    gitTagExistsLocally,
    type RcEntry,
    readChangelog,
    type StableEntry,
    validateChangelog,
} from "../scripts/changelog-utils.js";

// ---- bumpPatch / bumpMinor / bumpMajor --------------------------------------------------------------------------------------------------

describe("version bumping", () => {
    test("bumpPatch increments patch", () => {
        assert.equal(bumpPatch("1.2.3"), "1.2.4");
    });

    test("bumpPatch on zero", () => {
        assert.equal(bumpPatch("0.0.0"), "0.0.1");
    });

    test("bumpMinor increments minor and resets patch", () => {
        assert.equal(bumpMinor("1.2.3"), "1.3.0");
    });

    test("bumpMajor increments major and resets minor and patch", () => {
        assert.equal(bumpMajor("1.2.3"), "2.0.0");
    });

    test("bumpMajor on zero", () => {
        assert.equal(bumpMajor("0.0.0"), "1.0.0");
    });
});

// ---- validateChangelog ------------------------------------------------------------------------------------------------------------------

function makeValidChangelog(entries: ChangelogEntry[] = []): Changelog {
    return {
        releases: [],
        in_progress: {
            base_version: "1.0.0",
            entries,
        },
    };
}

describe("validateChangelog", () => {
    test("valid changelog with no entries passes", () => {
        assert.doesNotThrow(() => validateChangelog(makeValidChangelog()));
    });

    test("valid changelog with entries passes", () => {
        const cl = makeValidChangelog([{ rc_version: "1.0.0-rc-1", date: "2026-04-04", added: ["New feature"] }]);
        assert.doesNotThrow(() => validateChangelog(cl));
    });

    test("throws when entries is not an array", () => {
        const cl = makeValidChangelog();
        (cl.in_progress as unknown as Record<string, unknown>).entries = "not-an-array";
        assert.throws(() => validateChangelog(cl), /must be an array/);
    });

    test("throws when entry missing rc_version", () => {
        const cl = makeValidChangelog([{ date: "2026-04-04", added: ["test"] } as unknown as RcEntry]);
        assert.throws(() => validateChangelog(cl), /rc_version/);
    });

    test("throws when entry missing date", () => {
        const cl = makeValidChangelog([{ rc_version: "1.0.0-rc-1", added: ["test"] } as unknown as RcEntry]);
        assert.throws(() => validateChangelog(cl), /date/);
    });

    test("throws when entry has no categories", () => {
        const cl = makeValidChangelog([{ rc_version: "1.0.0-rc-1", date: "2026-04-04" } as RcEntry]);
        assert.throws(() => validateChangelog(cl), /at least one of/);
    });

    test("throws when category is not an array", () => {
        const cl = makeValidChangelog([{ rc_version: "1.0.0-rc-1", date: "2026-04-04", added: "not-array" } as unknown as RcEntry]);
        assert.throws(() => validateChangelog(cl), /must be an array/);
    });

    test("throws when category item is not a string", () => {
        const cl = makeValidChangelog([{ rc_version: "1.0.0-rc-1", date: "2026-04-04", added: [123] } as unknown as RcEntry]);
        assert.throws(() => validateChangelog(cl), /must be a string/);
    });

    test("accepts stable entry with version field", () => {
        const cl = makeValidChangelog([{ version: "1.0.0", date: "2026-04-04", added: ["New feature"] } as StableEntry]);
        assert.doesNotThrow(() => validateChangelog(cl));
    });

    test("throws when entry has both rc_version and version", () => {
        const cl = makeValidChangelog([
            { rc_version: "1.0.0-rc-1", version: "1.0.0", date: "2026-04-04", added: ["test"] } as unknown as ChangelogEntry,
        ]);
        assert.throws(() => validateChangelog(cl), /both.*rc_version.*and.*version/);
    });

    test("throws when entry has neither rc_version nor version", () => {
        const cl = makeValidChangelog([{ date: "2026-04-04", added: ["test"] } as unknown as ChangelogEntry]);
        assert.throws(() => validateChangelog(cl), /missing.*rc_version.*or.*version/);
    });
});

// ---- directPromote ----------------------------------------------------------------------------------------------------------------------

describe("directPromote", () => {
    const dumpOpts = { lineWidth: 120, quotingType: '"' as const, forceQuotes: false, noRefs: true };

    function writeTestChangelog(data: Changelog): void {
        writeFileSync(CHANGELOG_PATH, yaml.dump(data, dumpOpts), "utf8");
    }

    test("promotes stable entry to releases and clears in_progress", () => {
        const original = readFileSync(CHANGELOG_PATH, "utf8");
        try {
            writeTestChangelog({
                releases: [],
                in_progress: {
                    base_version: "2.0.0",
                    entries: [{ version: "2.0.0", date: "2026-01-01", added: ["Feature A"], fixed: ["Bug B"] }],
                },
            });

            const result = directPromote("2.0.0", "2026-04-14");

            assert.equal(result.version, "2.0.0");
            assert.equal(result.date, "2026-04-14");
            assert.deepEqual(result.added, ["Feature A"]);
            assert.deepEqual(result.fixed, ["Bug B"]);

            const after = readChangelog();
            assert.equal(after.releases.length, 1);
            assert.equal(after.releases[0]?.version, "2.0.0");
            assert.equal(after.in_progress.base_version, "2.0.1");
            assert.equal(after.in_progress.entries.length, 0);
        } finally {
            writeFileSync(CHANGELOG_PATH, original, "utf8");
        }
    });

    test("throws when no stable entries exist", () => {
        const original = readFileSync(CHANGELOG_PATH, "utf8");
        try {
            writeTestChangelog({
                releases: [],
                in_progress: {
                    base_version: "2.0.0",
                    entries: [{ rc_version: "2.0.0-rc-1", date: "2026-01-01", added: ["Feature A"] }],
                },
            });

            assert.throws(() => directPromote("2.0.0", "2026-04-14"), /no stable entries/i);
        } finally {
            writeFileSync(CHANGELOG_PATH, original, "utf8");
        }
    });
});

// ---- gitTagExistsLocally ----------------------------------------------------------------------------------------------------------------

describe("gitTagExistsLocally", () => {
    test("returns false for nonexistent tag", () => {
        assert.equal(gitTagExistsLocally("v999.999.999-nonexistent"), false);
    });

    // We can't easily test the true case without creating a tag,
    // but we can verify an existing tag if any exist
    test("returns boolean", () => {
        const result = gitTagExistsLocally("v0.0.0");
        assert.equal(typeof result, "boolean");
    });
});
