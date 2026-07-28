import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { describe, test } from "node:test";
import { WEB_CONTAINER_PORT } from "../src/lib/constants.js";
import {
    assertHostPortsAvailable,
    formatPortNotice,
    formatWebRange,
    inRange,
    type PortMapping,
    parsePublishedPorts,
    parseWebRange,
    portEnvArgs,
    portPublishArgs,
    portsLabel,
    validatePortsConfig,
} from "../src/lib/ports.js";

// ---- Test helpers -----------------------------------------------------------------------------------------------------------------------

// Bind an ephemeral loopback port and return the socket plus its number, so the port is genuinely occupied.
function occupyEphemeralPort(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
    });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

// ---- inRange ----------------------------------------------------------------------------------------------------------------------------

describe("inRange", () => {
    test("accepts the bounds and rejects outside them", () => {
        assert.equal(inRange(1024), true);
        assert.equal(inRange(65535), true);
        assert.equal(inRange(1023), false);
        assert.equal(inRange(65536), false);
        assert.equal(inRange(3900.5), false);
    });
});

// ---- parseWebRange / formatWebRange -----------------------------------------------------------------------------------------------------

describe("parseWebRange", () => {
    test("parses a valid range and round-trips through formatWebRange", () => {
        assert.deepEqual(parseWebRange("3900-3999"), { start: 3900, end: 3999 });
        assert.equal(formatWebRange({ start: 3900, end: 3999 }), "3900-3999");
        assert.deepEqual(parseWebRange("  4000-4001 "), { start: 4000, end: 4001 });
    });

    test("rejects malformed input", () => {
        assert.equal(parseWebRange("3900"), null);
        assert.equal(parseWebRange("3900:3999"), null);
        assert.equal(parseWebRange("a-b"), null);
        assert.equal(parseWebRange(""), null);
    });

    test("rejects reversed, equal, and out-of-bounds ranges", () => {
        assert.equal(parseWebRange("3999-3900"), null);
        assert.equal(parseWebRange("3900-3900"), null);
        assert.equal(parseWebRange("100-3999"), null);
        assert.equal(parseWebRange("3900-70000"), null);
    });
});

// ---- validatePortsConfig ----------------------------------------------------------------------------------------------------------------

describe("validatePortsConfig", () => {
    test("normalizes a bare integer to an identity mapping", () => {
        assert.deepEqual(validatePortsConfig([{ port: 4820 }]), [{ host: 4820, container: 4820 }]);
    });

    test("carries env on an identity entry", () => {
        assert.deepEqual(validatePortsConfig([{ port: 4820, env: "APP_PORT" }]), [{ host: 4820, container: 4820, env: "APP_PORT" }]);
    });

    test('parses a "HOST:CONTAINER" mapping, host first as in docker', () => {
        assert.deepEqual(validatePortsConfig([{ port: "8080:3000" }]), [{ host: 8080, container: 3000 }]);
    });

    test("accepts a mix of identity and mapping entries", () => {
        assert.deepEqual(validatePortsConfig([{ port: 5173 }, { port: "8080:3000" }]), [
            { host: 5173, container: 5173 },
            { host: 8080, container: 3000 },
        ]);
    });

    test("returns an empty array for no entries", () => {
        assert.deepEqual(validatePortsConfig([]), []);
    });

    test("rejects an out-of-range bare integer with a mapping hint", () => {
        assert.throws(() => validatePortsConfig([{ port: 80 }]), /between 1024 and 65535/);
        assert.throws(() => validatePortsConfig([{ port: 80 }]), /HOST:CONTAINER/);
    });

    test("rejects a string that is not a HOST:CONTAINER mapping", () => {
        assert.throws(() => validatePortsConfig([{ port: "not-a-mapping" }]), /invalid port "not-a-mapping"/);
    });

    test("rejects a mapping with an out-of-range side", () => {
        assert.throws(() => validatePortsConfig([{ port: "80:3000" }]), /out of range/);
        assert.throws(() => validatePortsConfig([{ port: "8080:70000" }]), /out of range/);
    });

    test("rejects env on a non-identity mapping", () => {
        assert.throws(() => validatePortsConfig([{ port: "8080:3000", env: "X" }]), /only allowed on identity entries/);
    });

    test("rejects duplicate host ports, whether bare or mapped", () => {
        assert.throws(() => validatePortsConfig([{ port: 4820 }, { port: 4820 }]), /duplicate host port 4820/);
        assert.throws(() => validatePortsConfig([{ port: 8080 }, { port: "8080:3000" }]), /duplicate host port 8080/);
    });

    test("reserves the web interface container port, in either entry form", () => {
        // Two publishers on container 3899 means whichever binds first wins, so the web URL could front
        // the user's service. Rejected up front rather than skipped later.
        assert.throws(() => validatePortsConfig([{ port: WEB_CONTAINER_PORT }]), /reserved for the totopo web agent interface/);
        assert.throws(() => validatePortsConfig([{ port: `8080:${WEB_CONTAINER_PORT}` }]), /reserved for the totopo web agent interface/);
        // The reservation is on the container side only - the same number as a host port is fine.
        assert.doesNotThrow(() => validatePortsConfig([{ port: `${WEB_CONTAINER_PORT}:3000` }]));
    });

    test("rejects duplicate env names", () => {
        assert.throws(
            () =>
                validatePortsConfig([
                    { port: 4820, env: "SHARED" },
                    { port: 4821, env: "SHARED" },
                ]),
            /duplicate env "SHARED"/,
        );
    });
});

