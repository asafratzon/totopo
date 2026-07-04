import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { describe, test } from "node:test";
import {
    assertHostPortsAvailable,
    formatPortNotice,
    type PortMapping,
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

    test("empty list fingerprints to the empty string (no churn, no spurious recreate)", () => {
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
});
