## Backlog

- Webterm:

    - Web agent interface: per-URL token, so only a browser that was handed the URL can open the relay.
        - Today the only gate is the browser Origin check. The server binds `0.0.0.0` inside the container (required for the published port to work), so any local process, and any container on the same Docker network, can reach it and forge that header.
        - The URL now reaches every session in the container and sessions live until the container stops, so what is behind the port is more than one conversation.

    - Web agent interface: relay more than one agent at a time.
        - One server relays one agent, so switching agents means stopping the live one. The session registry already keeps sessions separate, so what is missing is a per-session agent choice (and a way to pick it in the browser).

    - innate skill to illustrate things, like long responses, plans etc - so they appear as html in a minizable pane that allow navigation between previous ones perhaps? thinkg of a simple and robust design.

- Local LLM Support?

- True sandboxing in terms of secrets or env vars?
