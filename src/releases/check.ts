// =============================================================================
// check.ts — pre-release health checks
// Usage: pnpm check
//
// Run before pnpm rc to catch issues early. Add new checks here as the
// project grows.
// =============================================================================

import { readChangelog, validateChangelog } from "./changelog-utils.ts";

let errors = 0;

const pass = (label: string, detail?: string) => console.log(`\x1b[32m✓\x1b[0m ${label.padEnd(36)}\x1b[2m${detail ?? ""}\x1b[0m`);

const fail = (label: string, detail: string) => {
    console.log(`\x1b[31m✗\x1b[0m ${label.padEnd(36)}${detail}`);
    errors++;
};

console.log("\n\x1b[1mtotopo — pre-release checks\x1b[0m\n");

// ─── changelog.yaml structure ────────────────────────────────────────────────
try {
    const data = readChangelog();
    validateChangelog(data);
    const count = data.in_progress.entries.length;
    pass("changelog.yaml structure", count > 0 ? `${count} in-progress entry/entries` : "no in-progress entries");
} catch (e) {
    fail("changelog.yaml structure", e instanceof Error ? e.message : String(e));
}

// ─── No rc versions in releases ──────────────────────────────────────────────
try {
    const data = readChangelog();
    const rcInReleases = data.releases.filter((r) => r.version.includes("-rc-"));
    if (rcInReleases.length > 0) {
        const versions = rcInReleases.map((r) => r.version).join(", ");
        fail("no rc versions in releases", `rc entries belong in in_progress.entries, not releases: ${versions}`);
    } else {
        pass("no rc versions in releases");
    }
} catch (e) {
    fail("no rc versions in releases", e instanceof Error ? e.message : String(e));
}

// ─── Summary ─────────────────────────────────────────────────────────────────
if (errors === 0) {
    console.log(`\n\x1b[32m●\x1b[0m \x1b[1mAll checks passed.\x1b[0m\n`);
} else {
    console.log(`\n\x1b[31m●\x1b[0m \x1b[1m${errors} check(s) failed.\x1b[0m\n`);
    process.exit(1);
}
