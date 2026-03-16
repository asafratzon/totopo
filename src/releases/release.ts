// =========================================================================================================================================
// release.ts — promote rc to latest
// Usage: pnpm rc:promote  (run from host, not inside container)
//
// Reads the current rc version from the npm registry, strips the -rc-N
// suffix, validates changelog.yaml has notes, squashes rc entries, regenerates
// CHANGELOG.md, updates package.json, commits, publishes to npm, removes the
// rc dist-tag, pushes tags to GitHub (only after npm publish succeeded), and
// creates a GitHub release with notes from changelog.yaml via gh CLI.
// =========================================================================================================================================

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cancel, confirm, intro, log, outro, select } from "@clack/prompts";
import {
    gitCommitExists,
    gitTagExistsLocally,
    gitTagExistsOnRemote,
    readChangelog,
    squashAndPromote,
    waitForNpmVersion,
} from "./changelog-utils.js";
import { syncGithubReleases } from "./sync-github-releases.js";

const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    name: string;
    version: string;
};
const { name } = pkg;

intro(`${name} — promote rc to latest`);
log.message("Make sure you are logged in to npm before proceeding (npm whoami).");

let stashedBeforeRelease = false;

// ─── Phase 0: uncommitted changes guard ──────────────────────────────────────────────────────────────────────────────────────────────────
const porcelainResult = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: "pipe" });
const porcelainLines = porcelainResult.stdout.trim().split("\n").filter(Boolean);

if (porcelainLines.length > 0) {
    const PACKAGED = ["ai.sh", "src/core/", "templates/", "tsconfig.json", "LICENSE", "package.json"];
    const changedPaths = porcelainLines.map((l) => l.slice(3).trim());
    const packagedDirty = changedPaths.filter((p) => PACKAGED.some((prefix) => p === prefix || p.startsWith(prefix)));

    if (packagedDirty.length > 0) {
        // Case A — stop, explain, exit
        log.warn("Uncommitted changes overlap with packaged files:");
        for (const p of packagedDirty) log.message(`  ${p}`);
        log.error("These files are included in the published npm package. Publishing with them uncommitted would corrupt the release.");
        log.message("Options:");
        log.message("  1. Commit them and cut another rc (pnpm rc), then re-run pnpm rc:promote");
        log.message("  2. Manually stash (git stash), re-run pnpm rc:promote, then git stash pop");
        cancel("Resolve uncommitted changes and re-run.");
        process.exit(1);
    } else {
        // Case B — offer automated options
        log.warn("Uncommitted changes detected (none overlap with packaged files):");
        for (const p of changedPaths) log.message(`  ${p}`);
        const choice = await select({
            message: "How do you want to handle these?",
            options: [
                { value: "stash", label: "Stash now → run release flow → unstash at the end" },
                { value: "commit", label: "Commit them with a neutral message and continue" },
                { value: "cancel", label: "Cancel — I'll resolve them manually" },
            ],
        });
        if (!choice || choice === Symbol.for("cancel") || choice === "cancel") {
            cancel("Aborted.");
            process.exit(0);
        }
        if (choice === "stash") {
            log.step("git stash");
            execSync("git stash", { stdio: "inherit" });
            stashedBeforeRelease = true;
        } else {
            log.step("Committing non-packaged changes...");
            execSync(`git add ${changedPaths.map((p) => JSON.stringify(p)).join(" ")}`, { stdio: "inherit" });
            execSync(`git commit -m "chore: commit non-packaged changes before release"`, { stdio: "inherit" });
        }
    }
}

// ─── Sync GitHub releases ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
log.step("Syncing GitHub releases with npm...");
await syncGithubReleases(name);

// ─── Fetch rc from registry ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
log.step("Checking npm registry for rc...");

const probe = spawnSync("npm", ["view", name, "dist-tags", "--json"], {
    encoding: "utf8",
    stdio: "pipe",
});