// ---- Docker argument builders -----------------------------------------------------------------------------------------------------------

describe("portPublishArgs / portEnvArgs", () => {
    test("publishes loopback-only, host:container per mapping", () => {
        const mappings: PortMapping[] = [
            { host: 8080, container: 3000 },
            { host: 5432, container: 5432 },
        ];
        assert.deepEqual(portPublishArgs(mappings), ["-p", "127.0.0.1:8080:3000", "-p", "127.0.0.1:5432:5432"]);
    });

    test("injects env vars only for entries that declare one, carrying the host port", () => {
        const mappings: PortMapping[] = [
            { host: 4820, container: 4820, env: "APP_PORT" },
            { host: 5432, container: 5432 },
        ];
        assert.deepEqual(portEnvArgs(mappings), ["-e", "APP_PORT=4820"]);
    });

    test("both builders return nothing for an empty list", () => {
        assert.deepEqual(portPublishArgs([]), []);
        assert.deepEqual(portEnvArgs([]), []);
    });
});

// ---- portsLabel -------------------------------------------------------------------------------------------------------------------------

describe("portsLabel", () => {
    const a: PortMapping[] = [{ host: 8080, container: 3000 }];

    test("empty list fingerprints to the empty string (no spurious recreate)", () => {
        assert.equal(portsLabel([]), "");
    });

    test("is stable for the same input", () => {
        assert.equal(portsLabel(a), portsLabel(a));
        assert.match(portsLabel(a), /^[0-9a-f]{12}$/);
    });

    test("is order-independent", () => {
        const one: PortMapping = { host: 4820, container: 4820, env: "A" };
        const two: PortMapping = { host: 5000, container: 5000, env: "B" };
        assert.equal(portsLabel([one, two]), portsLabel([two, one]));
    });

    test("changes when host, container, or env changes", () => {
        const base: PortMapping[] = [{ host: 8080, container: 3000, env: "" }];
        const hostEdit: PortMapping[] = [{ host: 8081, container: 3000 }];
        const containerEdit: PortMapping[] = [{ host: 8080, container: 3001 }];
        const envEdit: PortMapping[] = [{ host: 8080, container: 3000, env: "Y" }];
        assert.notEqual(portsLabel(base), portsLabel(hostEdit));
        assert.notEqual(portsLabel(base), portsLabel(containerEdit));
        assert.notEqual(portsLabel(base), portsLabel(envEdit));
    });
});

