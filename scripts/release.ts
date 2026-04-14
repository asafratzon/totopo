// =========================================================================================================================================
// release.ts - publish to npm and GitHub
// Usage: pnpm release  (run from host, not inside container)
//
// This is the single entry point for all npm publishing. It shows the current
// npm registry state (latest and rc dist-tags) and offers a menu to choose
// what to do next.
//
// Three flows are available:
//
//   1. Publish release candidate
//      Publishes a new -rc-N version under the "rc" dist-tag so users can
//      test with `npx totopo@rc` before it becomes the default.
//
//   2. Promote rc to stable
//      Takes the current rc version, strips the -rc-N suffix, squash-merges
//      the RC branch into main, publishes as "latest", and removes the rc
//      dist-tag.
//
//   3. Publish stable release  (only shown when no rc tag exists)
//      Skips the RC lane entirely and publishes a new version directly as
//      "latest". Use when the change is small enough to ship without a
//      testing phase.
//
// Before running this script, use the /release skill inside the container to
// prepare: it helps draft changelog entries, validates test coverage and
// migrations, and stages the commit. This script handles everything that
// requires host access (npm publish, git push, GitHub releases).
//
// Changelog notes must be present in scripts/changelog.yaml BEFORE running.
// See CONTRIBUTING.md for the changelog.yaml format.
//
// Version alignment rules (for RC flow):
//   - Base version already released (e.g. 3.3.0 in registry) -> bump -> 3.3.1-rc-1
//   - Registry has 3.3.1-rc-5 as latest rc -> next is always 3.3.1-rc-6
// =========================================================================================================================================

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cancel, confirm, intro, isCancel, log, outro, select } from "@clack/prompts";
import {
    bumpMajor,
    bumpMinor,
    bumpPatch,
    directPromote,
    gitTagExistsLocally,
    gitTagExistsOnRemote,
    isRcEntry,
    readChangelog,
    squashAndPromote,
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

// =========================================================================================================================================
// Shared helpers
// =========================================================================================================================================

// --- npm auth ----------------------------------------------------------------------------------------------------------------------------

async function checkNpmAuth(): Promise<void> {
    const whoami = spawnSync("npm", ["whoami"], { encoding: "utf8", stdio: "pipe" });
    if (whoami.status === 0) {
        log.success(`Logged in to npm as ${whoami.stdout.trim()}`);
        return;
    }
    const loginOk = await confirm({ message: "Not logged in to npm. Run npm login now?" });
    if (isCancel(loginOk) || !loginOk) {
        cancel("Cannot publish without npm auth.");
        process.exit(0);
    }
    execSync("npm login", { stdio: "inherit" });
}

// --- npm registry ------------------------------------------------------------------------------------------------------------------------

function fetchDistTags(): Record<string, string> {
    const probe = spawnSync("npm", ["view", name, "dist-tags", "--json"], { encoding: "utf8", stdio: "pipe" });
    try {
        return JSON.parse(probe.stdout.trim()) as Record<string, string>;
    } catch {
        return {};
    }
}

function fetchAllVersions(): string[] {
    const probe = spawnSync("npm", ["view", name, "versions", "--json"], { encoding: "utf8", stdio: "pipe" });
    try {
        const parsed = JSON.parse(probe.stdout.trim());
        return Array.isArray(parsed) ? (parsed as string[]) : [parsed as string];
    } catch {
        return [];
    }
}

// --- Uncommitted changes guard -----------------------------------------------------------------------------------------------------------

async function guardUncommittedChanges(): Promise<{ stashed: boolean }> {
    const porcelainResult = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: "pipe" });
    const porcelainLines = porcelainResult.stdout.trim().split("\n").filter(Boolean);

    if (porcelainLines.length === 0) return { stashed: false };

    const PACKAGED = ["bin/", "dist/", "templates/", "LICENSE", "package.json"];
    const changedPaths = porcelainLines.map((l) => l.slice(3).trim());
    const packagedDirty = changedPaths.filter((p) => PACKAGED.some((prefix) => p === prefix || p.startsWith(prefix)));

    if (packagedDirty.length > 0) {
        log.warn("Uncommitted changes overlap with packaged files:");
        for (const p of packagedDirty) log.message(`  ${p}`);
        log.error("These files are included in the published npm package. Publishing with them uncommitted would corrupt the release.");
        log.message("Options:");
        log.message("  1. Commit them and re-run pnpm release");
        log.message("  2. Manually stash (git stash), re-run pnpm release, then git stash pop");
        cancel("Resolve uncommitted changes and re-run.");
        process.exit(1);
    }

    log.warn("Uncommitted changes detected (none overlap with packaged files):");
    for (const p of changedPaths) log.message(`  ${p}`);
    const choice = await select({
        message: "How do you want to handle these?",
        options: [
            { value: "stash", label: "Stash now -> run release flow -> unstash at the end" },
            { value: "commit", label: "Commit them with a neutral message and continue" },
            { value: "cancel", label: "Cancel -- I'll resolve them manually" },
        ],
    });
    if (isCancel(choice) || choice === "cancel") {
        cancel("Aborted.");
        process.exit(0);
    }
    if (choice === "stash") {
        log.step("git stash");
        execSync("git stash", { stdio: "inherit" });
        return { stashed: true };
    }
    log.step("Committing non-packaged changes...");
    execSync("git add -A", { stdio: "inherit" });
    execSync(`git commit -m "chore: commit non-packaged changes before release"`, { stdio: "inherit" });
    return { stashed: false };
}