let distTags: Record<string, string> = {};
try {
    distTags = JSON.parse(probe.stdout.trim());
} catch {
    log.error("Could not fetch dist-tags from npm registry.");
    process.exit(1);
}

const latestRcVersion = distTags.rc;

if (!latestRcVersion) {
    log.error("No rc tag found in npm registry.");
    log.message("Run pnpm rc first to publish a release candidate.");
    process.exit(1);
}

const baseVersion = latestRcVersion.replace(/-rc-\d+$/, "");

if (baseVersion === latestRcVersion) {
    log.error(`rc points to ${latestRcVersion} which has no -rc-N suffix.`);
    process.exit(1);
}

log.success(`rc: ${latestRcVersion} → will release as ${baseVersion}`);

// ─── Check base version not already released ─────────────────────────────────────────────────────────────────────────────────────────────
const allVersionsProbe = spawnSync("npm", ["view", name, "versions", "--json"], { encoding: "utf8", stdio: "pipe" });
let allVersions: string[] = [];
try {
    const parsed = JSON.parse(allVersionsProbe.stdout.trim());
    allVersions = Array.isArray(parsed) ? parsed : [parsed];
} catch {
    // ignore
}

if (allVersions.includes(baseVersion)) {
    log.error(`${name}@${baseVersion} is already published on npm.`);
    process.exit(1);
}

// ─── Validate changelog entries ──────────────────────────────────────────────────────────────────────────────────────────────────────────
log.step("Validating changelog.yaml...");
const changelog = readChangelog();

if (changelog.in_progress.base_version !== baseVersion) {
    log.error(
        `changelog.yaml in_progress.base_version is ${changelog.in_progress.base_version}, but promoting ${baseVersion}. Update changelog.yaml manually.`,
    );
    process.exit(1);
}

const squashAlreadyDone = changelog.in_progress.entries.length === 0;
if (!squashAlreadyDone) log.success(`Found ${changelog.in_progress.entries.length} rc entry/entries to squash for ${baseVersion}`);

// ─── Confirm ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ok = await confirm({
    message: `Publish ${name}@${baseVersion} as latest?`,
});

if (!ok || ok === Symbol.for("cancel")) {
    cancel("Aborted.");
    process.exit(0);
}

// ─── Phase 7: Squash rc entries + update changelog.yaml ──────────────────────────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
if (squashAlreadyDone) {
    log.info("Skipping changelog squash — already done");
} else {
    log.step("Squashing rc entries and updating changelog.yaml...");
    squashAndPromote(baseVersion, today);
    log.success("changelog.yaml updated");
}

// ─── Phase 8: Regenerate CHANGELOG.md ────────────────────────────────────────────────────────────────────────────────────────────────────
if (squashAlreadyDone) {
    log.info("Skipping CHANGELOG.md regen — squash already done");
} else {
    log.step("Regenerating CHANGELOG.md...");
    execSync("pnpm generate-changelog", { stdio: "inherit" });
    log.success("CHANGELOG.md regenerated");
}

// ─── Phase 9: Update package.json ────────────────────────────────────────────────────────────────────────────────────────────────────────
const pkgNow = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
if (pkgNow.version === baseVersion) {
    log.info(`Skipping package.json — already at ${baseVersion}`);
} else {
    pkg.version = baseVersion;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
    log.success(`package.json → ${baseVersion}`);
}

// ─── Phase 10: Commit ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const tag = `v${baseVersion}`;
const releaseCommitMsg = `chore: release ${tag}`;
if (gitCommitExists(releaseCommitMsg)) {
    log.info(`Skipping git commit — ${releaseCommitMsg} already exists`);
} else {
    log.step("git commit");
    execSync(`git add ${pkgPath} CHANGELOG.md src/releases/changelog.yaml`, { stdio: "inherit" });
    execSync(`git commit -m "${releaseCommitMsg}"`, { stdio: "inherit" });
}

