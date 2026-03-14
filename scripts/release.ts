// =============================================================================
// release.ts — promote rc to latest
// Usage: pnpm release  (run from host, not inside container)
//
// Strips the -rc-N suffix from the current version, updates package.json,
// commits, tags, pushes, and publishes as latest.
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

const currentVersion = pkg.version;
const baseVersion = currentVersion.replace(/-rc-\d+$/, "");
const isRc = currentVersion !== baseVersion;

intro(`${name} — release`);

// ─── Verify an rc was published ──────────────────────────────────────────────
if (isRc) {
	log.info(
		`Current version: ${currentVersion} → will release as ${baseVersion}`,
	);
} else {
	log.info(
		`Current version: ${currentVersion} (no rc suffix — releasing as-is)`,
	);
}

// ─── Check registry ──────────────────────────────────────────────────────────
log.step(`Checking npm registry...`);

const probe = spawnSync("npm", ["view", name, "versions", "--json"], {
	encoding: "utf8",
	stdio: "pipe",
});

let allVersions: string[] = [];
try {
	const parsed = JSON.parse(probe.stdout.trim());
	allVersions = Array.isArray(parsed) ? parsed : [parsed];
} catch {
	// no versions yet
}

if (allVersions.includes(baseVersion)) {
	log.error(`${name}@${baseVersion} is already published on npm.`);
	log.message("Bump the version in package.json before releasing.");
	process.exit(1);
}

const rcVersions = allVersions.filter((v) =>
	v.startsWith(`${baseVersion}-rc-`),
);
if (rcVersions.length === 0 && isRc) {
	log.warn(
		`No rc versions found for ${baseVersion} — are you sure this was tested?`,
	);
}

// ─── Confirm ─────────────────────────────────────────────────────────────────
const ok = await confirm({
	message: `Publish ${name}@${baseVersion} as latest?`,
});

if (!ok || ok === Symbol.for("cancel")) {
	cancel("Aborted.");
	process.exit(0);
}

// ─── Bump package.json ───────────────────────────────────────────────────────
pkg.version = baseVersion;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
log.success(`package.json → ${baseVersion}`);

// ─── Commit ──────────────────────────────────────────────────────────────────
execSync(`git add ${pkgPath}`, { stdio: "inherit" });
execSync(`git commit -m "chore: release v${baseVersion}"`, {
	stdio: "inherit",
});

// ─── Tag + push ──────────────────────────────────────────────────────────────
const tag = `v${baseVersion}`;

log.step("git push");
execSync("git push", { stdio: "inherit" });

log.step(`git tag ${tag}`);
execSync(`git tag ${tag}`, { stdio: "inherit" });

log.step("git push --tags");
execSync("git push --tags", { stdio: "inherit" });

// ─── Publish ─────────────────────────────────────────────────────────────────
log.step("pnpm publish --access public");
execSync("pnpm publish --access public", { stdio: "inherit" });

// ─── Done ────────────────────────────────────────────────────────────────────
outro(`${name}@${baseVersion} published as latest`);
console.log(`  Verify: https://www.npmjs.com/package/${name}`);
console.log(`  Test:   npx ${name}`);
console.log("");