// --- Build + test ------------------------------------------------------------------------------------------------------------------------

function buildAndTest(): void {
    log.step("Building...");
    try {
        execSync("pnpm re:build", { stdio: "inherit" });
    } catch {
        log.error("Build failed -- fix errors before releasing.");
        process.exit(1);
    }
    log.success("Build succeeded");

    log.step("Running tests...");
    try {
        execSync("pnpm test:all", { stdio: "inherit" });
    } catch {
        log.error("Tests failed -- fix before releasing.");
        process.exit(1);
    }
    log.success("All tests passed");
}

// --- Git helpers -------------------------------------------------------------------------------------------------------------------------

function commitFiles(files: string[], message: string): void {
    const dirtyCheck = spawnSync("git", ["status", "--porcelain", ...files], { encoding: "utf8", stdio: "pipe" });
    if (dirtyCheck.stdout.trim().length === 0) {
        log.info("Skipping git commit -- nothing to commit");
        return;
    }
    log.step("git commit");
    execSync(`git add ${files.join(" ")}`, { stdio: "inherit" });
    execSync(`git commit -m "${message}"`, { stdio: "inherit" });
}

function pushToRemote(): void {
    const pushStatus = spawnSync("git", ["status", "-sb"], { encoding: "utf8", stdio: "pipe" });
    const pushLine = pushStatus.stdout.split("\n")[0] ?? "";
    const hasUpstream = pushLine.includes("...");
    const alreadyPushed = hasUpstream && !pushLine.includes("[ahead");
    if (alreadyPushed) {
        log.info("Skipping git push -- remote already has this commit");
    } else if (!hasUpstream) {
        const branch = spawnSync("git", ["branch", "--show-current"], { encoding: "utf8", stdio: "pipe" }).stdout.trim();
        log.step(`git push --set-upstream origin ${branch}`);
        execSync(`git push --set-upstream origin ${branch}`, { stdio: "inherit" });
    } else {
        log.step("git push");
        execSync("git push", { stdio: "inherit" });
    }
}

function tagAndPush(tag: string): void {
    if (gitTagExistsLocally(tag)) {
        log.info(`Skipping git tag -- ${tag} already exists`);
    } else {
        log.step(`git tag ${tag}`);
        execSync(`git tag ${tag}`, { stdio: "inherit" });
    }
    if (gitTagExistsOnRemote(tag)) {
        log.info(`Skipping git push --tags -- ${tag} already on remote`);
    } else {
        log.step("git push --tags");
        execSync("git push --tags", { stdio: "inherit" });
    }
}

// --- npm publish -------------------------------------------------------------------------------------------------------------------------

function npmPublish(distTag?: string): void {
    const publishedVersions = fetchAllVersions();
    if (publishedVersions.includes(pkg.version)) {
        log.info(`Skipping npm publish -- ${name}@${pkg.version} already in registry`);
        return;
    }
    const tagArg = distTag ? ` --tag ${distTag}` : "";
    log.step(`pnpm publish --access public${tagArg}`);
    execSync(`pnpm publish --access public${tagArg ? ` --tag ${distTag}` : ""}`, { stdio: "inherit" });
}