// ---- formatPortNotice -------------------------------------------------------------------------------------------------------------------

describe("formatPortNotice", () => {
    test("identity entry with env names the env var", () => {
        assert.equal(formatPortNotice({ host: 4820, container: 4820, env: "APP_PORT" }), "port 4820 open (APP_PORT)");
    });

    test("identity entry without env is bare", () => {
        assert.equal(formatPortNotice({ host: 5173, container: 5173 }), "port 5173 open");
    });

    test("mapping shows the host -> container arrow", () => {
        assert.equal(formatPortNotice({ host: 8080, container: 3000 }), "port 8080 -> 3000 open");
    });
});

// ---- assertHostPortsAvailable (host I/O) ------------------------------------------------------------------------------------------------

describe("assertHostPortsAvailable", () => {
    test("resolves for an empty list", async () => {
        await assert.doesNotReject(assertHostPortsAvailable([]));
    });

    test("passes when the host port is free", async () => {
        const { server, port } = await occupyEphemeralPort();
        await closeServer(server); // free it again
        await assert.doesNotReject(assertHostPortsAvailable([{ host: port, container: port }]));
    });

    test("throws when an identity host port is taken, naming it", async () => {
        const { server, port } = await occupyEphemeralPort();
        try {
            await assert.rejects(assertHostPortsAvailable([{ host: port, container: port }]), (err: Error) => {
                assert.match(err.message, /already in use/);
                assert.match(err.message, new RegExp(String(port)));
                return true;
            });
        } finally {
            await closeServer(server);
        }
    });

    test("throws when a mapping's host port is taken, naming the mapping", async () => {
        const { server, port } = await occupyEphemeralPort();
        try {
            await assert.rejects(assertHostPortsAvailable([{ host: port, container: 3000 }]), (err: Error) => {
                assert.match(err.message, /already in use/);
                assert.match(err.message, new RegExp(`"${port}:3000"`));
                return true;
            });
        } finally {
            await closeServer(server);
        }
    });

    test("never fails a session over the web interface port", async () => {
        const { server, port } = await occupyEphemeralPort();
        try {
            // The web interface is optional, so its mapping is skipped even though the port is taken -
            // the caller drops it and the session runs on. Only totopo.yaml ports are hard failures.
            await assert.doesNotReject(assertHostPortsAvailable([{ host: port, container: WEB_CONTAINER_PORT }], port));
        } finally {
            await closeServer(server);
        }
    });

    test("still fails on a taken totopo.yaml port alongside a skipped web port", async () => {
        const { server, port } = await occupyEphemeralPort();
        try {
            const mappings = [
                { host: port, container: WEB_CONTAINER_PORT },
                { host: port, container: 3000 },
            ];
            // The web entry is skipped; the totopo.yaml entry on the same taken host port is not.
            await assert.rejects(assertHostPortsAvailable(mappings, port), (err: Error) => {
                assert.match(err.message, /already in use/);
                assert.match(err.message, new RegExp(`"${port}:3000"`));
                return true;
            });
        } finally {
            await closeServer(server);
        }
    });
});

// ---- parsePublishedPorts (pure) ---------------------------------------------------------------------------------------------------------

describe("parsePublishedPorts", () => {
    test("reads host ports out of a docker ps ports column", () => {
        const out = "127.0.0.1:3900->3899/tcp\n[::]:5432->5432/tcp, 0.0.0.0:8080->80/tcp\n";
        assert.deepEqual(
            [...parsePublishedPorts(out)].sort((a, b) => a - b),
            [3900, 5432, 8080],
        );
    });

    test("is empty for no output and ignores unpublished ports", () => {
        assert.equal(parsePublishedPorts("").size, 0);
        // An exposed-but-unpublished port has no "->" host side.
        assert.equal(parsePublishedPorts("3899/tcp").size, 0);
    });
});
