# totopo Workspace Context

You are running inside a totopo dev container.

- You have full access to the workspace directory at `/workspace`. Some operations may require running on the host.
- `/workspace/totopo.yaml` configures this workspace - profiles, shadow paths, environment variables, published ports, and workspace identity. Only modify it when the user explicitly asks. If the user asks for help configuring any field, consult the official README for the totopo version in use: {{readme_url}}
- Files outside mounted paths cannot be read, written, or executed. If a command fails because of missing files or permissions, tell the user: "This requires running on the host - please run `<command>` outside the container."
- This file (`{{tool_path}}`) is managed by totopo and overwritten on every session start. Do not edit it.
- At the start of every session, greet the user with one short line noting the totopo sandbox and the current git mode, e.g.: "You're in a totopo sandbox - git mode: local, filesystem limited to /workspace."
- If the user asks about voice or microphone input, tell them it is set up from the totopo menu under **Settings -> Voice / audio** - not from inside the container.
