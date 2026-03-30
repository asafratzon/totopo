The project is at a turning point — a major simplification from v2 to v3.

There is an existing PLAN.md in the repo root written by a previous session. Do not follow it blindly. It contains useful context and was reviewed for correctness, but you should form your own understanding by reading the codebase and build your own implementation plan. Use PLAN.md as a reference, not as instructions. Delete it when you're done.


### What is changing and why

totopo currently supports two Dockerfile generation modes (host-mirror / full), stores per-project config in `~/.totopo/projects/<id>/settings.json`, copies a `Dockerfile` and `post-start.mjs` into each project's config dir, and requires a multiselect tool picker during onboarding.

The new model simplifies all of this:

- `templates/Dockerfile` in the package is the hardcoded essentials base (Node.js LTS, git, AI CLIs, security layer). No optional runtime layers.
- `totopo.yaml` in the project root becomes the single project config file (shared, committed to git): shadow paths + a raw `dockerfile_extra` Dockerfile snippet the user controls.
- `~/.totopo/projects/<id>/` shrinks to just `meta.json` + `agents/` + `shadows/`. No `Dockerfile`, no `post-start.mjs`, no `settings.json`.
- `post-start.mjs` is `COPY`-ed into the image from `templates/` at build time (baked in, not mounted).
- The Dockerfile is generated in memory at build time: base + `dockerfile_extra` + `USER devuser` appended last -> written to OS temp file -> `docker build -f <tempfile> <packageDir>/templates` -> temp file deleted.
- on totopo menu startup, npm registry version check runs only once per day, cached in `~/.totopo/state.json`, if a new version is published `~/.totopo/state.json`, show notice for the user with link to github releases page.

### Feasibility already proven

A test in `temp/` (can be deleted) confirmed that:
- Reading `templates/Dockerfile`, appending `dockerfile_extra` from `totopo.yaml` in memory, writing to a temp file, and running `docker build -f <tempfile> <context>` works correctly.
- `COPY post-start.mjs` resolves correctly when the build context is `<packageDir>/templates`.
- `USER devuser` appended last by totopo (not by the user's snippet) is enforced correctly.


### What needs to change and why
1. Eliminate runtime modes (host-mirror / full)
Currently totopo has two Dockerfile generation modes. "Host-mirror" detects what runtimes are on the user's machine and generates a Dockerfile pinned to those versions. "Full" uses a template with everything at latest versions. This involves a multiselect tool picker, host runtime detection, dynamic Dockerfile generation, and a sync-on-every-run mechanism.
All of this is being removed. Instead:
- The package ships a single templates/Dockerfile containing only the essentials: OS base, Node.js, git, AI CLIs (opencode, claude, codex), security layer (non-root user, git remote block), and core dev tools.
- If users need Python, Go, Rust, Bun, Java, or any project-specific tooling, they add raw Dockerfile instructions to a dockerfile_extra field in totopo.yaml. This gives them full flexibility without totopo needing to understand every possible runtime.
- USER devuser must always be the final instruction in the built Dockerfile. totopo owns this line — it is appended after the user's dockerfile_extra, never part of the base template and never the user's responsibility.
2. Make totopo.yaml the single project config file
Currently totopo.yaml is optional (a "project anchor" for shared onboarding). Project settings like runtime mode and selected tools live in ~/.totopo/projects/<id>/settings.json, hidden from the user.
This changes to:
- totopo.yaml is always created at onboarding (no longer a "shared vs local" choice).
- Shadow paths (which directories to overlay with container-local storage) move from settings.json into totopo.yaml as shadow_paths. This makes them visible, version-controlled, and shareable with the team.
- dockerfile_extra lives in totopo.yaml as described above.
- settings.json is eliminated entirely — nothing remains that needs it.
- The default totopo.yaml created at onboarding should include commented-out examples showing how to use shadow_paths and dockerfile_extra, so users can see the possibilities without reading docs.
3. Stop storing generated files in ~/.totopo/projects/<id>/
Currently each project dir under ~/.totopo/ contains a generated Dockerfile, a copy of post-start.mjs, and settings.json. After this change:
- ~/.totopo/projects/<id>/ contains only: meta.json (project identity), agents/ (AI agent memory — never touched by totopo), and shadows/ (container-local overlay content).
- The Dockerfile is generated in memory at build time (base template + dockerfile_extra + USER devuser), written to an OS temp file, passed to docker build, then deleted. It is never persisted in ~/.totopo/.
- post-start.mjs is baked into the Docker image via COPY from the package's templates/ directory at build time. It is never copied to ~/.totopo/.

4. Simplified onboarding
The onboarding flow loses several steps:
- No more runtime mode selection (host-mirror vs full)
- No more tool picker (multiselect of Python, Go, Rust, etc.)
- No more "shared vs local" scope question (totopo.yaml is always created)
- What remains: detect project root, confirm it, non-git warning if applicable, create ~/.totopo/.env if needed, register the project, create totopo.yaml with commented examples if it doesn't already exist.
