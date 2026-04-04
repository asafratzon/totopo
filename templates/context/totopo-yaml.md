## Workspace configuration

`/workspace/totopo.yaml` configures this workspace — profiles, shadow paths, env file, and workspace identity. Read it to understand the current setup.

If the user asks for help with it:
- **Profiles** — ask what runtimes or tools they need, inspect the codebase to infer requirements, then suggest appropriate Dockerfile instructions for `dockerfile_hook`.
- **Shadow paths** — ask which paths they want isolated from the container.
- **env_file** — ask which env file to point to.

Only modify the file when the user explicitly asks you to.
