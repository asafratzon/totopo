// =============================================================================
// release.ts — promote rc to latest
// Usage: pnpm rc:promote  (run from host, not inside container)
//
// Reads the current rc version from the npm registry, strips the
// -rc-N suffix, updates package.json, commits, tags, pushes, and publishes
// as latest.
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

intro(`${name} — promote rc to latest`);
log.message(
	"Make sure you are logged in to npm before proceeding (npm whoami).",
);

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

const latestRcVersion = distTags["rc"];

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

// ─── Confirm ─────────────────────────────────────────────────────────────────
const ok = await confirm({
	message: `Publish ${name}@${baseVersion} as latest?`,
});

if (!ok || ok === Symbol.for("cancel")) {
	cancel("Aborted.");
	process.exit(0);
}

// ─── Update package.json ─────────────────────────────────────────────────────
pkg.version = baseVersion;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
log.success(`package.json → ${baseVersion}`);

// ─── Commit ──────────────────────────────────────────────────────────────────
const tag = `v${baseVersion}`;

log.step("git commit");
execSync(`git add ${pkgPath}`, { stdio: "inherit" });
execSync(`git commit -m "chore: release ${tag}"`, { stdio: "inherit" });

// ─── Tag + push ──────────────────────────────────────────────────────────────
log.step("git push");
execSync("git push", { stdio: "inherit" });

log.step(`git tag ${tag}`);
execSync(`git tag ${tag}`, { stdio: "inherit" });

log.step("git push --tags");
execSync("git push --tags", { stdio: "inherit" });

// ─── Publish ─────────────────────────────────────────────────────────────────
log.step("pnpm publish --access public");
execSync("pnpm publish --access public", { stdio: "inherit" });

// ─── Remove rc tag ───────────────────────────────────────────────────────────
log.step(`Removing rc tag from npm registry...`);
execSync(`npm dist-tag rm ${name} rc`, { stdio: "inherit" });
log.success("rc tag removed — npx totopo@rc will no longer resolve");

// ─── Done ────────────────────────────────────────────────────────────────────
outro(`${name}@${baseVersion} published as latest`);
console.log(`  Verify: https://www.npmjs.com/package/${name}`);
console.log(`  Test:   npx ${name}`);
console.log("");
