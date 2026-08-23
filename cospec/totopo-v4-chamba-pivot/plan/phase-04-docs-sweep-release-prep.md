# Phase 04 - Totopo docs, sweep, and release prep

Status: done

Covers FR-25, FR-26, FR-27, and FR-29's stage-1 close-out.
Stage 1 is code-complete after phase 3; this phase is what totopo's users and its next maintainer read, plus the version the release flow starts from.

## Shape

Three separate jobs, in this order.

**The README.** FR-27 wants one section for a v3.16 user: nothing to do, the first v4 run tidies the dead audio settings by itself, voice is gone, everything else behaves as it did.
Only an older workspace needs a step, and the step is exact: run `npx totopo@3.16.0` once, then come back to v4.
It sits just above Troubleshooting and is called "Migrating from v3" (the user's call, after reading it: a section nobody needs on a first read belongs next to the other things you go looking for when something is off). The web interface section moved up to just after the two demo GIFs at the same time.

**The sweep.** The audio and migration greps come back clean apart from the carve-outs FR-29 names, so what is left is prose that still describes the old shape: the migration convention in `AGENTS.md` names a file phase 2 deleted, the `/release` skill still sends the releaser to the migration registry, and two constants in `constants.ts` say "only referenced in migration" about a migration that no longer exists.
The advanced demo scenario still stars the host audio server, so its source is fixed here and the re-render is the host step.

**The release prep.** `package.json` goes to `4.0.0-rc-1`, which is the shape `pnpm release` expects: it strips the `-rc-N`, finds `4.0.0` unreleased, targets `4.0.0-rc-1`, and leaves `package.json` alone.
The changelog stays untouched - it is written during `/release`, by the repo's own rule - so this phase writes out the host steps instead.

## Tasks

- [x] README: a "Migrating from v3" section above Troubleshooting - a v3.16 workspace just works and what the first v4 run changes; older shapes run `npx totopo@3.16.0` once
- [x] README: the `.lock` line in "What Gets Installed" names what the file actually carries now (the web port and the shape version came after that comment was written)
- [x] `AGENTS.md`: the migration convention points at `legacy-check.ts`, the only place old names are still read
- [x] `.claude/skills/release/SKILL.md`: the missing-migration step becomes the v4 question - does the change move the on-disk shape, and if it does, does `LOCK_VERSION` and the refuse-check cover it
- [x] `scripts/release.ts`: the header comment no longer says the `/release` skill validates migrations
- [x] `src/lib/constants.ts`: drop `PROJECTS_DIR` and `GLOBAL_ENV_FILE`, orphaned when the chain went
- [x] The demo scenario: the two host-audio-server beats out of `demos/advanced.js`, both scenarios' version line at v4.0.0, and the demo skill's own description and file list no longer promise voice
- [x] `package.json` to `4.0.0-rc-1`
- [x] The host steps written out for the user: re-render the demos, draft the changelog entry with `/release`, `pnpm release`, and what to smoke-test

## Verify

- `grep -rni "audio\|pulse\|sox" src bin templates scripts README.md AGENTS.md` returns only the three carve-outs FR-29 names: the FR-30 tidy-up and its old key literals, webterm's browser dictation, and the unrelated chime
- `grep -rn "runMigration\|migrate-to-latest" .` returns nothing outside `cospec/` and the changelog's release history
- A full read of the README against FR-27's AC: a v3.16 user learns they need to do nothing, what the first run changes, and that only an older shape needs `npx totopo@3.16.0`
- `pnpm lint:fix` then `pnpm check` green
- Both GIFs re-rendered with `render.sh` and looked at frame by frame: `totopo v4.0.0` in the header, no host-audio-server lines in the advanced one

## Host steps for the user

Stage 1 is code-complete after this phase. What is left needs Docker or npm, so it happens on the host.

1. **Try the RC in a real container.** Worth covering: a v3.16 workspace opens and reports the tidy-up once, and reports nothing on a second run; a fresh workspace onboards; the web interface comes up and the browser page behaves as it did - tab lights and the busy trace, the finished glow, the browser-tab count and the favicon, the chime and the bell, drafts surviving a tab switch, copy and paste, dictation, the power button; and an older workspace (or a `totopo.yaml` with a retired key) gets the refusal and is left untouched.
2. **Draft the release notes.** Run `/release` in the container. `package.json` is already at `4.0.0-rc-1`, which is the version the flow targets; the changelog entry is written there, not in this phase, because the repo's rule keeps `scripts/changelog.yaml` for releases only.
3. **Publish.** `pnpm release` on the host, RC lane. It needs the changelog entry from step 2 to exist first, then publishes `4.0.0-rc-1` under the `rc` tag.

## Notes

`package.json` went to `4.0.0-rc-1` rather than `4.0.0` or a bare bump. `pnpm release` strips the `-rc-N`, sees `4.0.0` unpublished, and targets `4.0.0-rc-1` without asking for a bump type - so the version in the tree is the one the flow will publish, and nothing has to be guessed at release time. `GITHUB_README_URL` is derived from this version, so the Help URL points at the `v4.0.0-rc-1` tag, which the release creates.

The sweep found more than the two greps in the definition of done. All of it was prose describing machinery that is gone: `AGENTS.md` and the `/release` skill both sent a reader to `migrate-to-latest.ts`, `scripts/release.ts` said the skill validates migrations, `totopo-yaml.ts` and `scripts/check.ts` still named `pnpm rc` and `pnpm rc:promote` (renamed to `pnpm release` some time ago), and `PROJECTS_DIR` and `GLOBAL_ENV_FILE` in `constants.ts` were left behind with comments saying they were only referenced in a migration. The two constants are deleted rather than kept for reference: `legacy-check.ts` reads those old names as string literals, which is what the repo's convention asks for.

The demos rendered in the container after all, so the GIFs are part of this phase rather than a host step. They are synthetic - a script hand-writes an asciicast and `agg` turns it into a GIF - so nothing about them needs Docker, and this container already had the renderer, the fonts and Pillow provisioned. Both were re-rendered, not just the advanced one, so the two GIFs on the README agree on the version.

The README's account of why voice went is the user's, recorded here because it is the part a reader actually wants: the feature existed only because Claude Code's hold-SPACE dictation records from a microphone and a container has none, so totopo bridged the host mic in over a local audio server - macOS-only, and a lot of machinery. macOS already dictates into any focused window with the microphone key, terminal sessions included, so the bridge was solving a problem the OS had already solved. That is now a Troubleshooting entry too, since "dictation does not work in claude here" is the question it answers.
