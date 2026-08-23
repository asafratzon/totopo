# Phase 01 - Audio retirement

Status: done

Covers FR-07 and FR-08: remove every trace of the voice/audio feature.
Webterm's browser dictation (Web Speech API, the mic button) and the unrelated `AudioContext` chime stay - they are not the audio server.

## Tasks

- [x] Delete `src/lib/audio-host.ts` and `tests/audio-host.test.ts`; move `IS_MACOS` to a live module and repoint its importers (`menu.ts`, `dev.ts`, `settings.ts`), or drop it when audio was its only user
- [x] Remove the audio constants from `src/lib/constants.ts`: `PULSE_COOKIE_FILE`, `LABEL_AUDIO`, the audio bridge block, `AUDIO_MODE`/`AudioMode`/`AUDIO_MODES`; fix the `GLOBAL_DIR` comment
- [x] Remove the `.lock` audio flag from `src/lib/workspace-identity.ts`: the key, both defaults, `readAudio`/`writeAudio`, the `initWorkspaceDir` parameter
- [x] Remove `readAudioMode`/`writeAudioMode` and the `audio_mode` key from `src/lib/global-config.ts`
- [x] Remove the audio wiring from `src/commands/dev.ts`: imports, `countdown()` and its only caller, the container-info audio label slot, `audioStateLabel`, `shouldStopHostAudioServer`, the audio start options and run args, the recreate-on-change branch, session-start auto-start, session-exit auto-stop, the stale-mount hint's audio example
- [x] Settle `connectedSessionCount()` in `src/lib/sessions.ts` once its last caller goes
- [x] Remove the audio notice and settings hint from `src/commands/menu.ts` and the audio wiring from `bin/totopo.js`
- [x] Remove the whole `audioMenu` and its settings entry from `src/commands/settings.ts`
- [x] Drop `sox libsox-fmt-pulse pulseaudio-utils` from `templates/Dockerfile` and fix its comment
- [x] Remove the voice bullet from `templates/context/baseline.md`
- [x] Remove the README voice sections: Voice Mode, the troubleshooting entry, the mic-bridge security paragraph, and any voice mentions in feature lists
- [x] Update the affected tests: delete audio tests, keep what remains in `tests/dev.test.ts`, `tests/workspace-identity.test.ts`, `tests/global-config.test.ts`, `tests/docker/session-lifecycle.test.ts`
- [x] Drop the BACKLOG item that asked for this

## Verify

- `grep -rniE "pulse|sox|audio" src/ templates/ bin/` returns no functional hits, with the allowed exceptions: webterm's browser dictation, the `AudioContext` chime and pulse animation, `templates/webterm/package-lock.json` (a base64 integrity hash that happens to read "Sox"), and `scripts/changelog.yaml` (release history, never edited during feature work)
- `grep -rn "Voice\|voice" README.md` shows no voice setup content
- `pnpm lint:fix` then `pnpm check` green

## Notes

`src/lib/migrate-to-latest.ts` and its test still hold audio references (`migrateAddAudio`, `migrateMoveAudioCookie`) at the end of this phase, because the plan deletes the whole migration chain in phase 2 (FR-09), not here.
The constants those migrations used are gone, so their old key names (`audio=`, `pulse-cookie`) became hardcoded string literals, which is what the repo's migration convention asks for anyway.
FR-07's grep AC is therefore met in full only after phase 2.

`IS_MACOS` was dropped rather than relocated: all three importers used it only for audio.

The `pulse-cookie` example in dev.ts's dangling-mount warning was replaced with a renamed workspace directory, so the message still explains the real failure without naming a feature that no longer exists.

Results: 584 tests pass, `pnpm check` green.
