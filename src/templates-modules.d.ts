// Type declarations for plain-JS modules under templates/ that TS code imports.
// The runtime artifacts ship as untyped ESM (they run inside the container, not
// as part of the TS build); these declarations let constants.ts and tests
// reference them with full typing. Lives under src/ so both the dev tsconfig
// and tsconfig.build.json (which only includes src/**/*.ts) pick it up.

declare module "*/git-readonly-wrapper.mjs" {
    export function classify(argv: string[]): { allow: true } | { allow: false; reason: string };
    export function findSubcommand(argv: string[]): { subcmd: string | null; rest: string[] };
}

declare module "*/runtime-constants.mjs" {
    export const GIT_MODE: {
        readonly strict: "strict";
        readonly local: "local";
        readonly unrestricted: "unrestricted";
    };
    export const GIT_WRAPPER_PATH: string;
    export const GIT_WRAPPER_SOURCE: string;
}
