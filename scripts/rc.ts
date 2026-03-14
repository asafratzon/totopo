// =============================================================================
// rc.ts — publish a release candidate
// Usage: pnpm rc  (run from host, not inside container)
// =============================================================================

import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cancel, confirm, intro, log, outro } from "@clack/prompts";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
	name: string;
	version: string;
};
const { name, version } = pkg;
const tag = `v${version}`;

intro(`${name} — release candidate`);

// ─── Check registry ──────────────────────────────────────────────────────────
log.step(`Checking npm registry for ${name}@${version}...`);

const probe = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
	encoding: "utf8",
	stdio: "pipe",
});
const published = probe.stdout.trim();

if (published === version) {
	log.error(`${name}@${version} is already published on npm.`);
	log.message("Bump the version in package.json before publishing.");
	process.exit(1);
}

log.success(`${name}@${version} not yet published — good to go`);

// ─── Confirm ─────────────────────────────────────────────────────────────────
const ok = await confirm({
	message: `Push + tag ${tag} + publish as rc?`,
});

if (!ok || ok === Symbol.for("cancel")) {
	cancel("Aborted.");
	process.exit(0);
}

// ─── Release steps ───────────────────────────────────────────────────────────
log.step("git push");
execSync("git push", { stdio: "inherit" });

log.step(`git tag ${tag}`);
execSync(`git tag ${tag}`, { stdio: "inherit" });

log.step("git push --tags");
execSync("git push --tags", { stdio: "inherit" });

log.step("pnpm publish --access public --tag rc");
execSync("pnpm publish --access public --tag rc", { stdio: "inherit" });

// ─── Done ────────────────────────────────────────────────────────────────────
outro(`${name}@${version} published as rc`);

console.log("  Test:            npx totopo@rc");
console.log(`  Promote to latest: npm dist-tag add ${name}@${version} latest`);
console.log("");
