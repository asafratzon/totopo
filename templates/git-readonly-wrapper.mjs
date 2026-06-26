#!/usr/bin/env node
// =============================================================================
// git-readonly-wrapper.mjs -- Read-only git wrapper for strict mode
// Baked into the container image at /usr/local/share/totopo/git-readonly.
// startup.mjs symlinks /usr/local/bin/git -> this file when git_mode=strict.
// PATH puts /usr/local/bin before /usr/bin so this is invoked when an agent
// runs `git`. Allowed subcommands forward to /usr/bin/git unchanged; blocked
// ones print a clear error and exit non-zero.
//
// Threat model: guardrails for cooperative agents, not adversarial containment.
// /usr/bin/git remains accessible by absolute path; remote ops stay blocked at
// the gitconfig protocol layer regardless of which binary is invoked.
//
// The classifier is exported for unit testing. Pure Node built-ins, no deps.
// =============================================================================

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REAL_GIT = "/usr/bin/git";

// -- Read-only global actions: print and exit, no subcommand needed -----------
const READ_ONLY_GLOBAL_ACTIONS = new Set(["--version", "--help", "-h", "--html-path", "--man-path", "--info-path"]);

// -- Global flags that consume the next argv element as their value -----------
const TWO_ARG_GLOBALS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source"]);

// -- Subcommands that are unconditionally read-only ---------------------------
const READ_SUBCOMMANDS = new Set([
    "status",
    "log",
    "show",
    "diff",
    "blame",
    "reflog",
    "rev-parse",
    "rev-list",
    "describe",
    "cat-file",
    "name-rev",
    "fsck",
    "shortlog",
    "grep",
    "count-objects",
    "var",
    "help",
    "version",
    "ls-files",
    "ls-tree",
    "merge-base",
    "for-each-ref",
    "show-ref",
    "symbolic-ref",
    "check-ignore",
    "check-attr",
    "check-mailmap",
    "check-ref-format",
    "whatchanged",
    "cherry",
    "range-diff",
    "verify-commit",
    "verify-tag",
    "annotate",
    "instaweb",
    "diff-tree",
    "diff-index",
    "diff-files",
]);

// -- branch/tag flags that indicate mutation; block on any match --------------
const BRANCH_MUTATING_FLAGS = new Set([
    "-d",
    "-D",
    "-m",
    "-M",
    "-c",
    "-C",
    "--delete",
    "--move",
    "--copy",
    "--set-upstream",
    "--set-upstream-to",
    "--unset-upstream",
    "--edit-description",
    "--create-reflog",
]);

const TAG_MUTATING_FLAGS = new Set([
    "-d",
    "-D",
    "-m",
    "-a",
    "-s",
    "-u",
    "-f",
    "--delete",
    "--message",
    "--annotate",
    "--sign",
    "--local-user",
    "--cleanup",
    "--force",
]);

// -- config flags: explicit read/write markers + flags that consume the next arg ----
const CONFIG_READ_FLAGS = new Set([
    "--get",
    "--get-all",
    "--get-regexp",
    "--get-urlmatch",
    "--get-color",
    "--get-colorbool",
    "--list",
    "-l",
    "--show-origin",
    "--show-scope",
    "--name-only",
]);
const CONFIG_WRITE_FLAGS = new Set([
    "--unset",
    "--unset-all",
    "--add",
    "--replace-all",
    "--remove-section",
    "--rename-section",
    "-e",
    "--edit",
]);
// Flags that take their next arg as a value -- skip the value when counting tokens.
// --file/-f/--blob = scope; --type = value coercion; --default = fallback for --get.
const CONFIG_TWO_ARG_FLAGS = new Set(["--file", "-f", "--blob", "--type", "--default"]);
// Keys whose write form is allowed in strict mode. Narrow by design: each entry must be
// safe (cannot escalate to remote ops or weaken protocol.allow). core.hooksPath unblocks
// `pnpm install` for repos whose prepare script points git at a tracked hooks directory.
// Compared lowercased: git treats section/variable names case-insensitively.
const CONFIG_WRITE_ALLOWLIST = new Set(["core.hookspath"]);

// -- remote: block these subactions, allow the rest (default = list) ----------
const REMOTE_MUTATING_ACTIONS = new Set(["add", "remove", "rm", "rename", "set-url", "prune", "update", "set-head", "set-branches"]);

// -- stash: only these subactions are read-only; bare `git stash` mutates -----
const STASH_READ_ACTIONS = new Set(["list", "show"]);

// -- worktree: only `list` is read-only ---------------------------------------
const WORKTREE_READ_ACTIONS = new Set(["list"]);

// -- notes: list/show are read; bare `git notes` defaults to list -------------
const NOTES_READ_ACTIONS = new Set(["list", "show", "get-ref"]);

// -- bisect: log/view are read; everything else mutates the bisect state ------
const BISECT_READ_ACTIONS = new Set(["log", "view"]);

/**
 * Walk argv left-to-right and find the first non-flag token (the subcommand).
 * Skips git's global option flags, including ones whose value is in the next argv slot.
 * Returns { subcmd, rest } where rest is the args after the subcommand.
 */
