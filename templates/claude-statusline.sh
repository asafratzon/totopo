#!/bin/sh
# =============================================================================
# Default Claude Code status line shipped by totopo.
# Baked into the container image at /usr/local/share/totopo/claude-statusline.sh
# Referenced from ~/.claude/settings.json -> statusLine.command
#
# Render pattern (4 segments separated by mid-dot):
#   1. <tokens>k / <ctx> (<pct>%)
#   2. <model> <effort>
#   3. Claude Code v<version> (<age>[, hint])
#   4. <bar> (<rate>% used, resets in <hr> hr <min> min)
#
# Designed to degrade gracefully: every field uses jq's // fallback, and any field that goes
# missing in a future Claude Code release is silently skipped rather than failing the script.
# The Claude Code segment is also skipped silently when its data sources are unavailable.
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
GREY_LIGHT='\033[38;5;245m'
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
    # Rounding tiers protect the two endpoints from misleading reads:
    #   exactly 0  -> empty bar; any non-zero usage rounds up to at least 1 block
    #   1-9        -> 1 block (round up so a sliver never reads as empty)
    #   10-90      -> nearest 10 (round half up via int((r+5)/10))
    #   91-99      -> 9 blocks (round down so the bar never reads as full until truly 100)
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
  IFS= read -r bar
} <<EOF
$awk_out
EOF

# Bar color by rate-limit usage: <50% light grey, <80% yellow, >=80% red.
# Light grey at the calm baseline keeps the line quiet until usage actually warrants attention.
bar_color="$GREY_LIGHT"
if [ -n "$rate_pct" ]; then
  if [ "$rate_pct" -lt 50 ]; then
    bar_color="$GREY_LIGHT"
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
      cc_now=$(date +%s)
      cc_age_days=$(( (cc_now - cc_secs) / 86400 ))
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

# Segment 1: tokens (always rendered; used_tokens defaults to 0).
ctx_seg="${tokens_color}${tokens_label}${RESET}"
[ -n "$ctx_size" ] && ctx_seg="${ctx_seg} ${GREY}/ ${ctx_size}${RESET}"
ctx_seg="${ctx_seg} ${GREY}(${used_pct}%)${RESET}"

# Segment 2: model + effort (rendered only when model name is present; effort shares model color).
model_seg=""
if [ -n "$model_display" ]; then
  model_seg="${BLUE}${model_display}${RESET}"
  [ -n "$effort" ] && model_seg="${model_seg} ${BLUE}${effort}${RESET}"
fi

# Segment 3: cc_seg (computed above; may be empty).

# Segment 4: rate-limit gauge (rendered only when rate-limit data is present).
quota_seg=""
if [ -n "$bar" ] && [ -n "$reset_label" ]; then
  quota_seg="${bar_color}${bar}${RESET} ${GREY}(${rate_pct}% used, resets in ${reset_label})${RESET}"
fi

# Join non-empty segments with SEP, in order: tokens -> model -> claude-code -> gauge.
out=""
for seg in "$ctx_seg" "$model_seg" "$cc_seg" "$quota_seg"; do
  [ -z "$seg" ] && continue
  if [ -z "$out" ]; then
    out="$seg"
  else
    out="${out}${SEP}${seg}"
  fi
done

printf '%b\n' "$out"
