// =========================================================================================================================================
// changelog-utils.ts — read/write/query src/releases/changelog.yaml
// =========================================================================================================================================

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHANGELOG_PATH = path.join(__dirname, "changelog.yaml");

// ─── Types ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReleaseEntry {
    version: string;
    date: string;
    added?: string[];
    changed?: string[];
    fixed?: string[];
    security?: string[];
}

export interface RcEntry {
    rc_version: string;
    date: string;
    added?: string[];
    changed?: string[];
    fixed?: string[];
    security?: string[];
}

export interface InProgress {
    base_version: string;
    entries: RcEntry[];
}

export interface Changelog {
    releases: ReleaseEntry[];
    in_progress: InProgress;
}

// ─── Read / Write ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function readChangelog(): Changelog {
    const raw = readFileSync(CHANGELOG_PATH, "utf8");
    return yaml.load(raw) as Changelog;
}

export function writeChangelog(data: Changelog): void {
    const out = yaml.dump(data, {
        lineWidth: 120,
        quotingType: '"',
        forceQuotes: false,
        noRefs: true,
    });
    writeFileSync(CHANGELOG_PATH, out, "utf8");
}

// ─── Append rc notes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RcNotes {
    added?: string[];
    changed?: string[];
    fixed?: string[];
    security?: string[];
}

export function appendRcNotes(rcVersion: string, date: string, notes: RcNotes): void {
    const data = readChangelog();
    const entry: RcEntry = { rc_version: rcVersion, date, ...notes };
    data.in_progress.entries.push(entry);
    writeChangelog(data);
}

// ─── Squash rc entries and promote ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function squashAndPromote(baseVersion: string, date: string): ReleaseEntry {
    const data = readChangelog();

    if (data.in_progress.base_version !== baseVersion) {
        throw new Error(`changelog.yaml in_progress.base_version is ${data.in_progress.base_version}, expected ${baseVersion}`);
    }

    if (data.in_progress.entries.length === 0) {
        throw new Error("changelog.yaml has no entries for this release. Run pnpm rc and add notes first.");
    }

    // Combine all rc entries by category (preserve order, skip duplicates)
    const combined: Record<string, string[]> = {};
    for (const category of ["added", "changed", "fixed", "security"] as const) {
        const seen = new Set<string>();
        const items: string[] = [];
        for (const entry of data.in_progress.entries) {
            for (const item of (Array.isArray(entry[category]) ? entry[category] : [])) {
                if (!seen.has(item)) {
                    seen.add(item);
                    items.push(item);
                }
            }
        }
        if (items.length > 0) combined[category] = items;
    }

    const promoted: ReleaseEntry = { version: baseVersion, date, ...combined };

    // Prepend to releases, clear in_progress entries
    data.releases.unshift(promoted);
    data.in_progress.base_version = bumpPatch(baseVersion);
    data.in_progress.entries = [];

    writeChangelog(data);
    return promoted;
}

// ─── Get release notes for a specific version ────────────────────────────────────────────────────────────────────────────────────────────

// Returns Markdown-formatted release notes for the given version, or a bare fallback string if not found
export function getReleaseNotes(version: string): string {
    const data = readChangelog();
    const entry = data.releases.find((r) => r.version === version);
    if (!entry) return `Release v${version}`;

    const lines: string[] = [];
    if (entry.added?.length) {
        lines.push("### Added\n");
        for (const item of entry.added) lines.push(`- ${item}`);
        lines.push("");
    }
    if (entry.changed?.length) {
        lines.push("### Changed\n");
        for (const item of entry.changed) lines.push(`- ${item}`);
        lines.push("");
    }
    if (entry.fixed?.length) {
        lines.push("### Fixed\n");
        for (const item of entry.fixed) lines.push(`- ${item}`);
        lines.push("");
    }
    if (entry.security?.length) {
        lines.push("### Security\n");
        for (const item of entry.security) lines.push(`- ${item}`);
        lines.push("");
    }
    return lines.join("\n").trim();
}

// ─── npm registry polling ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";

/**
 * Poll the npm registry until `version` appears, then resolve.
 * Rejects if the version doesn't appear within `timeoutMs`.
 */
export async function waitForNpmVersion(
    packageName: string,
    version: string,
    { intervalMs = 2000, timeoutMs = 30000 } = {},
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const r = spawnSync("npm", ["view", packageName, "versions", "--json"], {
            encoding: "utf8",
            stdio: "pipe",
        });
        try {
            const parsed = JSON.parse(r.stdout.trim());
            const versions: string[] = Array.isArray(parsed) ? parsed : [parsed];
            if (versions.includes(version)) return;
        } catch {
            // registry temporarily unreachable — keep polling
        }
        await new Promise((res) => setTimeout(res, intervalMs));
    }
    throw new Error(`Timed out waiting for ${packageName}@${version} to appear in npm registry`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Increments the patch segment of a semver string (e.g. "0.1.4" → "0.1.5")
export function bumpPatch(v: string): string {
    const parts = v.split(".");
    parts[2] = String(Number(parts[2]) + 1);
    return parts.join(".");
}

export function gitTagExistsLocally(tag: string): boolean {
    const r = spawnSync("git", ["tag", "-l", tag], { encoding: "utf8", stdio: "pipe" });
    return r.stdout.trim() === tag;
}

export function gitTagExistsOnRemote(tag: string): boolean {
    const r = spawnSync("git", ["ls-remote", "--tags", "origin", tag], { encoding: "utf8", stdio: "pipe" });
    return r.stdout.trim().length > 0;
}

export { CHANGELOG_PATH };
