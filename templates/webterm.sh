#!/usr/bin/env bash
# webterm - run an AI agent in the browser (the web agent interface) from inside this container.
# Baked into the image at /usr/local/share/totopo/webterm.sh, on PATH as `webterm`.
# The agent is always named explicitly: webterm claude | webterm opencode | webterm codex.
set -euo pipefail

CONTAINER_PORT=3899
AGENTS=(claude opencode codex)
STATE_FILE=/tmp/webterm.agent
SERVER_LOG=/tmp/webterm.log

# TOTOPO_WEB_URL is injected by the host at container create only when the feature is enabled,
# so its absence means the web interface is off - the command stays inert.
if [ -z "${TOTOPO_WEB_URL:-}" ]; then
    echo "The web agent interface is disabled."
    echo "Enable it on the host: npx totopo > Settings > Web interface, then reopen the session."
    exit 1
fi

usage() {
    local list="${AGENTS[*]}" # Space separated; render it as "a | b | c".
    echo "Usage: webterm <agent>   - run an agent in the web interface"
    echo ""
    echo "Agents: ${list// / | }"
    echo ""
    echo "Example: webterm ${AGENTS[0]}"
    echo ""
    echo "The browser then relays that agent at ${TOTOPO_WEB_URL}"
}

# Bare `webterm` explains how to invoke instead of guessing an agent. The usage text carries the
# URL too, so it doubles as "what is my web address" for an interface that is already running.
if [ $# -eq 0 ]; then
    usage
    exit 0
fi

AGENT="$1"
AGENT_KNOWN=""
for known in "${AGENTS[@]}"; do
    if [ "$AGENT" = "$known" ]; then
        AGENT_KNOWN=1
        break
    fi
done
if [ -z "$AGENT_KNOWN" ]; then
    echo "Unknown agent: ${AGENT}"
    echo ""
    usage
    exit 1
fi

# Idempotent: the host launches this on every container start, and the user may run it by hand.
# If something already listens on the fixed container port, report the live interface instead of
# starting a second one. The probe runs in a subshell, so its file descriptor closes with it.
# A bound port only proves something is listening, so name the agent from the server's state file.
if (exec 3<>"/dev/tcp/127.0.0.1/${CONTAINER_PORT}") 2>/dev/null; then
    RUNNING_AGENT=""
    if [ -r "$STATE_FILE" ]; then
        RUNNING_AGENT="$(head -n 1 "$STATE_FILE" 2>/dev/null || true)"
    fi
    if [ -n "$RUNNING_AGENT" ] && [ "$RUNNING_AGENT" != "$AGENT" ]; then
        # Known limitation: one server relays one agent. Switching kills the server, and with it every
        # session it is running, so it is never done implicitly - the user gets the command and decides.
        echo "webterm is already running, relaying ${RUNNING_AGENT}: ${TOTOPO_WEB_URL}"
        echo ""
        echo "It relays one agent at a time, so ${AGENT} was not started."
        echo "To switch (this ends every ${RUNNING_AGENT} session open in the browser):"
        echo ""
        echo "  pkill -f webterm/server.js && webterm ${AGENT}"
        exit 0
    fi
    echo "webterm is already running${RUNNING_AGENT:+ (relaying ${RUNNING_AGENT})}: ${TOTOPO_WEB_URL}"
    exit 0
fi

export WEBTERM_PORT="${CONTAINER_PORT}"
export WEBTERM_AGENT="$AGENT"
export WEBTERM_STATE_FILE="$STATE_FILE"
# Guarded like the sibling baked scripts: a detached `docker exec` need not carry HOME, and under
# `set -u` a bare $HOME would abort the launcher before the server ever starts.
export WEBTERM_RESUME_MARKER="${HOME:-/home/devuser}/.totopo-resume-pending"
# The workspace name (host-injected as TOTOPO_WORKSPACE) labels the session bar and the browser tab.
export WEBTERM_WORKSPACE="${TOTOPO_WORKSPACE:-}"

# Detached launches (docker exec -d) have no terminal; keep this script's own output reachable too.
if [ ! -t 1 ]; then
    exec >>"$SERVER_LOG" 2>&1
fi

# Start the server detached: the interface is a background service, not a foreground command, so a
# hand-run returns the prompt and the interface survives the shell that started it - the same
# behavior the host-started launch has. setsid puts it in its own session, so closing this terminal
# (or Ctrl-C) does not take it down. Its output appends to the log for debugging.
setsid node /usr/local/share/totopo/webterm/server.js >>"$SERVER_LOG" 2>&1 &

# Wait for the port to bind before claiming success, so a server that fails to start says so (with
# the log to look at) instead of printing a URL that will not answer.
for _ in 1 2 3 4 5 6 7 8 9 10; do
    if (exec 3<>"/dev/tcp/127.0.0.1/${CONTAINER_PORT}") 2>/dev/null; then
        echo "Web agent interface: ${TOTOPO_WEB_URL} (relaying ${AGENT})"
        exit 0
    fi
    sleep 0.3
done

echo "webterm did not start within 3s - see ${SERVER_LOG}"
exit 1
