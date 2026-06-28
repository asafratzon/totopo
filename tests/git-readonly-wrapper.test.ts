import assert from "node:assert/strict";
import { describe, test } from "node:test";
// The wrapper lives under templates/ (outside tsconfig include) and is intentionally
// self-contained ESM so the container can run it without bundling. Types are declared
// in tests/templates-modules.d.ts so the .mjs source stays plain JavaScript.
import { classify, findSubcommand } from "../templates/git-readonly-wrapper.mjs";

describe("findSubcommand", () => {
    test("plain subcommand", () => {
        assert.deepEqual(findSubcommand(["status"]), { subcmd: "status", rest: [] });
    });

    test("subcommand with args", () => {
        assert.deepEqual(findSubcommand(["log", "--oneline", "-n", "5"]), { subcmd: "log", rest: ["--oneline", "-n", "5"] });
    });

    test("skips -C path", () => {
        assert.deepEqual(findSubcommand(["-C", "/tmp", "status"]), { subcmd: "status", rest: [] });
    });

    test("skips -c key=value", () => {
        assert.deepEqual(findSubcommand(["-c", "core.hooksPath=/tmp", "commit"]), { subcmd: "commit", rest: [] });
    });

    test("skips multiple global two-arg flags", () => {
        assert.deepEqual(findSubcommand(["-c", "x=y", "-C", "/repo", "log"]), { subcmd: "log", rest: [] });
    });

    test("skips --git-dir <path> two-arg form", () => {
        assert.deepEqual(findSubcommand(["--git-dir", "/repo/.git", "status"]), { subcmd: "status", rest: [] });
    });

    test("skips --git-dir=<path> one-arg form", () => {
        assert.deepEqual(findSubcommand(["--git-dir=/repo/.git", "status"]), { subcmd: "status", rest: [] });
    });

    test("returns null subcommand when only flags", () => {
        assert.deepEqual(findSubcommand(["--no-pager"]), { subcmd: null, rest: [] });
    });

    test("returns null for empty argv", () => {
        assert.deepEqual(findSubcommand([]), { subcmd: null, rest: [] });
    });
});

describe("classify - read subcommands (allow)", () => {
    for (const cmd of ["status", "log", "show", "diff", "blame", "reflog", "rev-parse", "ls-files", "grep", "fsck", "describe"]) {
        test(`allows ${cmd}`, () => {
            assert.equal(classify([cmd]).allow, true);
        });
    }

    test("allows status with global flag prefix", () => {
        assert.equal(classify(["-c", "color.ui=always", "status"]).allow, true);
    });

    test("allows status with -C", () => {
        assert.equal(classify(["-C", "/workspace", "status"]).allow, true);
    });
});

describe("classify - mutating subcommands (block)", () => {
    for (const cmd of [
        "commit",
        "add",
        "reset",
        "checkout",
        "switch",
        "restore",
        "merge",
        "rebase",
        "revert",
        "cherry-pick",
        "fetch",
        "pull",
        "push",
        "clean",
        "rm",
        "mv",
        "apply",
        "am",
        "filter-branch",
        "update-ref",
        "pack-refs",
        "gc",
        "prune",
        "repack",
        "write-tree",
        "commit-tree",
        "hash-object",
        "update-index",
        "init",
        "clone",
    ]) {
        test(`blocks ${cmd}`, () => {
            const result = classify([cmd]);
            assert.equal(result.allow, false);
            if (!result.allow) assert.match(result.reason, /blocked in strict mode/);
        });
    }

    test("blocks commit even when prefixed with -c", () => {
        const result = classify(["-c", "core.hooksPath=/tmp", "commit", "-m", "x"]);
        assert.equal(result.allow, false);
    });
});

describe("classify - branch", () => {
    test("allows bare branch (lists)", () => {
        assert.equal(classify(["branch"]).allow, true);
    });

    test("allows branch --list", () => {
        assert.equal(classify(["branch", "--list"]).allow, true);
    });

    test("allows branch -a -v", () => {
        assert.equal(classify(["branch", "-a", "-v"]).allow, true);
    });

    test("blocks branch -d <name>", () => {
        const r = classify(["branch", "-d", "feature"]);
        assert.equal(r.allow, false);
        if (!r.allow) assert.match(r.reason, /branch -d/);
    });

    test("blocks branch -D <name>", () => {
        assert.equal(classify(["branch", "-D", "feature"]).allow, false);
    });

    test("blocks branch -m <new>", () => {
        assert.equal(classify(["branch", "-m", "renamed"]).allow, false);
    });

    test("blocks branch --delete", () => {
        assert.equal(classify(["branch", "--delete", "feature"]).allow, false);
    });
});

describe("classify - tag", () => {
    test("allows bare tag (lists)", () => {
        assert.equal(classify(["tag"]).allow, true);
    });

    test("allows tag --list", () => {
        assert.equal(classify(["tag", "--list"]).allow, true);
    });

    test("blocks tag -a", () => {
        assert.equal(classify(["tag", "-a", "v1.0", "-m", "msg"]).allow, false);
    });

    test("blocks tag -d", () => {
        assert.equal(classify(["tag", "-d", "v1.0"]).allow, false);
    });
});

