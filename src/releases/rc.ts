// =========================================================================================================================================
// rc.ts — publish a release candidate
// Usage: pnpm rc  (run from host, not inside container)
//
// Determines the correct next rc version by checking the npm registry,
// aligns package.json to match, then commits, publishes to npm, pushes
// tags to GitHub (only after npm publish succeeds), and creates a GitHub
// pre-release via gh CLI.
//
// Changelog notes must be added to src/releases/changelog.yaml BEFORE
// running pnpm rc. The script hard-blocks if in_progress.entries is empty.
//
// Version alignment rules:
//   - Base version already released (e.g. 0.1.3 in registry) → bump patch → 0.1.4-rc-1
//   - Registry has 0.1.4-rc-5 as latest rc → next is always 0.1.4-rc-6
//     regardless of what package.json currently says
// =========================================================================================================================================

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cancel, confirm, intro, isCancel, log, outro, select } from "@clack/prompts";
import {
    bumpMajor,
    bumpMinor,
    bumpPatch,
    gitTagExistsLocally,
    gitTagExistsOnRemote,
    readChangelog,
    validateChangelog,
    waitForNpmVersion,
    writeChangelog,
} from "./changelog-utils.ts";
import { syncGithubReleases } from "./sync-github-releases.ts";

const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    name: string;
    version: string;
};
const { name } = pkg;

// Strip any existing -rc-N suffix to get the base version
const baseVersion = pkg.version.replace(/-rc-\d+$/, "");

intro(`${name} — release candidate`);
log.message("Make sure you are logged in to npm before proceeding (npm whoami).");

// ─── Early changelog check ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const changelog = readChangelog();
try {
    validateChangelog(changelog);
} catch (e) {
    log.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
}
if (changelog.in_progress.entries.length === 0) {
    log.error(`No changelog entries found for ${changelog.in_progress.base_version}.`);
    log.message("Add entries to src/releases/changelog.yaml under in_progress.entries, then re-run pnpm rc.");
    process.exit(1);
}
log.success(`changelog.yaml has ${changelog.in_progress.entries.length} entry/entries for ${changelog.in_progress.base_version}`);

// ─── Sync GitHub releases ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
log.step("Syncing GitHub releases with npm...");
await syncGithubReleases(name);

// ─── Fetch all published versions ────────────────────────────────────────────────────────────────────────────────────────────────────────
log.step("Checking npm registry...");

const probe = spawnSync("npm", ["view", name, "versions", "--json"], {
    encoding: "utf8",
    stdio: "pipe",
});

let allVersions: string[] = [];
try {
    const parsed = JSON.parse(probe.stdout.trim());
    allVersions = Array.isArray(parsed) ? parsed : [parsed];
} catch {
    // package not yet published
}

// ─── Compute next version ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Start with the current base; bumped below if the base version is already published on npm
let targetBase = baseVersion;

if (allVersions.includes(baseVersion)) {
    const bump = await select({
        message: `${name}@${baseVersion} is already released. Choose bump type:`,
        options: [
            { value: "patch", label: `patch  →  ${bumpPatch(baseVersion)}` },
            { value: "minor", label: `minor  →  ${bumpMinor(baseVersion)}` },
            { value: "major", label: `major  →  ${bumpMajor(baseVersion)}` },
        ],
    });
    if (isCancel(bump)) {
        cancel("Aborted.");
        process.exit(0);
    }

    if (bump === "minor") targetBase = bumpMinor(baseVersion);
    else if (bump === "major") targetBase = bumpMajor(baseVersion);
    else targetBase = bumpPatch(baseVersion);
}

if (changelog.in_progress.base_version !== targetBase) {
    const data = readChangelog();
    data.in_progress.base_version = targetBase;
    writeChangelog(data);
    log.info(`Updated changelog.yaml in_progress.base_version → ${targetBase}`);
}

const rcVersions = allVersions
    .filter((v) => v.startsWith(`${targetBase}-rc-`))
    .map((v) => Number.parseInt(v.replace(`${targetBase}-rc-`, ""), 10))
    .filter((n) => !Number.isNaN(n));

const maxN = rcVersions.length > 0 ? Math.max(...rcVersions) : 0;
const nextRcN = maxN + 1;
const nextVersion = `${targetBase}-rc-${nextRcN}`;

