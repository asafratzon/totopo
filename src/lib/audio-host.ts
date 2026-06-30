// =========================================================================================================================================
// src/lib/audio-host.ts - Host-side PulseAudio control for Claude Code /voice (macOS-first).
// Bridges the host microphone into the container over TCP so SoX 'rec' inside the container can capture audio.
// All actions run on the host; the per-workspace wiring is the .lock audio flag (see dev.ts).
// =========================================================================================================================================

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AUDIO_TCP_PORT, GLOBAL_DIR, PULSE_COOKIE_FILE, TOTOPO_DIR } from "./constants.js";

// Coarse network filter: loopback plus the private (RFC1918) ranges Docker may present container
// traffic from. This keeps the server off the public internet without guessing the exact source IP
// a given Docker setup uses (which varies), so /voice connects reliably. Actual access control is the
// shared cookie (see hostCookiePath): a client on these networks still cannot connect without it.
const ACL = "127.0.0.1;10.0.0.0/8;172.16.0.0/12;192.168.0.0/16";

// Host-side daemon control (install/start/stop/test) is automated on macOS only.
// Other platforms still get accurate running/installed status; setup is documented in the README.
export const IS_MACOS = process.platform === "darwin";

export interface AudioStatus {
    installed: boolean;
    running: boolean;
    version: string | null;
}

export interface ActionResult {
    ok: boolean;
    message: string;
}

export interface MicTestResult {
    ok: boolean;
    message: string;
    bytes: number;
}

// --- Probes ------------------------------------------------------------------------------------------------------------------------------

// True if a command exists on PATH.
function have(cmd: string): boolean {
    return spawnSync("which", [cmd], { stdio: "pipe" }).status === 0;
}

// True if pulseaudio is installed on the host.
function isPulseInstalled(): boolean {
    return have("pulseaudio");
}

// First line of `pulseaudio --version`, or null when unavailable.
function pulseVersion(): string | null {
    const r = spawnSync("pulseaudio", ["--version"], { encoding: "utf8", stdio: "pipe" });
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout.trim().split("\n")[0] ?? null;
}

// True when a PulseAudio daemon is currently running on the host. Safe on any platform.
export function isAudioServerRunning(): boolean {
    return spawnSync("pulseaudio", ["--check"], { stdio: "pipe" }).status === 0;
}

// --- Status ------------------------------------------------------------------------------------------------------------------------------

// Snapshot of the host audio server for the Voice menu.
export function getStatus(): AudioStatus {
    const installed = isPulseInstalled();
    return {
        installed,
        running: isAudioServerRunning(),
        version: installed ? pulseVersion() : null,
    };
}

// --- Actions -----------------------------------------------------------------------------------------------------------------------------

// Install pulseaudio via Homebrew (macOS). Inherits stdio so brew progress is visible.
export function installPulse(): ActionResult {
    if (isPulseInstalled()) return { ok: true, message: "pulseaudio is already installed." };
    if (!have("brew")) return { ok: false, message: "Homebrew not found. Install it from https://brew.sh then retry." };
    const r = spawnSync("brew", ["install", "pulseaudio"], { stdio: "inherit" });
    if (r.status === 0) return { ok: true, message: "pulseaudio installed." };
    return { ok: false, message: "brew install pulseaudio failed." };
}

// PulseAudio authenticates native-protocol clients with a 256-byte shared-secret cookie.
const COOKIE_BYTES = 256;

// totopo uses its OWN cookie for the container (TCP) path, kept separate from the user's general
// PulseAudio cookie and never mounting that general credential into the container. It lives under the
// host-global ~/.totopo/global/ dir (the server is a single shared resource, not per-workspace) at a
// stable path that survives reboots, so a running container keeps working without a rebuild.
export function hostCookiePath(): string {
    return join(homedir(), TOTOPO_DIR, GLOBAL_DIR, PULSE_COOKIE_FILE);
}

// Write a fresh random cookie to `path`, in place (truncating the same file) so a container's
// read-only bind mount sees the new bytes live - no rebuild needed. 0600: only the host user reads it.
function writeFreshCookie(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(COOKIE_BYTES), { mode: 0o600 });
}