// ─── Phase 11: Push ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const releasePushStatus = spawnSync("git", ["status", "-sb"], { encoding: "utf8", stdio: "pipe" });
const releasePushLine = releasePushStatus.stdout.split("\n")[0] ?? "";
const releaseHasUpstream = releasePushLine.includes("...");
const releaseAlreadyPushed = releaseHasUpstream && !releasePushLine.includes("[ahead");
if (releaseAlreadyPushed) {
    log.info("Skipping git push — remote already has this commit");
} else {
    log.step("git push");
    execSync("git push", { stdio: "inherit" });
}

// ─── Phase 12: Publish to npm ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Re-fetch dist-tags (may have changed since Phase 2)
const freshDistTagsProbe = spawnSync("npm", ["view", name, "dist-tags", "--json"], { encoding: "utf8", stdio: "pipe" });
let freshDistTags: Record<string, string> = {};
try {
    freshDistTags = JSON.parse(freshDistTagsProbe.stdout.trim());
} catch {}
if (freshDistTags.latest === baseVersion) {
    log.info("Skipping npm publish — already latest");
} else {
    log.step("pnpm publish --access public");
    execSync("pnpm publish --access public", { stdio: "inherit" });
}

// ─── Phase 13: Remove rc dist-tag ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Re-fetch dist-tags after publish
const freshRcTagProbe = spawnSync("npm", ["view", name, "dist-tags", "--json"], { encoding: "utf8", stdio: "pipe" });
let freshRcDistTags: Record<string, string> = {};
try {
    freshRcDistTags = JSON.parse(freshRcTagProbe.stdout.trim());
} catch {}
const freshRcTag = freshRcDistTags.rc;
const rcStillPointsHere = freshRcTag && freshRcTag.replace(/-rc-\d+$/, "") === baseVersion;
if (!rcStillPointsHere) {
    log.info("Skipping dist-tag rm — rc tag already removed or points elsewhere");
} else {
    log.step("Removing rc tag from npm registry...");
    execSync(`npm dist-tag rm ${name} rc`, { stdio: "inherit" });
    log.success("rc tag removed — npx totopo@rc will no longer resolve");
}

// ─── Phase 14: Tag + push to GitHub (only after npm publish succeeded) ───────────────────────────────────────────────────────────────────
const releaseTagLocal = gitTagExistsLocally(tag);
const releaseTagRemote = gitTagExistsOnRemote(tag);
if (releaseTagLocal) {
    log.info(`Skipping git tag — ${tag} already exists`);
} else {
    log.step(`git tag ${tag}`);
    execSync(`git tag ${tag}`, { stdio: "inherit" });
}
if (releaseTagRemote) {
    log.info(`Skipping git push --tags — ${tag} already on remote`);
} else {
    log.step("git push --tags");
    execSync("git push --tags", { stdio: "inherit" });
}

// ─── Wait for npm registry to propagate ──────────────────────────────────────────────────────────────────────────────────────────────────
log.step(`Waiting for ${name}@${baseVersion} to appear in npm registry...`);
await waitForNpmVersion(name, baseVersion);
log.success("npm registry updated");

// ─── Sync GitHub releases (register the new release) ─────────────────────────────────────────────────────────────────────────────────────
await syncGithubReleases(name);

// ─── Unstash if we stashed before release ────────────────────────────────────────────────────────────────────────────────────────────────
if (stashedBeforeRelease) {
    log.step("git stash pop");
    const popResult = spawnSync("git", ["stash", "pop"], { encoding: "utf8", stdio: "pipe" });
    if (popResult.status === 0) {
        log.success("Stashed changes restored");
    } else {
        log.warn("git stash pop failed — run: git stash pop");
    }
}

// ─── Done ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
outro(`${name}@${baseVersion} published as latest`);
console.log(`  Verify: https://www.npmjs.com/package/${name}`);
console.log(`  Test:   npx ${name}`);
console.log("");
