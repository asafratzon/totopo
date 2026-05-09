#!/bin/sh
# =============================================================================
# Default Claude Code status line shipped by totopo.
# Baked into the container image at /usr/local/share/totopo/claude-statusline.sh
# Referenced from ~/.claude/settings.json -> statusLine.command
#
# Render pattern (4 segments separated by mid-dot):
#   1. <tokens>k (<pct>%)
#   2. <model_full> <effort>
#   3. <bar> (resets in <Xh Ym>)
#   4. Claude Code v<version> (<age>[, hint])
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
    (.context_window.total_input_tokens // 0),
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

# Colors
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
BLUE='\033[34m'
PURPLE='\033[38;5;177m'
GREY='\033[90m'
GREY_LIGHT='\033[38;5;245m'
RESET='\033[0m'

# Normalize tokens & pct to integers (may arrive empty, non-numeric, or fractional when
# current_usage is null or the JSON schema changes in a future Claude Code release).
case "$used_tokens" in ''|*[!0-9]*) used_tokens=0 ;; esac
case "$used_pct"    in ''|*[!0-9]*) used_pct=0    ;; esac

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

# Bar color by rate-limit usage: <50% light grey (calm baseline), 50-79% yellow, >=80% red.
# Light grey keeps the line quiet until usage actually warrants attention.
bar_color="$GREY_LIGHT"
if [ -n "$rate_pct" ] && [ "$rate_pct" -ge 50 ]; then
  if [ "$rate_pct" -lt 80 ]; then
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
    now_epoch=$(date +%s)
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
ctx_seg="${tokens_color}${tokens_label}${RESET} ${GREY}(${used_pct}%)${RESET}"

# Segment 2: model display name + effort (rendered only when model name is present).
# model_full is rendered as-is (e.g. "Opus 4.7 (1M context)") -- future-proof and requires no parsing.
# Effort renders unparenthesized in purple to avoid double-parens when the model name itself
# already contains a parenthetical (e.g. "Opus 4.7 (1M context)") -- the color shift is the cue.
model_seg=""
if [ -n "$model_full" ]; then
  model_seg="${BLUE}${model_full}${RESET}"
  [ -n "$effort" ] && model_seg="${model_seg} ${PURPLE}${effort}${RESET}"
fi

# Segment 3: rate-limit gauge (rendered only when rate-limit data is present).
quota_seg=""
if [ -n "$bar" ] && [ -n "$reset_label" ]; then
  quota_seg="${GREY}5h limit${RESET} ${bar_color}${bar}${RESET} ${GREY}(resets in ${reset_label})${RESET}"
fi

# Segment 4: cc_seg (computed above; may be empty).

# Join non-empty segments with SEP, in order: tokens -> model -> gauge -> claude-code.
out=""
for seg in "$ctx_seg" "$model_seg" "$quota_seg" "$cc_seg"; do
  [ -z "$seg" ] && continue
  if [ -z "$out" ]; then
    out="$seg"
  else
    out="${out}${SEP}${seg}"
  fi
done

printf '%b\n' "$out"
