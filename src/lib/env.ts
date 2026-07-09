// =========================================================================================================================================
// src/lib/env.ts - Resolve the `env` field into container environment injection (files + inline vars)
// An `env` entry is either an env-file path (no '=') loaded via --env-file, or an inline KEY=VALUE injected via -e.
// Config is the source of truth: a hashed label over inline vars + resolved file contents recreates the container on change.
// =========================================================================================================================================

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// --- Constants ---------------------------------------------------------------------------------------------------------------------------

// Inline var keys must be valid shell env identifiers - the same pattern the `ports` env field uses.
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// --- Interfaces --------------------------------------------------------------------------------------------------------------------------

/** A single resolved env-file entry: its absolute path and whether that path exists on disk. */
export interface EnvFile {
    path: string;
    exists: boolean;
}

/** Validated, normalized `env` config. `inlineVars` are KEY=VALUE strings; `files` are resolved absolute paths. */
export interface EnvConfig {
    inlineVars: string[];
    files: EnvFile[];
}

// --- Config validation and normalization -------------------------------------------------------------------------------------------------

/**
 * Validate and normalize the raw `env` field into inline vars and file entries. This is the single source of
 * truth for env semantics (unit-testable without the JSON Schema). A scalar or undefined is normalized to an
 * array; entries are trimmed and empties dropped. Classification is by presence of '=': an entry with '=' is
 * an inline KEY=VALUE var; an entry without '=' is an env-file path resolved relative to the workspace dir.
 * Throws on the first malformed inline entry with a clear message. Missing files never throw - they are
 * flagged exists:false and warned about at startup (matching the old env_file behavior).
 */
export function validateEnvConfig(raw: string | string[] | undefined, workspaceDir: string): EnvConfig {
    const entries = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((e) => e.trim()).filter((e) => e.length > 0);

    const inlineVars: string[] = [];
    const files: EnvFile[] = [];

    for (const entry of entries) {
        const eq = entry.indexOf("=");
        if (eq === -1) {
            // No '=' -> file path, resolved relative to the workspace dir.
            const path = join(workspaceDir, entry);
            files.push({ path, exists: existsSync(path) });
        } else {
            // Has '=' -> inline KEY=VALUE. The key must be a valid env identifier; the value may be empty or contain further '='.
            const key = entry.slice(0, eq);
            if (!ENV_KEY_PATTERN.test(key)) {
                throw new Error(`env: invalid variable "${entry}" - the key must match ${ENV_KEY_PATTERN.source} (e.g. FOO=bar).`);
            }
            inlineVars.push(entry);
        }
    }

    return { inlineVars, files };
}

// --- Docker argument builders (pure) -----------------------------------------------------------------------------------------------------

/**
 * Docker run args for env injection: --env-file for each existing file (missing files omitted), then
 * -e KEY=VALUE per inline var. Files come first so an inline var wins a duplicate key - docker applies later
 * -e over an earlier --env-file - which lets a totopo.yaml inline var override a value from an env file.
 */
export function envRunArgs(cfg: EnvConfig): string[] {
    const fileArgs = cfg.files.filter((f) => f.exists).flatMap((f) => ["--env-file", f.path]);
    const inlineArgs = cfg.inlineVars.flatMap((v) => ["-e", v]);
    return [...fileArgs, ...inlineArgs];
}

/** One warning line per missing env file (skipped, matching the old env_file behavior). */
export function envWarnings(cfg: EnvConfig): string[] {
    return cfg.files.filter((f) => !f.exists).map((f) => `env "${f.path}" not found - skipping`);
}

// --- Fingerprint -------------------------------------------------------------------------------------------------------------------------

/**
 * Deterministic fingerprint over the resolved env config, used as the container LABEL_ENV. Covers each inline
 * KEY=VALUE and, for each existing file, its path plus contents - so editing an inline var, editing a file's
 * contents, or repointing at a different file recreates the container on the next session. An empty config
 * (no inline vars and no existing files) fingerprints to "" so an env-less workspace never recreates on
 * account of this label. Hashed so no secret values leak into docker labels (which are visible via inspect).
 */
export function envLabel(cfg: EnvConfig): string {
    if (cfg.inlineVars.length === 0 && cfg.files.every((f) => !f.exists)) return "";
    const parts: string[] = [];
    for (const v of cfg.inlineVars) parts.push(`e:${v}`);
    for (const f of cfg.files) {
        if (!f.exists) continue;
        parts.push(`f:${f.path}\n${readFileSync(f.path, "utf8")}`);
    }
    return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12);
}
