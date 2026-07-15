#!/bin/sh
# =============================================================================
# context-usage -- prints the freshest Claude Code context/quota snapshot.
# Baked into the container image at /usr/local/share/totopo/context-usage.sh
# and symlinked to /usr/local/bin/context-usage.
#
# Snapshots are written by claude-statusline.sh to ~/.claude/context-usage/
# on every prompt render, one file per session. Each snapshot records the pid
# (and start time) of the Claude CLI process that spawned the status line; this
# helper runs as a descendant of that SAME process, so matching them identifies
# the asking session's own snapshot deterministically. When pid resolution fails, the
# newest file by mtime is used instead (it is almost always the asking
# session's own: its status line re-rendered the moment the current prompt
# was submitted), and warnings cover the two ways that heuristic can mislead
# (stale snapshot, another session writing at the same time).
# =============================================================================

snap_dir="${HOME:-/home/devuser}/.claude/context-usage"

# All snapshots, newest first. Filenames are sanitized to [A-Za-z0-9-].json at
# write time, so ls output is line-safe and word-splitting the list below is
# safe too. An unmatched glob yields no stdout lines (error suppressed).
files=$(ls -t -- "$snap_dir"/*.json 2>/dev/null)

if [ -z "$files" ]; then
  echo "No context snapshots found in $snap_dir." >&2
  echo "Snapshots appear after the Claude Code status line renders at least once." >&2
  exit 1
fi

# Resolve the pid of this session's Claude CLI process; mirrors find_claude_pid in
# claude-statusline.sh (see the comments there). Prints nothing when resolution fails.
find_claude_pid() {
  fcp_pid=$$
  while [ "$fcp_pid" -gt 1 ] 2>/dev/null; do
    fcp_comm=""
    read -r fcp_comm < "/proc/$fcp_pid/comm" 2>/dev/null || return
    case "$fcp_comm" in
      claude) printf '%s' "$fcp_pid"; return ;;
      node*) grep -aq "claude-code" "/proc/$fcp_pid/cmdline" 2>/dev/null && { printf '%s' "$fcp_pid"; return; } ;;
    esac
    read -r fcp_stat < "/proc/$fcp_pid/stat" 2>/dev/null || return
    fcp_rest="${fcp_stat##*) }"
    set -- $fcp_rest
    fcp_pid=$2
  done
}

# Start time of a process (jiffies since host boot, /proc/<pid>/stat field 22); mirrors
# proc_start_time in claude-statusline.sh. Prints nothing when unavailable.
proc_start_time() {
  read -r pst_stat < "/proc/$1/stat" 2>/dev/null || return
  pst_rest="${pst_stat##*) }"
  set -- $pst_rest
  printf '%s' "${20}"
}

# TOTOPO_CLAUDE_PID and TOTOPO_CLAUDE_PID_START are test/debug overrides.
my_claude_pid="${TOTOPO_CLAUDE_PID:-$(find_claude_pid)}"
case "$my_claude_pid" in *[!0-9]*) my_claude_pid="" ;; esac
my_pid_start=""
[ -n "$my_claude_pid" ] && my_pid_start="${TOTOPO_CLAUDE_PID_START:-$(proc_start_time "$my_claude_pid")}"
case "$my_pid_start" in *[!0-9]*) my_pid_start="" ;; esac

# Deterministic selection first: the snapshot recorded by this session's own Claude
# process. The list is newest-first, so the first match also wins when one process
# wrote several session files over time (e.g. after /clear). Pids get recycled across
# container restarts while snapshots persist in the bind-mounted home, so when both
# sides carry a start time it must agree too; a missing start time on either side
# falls back to the pid alone. The while-read loop (heredoc, not a pipe, so $matched
# survives) keeps paths intact even if the directory prefix contains spaces.
newest=""
second=""
matched=""
if [ -n "$my_claude_pid" ]; then
  while IFS= read -r f; do
    pid_fields=$(jq -r '(.claude_pid // ""), (.claude_pid_start // "")' "$f" 2>/dev/null)
    {
      IFS= read -r fpid
      IFS= read -r fstart
    } <<INNER
$pid_fields
INNER
    [ "$fpid" = "$my_claude_pid" ] || continue
    if [ -n "$fstart" ] && [ -n "$my_pid_start" ] && [ "$fstart" != "$my_pid_start" ]; then
      continue
    fi
    matched="$f"
    break
  done <<EOF
$files
EOF
fi

if [ -n "$matched" ]; then
  newest="$matched"
else
  # Heuristic fallback: newest by mtime, plus the runner-up for the ambiguity warning.
  {
    IFS= read -r newest
    IFS= read -r second
  } <<EOF
$files
EOF
fi

# Single jq pass over the snapshot, one field per line. Every path has a fallback so a
# missing field becomes an empty string (or 0) instead of failing the script.
parsed=$(jq -r '
    .session_id // "",
    .updated_at // "",
    .context_tokens // 0,
    .context_used_pct // 0,
    .model // "",
    .effort // "",
    .quota_left_pct // "",
    .quota_resets_at // ""
' "$newest" 2>/dev/null)

if [ -z "$parsed" ]; then
  echo "Snapshot $newest is unreadable." >&2
  exit 1
fi

{
  IFS= read -r session_id
  IFS= read -r updated_at
  IFS= read -r tokens
  IFS= read -r used_pct
  IFS= read -r model
  IFS= read -r effort
  IFS= read -r quota_left
  IFS= read -r quota_resets_at
} <<EOF
$parsed
EOF

now=$(date +%s)

# Format a seconds delta as "Xh Ym", "Xm", or "Xs".
fmt_delta() {
  d=$1
  if [ "$d" -ge 3600 ]; then
    echo "$(( d / 3600 ))h $(( (d % 3600) / 60 ))m"
  elif [ "$d" -ge 60 ]; then
    echo "$(( d / 60 ))m"
  else
    echo "${d}s"
  fi
}

# Age of the snapshot from its own updated_at field (portable, and equal to file mtime).
# age stays empty when updated_at is missing or non-numeric.
age=""
age_label="unknown"
case "$updated_at" in
  '' | *[!0-9]*) ;;
  *)
    age=$(( now - updated_at ))
    [ "$age" -lt 0 ] && age=0
    age_label="$(fmt_delta "$age") ago"
    ;;
esac

# Tokens label mirrors the status line formatting: 45.0k below 100k, 245k above.
case "$tokens" in
  '' | *[!0-9]*) tokens_label="?" ;;
  *) tokens_label=$(awk -v t="$tokens" 'BEGIN {
       if (t == 0) printf "0k";
       else if (t >= 100000) printf "%dk", int(t/1000 + 0.5);
       else printf "%.1fk", t/1000;
     }') ;;
esac

# The "this session" marker means the snapshot was matched by pid and is guaranteed to
# describe the asking session; without it the newest-file heuristic picked the snapshot.
if [ -n "$matched" ]; then
  printf 'session: %s (this session, updated %s)\n' "${session_id:-unknown}" "$age_label"
else
  printf 'session: %s (updated %s)\n' "${session_id:-unknown}" "$age_label"
fi
printf 'context: %s tokens (%s%% of window)\n' "$tokens_label" "${used_pct:-?}"

# Quota line only when the snapshot carried rate-limit data.
if [ -n "$quota_left" ]; then
  reset_label=""
  case "$quota_resets_at" in
    '' | *[!0-9]*) ;;
    *)
      delta=$(( quota_resets_at - now ))
      if [ "$delta" -gt 0 ]; then
        reset_label=", resets in $(fmt_delta "$delta")"
      else
        reset_label=", resets now"
      fi
      ;;
  esac
  printf 'quota:   %s%% remaining%s\n' "$quota_left" "$reset_label"
fi

if [ -n "$model" ]; then
  effort_label=""
  [ -n "$effort" ] && effort_label=" (effort $effort)"
  printf 'model:   %s%s\n' "$model" "$effort_label"
fi

# Warnings apply only to the heuristic path: a pid-matched snapshot is this session's own
# by construction, however old it is (it reflects the last render, i.e. the turn start).

# Freshness warning: a snapshot older than 5 minutes likely belongs to an idle session.
if [ -z "$matched" ] && [ -n "$age" ] && [ "$age" -gt 300 ]; then
  printf 'warning: snapshot is %s old - it may not reflect the current session\n' "$(fmt_delta "$age")"
fi

# Ambiguity warning: another session wrote its snapshot around the same moment, so mtime
# ordering may not identify the asking session. Compare updated_at of the two newest files.
# Guarded on age being set, which implies updated_at is numeric. The explicit matched check
# keeps this off the pid path even if a future edit populates $second unconditionally.
if [ -z "$matched" ] && [ -n "$second" ] && [ -n "$age" ]; then
  second_updated=$(jq -r '.updated_at // ""' "$second" 2>/dev/null)
  case "$second_updated" in
    '' | *[!0-9]*) ;;
    *)
      gap=$(( updated_at - second_updated ))
      [ "$gap" -lt 0 ] && gap=$(( -gap ))
      if [ "$gap" -lt 60 ]; then
        printf 'warning: another session updated its snapshot within the last minute - this may not be your session (%s)\n' "$second"
      fi
      ;;
  esac
fi
