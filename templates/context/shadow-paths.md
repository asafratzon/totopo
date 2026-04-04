## Shadow paths

The following patterns are overlaid with container-local storage and do not reflect
the host filesystem:

{{pattern_list}}

Matching paths are initialized empty on first use. The container may accumulate
content in them over time (for example, a shadowed `node_modules` gets
populated when you run `npm install` inside the container). Do not assume they
are empty, and do not attempt to sync or restore their host contents.
