// =============================================================================
// release.ts — promote rc to latest
// Usage: pnpm rc:promote  (run from host, not inside container)
//
// Reads the current rc version from the npm registry, strips the -rc-N
// suffix, validates changelog.yaml has notes, squashes rc entries, regenerates
// CHANGELOG.md, updates package.json, commits, publishes to npm, removes the
// rc dist-tag, pushes tags to GitHub (only after npm publish succeeded), and
// creates a GitHub release with notes from changelog.yaml via gh CLI.
// =============================================================================

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cancel, confirm, intro, log, outro } from "@clack/prompts";
import {
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
log.message(
	"Make sure you are logged in to npm before proceeding (npm whoami).",
);

// ─── Sync GitHub releases ─────────────────────────────────────────────────────
log.step("Syncing GitHub releases with npm...");
await syncGithubReleases(name);

// ─── Fetch rc from registry ───────────────────────────────────────────────────
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

// ─── Check base version not already released ──────────────────────────────────
const allVersionsProbe = spawnSync(
	"npm",
	["view", name, "versions", "--json"],
	{ encoding: "utf8", stdio: "pipe" },
);
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

// ─── Validate changelog entries ───────────────────────────────────────────────
log.step("Validating changelog.yaml...");
const changelog = readChangelog();

if (changelog.in_progress.base_version !== baseVersion) {
	log.error(
		`changelog.yaml in_progress.base_version is ${changelog.in_progress.base_version}, but promoting ${baseVersion}. Update changelog.yaml manually.`,
	);
	process.exit(1);
}

if (changelog.in_progress.entries.length === 0) {
	log.error(
		"changelog.yaml has no entries for this release. Run pnpm rc and add notes first.",
	);
	process.exit(1);
}

log.success(
	`Found ${changelog.in_progress.entries.length} rc entry/entries to squash for ${baseVersion}`,
);

// ─── Confirm ─────────────────────────────────────────────────────────────────
const ok = await confirm({
	message: `Publish ${name}@${baseVersion} as latest?`,
});

if (!ok || ok === Symbol.for("cancel")) {
	cancel("Aborted.");
	process.exit(0);
}

// ─── Squash rc entries + update changelog.yaml ───────────────────────────────
log.step("Squashing rc entries and updating changelog.yaml...");
const today = new Date().toISOString().slice(0, 10);
squashAndPromote(baseVersion, today);
log.success("changelog.yaml updated");

// ─── Regenerate CHANGELOG.md ─────────────────────────────────────────────────
log.step("Regenerating CHANGELOG.md...");
execSync("pnpm generate-changelog", { stdio: "inherit" });
log.success("CHANGELOG.md regenerated");

// ─── Update package.json ─────────────────────────────────────────────────────
pkg.version = baseVersion;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
log.success(`package.json → ${baseVersion}`);

// ─── Commit + push code ───────────────────────────────────────────────────────
const tag = `v${baseVersion}`;

log.step("git commit");
execSync(`git add ${pkgPath} CHANGELOG.md src/releases/changelog.yaml`, {
	stdio: "inherit",
});
execSync(`git commit -m "chore: release ${tag}"`, { stdio: "inherit" });

log.step("git push");
execSync("git push", { stdio: "inherit" });

// ─── Publish to npm ───────────────────────────────────────────────────────────
log.step("pnpm publish --access public");
execSync("pnpm publish --access public", { stdio: "inherit" });

// ─── Remove rc dist-tag ───────────────────────────────────────────────────────
log.step("Removing rc tag from npm registry...");
execSync(`npm dist-tag rm ${name} rc`, { stdio: "inherit" });
log.success("rc tag removed — npx totopo@rc will no longer resolve");

// ─── Tag + push to GitHub (only after npm publish succeeded) ──────────────────
log.step(`git tag ${tag}`);
execSync(`git tag ${tag}`, { stdio: "inherit" });

log.step("git push --tags");
execSync("git push --tags", { stdio: "inherit" });

// ─── Wait for npm registry to propagate ──────────────────────────────────────
log.step(`Waiting for ${name}@${baseVersion} to appear in npm registry...`);
await waitForNpmVersion(name, baseVersion);
log.success("npm registry updated");

// ─── Sync GitHub releases (register the new release) ─────────────────────────
await syncGithubReleases(name);

// ─── Done ────────────────────────────────────────────────────────────────────
outro(`${name}@${baseVersion} published as latest`);
console.log(`  Verify: https://www.npmjs.com/package/${name}`);
console.log(`  Test:   npx ${name}`);
console.log("");
