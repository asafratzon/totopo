import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { audioStateLabel, resolveWorkdir, shouldStopHostAudioServer } from "../src/commands/dev.js";
import { AUDIO_MODE } from "../src/lib/constants.js";

describe("audioStateLabel", () => {
    test("returns the plain false label when audio is off, regardless of cookie path", () => {
        assert.equal(audioStateLabel(false, undefined), "false");
        assert.equal(audioStateLabel(false, "/home/user/.totopo/global/pulse-cookie"), "false");
    });

    test("returns a true:<hash> label when audio is on", () => {
        const label = audioStateLabel(true, "/home/user/.totopo/global/pulse-cookie");
        assert.match(label, /^true:[0-9a-f]{12}$/);
    });

    test("the label differs between two different cookie paths", () => {
        const oldPath = audioStateLabel(true, "/home/user/.totopo/pulse-cookie");
        const newPath = audioStateLabel(true, "/home/user/.totopo/global/pulse-cookie");
        assert.notEqual(oldPath, newPath, "relocating the cookie must change the label so the container recreates");
    });

    test("the label is stable for the same cookie path", () => {
        const path = "/home/user/.totopo/global/pulse-cookie";
        assert.equal(audioStateLabel(true, path), audioStateLabel(true, path));
    });

    test("audio on is always distinct from audio off", () => {
        assert.notEqual(audioStateLabel(true, undefined), audioStateLabel(false, undefined));
    });
});

describe("shouldStopHostAudioServer", () => {
    // Thunks that record how many times they were called, to assert short-circuit behavior. `calls` is a
    // live mutable property (not an Object.assign getter, which would snapshot the value at copy time).
    type Counter<T> = (() => T) & { calls: number };
    const counting = <T>(value: T): Counter<T> => {
        const fn = (() => {
            fn.calls++;
            return value;
        }) as Counter<T>;
        fn.calls = 0;
        return fn;
    };

    test("stops when on macOS, automatic mode, server running, and no sessions anywhere", () => {
        assert.equal(
            shouldStopHostAudioServer(
                true,
                AUDIO_MODE.automatic,
                () => true,
                () => 0,
            ),
            true,
        );
    });

    // The regression this guards: the decision must not depend on whether the just-closed workspace was
    // itself audio-wired. The predicate takes no audio flag, so the last session to close always stops the
    // shared server - including when that final session was not voice-enabled.
    test("stops on the last exit regardless of this workspace's audio wiring", () => {
        assert.equal(
            shouldStopHostAudioServer(
                true,
                AUDIO_MODE.automatic,
                () => true,
                () => 0,
            ),
            true,
        );
    });

    test("does not stop when not on macOS", () => {
        assert.equal(
            shouldStopHostAudioServer(
                false,
                AUDIO_MODE.automatic,
                () => true,
                () => 0,
            ),
            false,
        );
    });

    test("does not stop in manual mode", () => {
        assert.equal(
            shouldStopHostAudioServer(
                true,
                AUDIO_MODE.manual,
                () => true,
                () => 0,
            ),
            false,
        );
    });

    test("does not stop when the server is not running", () => {
        assert.equal(
            shouldStopHostAudioServer(
                true,
                AUDIO_MODE.automatic,
                () => false,
                () => 0,
            ),
            false,
        );
    });

    test("does not stop while any session is still connected", () => {
        assert.equal(
            shouldStopHostAudioServer(
                true,
                AUDIO_MODE.automatic,
                () => true,
                () => 1,
            ),
            false,
        );
    });

    test("skips the session scan when the server is not running (short-circuit keeps the cost off)", () => {
        const running = counting(false);
        const sessions = counting(0);
        shouldStopHostAudioServer(true, AUDIO_MODE.automatic, running, sessions);
        assert.equal(running.calls, 1, "server-running check should run");
        assert.equal(sessions.calls, 0, "session scan must be skipped when the server is down");
    });

    test("skips both probes off macOS and in manual mode", () => {
        const runningOffMac = counting(true);
        const sessionsOffMac = counting(0);
        shouldStopHostAudioServer(false, AUDIO_MODE.automatic, runningOffMac, sessionsOffMac);
        assert.equal(runningOffMac.calls, 0, "no probes off macOS");
        assert.equal(sessionsOffMac.calls, 0, "no probes off macOS");

        const runningManual = counting(true);
        const sessionsManual = counting(0);
        shouldStopHostAudioServer(true, AUDIO_MODE.manual, runningManual, sessionsManual);
        assert.equal(runningManual.calls, 0, "no probes in manual mode");
        assert.equal(sessionsManual.calls, 0, "no probes in manual mode");
    });
});

describe("resolveWorkdir", () => {
    test("returns the container workspace root when invoked at the workspace root", () => {
        assert.equal(resolveWorkdir("/home/user/proj", "/home/user/proj"), "/workspace");
    });

    test("maps a sub-directory to the matching path under the container workspace", () => {
        assert.equal(resolveWorkdir("/home/user/proj", "/home/user/proj/apps/orot-core"), "/workspace/apps/orot-core");
    });
});
