import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CONTAINER_LOGIN_SHELL, loginShellExecArgs, sessionMatchNeedle } from "../src/lib/sessions.js";

describe("sessions detection", () => {
    test("loginShellExecArgs returns the expected docker exec argv", () => {
        assert.deepEqual(loginShellExecArgs("/workspace", "totopo-orot-io"), [
            "exec",
            "-it",
            "-w",
            "/workspace",
            "totopo-orot-io",
            "bash",
            "--login",
        ]);
    });

    // Drift guard: the detector's match needle must always be a substring of the actual connect command,
    // otherwise pgrep would never match a live session and the stop prompt would silently break again.
    test("sessionMatchNeedle is a substring of the real connect command", () => {
        const containerName = "totopo-orot-io";
        const connectCommand = loginShellExecArgs("/some/deep/workdir", containerName).join(" ");
        assert.ok(
            connectCommand.includes(sessionMatchNeedle(containerName)),
            `needle "${sessionMatchNeedle(containerName)}" must appear in connect command "${connectCommand}"`,
        );
    });

    test("sessionMatchNeedle is container-name + login shell args", () => {
        assert.equal(sessionMatchNeedle("totopo-foo"), `totopo-foo ${CONTAINER_LOGIN_SHELL.join(" ")}`);
    });
});
