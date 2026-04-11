// =========================================================================================================================================
// sync-github-releases.ts - keep GitHub releases in sync with npm and changelog.yaml
// Usage: pnpm sync-releases
//        or import { syncGithubReleases } from "./sync-github-releases.ts"
//
// For every version published on npm:
//   - Missing GitHub release          -> created via `gh release create`
//   - Existing release with no notes  -> updated via `gh release edit`
//     (detects blank body or our own placeholder string - never overwrites hand-written notes)
//   - rc versions                     -> created as pre-release with a generic note; never updated
//
// Release notes come from changelog.yaml via getReleaseNotes(). Falls back to
// placeholderNotes() when no entry exists, which doubles as the stale-detection string.
//
// Safe to run repeatedly. Skips gracefully if gh CLI is not available.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { log } from "@clack/prompts";
import { getReleaseNotes } from "./changelog-utils.ts";

// Fallback notes used when changelog.yaml has no entry for a version - also used to detect stale placeholders
function placeholderNotes(tag: string): string {
    return `Release ${tag}`;
}

// Thin wrapper around spawnSync that captures stdout/stderr and returns a typed result object
function run(cmd: string, args: string[]): { stdout: string; stderr: string; ok: boolean } {
    const r = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe" });
    return {
        stdout: r.stdout?.trim() ?? "",
        stderr: r.stderr?.trim() ?? "",
        ok: r.status === 0,
    };
}

export async function syncGithubReleases(packageName: string): Promise<void> {
    // -- Check gh availability ------------------------------------------------------------------------------------------------------------
    const ghCheck = run("gh", ["--version"]);
    if (!ghCheck.ok) {
        log.warn("gh CLI not found — skipping GitHub release sync");
        log.message("Install from https://cli.github.com/ to automate this step.");
        return;
    }

    // -- Fetch npm versions ---------------------------------------------------------------------------------------------------------------
    const npmResult = run("npm", ["view", packageName, "versions", "--json"]);
    let npmVersions: string[] = [];
    try {
        const parsed = JSON.parse(npmResult.stdout);
        npmVersions = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        log.warn("Could not fetch npm versions — skipping GitHub release sync");
        return;
    }

    // -- Fetch existing GitHub releases ---------------------------------------------------------------------------------------------------
    const ghResult = run("gh", ["release", "list", "--limit", "1000", "--json", "tagName"]);
    let ghTags = new Set<string>();
    try {
        const releases = JSON.parse(ghResult.stdout) as { tagName: string }[];
        ghTags = new Set(releases.map((r) => r.tagName));
    } catch {
        log.warn(`Could not fetch GitHub releases — skipping sync${ghResult.stderr ? `: ${ghResult.stderr}` : ""}`);
        return;
    }

    // -- Create missing releases / update releases with empty or placeholder notes ---------------------------------------------------------
    const missing = npmVersions.filter((v) => !ghTags.has(`v${v}`));

    // For existing stable releases, fetch body individually to check if notes need updating
    const needsNotes: string[] = [];
    for (const version of npmVersions) {
        if (!ghTags.has(`v${version}`)) continue; // missing - handled above
        if (/-rc-\d+$/.test(version)) continue; // rc notes are intentionally generic
        const bodyResult = run("gh", ["release", "view", `v${version}`, "--json", "body"]);
        let body = "";
        try {
            body = (JSON.parse(bodyResult.stdout) as { body: string }).body ?? "";
        } catch {
            /* leave body empty — will trigger update */
        }
        if (body.trim() === "" || body.trim() === placeholderNotes(`v${version}`)) {
            needsNotes.push(version);
        }
    }

    if (missing.length === 0 && needsNotes.length === 0) {
        log.success("GitHub releases are in sync with npm");
        return;
    }

    if (missing.length > 0) log.step(`Creating ${missing.length} missing GitHub release(s): ${missing.join(", ")}`);
    if (needsNotes.length > 0) log.step(`Updating ${needsNotes.length} release(s) with missing notes: ${needsNotes.join(", ")}`);

    for (const version of missing) {
        const tag = `v${version}`;
        const isRc = /-rc-\d+$/.test(version);
        const baseVersion = version.replace(/-rc-\d+$/, "");
        const notes = isRc ? `Release candidate for ${baseVersion}` : getReleaseNotes(version) || placeholderNotes(tag);

        const args = ["release", "create", tag, "--title", tag, "--notes", notes, ...(isRc ? ["--prerelease"] : [])];
        const result = spawnSync("gh", args, { encoding: "utf8", stdio: "pipe" });
        if (result.status === 0) {
            log.success(`Created GitHub release ${tag}`);
        } else {
            log.warn(`Failed to create GitHub release ${tag}: ${result.stderr?.trim()}`);
        }
    }

    for (const version of needsNotes) {
        const tag = `v${version}`;
        const notes = getReleaseNotes(version) || placeholderNotes(tag);
        const result = spawnSync("gh", ["release", "edit", tag, "--notes", notes], { encoding: "utf8", stdio: "pipe" });
        if (result.status === 0) {
            log.success(`Updated notes for GitHub release ${tag}`);
        } else {
            log.warn(`Failed to update notes for ${tag}: ${result.stderr?.trim()}`);
        }
    }
}

// -- Standalone entrypoint ----------------------------------------------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    name: string;
};
await syncGithubReleases(pkg.name);
