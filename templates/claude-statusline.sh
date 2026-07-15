#!/bin/sh
# =============================================================================
# Default Claude Code status line shipped by totopo.
# Baked into the container image at /usr/local/share/totopo/claude-statusline.sh
# Referenced from ~/.claude/settings.json -> statusLine.command
#
# Render pattern (4 segments separated by mid-dot):
#   1. <robot icon> <model_full> <effort>
#   2. <brain icon> <tokens>k / <window size> (<pct>%)
#   3. <lightning icon> <bar> <pct remaining>% (<plug icon> <Xh Ym>)
#   4. Claude Code v<version> (<age>[, hint])
#
# Designed to degrade gracefully: every field uses jq's // fallback, and any field that goes
# missing in a future Claude Code release is silently skipped rather than failing the script.
# The Claude Code segment is also skipped silently when its data sources are unavailable.
#
# Side effect: writes a per-session snapshot of the parsed data to
# ~/.claude/context-usage/<session_id>.json so agents can inspect their own context/quota
# usage (see the context-usage helper). Best-effort: any failure is silent and the visible
# line is never affected. Old snapshots are cleaned by startup.mjs at session start.
#
# To customize or revert, ask Claude: /totopo-statusline
# =============================================================================

# Resolve the pid of this session's Claude CLI process: the nearest ancestor whose comm is
# exactly "claude" (npm bin) or a node process running claude-code. Recorded in the snapshot
# so the context-usage helper -- which runs as a descendant of the SAME process -- can match
# the snapshot to its own session deterministically. Prints nothing when resolution fails
# (no /proc, unexpected tree); readers then fall back to newest-by-mtime.
# Exact comm match matters: this script's own comm is "claude-statusli" when executed directly.
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
    # Stat format is "pid (comm) state ppid ..." and comm may contain anything; strip
    # through the last ")" so the remainder starts with state, then take field 2.
    fcp_rest="${fcp_stat##*) }"
    set -- $fcp_rest
    fcp_pid=$2
  done
}

# Start time of a process (jiffies since host boot, /proc/<pid>/stat field 22). Recorded next
# to the pid: snapshots persist in the bind-mounted home across container restarts while pids
# get recycled, so only the (pid, start time) pair identifies a process unambiguously.
# Prints nothing when the pid or /proc is unavailable; readers then match on the pid alone.
proc_start_time() {
  read -r pst_stat < "/proc/$1/stat" 2>/dev/null || return
  pst_rest="${pst_stat##*) }"
  set -- $pst_rest
  printf '%s' "${20}"
}

# Digits-only guards keep the jq tonumber below safe. TOTOPO_CLAUDE_PID and
# TOTOPO_CLAUDE_PID_START are test/debug overrides.
claude_pid="${TOTOPO_CLAUDE_PID:-$(find_claude_pid)}"
case "$claude_pid" in *[!0-9]*) claude_pid="" ;; esac
claude_pid_start=""
[ -n "$claude_pid" ] && claude_pid_start="${TOTOPO_CLAUDE_PID_START:-$(proc_start_time "$claude_pid")}"
case "$claude_pid_start" in *[!0-9]*) claude_pid_start="" ;; esac

