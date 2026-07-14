- Shadow paths - the following patterns are overlaid with container-local storage and do not reflect the host filesystem (git-tracked paths are skipped):
{{pattern_list}}
  - Matching paths start empty but may accumulate container-local content over time (e.g. `npm install` populates a shadowed `node_modules`). Do not assume they are empty, and do not attempt to sync or restore their host contents.
