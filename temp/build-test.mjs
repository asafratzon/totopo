#!/usr/bin/env node
// build-test.mjs - feasibility test for the new totopo Dockerfile strategy
//
// What this tests:
//   1. Read Dockerfile.base from package (simulates templates/Dockerfile)
//   2. Read dockerfile_extra from totopo.yaml (simulates project config)
//   3. Combine in memory -> write to a temp file
//   4. Run: docker build -f <tempfile> <packageDir>
//      (build context = this dir, so COPY post-start.mjs works)
//   5. Run the container and verify post-start.mjs output
//   6. Clean up temp file and image
//
// Run from the host: node temp/build-test.mjs

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

const dir = dirname(fileURLToPath(import.meta.url));
const IMAGE_NAME = "totopo-build-test";
const TEMP_DOCKERFILE = join(tmpdir(), `totopo-test-${randomBytes(4).toString("hex")}.dockerfile`);

function run(label, args, opts = {}) {
    console.log(`\n> ${label}`);
    const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", stdio: "inherit", ...opts });
    if (result.status !== 0 && !opts.allowFail) {
        console.error(`\nFailed: ${label} (exit ${result.status})`);
        process.exit(1);
    }
    return result;
}

// --- 1. Read base Dockerfile from package --------------------------------
console.log("\n[1] Reading Dockerfile.base (simulates templates/Dockerfile in package)...");
const base = readFileSync(join(dir, "Dockerfile.base"), "utf8");
console.log(`    ${base.split("\n").length} lines read`);

// --- 2. Read dockerfile_extra from totopo.yaml ---------------------------
console.log("\n[2] Reading dockerfile_extra from totopo.yaml...");
const yaml = loadYaml(readFileSync(join(dir, "totopo.yaml"), "utf8"));
const extra = yaml.dockerfile_extra ?? "";
if (extra) {
    console.log("    dockerfile_extra found:");
    for (const l of extra.split("\n")) console.log(`      ${l}`);
} else {
    console.log("    No dockerfile_extra found - using base only.");
}

// --- 3. Combine in memory, write temp file --------------------------------
console.log("\n[3] Combining base + extra in memory -> temp Dockerfile...");
// USER devuser is always the final instruction - totopo owns this, not the user's dockerfile_extra
const combined = `${base}\n# --- dockerfile_extra from totopo.yaml ---\n${extra}\nUSER devuser\n`;
writeFileSync(TEMP_DOCKERFILE, combined);
console.log(`    Written to: ${TEMP_DOCKERFILE}`);
console.log("\n--- Combined Dockerfile ---");
console.log(combined);
console.log("--- End Dockerfile ---");

// --- 4. docker build ------------------------------------------------------
// Build context = dir (so COPY post-start.mjs resolves correctly)
run(`docker build -f ${TEMP_DOCKERFILE} -t ${IMAGE_NAME} ${dir}`, ["docker", "build", "-f", TEMP_DOCKERFILE, "-t", IMAGE_NAME, dir]);

// --- 5. Run container and verify -----------------------------------------
run("docker run --rm (verify post-start + tools)", ["docker", "run", "--rm", IMAGE_NAME, "node", "/home/devuser/post-start.mjs"]);

// Also verify python3 was installed by dockerfile_extra
console.log("\n> Verify python3 (installed via dockerfile_extra):");
run("python3 --version", ["docker", "run", "--rm", IMAGE_NAME, "python3", "--version"]);

// --- 6. Cleanup -----------------------------------------------------------
console.log("\n[6] Cleaning up...");
if (existsSync(TEMP_DOCKERFILE)) {
    unlinkSync(TEMP_DOCKERFILE);
    console.log("    Temp Dockerfile deleted.");
}
run("docker rmi test image", ["docker", "rmi", IMAGE_NAME], { allowFail: true });

console.log("\nFeasibility test PASSED.\n");
