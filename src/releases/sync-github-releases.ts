// =========================================================================================================================================
// sync-github-releases.ts — align GitHub releases with npm registry
// Usage: pnpm sync-releases
//        or import { syncGithubReleases } from "./sync-github-releases.js"
//
// Fetches all published npm versions and all existing GitHub releases,
// then creates any GitHub releases that are missing. Safe to run repeatedly.
// Skips gracefully if gh CLI is not available.
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { log } from "@clack/prompts";
import { getReleaseNotes } from "./changelog-utils.js";

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
    // ── Check gh availability ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const ghCheck = run("gh", ["--version"]);
    if (!ghCheck.ok) {
        log.warn("gh CLI not found — skipping GitHub release sync");
        log.message("Install from https://cli.github.com/ to automate this step.");
        return;
    }

    // ── Fetch npm versions ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const npmResult = run("npm", ["view", packageName, "versions", "--json"]);
    let npmVersions: string[] = [];
    try {
        const parsed = JSON.parse(npmResult.stdout);
        npmVersions = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        log.warn("Could not fetch npm versions — skipping GitHub release sync");
        return;
    }

    // ── Fetch existing GitHub releases ───────────────────────────────────────────────────────────────────────────────────────────────────
    const ghResult = run("gh", ["release", "list", "--limit", "100", "--json", "tagName"]);
    let ghTags = new Set<string>();
    try {
        const releases = JSON.parse(ghResult.stdout) as { tagName: string }[];
        ghTags = new Set(releases.map((r) => r.tagName));
    } catch {
        log.warn(`Could not fetch GitHub releases — skipping sync${ghResult.stderr ? `: ${ghResult.stderr}` : ""}`);
        return;
    }

    // ── Find missing releases ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const missing = npmVersions.filter((v) => !ghTags.has(`v${v}`));

    if (missing.length === 0) {
        log.success("GitHub releases are in sync with npm");
        return;
    }

    log.step(`Creating ${missing.length} missing GitHub release(s): ${missing.join(", ")}`);

    for (const version of missing) {
        const tag = `v${version}`;
        const isRc = /-rc-\d+$/.test(version);
        const baseVersion = version.replace(/-rc-\d+$/, "");
        const notes = isRc ? `Release candidate for ${baseVersion}` : getReleaseNotes(version) || `Release ${tag}`;

        const args = ["release", "create", tag, "--title", tag, "--notes", notes, ...(isRc ? ["--prerelease"] : [])];

        const result = spawnSync("gh", args, {
            encoding: "utf8",
            stdio: "pipe",
        });
        if (result.status === 0) {
            log.success(`Created GitHub release ${tag}`);
        } else {
            log.warn(`Failed to create GitHub release ${tag}: ${result.stderr?.trim()}`);
        }
    }
}

// ── Standalone entrypoint ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    name: string;
};
await syncGithubReleases(pkg.name);
