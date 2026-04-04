## Constraints

- Files outside mounted paths cannot be read, written, or executed.
- If a command fails because of missing files or permissions, tell the user: "This requires running on the host — please run `<command>` outside the container."
- This file (`{{tool_path}}`) is managed by totopo and overwritten on every session start. Do not edit it.
