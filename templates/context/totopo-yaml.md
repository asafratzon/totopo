## Workspace configuration

`/workspace/totopo.yaml` configures this workspace — profiles, shadow paths, env file, published ports, and workspace identity. Read it to understand the current setup.

If the user asks for help with it:
- **Profiles** — ask what runtimes or tools they need, inspect the codebase to infer requirements, then suggest appropriate Dockerfile instructions for `dockerfile_hook`.
- **Shadow paths** — ask which paths they want isolated from the container.
- **env_file** — ask which env file to point to.
- **Published ports** — to reach a server running in the container from the host browser, ask which port it listens on and add it under `ports` (published loopback-only on 127.0.0.1). This takes effect on the host after the container is recreated, not from inside this session.

Only modify the file when the user explicitly asks you to.
