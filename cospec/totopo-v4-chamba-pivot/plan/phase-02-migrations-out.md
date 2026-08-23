# Phase 02 - Migrations out, refuse-check and tidy-up in

Status: done

Covers FR-09, FR-10, FR-11, FR-30.
The 712-line migration chain goes; in its place a cheap old-shape check that refuses with a clear message, an explicit version marker in `.lock`, and one surviving tidy-up for the v3.16 shape.

## Tasks

- [x] Move `isImageStale` (and the staleness-detection doc block that explains it) into `src/lib/dockerfile-builder.ts`, which already owns `computeBuildHash` and stamps `LABEL_BUILD_HASH`; repoint `dev.ts` and the docker test
- [x] Delete `src/lib/migrate-to-latest.ts`, `tests/migrate-to-latest.test.ts`, and `tests/docker/migration.test.ts`; drop the `runMigration` call from `bin/totopo.js`
- [x] Add `LOCK_VERSION` to `src/lib/constants.ts` - the workspace shape version v4 stamps
- [x] Add the `version` key to `LOCK_KEYS` in `src/lib/workspace-identity.ts`, read it in `parseLockFile`, stamp it from `initWorkspaceDir`, and expose a reader for it
- [x] Add a key-removal helper to `src/lib/global-config.ts` so the tidy-up can drop a retired key without a public writer for it
- [x] Write `src/lib/legacy-check.ts` with two exported functions:
  - `detectLegacyShape(workspaceRoot)` - the four cheap markers (a `~/.totopo/projects/` dir, a `meta.json` in any workspace cache dir, a `.lock` whose first non-empty line has no `=`, and `project_id:`/`env_file:`/`schema_version:` in the resolved workspace's `totopo.yaml`); returns what was found and writes nothing
  - `tidyV3Leftovers()` - for every registered workspace whose lock is not at the current version: rewrite the lock through the canonical writer, which drops the retired `audio` key and stamps the version; then drop the retired audio-mode key from the host-global config. Old key names are hardcoded literals per the migration convention
- [x] Call both from `bin/totopo.js` where `runMigration` was: refuse and exit on a legacy shape (naming `npx totopo@3.16.0` exactly), otherwise tidy and carry on
- [x] Write `tests/legacy-check.test.ts` covering each marker, the clean v3.16 pass, no writes on refusal, the tidy-up's effect, and its second-run no-op
- [x] Update `tests/workspace-identity.test.ts` for the version key

## Verify

- `pnpm lint:fix` then `pnpm check` green
- `grep -rn "runMigration\|migrate-to-latest" src/ bin/ tests/` returns nothing
- `grep -rniE "pulse|sox|audio" src/ templates/ bin/` returns no functional hits outside webterm's dictation and chime, and the deliberate old-name literals in `legacy-check.ts`, `bin/totopo.js`, and the tidy-up's test
- New tests prove: each legacy marker refuses with the v3.16.0 message and leaves disk untouched; a v3.16-shape workspace passes, is tidied on the first run, and is unchanged on the second; a fresh `.lock` carries the version key

## Notes

Two design calls worth naming, both within what the spec left to the implementer:

**The version stamp lives in the canonical lock writer.** `writeLockFileInternal` stamps `LOCK_VERSION` itself rather than taking it from the caller, so any lock this totopo writes names the shape it was written in - and a key retired from `LOCK_KEYS` disappears on the same write. That single mechanism is the whole of FR-30's lock half: the tidy-up just triggers a rewrite. No text surgery, no migration framework.

**The tidy-up sweeps every registered workspace, not only the current one.** FR-30 is written in the singular, but a host-wide sweep means a user with several workspaces gets them all on the first v4 run instead of one per visit, and it matches how the `.lock` migrations always worked. It stays idempotent because a lock already at this shape or a newer one is skipped, and a lock with no `root=` is left alone rather than rewritten into a broken one.
(The newer-lock half came out of the phase-4 review: the first cut compared for equality, which would have had an older totopo roll a newer lock back on every start.)

`isImageStale` went to `dockerfile-builder.ts` rather than a new one-function module: that file already computes the build hash and stamps the label this function compares against, so the stamp and the check now live together.

FR-07's grep AC is met in full as of this phase - the only remaining `audio` hits are the FR-30 tidy-up and its tests, which is the carve-out that AC names.

Results: 562 unit tests pass (22 fewer than phase 1: the 30-odd migration-chain tests are gone, 23 legacy-check tests are new), `pnpm check` green.
