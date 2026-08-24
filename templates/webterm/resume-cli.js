// resume-cli.js - The shell auto-start hook's way of asking the same question the web interface asks.
//
//   node resume-cli.js <agent> [cwd]
//
// Prints the argv that reopens this workspace's last conversation, one token per line, or nothing at all -
// which is the answer for a workspace with no history, and for every session after the first since the
// container started. The caller runs what it printed, so nothing here decides anything the hook could not:
// the whole point is that the decision is made where the session stores are, which is in this container.
//
// Exists as its own entry point rather than as a function in server.js because the shell is the other door
// into the container, and the interface being optional means it has to be able to ask without one running.
// Both doors share resume.js, so there is one answer and one chance to spend, not two.
//
// Always exits 0 and prints nothing on any failure. It is called inside a command substitution in .bashrc;
// an error here must cost the user a resume, never their shell.

import { AGENT_STORES, isKnownAgent, RESUME_STAMP, WORKSPACE_ROOT } from "./config.js";
import { claimResumeChance, resumeArgvFor } from "./resume.js";

const [agent, cwd = WORKSPACE_ROOT] = process.argv.slice(2);

// The auto-start gate is the argument itself: the .bashrc hook only runs when the host set an auto-start
// agent, and passes that setting through as `agent`. So an agent this server does not run - a shell, a typo,
// an empty string - is also the answer to "auto-start is off", and it starts fresh.
try {
    if (isKnownAgent(agent)) {
        // Claimed before the store is read, and spent either way: a session that started fresh because the
        // workspace was empty has since written a transcript, and the next session must not reopen it.
        if (claimResumeChance(RESUME_STAMP)) {
            const argv = resumeArgvFor(agent, cwd, AGENT_STORES);
            if (argv !== null) process.stdout.write(`${argv.join("\n")}\n`);
        }
    }
} catch {
    // Nothing printed means "start fresh", which is always a usable answer.
}
