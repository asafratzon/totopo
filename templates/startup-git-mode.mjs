// =============================================================================
// startup-git-mode.mjs -- Git mode application + verification for startup.mjs
// Baked into the container image alongside startup.mjs at /home/devuser/.
//
// Strict / local / unrestricted are read from the TOTOPO_GIT_MODE env var injected by
// dev.ts. As root we apply the requested state to /etc/gitconfig and the
// /usr/local/bin/git symlink; as devuser we only verify that the state already
// matches (the previous root invocation is what put it there).
// Must use only Node.js built-ins -- no external packages available in container.
// =============================================================================

import { execSync } from "node:child_process";
import { lstatSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { GIT_MODE, GIT_WRAPPER_PATH, GIT_WRAPPER_SOURCE } from "./runtime-constants.mjs";

const VALID_GIT_MODES = Object.values(GIT_MODE);

function lstatExists(path) {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
}

function isWrapperSymlinkInPlace() {
    if (!lstatExists(GIT_WRAPPER_PATH)) return false;
    try {
        const st = lstatSync(GIT_WRAPPER_PATH);
        if (!st.isSymbolicLink()) return false;
        return readlinkSync(GIT_WRAPPER_PATH) === GIT_WRAPPER_SOURCE;
    } catch {
        return false;
    }
}

function removeWrapperIfPresent() {
    if (!lstatExists(GIT_WRAPPER_PATH)) return;
    try {
        unlinkSync(GIT_WRAPPER_PATH);
    } catch {
        // Already gone or inaccessible -- subsequent verification will catch it
    }
}

function applyAsRoot(gitMode, protocolValue, fail) {
    try {
        execSync(`git config --system protocol.allow ${protocolValue}`, { stdio: "pipe" });
    } catch {
        fail("git mode", `failed to set protocol.allow=${protocolValue}`);
    }

    if (gitMode === GIT_MODE.strict) {
        if (!isWrapperSymlinkInPlace()) {
            // Remove any pre-existing /usr/local/bin/git (stale symlink, leftover binary)
            // so symlinkSync below doesn't EEXIST.
            removeWrapperIfPresent();
            try {
                symlinkSync(GIT_WRAPPER_SOURCE, GIT_WRAPPER_PATH);
            } catch {
                fail("git wrapper", `failed to install ${GIT_WRAPPER_PATH}`);
            }
        }
        return;
    }
    removeWrapperIfPresent();
}

function verifyProtocol(gitMode, protocolValue, run, ok, fail) {
    const gitProtocol = run("git config --system protocol.allow");
    if (gitProtocol === protocolValue) {
        ok("git mode", `${gitMode} (protocol.allow=${protocolValue})`);
    } else {
        fail("git mode", `expected protocol.allow=${protocolValue}, found ${gitProtocol ?? "<unset>"}`);
    }
}

function verifyWrapper(gitMode, ok, fail, skip) {
    if (gitMode === GIT_MODE.strict) {
        if (isWrapperSymlinkInPlace()) {
            ok("git read-only wrapper", `${GIT_WRAPPER_PATH} -> ${GIT_WRAPPER_SOURCE}`);
        } else {
            fail("git read-only wrapper", `not installed at ${GIT_WRAPPER_PATH}`);
        }
        return;
    }
    if (lstatExists(GIT_WRAPPER_PATH)) {
        fail("git read-only wrapper", `should be absent in ${gitMode} mode`);
    } else {
        skip("git read-only wrapper", `not active in ${gitMode} mode`);
    }
}

function verifyStrictWrapperRejects(ok, fail) {
    // Probe the wrapper with a representative mutating command. The classifier
    // rejects before forking real git, so we should see our marker on stderr.
    let probeStderr = "";
    let probeExit = 0;
    try {
        execSync(`${GIT_WRAPPER_PATH} commit -m probe`, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
        probeStderr = (err.stderr ?? "").toString();
        probeExit = err.status ?? 1;
    }
    if (probeExit !== 0 && probeStderr.includes("blocked in strict mode")) {
        ok("strict wrapper rejects mutation", "'git commit' blocked");
    } else {
        fail("strict wrapper rejects mutation", "wrapper did not produce the expected error");
    }
}

function verifyRemoteBlocked(gitMode, ok, fail, skip) {
    if (gitMode === GIT_MODE.unrestricted) {
        skip("remote push", "allowed in unrestricted mode (network probe skipped)");
        return;
    }
    try {
        execSync("/usr/bin/git -C /workspace push", { stdio: "pipe" });
        fail("remote push blocked", "git push succeeded -- remote access is NOT blocked");
    } catch {
        ok("remote push blocked", "remote push not possible");
    }
}

/**
 * Apply (when root) and verify the git mode requested via TOTOPO_GIT_MODE.
 * Reports through the caller-provided ok/fail/skip helpers so all output flows
 * through the main startup script's section formatting and error counter.
 */
export function checkGitMode({ ok, fail, skip, run, isRoot }) {
    const gitMode = VALID_GIT_MODES.includes(process.env.TOTOPO_GIT_MODE) ? process.env.TOTOPO_GIT_MODE : GIT_MODE.local;
    const protocolValue = gitMode === GIT_MODE.unrestricted ? "always" : "never";

    if (isRoot) {
        applyAsRoot(gitMode, protocolValue, fail);
    }

    verifyProtocol(gitMode, protocolValue, run, ok, fail);
    verifyWrapper(gitMode, ok, fail, skip);
    if (gitMode === GIT_MODE.strict) verifyStrictWrapperRejects(ok, fail);
    verifyRemoteBlocked(gitMode, ok, fail, skip);
}