// --- Stash restore -----------------------------------------------------------------------------------------------------------------------

function restoreStash(stashed: boolean): void {
    if (!stashed) return;
    log.step("git stash pop");
    const popResult = spawnSync("git", ["stash", "pop"], { encoding: "utf8", stdio: "pipe" });
    if (popResult.status === 0) {
        log.success("Stashed changes restored");
    } else {
        log.warn("git stash pop failed -- run: git stash pop");
    }
}

// =========================================================================================================================================
// Flow 1: Publish release candidate
// =========================================================================================================================================

async function publishRc(allVersions: string[]): Promise<void> {
    const baseVersion = pkg.version.replace(/-rc-\d+$/, "");

    // --- Changelog check -----------------------------------------------------------------------------------------------------------------
    const changelog = readChangelog();
    try {
        validateChangelog(changelog);
    } catch (e) {
        log.error(String(e instanceof Error ? e.message : e));
        process.exit(1);
    }
    if (changelog.in_progress.entries.filter(isRcEntry).length === 0) {
        log.error(`No RC changelog entries found for ${changelog.in_progress.base_version}.`);
        log.message("Add entries to scripts/changelog.yaml under in_progress.entries, then re-run pnpm release.");
        process.exit(1);
    }
    log.success(`changelog.yaml has entries for ${changelog.in_progress.base_version}`);

    // --- Uncommitted changes guard -------------------------------------------------------------------------------------------------------
    const { stashed } = await guardUncommittedChanges();

    // --- Build + test --------------------------------------------------------------------------------------------------------------------
    buildAndTest();

    // --- Sync GitHub releases ------------------------------------------------------------------------------------------------------------
    log.step("Syncing GitHub releases with npm...");
    await syncGithubReleases(name);

    // --- Compute next rc version ---------------------------------------------------------------------------------------------------------
    let targetBase = baseVersion;

    if (allVersions.includes(baseVersion)) {
        const bump = await select({
            message: `${name}@${baseVersion} is already released. Choose bump type:`,
            options: [
                { value: "patch", label: `patch  ->  ${bumpPatch(baseVersion)}` },
                { value: "minor", label: `minor  ->  ${bumpMinor(baseVersion)}` },
                { value: "major", label: `major  ->  ${bumpMajor(baseVersion)}` },
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
        log.info(`Updated changelog.yaml in_progress.base_version -> ${targetBase}`);
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

    // --- Require a changelog entry for this specific rc ----------------------------------------------------------------------------------
    const hasEntryForRc = changelog.in_progress.entries.some((e) => isRcEntry(e) && e.rc_version === nextVersion);
    if (!hasEntryForRc) {
        log.error(`No changelog entry found for ${nextVersion}.`);
        log.message(
            `Add an entry to scripts/changelog.yaml under in_progress.entries:\n\n` +
                `  - rc_version: "${nextVersion}"\n` +
                `    date: "${new Date().toISOString().slice(0, 10)}"\n` +
                `    fixed:\n` +
                `      - "Description of change"\n\n` +
                `Then re-run pnpm release.`,
        );
        process.exit(1);
    }

    // --- Align package.json if needed ----------------------------------------------------------------------------------------------------
    if (pkg.version !== nextVersion) {
        log.warn(`package.json is at ${pkg.version} -- will update to ${nextVersion}`);
        const alignOk = await confirm({
            message: `Update package.json from ${pkg.version} -> ${nextVersion}?`,
        });
        if (isCancel(alignOk) || !alignOk) {
            cancel("Aborted.");
            process.exit(0);
        }
        pkg.version = nextVersion;
        writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`);
        log.success(`package.json updated to ${nextVersion}`);
    } else {
        log.info(`package.json already at ${nextVersion} -- no change needed`);
    }

    // --- Confirm publish -----------------------------------------------------------------------------------------------------------------
    const tag = `v${nextVersion}`;
    const publishOk = await confirm({
        message: `Commit, publish to npm, then push ${tag} to GitHub?`,
    });
    if (isCancel(publishOk) || !publishOk) {
        cancel("Aborted.");
        process.exit(0);
    }

    // --- Commit, push, publish, tag ------------------------------------------------------------------------------------------------------
    commitFiles([pkgPath, "scripts/changelog.yaml"], `chore: rc ${tag}`);
    pushToRemote();
    npmPublish("rc");
    tagAndPush(tag);

    // --- Wait for npm registry to propagate ----------------------------------------------------------------------------------------------
    log.step(`Waiting for ${name}@${nextVersion} to appear in npm registry...`);
    await waitForNpmVersion(name, nextVersion);
    log.success("npm registry updated");

    // --- Sync GitHub releases (register the new rc) --------------------------------------------------------------------------------------
    await syncGithubReleases(name);

    restoreStash(stashed);

    outro(`${name}@${nextVersion} published as rc`);
    console.log(`  Test:    npx totopo@rc`);
    console.log(`  Promote: pnpm release`);
    console.log("");
}

// =========================================================================================================================================
// Flow 2: Promote rc to stable
// =========================================================================================================================================

async function promoteRc(rcVersion: string): Promise<void> {
    const baseVersion = rcVersion.replace(/-rc-\d+$/, "");

    if (baseVersion === rcVersion) {
        log.error(`rc points to ${rcVersion} which has no -rc-N suffix.`);
        process.exit(1);
    }

    log.success(`rc: ${rcVersion} -> will release as ${baseVersion}`);

    // --- Changelog validation ------------------------------------------------------------------------------------------------------------
    log.step("Validating changelog.yaml...");
    const changelog = readChangelog();
    try {
        validateChangelog(changelog);
    } catch (e) {
        log.error(String(e instanceof Error ? e.message : e));
        process.exit(1);
    }

    // squashAndPromote advances base_version to bumpPatch(baseVersion) after squashing -
    // if we see that on re-run with empty entries, squash already completed successfully.
    const nextBase = bumpPatch(baseVersion);
    const squashAlreadyDone = changelog.in_progress.base_version === nextBase && changelog.in_progress.entries.length === 0;

    if (!squashAlreadyDone && changelog.in_progress.base_version !== baseVersion) {
        log.error(
            `changelog.yaml in_progress.base_version is ${changelog.in_progress.base_version}, but promoting ${baseVersion}. Update changelog.yaml manually.`,
        );
        process.exit(1);
    }

    if (!squashAlreadyDone) log.success(`Found rc entries to qualify as ${baseVersion}`);

    // --- Confirm -------------------------------------------------------------------------------------------------------------------------
    const ok = await confirm({
        message: `Publish ${name}@${baseVersion} as latest?`,
    });
    if (isCancel(ok) || !ok) {
        cancel("Aborted.");
        process.exit(0);
    }

    // --- Uncommitted changes guard -------------------------------------------------------------------------------------------------------
    const { stashed } = await guardUncommittedChanges();

    // --- Sync GitHub releases ------------------------------------------------------------------------------------------------------------
    log.step("Syncing GitHub releases with npm...");
    await syncGithubReleases(name);

    // --- Squash rc entries + update changelog.yaml ---------------------------------------------------------------------------------------
    const today = new Date().toISOString().slice(0, 10);
    if (squashAlreadyDone) {
        log.info("Skipping changelog squash -- already done");
    } else {
        log.step("Squashing rc entries and updating changelog.yaml...");
        squashAndPromote(baseVersion, today);
        log.success("changelog.yaml updated");
    }

    // --- Regenerate CHANGELOG.md ---------------------------------------------------------------------------------------------------------
    if (squashAlreadyDone) {
        log.info("Skipping CHANGELOG.md regen -- squash already done");
    } else {
        log.step("Regenerating CHANGELOG.md...");
        execSync("pnpm generate-changelog", { stdio: "inherit" });
        log.success("CHANGELOG.md regenerated");
    }

    // --- Update package.json -------------------------------------------------------------------------------------------------------------
    const pkgNow = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    if (pkgNow.version === baseVersion) {
        log.info(`Skipping package.json -- already at ${baseVersion}`);
    } else {
        pkg.version = baseVersion;
        writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`);
        log.success(`package.json -> ${baseVersion}`);
    }

    // --- Commit --------------------------------------------------------------------------------------------------------------------------
    const tag = `v${baseVersion}`;
    const releaseCommitMsg = `chore: release ${tag}`;
    commitFiles([pkgPath, "CHANGELOG.md", "scripts/changelog.yaml"], releaseCommitMsg);

    // --- Squash merge RC branch into main ------------------------------------------------------------------------------------------------
    const rcBranch = spawnSync("git", ["branch", "--show-current"], { encoding: "utf8", stdio: "pipe" }).stdout.trim();

    if (rcBranch === "main") {
        log.info("Already on main -- skipping squash merge (re-run detected or ran from main directly)");
    } else {
        log.step(`Squash merging ${rcBranch} into main...`);
        execSync("git switch main", { stdio: "inherit" });
        execSync(`git merge --squash ${rcBranch}`, { stdio: "inherit" });
        execSync(`git commit -m "${releaseCommitMsg}"`, { stdio: "inherit" });
        log.success(`Squashed ${rcBranch} into main`);
    }

    // --- Push ----------------------------------------------------------------------------------------------------------------------------
    pushToRemote();

    // --- Publish to npm ------------------------------------------------------------------------------------------------------------------
    const freshDistTags = fetchDistTags();
    if (freshDistTags.latest === baseVersion) {
        log.info("Skipping npm publish -- already latest");
    } else {
        log.step("pnpm publish --access public");
        execSync("pnpm publish --access public", { stdio: "inherit" });
    }

    // --- Remove rc dist-tag --------------------------------------------------------------------------------------------------------------
    const freshRcTag = fetchDistTags().rc;
    const rcStillPointsHere = freshRcTag && freshRcTag.replace(/-rc-\d+$/, "") === baseVersion;
    if (!rcStillPointsHere) {
        log.info("Skipping dist-tag rm -- rc tag already removed or points elsewhere");
    } else {
        log.step("Removing rc tag from npm registry...");
        execSync(`npm dist-tag rm ${name} rc`, { stdio: "inherit" });
        log.success("rc tag removed");
    }

    // --- Tag + push to GitHub ------------------------------------------------------------------------------------------------------------
    tagAndPush(tag);

    // --- Wait for npm registry to propagate ----------------------------------------------------------------------------------------------
    log.step(`Waiting for ${name}@${baseVersion} to appear in npm registry...`);
    await waitForNpmVersion(name, baseVersion);
    log.success("npm registry updated");

    // --- Sync GitHub releases (register the new release) ---------------------------------------------------------------------------------
    await syncGithubReleases(name);

    restoreStash(stashed);

    outro(`${name}@${baseVersion} published as latest`);
    console.log(`  Verify: https://www.npmjs.com/package/${name}`);
    console.log(`  Test:   npx ${name}`);
    console.log("");
}

// =========================================================================================================================================
// Flow 3: Publish stable release (bypassing RC lane)
// =========================================================================================================================================

async function publishStable(latestVersion: string): Promise<void> {
    // --- Changelog check -----------------------------------------------------------------------------------------------------------------
    const changelog = readChangelog();
    try {
        validateChangelog(changelog);
    } catch (e) {
        log.error(String(e instanceof Error ? e.message : e));
        process.exit(1);
    }

    // --- Compute target version ----------------------------------------------------------------------------------------------------------
    const bump = await select({
        message: `Current latest is ${name}@${latestVersion}. Choose bump type:`,
        options: [
            { value: "patch", label: `patch  ->  ${bumpPatch(latestVersion)}` },
            { value: "minor", label: `minor  ->  ${bumpMinor(latestVersion)}` },
            { value: "major", label: `major  ->  ${bumpMajor(latestVersion)}` },
        ],
    });
    if (isCancel(bump)) {
        cancel("Aborted.");
        process.exit(0);
    }

    let targetVersion: string;
    if (bump === "minor") targetVersion = bumpMinor(latestVersion);
    else if (bump === "major") targetVersion = bumpMajor(latestVersion);
    else targetVersion = bumpPatch(latestVersion);

    log.success(`Target version: ${targetVersion}`);

    // --- Validate changelog has stable entries --------------------------------------------------------------------------------------------
    if (changelog.in_progress.entries.length === 0) {
        log.error(`No changelog entries found.`);
        log.message(
            `Add an entry to scripts/changelog.yaml under in_progress.entries:\n\n` +
                `  - version: "${targetVersion}"\n` +
                `    date: "${new Date().toISOString().slice(0, 10)}"\n` +
                `    fixed:\n` +
                `      - "Description of change"\n\n` +
                `Then re-run pnpm release.`,
        );
        process.exit(1);
    }

    // Align base_version if needed
    if (changelog.in_progress.base_version !== targetVersion) {
        const data = readChangelog();
        data.in_progress.base_version = targetVersion;
        writeChangelog(data);
        log.info(`Updated changelog.yaml in_progress.base_version -> ${targetVersion}`);
    }

    // --- Confirm -------------------------------------------------------------------------------------------------------------------------
    const ok = await confirm({
        message: `Publish ${name}@${targetVersion} directly as latest (no RC)?`,
    });
    if (isCancel(ok) || !ok) {
        cancel("Aborted.");
        process.exit(0);
    }

    // --- Uncommitted changes guard -------------------------------------------------------------------------------------------------------
    const { stashed } = await guardUncommittedChanges();

    // --- Build + test --------------------------------------------------------------------------------------------------------------------
    buildAndTest();

    // --- Sync GitHub releases ------------------------------------------------------------------------------------------------------------
    log.step("Syncing GitHub releases with npm...");
    await syncGithubReleases(name);

    // --- Promote changelog entries --------------------------------------------------------------------------------------------------------
    const today = new Date().toISOString().slice(0, 10);
    log.step("Promoting changelog entries...");
    directPromote(targetVersion, today);
    log.success("changelog.yaml updated");

    log.step("Regenerating CHANGELOG.md...");
    execSync("pnpm generate-changelog", { stdio: "inherit" });
    log.success("CHANGELOG.md regenerated");

    // --- Update package.json -------------------------------------------------------------------------------------------------------------
    pkg.version = targetVersion;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`);
    log.success(`package.json -> ${targetVersion}`);

    // --- Commit, push, publish, tag ------------------------------------------------------------------------------------------------------
    const tag = `v${targetVersion}`;
    commitFiles([pkgPath, "CHANGELOG.md", "scripts/changelog.yaml"], `chore: release ${tag}`);
    pushToRemote();

    log.step("pnpm publish --access public");
    execSync("pnpm publish --access public", { stdio: "inherit" });

    tagAndPush(tag);

    // --- Wait for npm registry to propagate ----------------------------------------------------------------------------------------------
    log.step(`Waiting for ${name}@${targetVersion} to appear in npm registry...`);
    await waitForNpmVersion(name, targetVersion);
    log.success("npm registry updated");

    // --- Sync GitHub releases (register the new release) ---------------------------------------------------------------------------------
    await syncGithubReleases(name);

    restoreStash(stashed);

    outro(`${name}@${targetVersion} published as latest`);
    console.log(`  Verify: https://www.npmjs.com/package/${name}`);
    console.log(`  Test:   npx ${name}`);
    console.log("");
}

// =========================================================================================================================================
// Main
// =========================================================================================================================================

intro(`${name} -- release`);

await checkNpmAuth();

// --- Display current registry state ------------------------------------------------------------------------------------------------------
log.step("Checking npm registry...");
const distTags = fetchDistTags();
const allVersions = fetchAllVersions();

const latestVersion = distTags.latest;
const rcVersion = distTags.rc;

if (latestVersion) log.info(`latest: ${latestVersion}`);
else log.warn("No latest version found in npm registry");

if (rcVersion) log.info(`rc:     ${rcVersion}`);

// --- Action menu -------------------------------------------------------------------------------------------------------------------------
type Action = "publish-rc" | "promote-rc" | "publish-stable";

const options: { value: Action; label: string }[] = [{ value: "publish-rc", label: "Publish release candidate" }];

if (rcVersion) {
    const rcBase = rcVersion.replace(/-rc-\d+$/, "");
    options.push({ value: "promote-rc", label: `Promote rc to stable  (${rcVersion} -> ${rcBase})` });
} else {
    options.push({ value: "publish-stable", label: "Publish stable release" });
}

const action = await select<Action>({
    message: "What would you like to do?",
    options,
});

if (isCancel(action)) {
    cancel("Aborted.");
    process.exit(0);
}

// --- Dispatch ----------------------------------------------------------------------------------------------------------------------------
switch (action) {
    case "publish-rc":
        await publishRc(allVersions);
        break;
    case "promote-rc":
        await promoteRc(rcVersion as string);
        break;
    case "publish-stable":
        await publishStable(latestVersion ?? "0.0.0");
        break;
}