# Single jq invocation for all fields, separated by newlines. Every path uses // fallbacks so a
# missing or renamed field becomes an empty string, which downstream branches handle as "skip".
# jq itself aborts (empty or partial parsed) on malformed input, which still produces a valid line.
# Tokens floor-rounded; percentages rounded to integers so downstream shell uses them as-is.
# The rate limit is inverted at the source: the API reports percentage USED, the status line
# shows percentage REMAINING (energy-left metaphor: full bar and green when fresh), clamped to
# 0..100 so an over-limit report never renders a negative percentage.
# Each value is bound once and reused for both the render lines and the snapshot object, so the
# visible line and what the context-usage helper reads can never disagree.
parsed=$(jq -r --arg claude_pid "$claude_pid" --arg claude_pid_start "$claude_pid_start" '
    ((.model.display_name // "") | split(" (") | .[0]) as $model |
    ((.context_window.used_percentage // 0) | round) as $ctx_pct |
    (.context_window.total_input_tokens // 0) as $tokens |
    (.context_window.context_window_size // 0) as $ctx_size |
    (.effort.level // "") as $effort |
    (.rate_limits.five_hour.used_percentage
        | if . == null then "" else ((100 - round) | if . < 0 then 0 elif . > 100 then 100 else . end) end) as $quota_left |
    (.rate_limits.five_hour.resets_at // "") as $resets |
    (.session_id // "") as $sid |
    $model, $ctx_pct, $tokens, $ctx_size, $effort, $quota_left, $resets, $sid,
    ({
        session_id: $sid,
        claude_pid: (if $claude_pid == "" then null else ($claude_pid | tonumber) end),
        claude_pid_start: (if $claude_pid_start == "" then null else ($claude_pid_start | tonumber) end),
        updated_at: (now | floor),
        context_tokens: $tokens,
        context_used_pct: $ctx_pct,
        model: $model,
        effort: $effort,
        quota_left_pct: (if $quota_left == "" then null else $quota_left end),
        quota_resets_at: (if $resets == "" then null else $resets end)
    } | tojson)
' 2>/dev/null)

{
  IFS= read -r model_full
  IFS= read -r used_pct
  IFS= read -r used_tokens
  IFS= read -r ctx_size
  IFS= read -r effort
  IFS= read -r rate_left
  IFS= read -r rate_resets_at
  IFS= read -r session_id
  IFS= read -r snapshot_json
} <<EOF
$parsed
EOF

# The session id becomes a filename below; allow only safe characters (Claude Code emits a
# UUID). Anything unexpected (or an absent id) skips the snapshot write entirely.
case "$session_id" in ''|*[!A-Za-z0-9-]*) session_id="" ;; esac

# Capture "now" once for both the rate-limit countdown and the Claude Code freshness check.
# Status line runs on every prompt render, so avoid spawning `date` twice.
now_epoch=$(date +%s)

# Colors
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
BLUE='\033[34m'
PURPLE='\033[38;5;177m'
GREY='\033[90m'
GREY_LIGHT='\033[38;5;245m'
RESET='\033[0m'

# Unicode variation selector VS16 (U+FE0F) forces colorful emoji presentation for glyphs
# that would otherwise render as monochrome text. Terminals that ignore it render the default.
# The quotes hold the invisible selector character itself (a literal spares a fork per render).
VS16='️'

# Normalize tokens & pct to integers (may arrive empty, non-numeric, or fractional when
# current_usage is null or the JSON schema changes in a future Claude Code release).
case "$used_tokens" in ''|*[!0-9]*) used_tokens=0 ;; esac
case "$used_pct"    in ''|*[!0-9]*) used_pct=0    ;; esac
case "$ctx_size"    in ''|*[!0-9]*) ctx_size=0    ;; esac

# Token color by absolute count: <100k green, 100k-500k yellow, >500k red.
if [ "$used_tokens" -lt 100000 ]; then
  tokens_color="$GREEN"
elif [ "$used_tokens" -le 500000 ]; then
  tokens_color="$YELLOW"
else
  tokens_color="$RED"
fi

# Format tokens label + context-window size label + 10-char quota bar in a single awk pass.
# Each bar block = 10% remaining. rate_left arrives pre-inverted and pre-rounded from jq (or empty
# string when the field is absent). w is the context window size (0 when unknown -> empty label).
awk_out=$(awk -v t="$used_tokens" -v w="$ctx_size" -v r="$rate_left" 'BEGIN {
  if (t == 0) printf "0k\n";
  else if (t >= 100000) printf "%dk\n", int(t/1000 + 0.5);
  else printf "%.1fk\n", t/1000;

  # Window size label: whole millions as "1M", other millions as "1.5M", smaller as "200k".
  if (w == 0) printf "\n";
  else if (w >= 1000000 && w % 1000000 == 0) printf "%dM\n", w/1000000;
  else if (w >= 1000000) printf "%.1fM\n", w/1000000;
  else printf "%dk\n", int(w/1000 + 0.5);

  if (r != "") {
    if (r > 100) r = 100;
    if (r < 0) r = 0;
    # Rounding tiers protect the two endpoints from misleading reads:
    #   exactly 0  -> empty bar (quota exhausted)
    #   1-9        -> 1 block (round up so a last sliver of quota never reads as empty)
    #   10-90      -> nearest 10 (round half up via int((r+5)/10))
    #   91-99      -> 9 blocks (round down so the bar never reads as full until truly untouched)
    #   exactly 100 -> full bar
    if (r <= 0) filled = 0;
    else if (r >= 100) filled = 10;
    else if (r > 90) filled = 9;
    else if (r < 10) filled = 1;
    else filled = int((r + 5) / 10);
    bar = "";
    for (i = 0; i < filled; i++) bar = bar "▓";
    for (i = filled; i < 10; i++) bar = bar "░";
    printf "%s\n", bar;
  } else {
    printf "\n";
  }
}')

{
  IFS= read -r tokens_label
  IFS= read -r window_label
  IFS= read -r bar
} <<EOF
$awk_out
EOF

# Bar color by quota remaining: >50% green (plenty left), 21-50% yellow, <=20% red.
# Thresholds mirror the old usage-based tiers (used >=50 warned, >=80 alarmed).
bar_color="$GREEN"
if [ -n "$rate_left" ] && [ "$rate_left" -le 50 ]; then
  if [ "$rate_left" -gt 20 ]; then
    bar_color="$YELLOW"
  else
    bar_color="$RED"
  fi
fi

# Relative countdown until the rate-limit window resets (e.g. "2h 15m", "43m").
# Uses a delta from now so the display is correct regardless of container timezone.
# Skipped silently when resets_at is missing or non-numeric (forward compat with future schemas).
reset_label=""
case "$rate_resets_at" in
  '' | *[!0-9]*) ;;
  *)
    delta=$(( rate_resets_at - now_epoch ))
    if [ "$delta" -gt 0 ]; then
      delta_h=$(( delta / 3600 ))
      delta_m=$(( (delta % 3600) / 60 ))
      if [ "$delta_h" -gt 0 ]; then
        reset_label="${delta_h}h ${delta_m}m"
      else
        reset_label="${delta_m}m"
      fi
    else
      reset_label="now"
    fi
    ;;
esac

# Claude Code installed version + freshness of last update.
# Version comes from the npm package metadata; the timestamp file is written at image build time
# (Dockerfile) and at session start by startup.mjs after a successful `npm install -g ... @latest`.
# Both paths are stable and outside the default shadow patterns.
cc_pkg="/usr/lib/node_modules/@anthropic-ai/claude-code/package.json"
cc_ts_file="/home/devuser/.ai-cli-updated"

cc_version=""
[ -r "$cc_pkg" ] && cc_version=$(jq -r '.version // ""' "$cc_pkg" 2>/dev/null)

# Days since last successful update; clamped to >= 0 to absorb clock skew.
# Empty string when the timestamp file is missing or unparseable -- segment then omits the parens.
cc_age_days=""
if [ -r "$cc_ts_file" ]; then
  cc_iso=$(tr -d '[:space:]' < "$cc_ts_file" 2>/dev/null)
  if [ -n "$cc_iso" ]; then
    cc_secs=$(date -d "$cc_iso" +%s 2>/dev/null)
    if [ -n "$cc_secs" ]; then
      cc_age_days=$(( (now_epoch - cc_secs) / 86400 ))
      [ "$cc_age_days" -lt 0 ] && cc_age_days=0
    fi
  fi
fi

# Build the Claude Code segment. Empty when version is unknown.
# Age tiers (whole parens content takes the staleness color):
#   <1d   -> no parens          (fresh: just the version)
#   1-6d  -> "Nd ago"           grey
#   7-29d -> "Nw ago, <hint>"   yellow
#   >=30d -> "Nmo ago, <hint>"  red
# Hint reads "open a new totopo session to update" -- the auto-update only runs at container start,
# so restarting Claude inside the same container does not refresh the CLI.
cc_seg=""
if [ -n "$cc_version" ]; then
  cc_seg="${GREY_LIGHT}Claude Code v${cc_version}${RESET}"
  if [ -n "$cc_age_days" ] && [ "$cc_age_days" -ge 1 ]; then
    if [ "$cc_age_days" -lt 7 ]; then
      cc_age_label="${cc_age_days}d ago"
      cc_age_color="$GREY"
    elif [ "$cc_age_days" -lt 30 ]; then
      cc_weeks=$((cc_age_days / 7))
      cc_age_label="${cc_weeks}w ago, open a new totopo session to update"
      cc_age_color="$YELLOW"
    else
      cc_months=$((cc_age_days / 30))
      cc_age_label="${cc_months}mo ago, open a new totopo session to update"
      cc_age_color="$RED"
    fi
    cc_seg="${cc_seg} ${cc_age_color}(${cc_age_label})${RESET}"
  fi
fi

# Mid-dot separator between segments.
SEP=" ${GREY}·${RESET} "

# Segment 2: context-window usage (always rendered; used_tokens defaults to 0).
# Shows used tokens, then the window size and percentage in grey (e.g. "108k / 1M (11%)").
# The size half is dropped when context_window_size is unknown, leaving "108k (11%)".
if [ -n "$window_label" ]; then
  ctx_seg="🧠 ${tokens_color}${tokens_label}${RESET} ${GREY}/ ${window_label} (${used_pct}%)${RESET}"
else
  ctx_seg="🧠 ${tokens_color}${tokens_label}${RESET} ${GREY}(${used_pct}%)${RESET}"
fi

# Segment 1: model display name + effort (rendered only when model name is present).
# model_full is the display name with any " (...)" parenthetical stripped (e.g. "Opus 4.8"); the
# window size it used to carry now shows in the context segment instead.
# Effort renders unparenthesized in purple -- the color shift is the cue that it is a separate field.
model_seg=""
if [ -n "$model_full" ]; then
  model_seg="🤖 ${BLUE}${model_full}${RESET}"
  [ -n "$effort" ] && model_seg="${model_seg} ${PURPLE}${effort}${RESET}"
fi

# Segment 3: rate-limit gauge (rendered only when rate-limit data is present).
quota_seg=""
if [ -n "$bar" ] && [ -n "$reset_label" ]; then
  quota_seg="⚡${VS16} ${bar_color}${bar}${RESET} ${bar_color}${rate_left}%${RESET} ${GREY}(🔌 ${reset_label})${RESET}"
fi

# Segment 4: cc_seg (computed above; may be empty).

# Join non-empty segments with SEP, in order: model -> tokens -> gauge -> claude-code.
out=""
for seg in "$model_seg" "$ctx_seg" "$quota_seg" "$cc_seg"; do
  [ -z "$seg" ] && continue
  if [ -z "$out" ]; then
    out="$seg"
  else
    out="${out}${SEP}${seg}"
  fi
done

printf '%b\n' "$out"

# Persist the per-session snapshot AFTER the visible line is flushed, so nothing here can
# corrupt the status line. Temp file + mv in the same directory = atomic rename; concurrent
# sessions write distinct files, so no locking is needed. Dotted temp names never match the
# *.json globs used by readers; orphans and old snapshots are cleaned up by startup.mjs.
# Each render is its own process, so $$ makes the temp name unique without spawning mktemp.
if [ -n "$session_id" ] && [ -n "$snapshot_json" ]; then
  snap_dir="${HOME:-/home/devuser}/.claude/context-usage"
  snap_tmp="$snap_dir/.tmp.$$"
  {
    [ -d "$snap_dir" ] || mkdir -p "$snap_dir"
    printf '%s\n' "$snapshot_json" > "$snap_tmp" &&
    mv -f "$snap_tmp" "$snap_dir/$session_id.json"
  } 2>/dev/null || rm -f "$snap_tmp" 2>/dev/null
fi