describe("classify - config", () => {
    test("allows config --get", () => {
        assert.equal(classify(["config", "--get", "user.email"]).allow, true);
    });

    test("allows config --list", () => {
        assert.equal(classify(["config", "--list"]).allow, true);
    });

    test("allows config -l", () => {
        assert.equal(classify(["config", "-l"]).allow, true);
    });

    test("allows config <key> (single-token read form)", () => {
        // The startup script needs this: `git config --system protocol.allow` is a read.
        assert.equal(classify(["config", "user.email"]).allow, true);
    });

    test("allows config --system <key> (read with scope flag)", () => {
        assert.equal(classify(["config", "--system", "protocol.allow"]).allow, true);
    });

    test("blocks config <key> <value> (write form)", () => {
        const r = classify(["config", "user.email", "x@y.com"]);
        assert.equal(r.allow, false);
        if (!r.allow) assert.match(r.reason, /config/);
    });

    test("blocks config --system <key> <value> (write with scope flag)", () => {
        assert.equal(classify(["config", "--system", "protocol.allow", "always"]).allow, false);
    });

    test("blocks config --unset", () => {
        assert.equal(classify(["config", "--unset", "user.email"]).allow, false);
    });

    test("blocks config --add", () => {
        assert.equal(classify(["config", "--add", "remote.origin.fetch", "+refs/heads/*"]).allow, false);
    });

    test("--file consumes its next arg when counting tokens", () => {
        // `config --file myconfig user.name` should be one logical non-flag (user.name) -> read.
        assert.equal(classify(["config", "--file", "myconfig", "user.name"]).allow, true);
    });

    test("--type two-arg form does not cause false-positive write detection", () => {
        // `config --type int user.maxAge` is a read; --type consumes "int".
        assert.equal(classify(["config", "--type", "int", "user.maxAge"]).allow, true);
    });

    test("--default two-arg form does not cause false-positive write detection", () => {
        // `config --default fallback user.email` is a read; --default consumes "fallback".
        assert.equal(classify(["config", "--default", "fallback", "user.email"]).allow, true);
    });

    test("allows config core.hooksPath <value> (allowlisted write for prepare scripts)", () => {
        assert.equal(classify(["config", "core.hooksPath", ".githooks"]).allow, true);
    });

    test("allows config core.hooksPath write regardless of key casing", () => {
        // Git treats section/variable names case-insensitively.
        assert.equal(classify(["config", "core.HooksPath", ".githooks"]).allow, true);
        assert.equal(classify(["config", "CORE.HOOKSPATH", ".githooks"]).allow, true);
    });

    test("allows config --local core.hooksPath <value>", () => {
        assert.equal(classify(["config", "--local", "core.hooksPath", ".githooks"]).allow, true);
    });

    test("still blocks config --unset core.hooksPath", () => {
        // Allowlist applies only to the implicit two-token write form.
        assert.equal(classify(["config", "--unset", "core.hooksPath"]).allow, false);
    });

    test("still blocks config protocol.allow always (allowlist does not weaken remote block)", () => {
        assert.equal(classify(["config", "protocol.allow", "always"]).allow, false);
    });
});

describe("classify - stash", () => {
    test("blocks bare stash (defaults to push)", () => {
        const r = classify(["stash"]);
        assert.equal(r.allow, false);
        if (!r.allow) assert.match(r.reason, /stash/);
    });

    test("blocks stash push", () => {
        assert.equal(classify(["stash", "push"]).allow, false);
    });

    test("allows stash list", () => {
        assert.equal(classify(["stash", "list"]).allow, true);
    });

    test("allows stash show", () => {
        assert.equal(classify(["stash", "show"]).allow, true);
    });
});

describe("classify - remote", () => {
    test("allows bare remote (lists)", () => {
        assert.equal(classify(["remote"]).allow, true);
    });

    test("allows remote -v", () => {
        assert.equal(classify(["remote", "-v"]).allow, true);
    });

    test("allows remote show origin", () => {
        assert.equal(classify(["remote", "show", "origin"]).allow, true);
    });

    test("blocks remote add", () => {
        assert.equal(classify(["remote", "add", "origin", "url"]).allow, false);
    });

    test("blocks remote set-url", () => {
        assert.equal(classify(["remote", "set-url", "origin", "url"]).allow, false);
    });
});

describe("classify - worktree", () => {
    test("allows worktree list", () => {
        assert.equal(classify(["worktree", "list"]).allow, true);
    });

    test("blocks worktree add", () => {
        assert.equal(classify(["worktree", "add", "/tmp/wt", "branch"]).allow, false);
    });

    test("blocks bare worktree", () => {
        assert.equal(classify(["worktree"]).allow, false);
    });
});

describe("classify - bisect", () => {
    test("allows bisect log", () => {
        assert.equal(classify(["bisect", "log"]).allow, true);
    });

    test("allows bisect view", () => {
        assert.equal(classify(["bisect", "view"]).allow, true);
    });

    test("blocks bisect start", () => {
        assert.equal(classify(["bisect", "start"]).allow, false);
    });
});

describe("classify - global read-only actions", () => {
    test("allows --version", () => {
        assert.equal(classify(["--version"]).allow, true);
    });

    test("allows --help", () => {
        assert.equal(classify(["--help"]).allow, true);
    });

    test("allows -h", () => {
        assert.equal(classify(["-h"]).allow, true);
    });

    test("allows --help on a subcommand (does not fall through to commit)", () => {
        // git --help commit -- shows help for commit; read-only.
        assert.equal(classify(["--help", "commit"]).allow, true);
    });

    test("allows bare git", () => {
        assert.equal(classify([]).allow, true);
    });

    test("allows --html-path", () => {
        assert.equal(classify(["--html-path"]).allow, true);
    });
});

describe("classify - error message format", () => {
    test("blocked reason mentions 'switch git mode'", () => {
        const r = classify(["commit"]);
        assert.equal(r.allow, false);
        if (!r.allow) {
            assert.match(r.reason, /Switch git mode/);
            assert.match(r.reason, /Settings/);
        }
    });
});
