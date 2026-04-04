// =========================================================================================================================================
// check.ts - pre-release health checks
// Usage: pnpm check
//
// Runs before every commit (via .githooks/pre-commit) and before pnpm rc.
// Add new checks here as the project grows.
// =========================================================================================================================================

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readChangelog, validateChangelog } from "./changelog-utils.ts";

let errors = 0;

const pass = (label: string, detail?: string) => console.log(`\x1b[32m✓\x1b[0m ${label.padEnd(36)}\x1b[2m${detail ?? ""}\x1b[0m`);

const fail = (label: string, detail: string) => {
    console.log(`\x1b[31m✗\x1b[0m ${label.padEnd(36)}${detail}`);
    errors++;
};

console.log("\n\x1b[1mtotopo — pre-release checks\x1b[0m\n");

// =========================================================================================================================================
// Helpers: file collection
// =========================================================================================================================================

// Collects all files with the given extensions recursively under a directory
function collectSourceFiles(dir: string, exts: string[]): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            results.push(...collectSourceFiles(fullPath, exts));
        } else if (exts.some((ext) => entry.endsWith(ext))) {
            results.push(fullPath);
        }
    }
    return results;
}

const sourceFiles = [
    ...collectSourceFiles("src", [".ts", ".js"]),
    ...collectSourceFiles("bin", [".ts", ".js"]),
    ...collectSourceFiles("scripts", [".ts", ".js"]),
    ...collectSourceFiles("tests", [".ts", ".js"]),
];

// =========================================================================================================================================
// Check: divider line normalization (auto-fix)
// Detects comment lines that are purely decorative dividers (---, ===, etc.),
// normalizes special box-drawing chars to plain ASCII, and pads to 140 chars.
// Auto-fixes in place, then fails the check so diffs can be reviewed.
// =========================================================================================================================================

// Returns true if a comment line is a divider (starts or ends with 3+ dash/equals chars)
function isDividerLine(line: string): boolean {
    const content = line.replace(/^\s*\/\//, "").trim();
    return /^[-─═=]{3,}/.test(content) || /[-─═=]{3,}$/.test(content);
}

// Normalizes a divider line: replaces box-drawing chars and pads to exactly 140 chars
function normalizeDividerLine(line: string): string {
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? (indentMatch[1] ?? "") : "";
    const afterSlashes = line.slice(indent.length + 2); // Skip `//`

    // Replace box-drawing dash chars with plain ASCII equivalents
    const normalized = afterSlashes.replace(/─/g, "-").replace(/═/g, "=");

    // Determine fill char: whichever dash type appears more; default to `-`
    const dashCount = (normalized.match(/-/g) ?? []).length;
    const eqCount = (normalized.match(/=/g) ?? []).length;
    const fillChar = eqCount > dashCount ? "=" : "-";

    const base = `${indent}//${normalized.trimEnd()}`;
    const padNeeded = Math.max(0, 140 - base.length);
    return base + fillChar.repeat(padNeeded);
}

const dividerFixes: string[] = [];

for (const filePath of sourceFiles) {
    const original = readFileSync(filePath, "utf8");
    const lines = original.split("\n");
    let changed = false;
    let insideTemplateLiteral = false;

    const fixedLines = lines.map((line, idx) => {
        // Track template literal boundaries to avoid modifying Dockerfile/shell content inside String.raw``
        const backtickCount = (line.match(/`/g) ?? []).length;
        if (backtickCount % 2 !== 0) insideTemplateLiteral = !insideTemplateLiteral;

        if (insideTemplateLiteral || !isDividerLine(line)) return line;
        const fixed = normalizeDividerLine(line);
        if (fixed !== line) {
            dividerFixes.push(`  ${filePath}:${idx + 1}`);
            changed = true;
        }
        return fixed;
    });

    if (changed) {
        writeFileSync(filePath, fixedLines.join("\n"), "utf8");
    }
}

if (dividerFixes.length > 0) {
    fail(
        "divider lines normalized",
        `\n\n  [auto-fixed] ${dividerFixes.length} divider line(s) normalized to 140 chars:\n${dividerFixes.join("\n")}\n\n  Review the changes above, then re-stage and commit.\n`,
    );
} else {
    pass("divider lines", "all clean");
}

// =============================================================================
// Check: special characters in comments (flag only, no auto-fix)
// Scans comment lines for non-ASCII directional and typographic chars that
// should not appear in source code. String literals are exempt.
// =============================================================================

// Characters that must not appear in comments or non-string code
const SPECIAL_CHAR_PATTERN = /[→←—·]/u;

// Extracts comment text from a line (inline or full-line comment)
function extractCommentText(line: string): string | null {
    // Full-line comment
    if (/^\s*\/\//.test(line)) {
        return line.replace(/^\s*\/\//, "");
    }
    // Inline comment: find `//` not inside a string (simplified heuristic)
    const inlineMatch = line.match(/(?:^|[^"'`])\/\/(.*)$/);
    return inlineMatch ? (inlineMatch[1] ?? null) : null;
}

const specialCharViolations: string[] = [];

for (const filePath of sourceFiles) {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const commentText = extractCommentText(line);
        if (commentText && SPECIAL_CHAR_PATTERN.test(commentText)) {
            specialCharViolations.push(`  ${filePath}:${i + 1}  ${line.trim()}`);
        }
    }
}

if (specialCharViolations.length > 0) {
    fail(
        "special chars in comments",
        `\n\n  [error] special characters found in comment lines:\n${specialCharViolations.join("\n")}\n\n  Fix these manually, then re-stage and commit.\n`,
    );
} else {
    pass("special chars in comments", "all clean");
}

// =========================================================================================================================================
// Check: changelog.yaml structure
// =========================================================================================================================================

try {
    const data = readChangelog();
    validateChangelog(data);
    const count = data.in_progress.entries.length;
    pass("changelog.yaml structure", count > 0 ? `${count} in-progress entry/entries` : "no in-progress entries");
} catch (e) {
    fail("changelog.yaml structure", e instanceof Error ? e.message : String(e));
}

// =========================================================================================================================================
// Check: no rc versions in releases
// =========================================================================================================================================

try {
    const data = readChangelog();
    const rcInReleases = data.releases.filter((r) => r.version.includes("-rc-"));
    if (rcInReleases.length > 0) {
        const versions = rcInReleases.map((r) => r.version).join(", ");
        fail("no rc versions in releases", `rc entries belong in in_progress.entries, not releases: ${versions}`);
    } else {
        pass("no rc versions in releases");
    }
} catch (e) {
    fail("no rc versions in releases", e instanceof Error ? e.message : String(e));
}

// =========================================================================================================================================
// Summary
// =========================================================================================================================================

if (errors === 0) {
    console.log(`\n\x1b[32m\u25cf\x1b[0m \x1b[1mAll checks passed.\x1b[0m\n`);
} else {
    console.log(`\n\x1b[31m\u25cf\x1b[0m \x1b[1m${errors} check(s) failed.\x1b[0m\n`);
    process.exit(1);
}
