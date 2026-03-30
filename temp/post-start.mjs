#!/usr/bin/env node
// post-start.mjs - runs inside container after start to verify tool readiness
// This file is COPY-ed into the image from the totopo package at build time.
// It is never written to ~/.totopo/ - it lives only in the image.

import { execSync } from "node:child_process";

function check(label, cmd) {
    try {
        const out = execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim();
        console.log(`  ok  ${label}: ${out}`);
    } catch {
        console.log(`  --  ${label}: not found`);
    }
}

console.log("\n[post-start] Tool readiness check:");
check("node", "node --version");
check("python3", "python3 --version");
check("bun", "bun --version");
check("git", "git --version");
console.log("");
