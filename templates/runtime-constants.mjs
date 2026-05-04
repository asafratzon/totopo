// =============================================================================
// runtime-constants.mjs -- Constants shared between container-side runtime
// scripts and the totopo CLI build.
//
// Container-side scripts (startup.mjs, startup-git-mode.mjs) cannot import
// from src/lib/constants.ts since the TS source isn't shipped to the image.
// Keep this file plain ESM and import it from both sides; src/lib/constants.ts
// re-exports the values so TS callers stay typed.
// =============================================================================

export const GIT_MODE = Object.freeze({
    strict: "strict",
    local: "local",
    unrestricted: "unrestricted",
});

export const GIT_WRAPPER_PATH = "/usr/local/bin/git";
export const GIT_WRAPPER_SOURCE = "/usr/local/share/totopo/git-readonly";
