// =============================================================================
// rc.ts — publish a release candidate
// Usage: pnpm rc  (run from host, not inside container)
//
// Determines the correct next rc version by checking the npm registry,
// aligns package.json to match, then commits, tags, pushes, and publishes.
//
// Version alignment rules:
//   - Base version already released (e.g. 0.1.3 in registry) → bump patch → 0.1.4-rc-1
//   - Registry has 0.1.4-rc-5 as latest rc → next is always 0.1.4-rc-6
//     regardless of what package.json currently says
// =============================================================================

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cancel, confirm, intro, log, outro } from "@clack/prompts";

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

// ─── Confirm publish ─────────────────────────────────────────────────────────
const tag = `v${nextVersion}`;

const publishOk = await confirm({
	message: `Commit, push, tag ${tag}, and publish as rc?`,
});

if (!publishOk || publishOk === Symbol.for("cancel")) {
	cancel("Aborted.");
	process.exit(0);
}

// ─── Commit ──────────────────────────────────────────────────────────────────
log.step(`git commit`);
execSync(`git add ${pkgPath}`, { stdio: "inherit" });
execSync(`git commit -m "chore: rc ${tag}"`, { stdio: "inherit" });

// ─── Tag + push ──────────────────────────────────────────────────────────────
log.step("git push");
execSync("git push", { stdio: "inherit" });

log.step(`git tag ${tag}`);
execSync(`git tag ${tag}`, { stdio: "inherit" });

log.step("git push --tags");
execSync("git push --tags", { stdio: "inherit" });

// ─── Publish ─────────────────────────────────────────────────────────────────
log.step("pnpm publish --access public --tag rc");
execSync("pnpm publish --access public --tag rc", { stdio: "inherit" });

// ─── Done ────────────────────────────────────────────────────────────────────
outro(`${name}@${nextVersion} published as rc`);
console.log(`  Test:              npx totopo@rc`);
console.log(`  Promote to latest: pnpm rc:promote`);
console.log("");
