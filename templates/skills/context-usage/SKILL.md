---
name: context-usage
description: Report the current session's context-window and rate-limit (quota) usage. Use whenever the user asks how much context, tokens, or quota is used or left, how full the context window is, or when the rate limit resets.
---

# context-usage: Report context and quota usage

In a totopo container you CAN see your own context-window and rate-limit usage.
The Claude Code status line writes a per-session snapshot on every prompt render; a bundled helper reads it back.

## Procedure

1. Run:

   ```bash
   context-usage
   ```

   Example output:

   ```
   session: 78b4025b-... (this session, updated 3s ago)
   context: 70.8k tokens (7% of 1M window)
   quota:   84% remaining, resets in 21m
   model:   Fable 5 (effort high)
   ```

   The window size is named when the snapshot knows it, and left out ("7% of window") when it does not.

2. Answer in ONE short line, in exactly this shape:

   > Context: 70.8k tokens (7%) - quota: 84% left, resets in 21m.

   If the user asked only about context or only about quota, answer with just that half.
   Expand beyond one line only when the user explicitly asks for more detail.
   Do not add commentary, interpretation, or advice.

3. Caveats are the exception, not the norm.
   The `(this session, ...)` marker on the session line means the snapshot is guaranteed to be this session's own - say nothing about it.
   Only when the marker is absent AND the output contains a `warning:` line, append one short sentence relaying that warning.

## Interpretation notes

- The snapshot reflects usage as of the moment the current prompt was submitted; tokens consumed during the in-flight turn are not included yet.
  No need to mention this unless asked.
- The `quota` line refers to the 5-hour rate-limit window and is absent when Claude Code did not report rate-limit data.
- In the web interface the same numbers are already on screen, as a strip above the composer, so a session reached through a browser has no status line to read - the snapshot is still written and this still works.

## Fallback

If the `context-usage` command is not found, read the snapshot directly: list `~/.claude/context-usage/*.json`, pick the most recently modified file, and interpret its fields - `context_tokens`, `context_used_pct`, `context_window_size`, `model`, `effort`, `quota_left_pct`, `quota_resets_at` (epoch seconds), `version` (the installed Claude Code version), `updated_at` (epoch seconds), `session_id`.
Any of them can be `null` or absent when Claude Code did not report it; leave that part of the answer out rather than guessing.

If the command does not exist AND there are no snapshot files either, the container image predates this feature.
In that case tell the user to rebuild the image: start a new totopo session on the host and accept the rebuild prompt.

If the command exists but no snapshot files do, the status line has not rendered yet in any Claude session; say so rather than guessing values.
