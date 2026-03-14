// =============================================================================
// rc.ts — publish a release candidate
// Usage: pnpm rc  (run from host, not inside container)
//
// Determines the correct next rc version by checking the npm registry,
// aligns package.json to match, prompts for changelog notes, then commits,
// publishes to npm, pushes tags to GitHub (only after npm publish succeeds),
// and optionally creates a GitHub pre-release via gh CLI.
//
// Version alignment rules:
//   - Base version already released (e.g. 0.1.3 in registry) → bump patch → 0.1.4-rc-1
//   - Registry has 0.1.4-rc-5 as latest rc → next is always 0.1.4-rc-6
//     regardless of what package.json currently says
// =============================================================================

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cancel, confirm, intro, log, outro, text } from "@clack/prompts";
import { appendRcNotes, readChangelog } from "./changelog-utils.js";
import { syncGithubReleases } from "./sync-github-releases.js";

const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
	name: string;
	version: string;
};
const { name } = pkg;

// Strip any existing -rc-N suffix to get the base version
const baseVersion = pkg.version.replace(/-rc-\d+$/, "");

intro(`${name} — release candidate`);
log.message(
	"Make sure you are logged in to npm before proceeding (npm whoami).",
);

// ─── Sync GitHub releases ─────────────────────────────────────────────────────
log.step("Syncing GitHub releases with npm...");
await syncGithubReleases(name);

// ─── Fetch all published versions ────────────────────────────────────────────
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

// ─── Compute next version ────────────────────────────────────────────────────
function bumpPatch(v: string): string {
	const parts = v.split(".");
	parts[2] = String(Number(parts[2]) + 1);
	return parts.join(".");
}

let targetBase = baseVersion;

if (allVersions.includes(baseVersion)) {
	// Base version already released — must bump patch
	targetBase = bumpPatch(baseVersion);
	log.warn(
		`${name}@${baseVersion} is already released → bumping base to ${targetBase}`,
	);
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

// ─── Align package.json if needed ────────────────────────────────────────────
if (pkg.version !== nextVersion) {
	log.warn(`package.json is at ${pkg.version} — will update to ${nextVersion}`);

	const alignOk = await confirm({
		message: `Update package.json from ${pkg.version} → ${nextVersion}?`,
	});

	if (!alignOk || alignOk === Symbol.for("cancel")) {
		cancel("Aborted.");
		process.exit(0);
	}

	pkg.version = nextVersion;
	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
	log.success(`package.json updated to ${nextVersion}`);
} else {
	log.info(`package.json already at ${nextVersion} — no change needed`);
}

// ─── Changelog notes ─────────────────────────────────────────────────────────
const changelog = readChangelog();
const hasExistingEntries = changelog.in_progress.entries.length > 0;

log.message(
	hasExistingEntries
		? `changelog.yaml has ${changelog.in_progress.entries.length} existing rc entry/entries for ${targetBase}. Add more notes? (blank to skip)`
		: "Release notes are required. Enter items for each category (comma-separated, blank to skip).",
);

function parseItems(raw: string | symbol): string[] {
	if (typeof raw !== "string") return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

const addedRaw = await text({
	message: "Added (new features):",
	placeholder: "blank to skip",
});
if (addedRaw === Symbol.for("cancel")) {
	cancel("Aborted.");
	process.exit(0);
}

const changedRaw = await text({
	message: "Changed:",
	placeholder: "blank to skip",
});
if (changedRaw === Symbol.for("cancel")) {
	cancel("Aborted.");
	process.exit(0);
}

const fixedRaw = await text({
	message: "Fixed:",
	placeholder: "blank to skip",
});
if (fixedRaw === Symbol.for("cancel")) {
	cancel("Aborted.");
	process.exit(0);
}

const securityRaw = await text({
	message: "Security:",
	placeholder: "blank to skip",
});
if (securityRaw === Symbol.for("cancel")) {
	cancel("Aborted.");
	process.exit(0);
}

const added = parseItems(addedRaw);
const changed = parseItems(changedRaw);
const fixed = parseItems(fixedRaw);
const security = parseItems(securityRaw);

const hasNewNotes =
	added.length + changed.length + fixed.length + security.length > 0;

if (!hasNewNotes && !hasExistingEntries) {
	cancel(
		"At least one changelog entry is required before publishing an rc. Re-run pnpm rc and add notes.",
	);
	process.exit(1);
}

if (hasNewNotes) {
	const today = new Date().toISOString().slice(0, 10);
	const notes = {
		...(added.length ? { added } : {}),
		...(changed.length ? { changed } : {}),
		...(fixed.length ? { fixed } : {}),
		...(security.length ? { security } : {}),
	};
	appendRcNotes(nextVersion, today, notes);
	log.success("Changelog notes saved to src/releases/changelog.yaml");
} else {
	log.info("No new notes — using existing changelog entries.");
}

// ─── Confirm publish ─────────────────────────────────────────────────────────
const tag = `v${nextVersion}`;

const publishOk = await confirm({
	message: `Commit, publish to npm, then push ${tag} to GitHub?`,
});

if (!publishOk || publishOk === Symbol.for("cancel")) {
	cancel("Aborted.");
	process.exit(0);
}

// ─── Commit + push code ───────────────────────────────────────────────────────
log.step("git commit");
execSync(`git add ${pkgPath} src/releases/changelog.yaml`, {
	stdio: "inherit",
});
execSync(`git commit -m "chore: rc ${tag}"`, { stdio: "inherit" });

log.step("git push");
execSync("git push", { stdio: "inherit" });

// ─── Publish to npm ───────────────────────────────────────────────────────────
log.step("pnpm publish --access public --tag rc");
execSync("pnpm publish --access public --tag rc", { stdio: "inherit" });

// ─── Tag + push to GitHub (only after npm publish succeeded) ──────────────────
log.step(`git tag ${tag}`);
execSync(`git tag ${tag}`, { stdio: "inherit" });

log.step("git push --tags");
execSync("git push --tags", { stdio: "inherit" });

// ─── Sync GitHub releases (register the new rc) ───────────────────────────────
await syncGithubReleases(name);

// ─── Done ────────────────────────────────────────────────────────────────────
outro(`${name}@${nextVersion} published as rc`);
console.log(`  Test:              npx totopo@rc`);
console.log(`  Promote to latest: pnpm rc:promote`);
console.log("");
