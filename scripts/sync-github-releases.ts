// =============================================================================
// sync-github-releases.ts — align GitHub releases with npm registry
// Usage: pnpm tsx scripts/sync-github-releases.ts
//        or import { syncGithubReleases } from "./sync-github-releases.js"
//
// Fetches all published npm versions and all existing GitHub releases,
// then creates any GitHub releases that are missing. Safe to run repeatedly.
// Skips gracefully if gh CLI is not available.
// =============================================================================

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { log } from "@clack/prompts";

function run(cmd: string, args: string[]): { stdout: string; ok: boolean } {
	const r = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe" });
	return { stdout: r.stdout?.trim() ?? "", ok: r.status === 0 };
}

function changelogSection(version: string): string {
	if (!existsSync("CHANGELOG.md")) return "";
	const lines = readFileSync("CHANGELOG.md", "utf8").split("\n");
	let found = false;
	const section: string[] = [];
	for (const line of lines) {
		if (line.startsWith(`## [${version}]`)) {
			found = true;
			continue;
		}
		if (found && line.startsWith("## [")) break;
		if (found) section.push(line);
	}
	return section.join("\n").trim();
}

export async function syncGithubReleases(packageName: string): Promise<void> {
	// ── Check gh availability ──────────────────────────────────────────────────
	const ghCheck = run("gh", ["--version"]);
	if (!ghCheck.ok) {
		log.warn("gh CLI not found — skipping GitHub release sync");
		log.message("Install from https://cli.github.com/ to automate this step.");
		return;
	}

	// ── Fetch npm versions ─────────────────────────────────────────────────────
	const npmResult = run("npm", ["view", packageName, "versions", "--json"]);
	let npmVersions: string[] = [];
	try {
		const parsed = JSON.parse(npmResult.stdout);
		npmVersions = Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		log.warn("Could not fetch npm versions — skipping GitHub release sync");
		return;
	}

	// ── Fetch existing GitHub releases ─────────────────────────────────────────
	const ghResult = run("gh", [
		"release",
		"list",
		"--limit",
		"100",
		"--json",
		"tagName",
	]);
	let ghTags = new Set<string>();
	try {
		const releases = JSON.parse(ghResult.stdout) as { tagName: string }[];
		ghTags = new Set(releases.map((r) => r.tagName));
	} catch {
		log.warn("Could not fetch GitHub releases — skipping sync");
		return;
	}

	// ── Find missing releases ──────────────────────────────────────────────────
	const missing = npmVersions.filter((v) => !ghTags.has(`v${v}`));

	if (missing.length === 0) {
		log.success("GitHub releases are in sync with npm");
		return;
	}

	log.step(
		`Creating ${missing.length} missing GitHub release(s): ${missing.join(", ")}`,
	);

	for (const version of missing) {
		const tag = `v${version}`;
		const isRc = /-rc-\d+$/.test(version);
		const baseVersion = version.replace(/-rc-\d+$/, "");
		const notes = isRc
			? `Release candidate for ${baseVersion}`
			: changelogSection(version) || `Release ${tag}`;

		const args = [
			"release",
			"create",
			tag,
			"--title",
			tag,
			"--notes",
			notes,
			...(isRc ? ["--prerelease"] : []),
		];

		const result = spawnSync("gh", args, { encoding: "utf8", stdio: "pipe" });
		if (result.status === 0) {
			log.success(`Created GitHub release ${tag}`);
		} else {
			log.warn(
				`Failed to create GitHub release ${tag}: ${result.stderr?.trim()}`,
			);
		}
	}
}

// ── Standalone entrypoint ──────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
	name: string;
};
await syncGithubReleases(pkg.name);