export function findSubcommand(argv) {
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        if (!arg.startsWith("-")) {
            return { subcmd: arg, rest: argv.slice(i + 1) };
        }
        if (TWO_ARG_GLOBALS.has(arg)) {
            // -c key=value, -C path, --git-dir path, etc.
            i += 2;
            continue;
        }
        // --foo=bar, --bare, --no-pager, --paginate, etc. - one-arg
        i += 1;
    }
    return { subcmd: null, rest: [] };
}

/**
 * Classify a git invocation under strict mode.
 * Returns { allow: true } or { allow: false, reason: string }.
 * Pure function - exported for unit testing without forking.
 */
export function classify(argv) {
    // Read-only global actions (--version, --help, etc.) short-circuit.
    for (const a of argv) {
        if (READ_ONLY_GLOBAL_ACTIONS.has(a)) return { allow: true };
        if (a.startsWith("--list-cmds=")) return { allow: true };
    }

    const { subcmd, rest } = findSubcommand(argv);

    // Bare `git` (no subcommand) prints usage - read-only.
    if (subcmd === null) return { allow: true };

    if (READ_SUBCOMMANDS.has(subcmd)) return { allow: true };

    if (subcmd === "branch") {
        for (const a of rest) {
            if (BRANCH_MUTATING_FLAGS.has(a)) return blocked(`branch ${a}`);
        }
        return { allow: true };
    }

    if (subcmd === "tag") {
        for (const a of rest) {
            if (TAG_MUTATING_FLAGS.has(a)) return blocked(`tag ${a}`);
        }
        return { allow: true };
    }

    if (subcmd === "config") {
        // Explicit write flags take precedence over everything else.
        for (const a of rest) {
            if (CONFIG_WRITE_FLAGS.has(a)) return blocked(`config ${a}`);
        }
        // Explicit read flags are an unconditional allow.
        for (const a of rest) {
            if (CONFIG_READ_FLAGS.has(a)) return { allow: true };
        }
        // Otherwise count non-flag tokens after the subcommand:
        //   `config <key>`           -> 1 token  -> read
        //   `config <key> <value>`   -> 2 tokens -> write (allowed only if key is in allowlist)
        // Scope flags (--system, --global, ...) are flags and don't count.
        let nonFlagCount = 0;
        let firstKey = null;
        for (let i = 0; i < rest.length; i++) {
            const a = rest[i];
            if (a.startsWith("-")) {
                if (CONFIG_TWO_ARG_FLAGS.has(a)) i++; // also consume its value
                continue;
            }
            nonFlagCount++;
            if (nonFlagCount === 1) firstKey = a;
            if (nonFlagCount >= 2) {
                if (firstKey !== null && CONFIG_WRITE_ALLOWLIST.has(firstKey.toLowerCase())) return { allow: true };
                return blocked("config (write)");
            }
        }
        return { allow: true };
    }

    if (subcmd === "stash") {
        const action = firstNonFlag(rest);
        if (action !== null && STASH_READ_ACTIONS.has(action)) return { allow: true };
        return blocked(action ? `stash ${action}` : "stash");
    }

    if (subcmd === "remote") {
        const action = firstNonFlag(rest);
        if (action !== null && REMOTE_MUTATING_ACTIONS.has(action)) return blocked(`remote ${action}`);
        return { allow: true };
    }

    if (subcmd === "worktree") {
        const action = firstNonFlag(rest);
        if (action !== null && WORKTREE_READ_ACTIONS.has(action)) return { allow: true };
        return blocked(action ? `worktree ${action}` : "worktree");
    }

    if (subcmd === "notes") {
        const action = firstNonFlag(rest);
        if (action === null || NOTES_READ_ACTIONS.has(action)) return { allow: true };
        return blocked(`notes ${action}`);
    }

    if (subcmd === "bisect") {
        const action = firstNonFlag(rest);
        if (action !== null && BISECT_READ_ACTIONS.has(action)) return { allow: true };
        return blocked(action ? `bisect ${action}` : "bisect");
    }

    return blocked(subcmd);
}

function firstNonFlag(args) {
    for (const a of args) {
        if (!a.startsWith("-")) return a;
    }
    return null;
}

function blocked(label) {
    return {
        allow: false,
        reason: `git: '${label}' blocked in strict mode (read-only). Switch git mode via 'totopo' menu > Settings > Git mode.`,
    };
}

// Skip the runtime invocation when imported (e.g. by the test suite). The wrapper is normally
// invoked through the symlink at /usr/local/bin/git, so a literal argv[1] vs import.meta.url
// comparison wouldn't match -- realpathSync resolves the symlink before comparing.
function detectIsMain() {
    if (!process.argv[1]) return false;
    try {
        return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
    } catch {
        return false;
    }
}
const isMain = detectIsMain();

if (isMain) {
    const result = classify(process.argv.slice(2));
    if (!result.allow) {
        process.stderr.write(`${result.reason}\n`);
        process.exit(1);
    }
    const child = spawnSync(REAL_GIT, process.argv.slice(2), { stdio: "inherit" });
    process.exit(child.status ?? 1);
}