if (maxN > 0) {
    log.info(`Latest rc in registry: ${targetBase}-rc-${maxN}`);
}
log.success(`Next rc version: ${nextVersion}`);

// ─── Align package.json if needed ────────────────────────────────────────────────────────────────────────────────────────────────────────
if (pkg.version !== nextVersion) {
    log.warn(`package.json is at ${pkg.version} — will update to ${nextVersion}`);

    const alignOk = await confirm({
        message: `Update package.json from ${pkg.version} → ${nextVersion}?`,
    });

    if (isCancel(alignOk) || !alignOk) {
        cancel("Aborted.");
        process.exit(0);
    }

    pkg.version = nextVersion;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
    log.success(`package.json updated to ${nextVersion}`);
} else {
    log.info(`package.json already at ${nextVersion} — no change needed`);
}

// ─── Confirm publish ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const tag = `v${nextVersion}`;

const publishOk = await confirm({
    message: `Commit, publish to npm, then push ${tag} to GitHub?`,
});

if (isCancel(publishOk) || !publishOk) {
    cancel("Aborted.");
    process.exit(0);
}

// ─── Phase 7: Commit ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const commitMsg = `chore: rc ${tag}`;
const rcDirtyCheck = spawnSync("git", ["status", "--porcelain", pkgPath, "src/releases/changelog.yaml"], {
    encoding: "utf8",
    stdio: "pipe",
});
if (rcDirtyCheck.stdout.trim().length === 0) {
    log.info("Skipping git commit — nothing to commit");
} else {
    log.step("git commit");
    execSync(`git add ${pkgPath} src/releases/changelog.yaml`, { stdio: "inherit" });
    execSync(`git commit -m "${commitMsg}"`, { stdio: "inherit" });
}

// ─── Phase 8: Push ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const pushStatus = spawnSync("git", ["status", "-sb"], { encoding: "utf8", stdio: "pipe" });
const pushLine = pushStatus.stdout.split("\n")[0] ?? "";
const hasUpstream = pushLine.includes("...");
const alreadyPushed = hasUpstream && !pushLine.includes("[ahead");
if (alreadyPushed) {
    log.info("Skipping git push — remote already has this commit");
} else {
    log.step("git push");
    execSync("git push", { stdio: "inherit" });
}

// ─── Phase 9: Publish to npm ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const publishedProbe = spawnSync("npm", ["view", name, "versions", "--json"], { encoding: "utf8", stdio: "pipe" });
let publishedVersions: string[] = [];
try {
    const p = JSON.parse(publishedProbe.stdout.trim());
    publishedVersions = Array.isArray(p) ? p : [p];
} catch {}
if (publishedVersions.includes(nextVersion)) {
    log.info(`Skipping npm publish — ${name}@${nextVersion} already in registry`);
} else {
    log.step("pnpm publish --access public --tag rc");
    execSync("pnpm publish --access public --tag rc", { stdio: "inherit" });
}

// ─── Phase 10: Tag + push to GitHub (only after npm publish succeeded) ───────────────────────────────────────────────────────────────────
const tagLocal = gitTagExistsLocally(tag);
const tagRemote = gitTagExistsOnRemote(tag);
if (tagLocal) {
    log.info(`Skipping git tag — ${tag} already exists`);
} else {
    log.step(`git tag ${tag}`);
    execSync(`git tag ${tag}`, { stdio: "inherit" });
}
if (tagRemote) {
    log.info(`Skipping git push --tags — ${tag} already on remote`);
} else {
    log.step("git push --tags");
    execSync("git push --tags", { stdio: "inherit" });
}

// ─── Wait for npm registry to propagate ──────────────────────────────────────────────────────────────────────────────────────────────────
log.step(`Waiting for ${name}@${nextVersion} to appear in npm registry...`);
await waitForNpmVersion(name, nextVersion);
log.success("npm registry updated");

// ─── Sync GitHub releases (register the new rc) ──────────────────────────────────────────────────────────────────────────────────────────
await syncGithubReleases(name);

// ─── Done ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
outro(`${name}@${nextVersion} published as rc`);
console.log(`  Test:              npx totopo@rc`);
console.log(`  Promote to latest: pnpm rc:promote`);
console.log("");
