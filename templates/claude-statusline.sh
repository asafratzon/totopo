#!/bin/sh
# =============================================================================
# Default Claude Code status line shipped by totopo.
# Baked into the container image at /usr/local/share/totopo/claude-statusline.sh
# Referenced from ~/.claude/settings.json -> statusLine.command
#
# Render pattern:
#   <model> <effort> · <tokens>k / <ctx> (<pct>%) · <bar> (<rate>% used, resets in <hr> hr <min> min)
#
# Designed to degrade gracefully: every field uses jq's // fallback, and any field that goes
# missing in a future Claude Code release is silently skipped rather than failing the script.
#
# To customize or revert, ask Claude: /totopo-statusline
# =============================================================================

# Single jq invocation for all fields, separated by newlines. Every path uses // fallbacks so a
# missing or renamed field becomes an empty string, which downstream branches handle as "skip".
# jq itself returns no output (empty parsed) on malformed input, which still produces a valid line.
# Tokens floor-rounded; percentages rounded to integers so downstream shell uses them as-is.
parsed=$(jq -r '
    .model.display_name // "",
    ((.context_window.used_percentage // 0) | round),
    (((.context_window.current_usage.input_tokens // 0)
      + (.context_window.current_usage.cache_creation_input_tokens // 0)
      + (.context_window.current_usage.cache_read_input_tokens // 0)) | floor),
    .effort.level // "",
    (.rate_limits.five_hour.used_percentage | if . == null then "" else round end),
    (.rate_limits.five_hour.resets_at // "")
' 2>/dev/null)

{
  IFS= read -r model_full
  IFS= read -r used_pct
  IFS= read -r used_tokens
  IFS= read -r effort
  IFS= read -r rate_pct
  IFS= read -r rate_resets_at
} <<EOF
$parsed
EOF

# Split "Opus 4.7 (1M context)" into model "Opus 4.7" + ctx_size "1M" via POSIX parameter expansion.
ctx_size=""
model_display="$model_full"
case "$model_full" in
  *"("*")"*)
    inside=${model_full#*\(}
    inside=${inside%%\)*}
    ctx_size=${inside% context}
    model_display=${model_full%% \(*}
    ;;
esac

# Colors
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
BLUE='\033[34m'
GREY='\033[90m'
RESET='\033[0m'

# Normalize tokens & pct (may arrive empty when current_usage is null).
[ -z "$used_tokens" ] && used_tokens=0
[ -z "$used_pct" ] && used_pct=0

# Token color by absolute count: <100k green, 100k-500k yellow, >500k red.
if [ "$used_tokens" -lt 100000 ]; then
  tokens_color="$GREEN"
elif [ "$used_tokens" -le 500000 ]; then
  tokens_color="$YELLOW"
else
  tokens_color="$RED"
fi

# Format tokens label + 10-char quota bar in a single awk pass. Each bar block = 10% of the window.
# rate_pct arrives pre-rounded from jq (or empty string when the field is absent).
awk_out=$(awk -v t="$used_tokens" -v r="$rate_pct" 'BEGIN {
  if (t == 0) printf "0k\n";
  else if (t >= 100000) printf "%dk\n", int(t/1000 + 0.5);
  else printf "%.1fk\n", t/1000;

  if (r != "") {
    if (r > 100) r = 100;
    if (r < 0) r = 0;
    filled = int(r / 10);
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
  IFS= read -r bar
} <<EOF
$awk_out
EOF

# Bar color by rate-limit usage: <50% green, <80% yellow, >=80% red.
bar_color="$GREEN"
if [ -n "$rate_pct" ]; then
  if [ "$rate_pct" -lt 50 ]; then
    bar_color="$GREEN"
  elif [ "$rate_pct" -lt 80 ]; then
    bar_color="$YELLOW"
  else
    bar_color="$RED"
  fi
fi

# Time until the rate-limit window resets, formatted as "X hr Y min" / "Y min" / "X day Y hr".
# Skipped silently when resets_at is missing or non-numeric (forward compat with future schemas).
reset_label=""
case "$rate_resets_at" in
  '' | *[!0-9]*) ;;
  *)
    now=$(date +%s)
    secs=$((rate_resets_at - now))
    [ "$secs" -lt 60 ] && secs=60
    total_min=$(((secs + 30) / 60))
    if [ "$total_min" -lt 60 ]; then
      reset_label="${total_min} min"
    elif [ "$total_min" -lt 1440 ]; then
      hr=$((total_min / 60))
      min=$((total_min % 60))
      if [ "$min" -eq 0 ]; then
        reset_label="${hr} hr"
      else
        reset_label="${hr} hr ${min} min"
      fi
    else
      day=$((total_min / 1440))
      hr=$(((total_min % 1440) / 60))
      if [ "$hr" -eq 0 ]; then
        reset_label="${day} day"
      else
        reset_label="${day} day ${hr} hr"
      fi
    fi
    ;;
esac

# Mid-dot separator between segments.
SEP=" ${GREY}·${RESET} "

# Model + effort
out=""
if [ -n "$model_display" ]; then
  out="${BLUE}${model_display}${RESET}"
  [ -n "$effort" ] && out="${out} ${GREY}${effort}${RESET}"
fi

# <tokens> [/ <ctx>] (<pct>%)
ctx_seg="${tokens_color}${tokens_label}${RESET}"
[ -n "$ctx_size" ] && ctx_seg="${ctx_seg} ${GREY}/ ${ctx_size}${RESET}"
ctx_seg="${ctx_seg} ${GREY}(${used_pct}%)${RESET}"
if [ -n "$out" ]; then
  out="${out}${SEP}${ctx_seg}"
else
  out="${ctx_seg}"
fi

# <bar> (<rate>% used, resets in <hr> hr <min> min)  -- only when rate-limit data is present
if [ -n "$bar" ] && [ -n "$reset_label" ]; then
  quota_seg="${bar_color}${bar}${RESET} ${GREY}(${rate_pct}% used, resets in ${reset_label})${RESET}"
  out="${out}${SEP}${quota_seg}"
fi

printf '%b\n' "$out"
