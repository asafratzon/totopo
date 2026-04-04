import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    bumpMajor,
    bumpMinor,
    bumpPatch,
    type Changelog,
    gitTagExistsLocally,
    type RcEntry,
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

function makeValidChangelog(entries: RcEntry[] = []): Changelog {
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