// Ensure the cookie file exists WITHOUT rotating it (create-if-missing). Used at container-create time
// so the mount target is always valid; never clobbers a cookie a running server is already using.
export function ensureCookieFile(): string {
    const path = hostCookiePath();
    if (!existsSync(path)) writeFreshCookie(path);
    return path;
}

// Start the host daemon: capture the Mac mic (coreaudio) and expose it to the container over TCP.
// module-coreaudio-detect      : auto-create sources/sinks for CoreAudio devices (the mic).
// module-always-sink           : guarantee a sink exists (avoids warnings).
// module-native-protocol-unix  : let host-side pactl/parec connect over the local socket (uses the
//                                daemon's own default cookie, so testMic is unaffected by our cookie).
// module-native-protocol-tcp   : expose the server to the container over TCP. No auth-anonymous, so
//                                clients must present totopo's dedicated cookie (auth-cookie); the IP
//                                ACL is defense-in-depth, restricting which hosts may even connect.
export function startServer(): ActionResult {
    if (!isPulseInstalled()) return { ok: false, message: "pulseaudio is not installed. Install it first." };
    if (isAudioServerRunning()) return { ok: true, message: "pulseaudio is already running." };
    // Rotate the dedicated TCP cookie on each cold start: a cookie leaked from a previous session is
    // invalidated here. Written in place so a running container picks it up without a rebuild.
    const cookie = hostCookiePath();
    writeFreshCookie(cookie);
    const modules = [
        "--load=module-coreaudio-detect",
        "--load=module-always-sink",
        "--load=module-native-protocol-unix",
        `--load=module-native-protocol-tcp auth-ip-acl=${ACL} auth-cookie=${cookie} port=${AUDIO_TCP_PORT}`,
    ];
    const r = spawnSync("pulseaudio", ["--daemonize=yes", "-n", "--exit-idle-time=-1", ...modules], { stdio: "pipe" });
    if (r.status !== 0) return { ok: false, message: "pulseaudio failed to start. Approve any macOS firewall prompt, then retry." };
    if (isAudioServerRunning()) return { ok: true, message: `pulseaudio started on TCP ${AUDIO_TCP_PORT}.` };
    return { ok: false, message: "pulseaudio did not come up. Check Console.app logs and retry." };
}

// Stop the host daemon. Safe to call when nothing is running.
export function stopServer(): ActionResult {
    if (!isPulseInstalled()) return { ok: true, message: "pulseaudio is not installed; nothing to stop." };
    if (!isAudioServerRunning()) return { ok: true, message: "pulseaudio is not running." };
    spawnSync("pulseaudio", ["--kill"], { stdio: "pipe" });
    if (!isAudioServerRunning()) return { ok: true, message: "pulseaudio stopped." };
    return { ok: false, message: "Could not stop pulseaudio." };
}

// Record ~3s from the default source and inspect it. All-zero capture almost always means the
// macOS microphone permission was denied. Returns the captured byte count for the menu to report.
export function testMic(): MicTestResult {
    if (!isAudioServerRunning()) return { ok: false, message: "pulseaudio is not running. Start it first.", bytes: 0 };
    if (!have("parec")) return { ok: false, message: "parec not found - reinstall pulseaudio (it ships parec/pactl).", bytes: 0 };
    const r = spawnSync("parec", ["--channels=1", "--rate=16000", "--format=s16le"], {
        timeout: 3000,
        maxBuffer: 16000 * 2 * 5, // ~5s of 16kHz mono s16 headroom
        stdio: ["ignore", "pipe", "ignore"],
    });
    const buf = r.stdout ?? Buffer.alloc(0);
    const bytes = buf.length;
    if (bytes < 1000) {
        return { ok: false, message: `Captured only ${bytes} bytes - the host could not read the microphone source.`, bytes };
    }
    let nonZero = false;
    for (const b of buf) {
        if (b !== 0) {
            nonZero = true;
            break;
        }
    }
    if (!nonZero) {
        return {
            ok: false,
            message:
                "Captured audio but it was pure silence - the macOS microphone permission is almost certainly denied. " +
                "Approve your terminal under System Settings > Privacy & Security > Microphone, then retry.",
            bytes,
        };
    }
    return { ok: true, message: `Captured ${bytes} bytes of real audio - mic capture works.`, bytes };
}
