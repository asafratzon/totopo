// =============================================================================
// src/core/detect-host.ts — detect runtime versions installed on the host machine
// =============================================================================

import { execSync } from "node:child_process";

export interface HostRuntimes {
    node?: string; // "22"      (major — for NodeSource channel)
    python?: string; // "3.11"   (major.minor)
    go?: string; // "1.21.4" (exact — go.dev tarball)
    rust?: string; // "1.75.0" (exact — rustup pin)
    java?: string; // "21"     (major — Temurin package)
    bun?: string; // "1.0.7"  (exact — BUN_INSTALL_VERSION)
}

function run(cmd: string): string | undefined {
    try {
        const out = execSync(cmd, { encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim();
        return out || undefined;
    } catch {
        return undefined;
    }
}

export function detectHostRuntimes(): HostRuntimes {
    const result: HostRuntimes = {};

    // Node.js: `node --version` → `v22.11.0` → major "22"
    const nodeOut = run("node --version");
    if (nodeOut) {
        const major = nodeOut.replace(/^v/, "").split(".")[0];
        if (major) result.node = major;
    }

    // Python: `python3 --version` → `Python 3.11.2` → major.minor "3.11"
    const pythonOut = run("python3 --version");
    if (pythonOut) {
        const versionStr = pythonOut.split(" ")[1];
        if (versionStr) {
            const nums = versionStr.split(".");
            const major = nums[0];
            const minor = nums[1];
            if (major && minor) result.python = `${major}.${minor}`;
        }
    }

    // Go: `go version` → `go version go1.21.4 darwin/arm64` → "1.21.4"
    const goOut = run("go version");
    if (goOut) {
        const m = goOut.match(/go(\d+\.\d+\.\d+)/);
        const v = m?.[1];
        if (v) result.go = v;
    }

    // Rust/Cargo: `cargo --version` → `cargo 1.75.0 (...)` → "1.75.0"
    const cargoOut = run("cargo --version");
    if (cargoOut) {
        const v = cargoOut.split(" ")[1];
        if (v) result.rust = v;
    }

    // Java: `java --version` → first line `openjdk 21.0.2 ...` → major "21"
    const javaOut = run("java --version");
    if (javaOut) {
        const firstLine = javaOut.split("\n")[0] ?? "";
        const m = firstLine.match(/(\d+)/);
        const v = m?.[1];
        if (v) result.java = v;
    }

    // Bun: `bun --version` → `1.0.7`
    const bunOut = run("bun --version");
    if (bunOut && /^\d+\.\d+\.\d+/.test(bunOut)) {
        result.bun = bunOut;
    }

    return result;
}
