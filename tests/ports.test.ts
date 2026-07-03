import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { describe, test } from "node:test";
import {
    allocationsOf,
    finalizePorts,
    formatPortAllocations,
    parsePortAllocations,
    planPorts,
    portEnvArgs,
    portPublishArgs,
    portsLabel,
    type ResolvedPort,
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
    test("accepts a valid config", () => {
        assert.doesNotThrow(() =>
            validatePortsConfig([{ port: 4820, ifTaken: "next", env: "A_PORT" }, { port: 5432, ifTaken: "fail" }, { port: 6000 }]),
        );
    });

    test("rejects duplicate ports", () => {
        assert.throws(() => validatePortsConfig([{ port: 4820 }, { port: 4820, env: "X" }]), /duplicate port 4820/);
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

    test("rejects ifTaken: next without env (silently unreachable remap)", () => {
        assert.throws(() => validatePortsConfig([{ port: 4820, ifTaken: "next" }]), /ifTaken: next but has no env/);
    });

    test("allows ifTaken: fail without env", () => {
        assert.doesNotThrow(() => validatePortsConfig([{ port: 4820, ifTaken: "fail" }, { port: 5000 }]));
    });
});

// ---- planPorts (pure) -------------------------------------------------------------------------------------------------------------------

describe("planPorts", () => {
    test("honors a sticky allocation whose configured port is unchanged", () => {
        const { planned, allocations } = planPorts([{ port: 4820, ifTaken: "next", env: "X" }], new Map([[4820, 4821]]));
        assert.equal(planned[0]?.resolved, 4821);
        assert.deepEqual([...allocations], [[4820, 4821]]);
    });

    test("configured port wins when a stale sticky value collides with another entry's configured port", () => {
        const { planned } = planPorts([{ port: 4820 }, { port: 4821 }], new Map([[4820, 4821]]));
        assert.equal(planned[0]?.resolved, 4820, "sticky 4821 collides with entry 4821's configured port - fall back");
        assert.equal(planned[1]?.resolved, 4821);
    });

    test("resolves self-collisions between two sticky values in config order", () => {
        const { planned } = planPorts(
            [
                { port: 6000, ifTaken: "next", env: "A" },
                { port: 6001, ifTaken: "next", env: "B" },
            ],
            new Map([
                [6000, 7000],
                [6001, 7000],
            ]),
        );
        assert.equal(planned[0]?.resolved, 7000, "first entry claims 7000");
        assert.equal(planned[1]?.resolved, 6001, "second entry's sticky 7000 is taken - fall back to configured");
    });

    test("prunes stale allocation keys no longer present in the config", () => {
        const { allocations } = planPorts(
            [{ port: 8000 }],
            new Map([
                [8000, 8000],
                [9999, 9999],
            ]),
        );
        assert.ok(allocations.has(8000));
        assert.ok(!allocations.has(9999), "an allocation for a removed entry must be dropped");
    });

    test("uses the configured port when there is no sticky value", () => {
        const { planned, allocations } = planPorts([{ port: 4820, ifTaken: "next", env: "X" }], new Map());
        assert.equal(planned[0]?.resolved, 4820);
        assert.deepEqual([...allocations], [[4820, 4820]]);
    });
});

// ---- finalizePorts (host I/O) -----------------------------------------------------------------------------------------------------------

describe("finalizePorts", () => {
    test("keeps a free port", async () => {
        const { server, port } = await occupyEphemeralPort();
        await closeServer(server); // free it again
        const finalized = await finalizePorts([{ entry: { port, ifTaken: "fail" }, resolved: port }]);
        assert.equal(finalized[0]?.resolved, port);
    });

    test("ifTaken: next scans past an occupied port", async () => {
        const { server, port } = await occupyEphemeralPort();
        try {
            const finalized = await finalizePorts([{ entry: { port, ifTaken: "next", env: "X" }, resolved: port }]);
            assert.equal(finalized.length, 1);
            assert.notEqual(finalized[0]?.resolved, port, "must not reuse the occupied port");
            assert.ok((finalized[0]?.resolved ?? 0) > port, "scan goes upward");
        } finally {
            await closeServer(server);
        }
    });

    test("ifTaken: fail throws when the port is taken", async () => {
        const { server, port } = await occupyEphemeralPort();
        try {
            await assert.rejects(finalizePorts([{ entry: { port, ifTaken: "fail" }, resolved: port }]), /already in use/);
        } finally {
            await closeServer(server);
        }
    });

    test("throws a clear error when the scan range is exhausted", async () => {
        // Range for the top port is a single slot; occupying it (or finding it already taken) exhausts the scan.
        const server = createServer();
        let held = false;
        await new Promise<void>((resolve) => {
            server.once("error", () => resolve()); // already in use elsewhere - still occupied for our purposes
            server.once("listening", () => {
                held = true;
                resolve();
            });
            server.listen(65535, "127.0.0.1");
        });
        try {
            await assert.rejects(
                finalizePorts([{ entry: { port: 65535, ifTaken: "next", env: "X" }, resolved: 65535 }]),
                /no free host port/,
            );
        } finally {
            if (held) await closeServer(server);
        }
    });

    test("exclude skips a still-free port, forcing a next entry to scan upward", async () => {
        // Simulate a create retry: the port lost the docker-run race and is passed in exclude, even though it
        // is free on the host again. A next entry must move past it rather than re-pick the port that just raced.
        const { server, port } = await occupyEphemeralPort();
        await closeServer(server); // free it on the host
        const finalized = await finalizePorts([{ entry: { port, ifTaken: "next", env: "X" }, resolved: port }], new Set([port]));
        assert.equal(finalized.length, 1);
        assert.ok((finalized[0]?.resolved ?? 0) > port, "excluded port is skipped, scan goes upward");
    });

    test("exclude makes a fail entry error even though the host would accept the port", async () => {
        // This is why the dev.ts create-retry only seeds next-entry ports into exclude: finalizePorts short-circuits
        // the host probe for an excluded port, so a still-free fail port put in exclude would throw spuriously.
        const { server, port } = await occupyEphemeralPort();
        await closeServer(server); // free it on the host
        await assert.rejects(finalizePorts([{ entry: { port, ifTaken: "fail" }, resolved: port }], new Set([port])), /already in use/);
    });
});

// ---- portsLabel -------------------------------------------------------------------------------------------------------------------------

describe("portsLabel", () => {
    const a: ResolvedPort[] = [{ entry: { port: 4820, ifTaken: "next", env: "X" }, resolved: 4821 }];

    test("empty list fingerprints to the empty string (no churn, no spurious recreate)", () => {
        assert.equal(portsLabel([]), "");
    });

    test("is stable for the same input", () => {
        assert.equal(portsLabel(a), portsLabel(a));
        assert.match(portsLabel(a), /^[0-9a-f]{12}$/);
    });

    test("is order-independent", () => {
        const one: ResolvedPort = { entry: { port: 4820, env: "A" }, resolved: 4820 };
        const two: ResolvedPort = { entry: { port: 5000, env: "B" }, resolved: 5000 };
        assert.equal(portsLabel([one, two]), portsLabel([two, one]));
    });

    test("changes when ifTaken or env changes even if the resolved port is identical", () => {
        const base: ResolvedPort[] = [{ entry: { port: 4820, ifTaken: "fail", env: "X" }, resolved: 4820 }];
        const ifTakenEdit: ResolvedPort[] = [{ entry: { port: 4820, ifTaken: "next", env: "X" }, resolved: 4820 }];
        const envEdit: ResolvedPort[] = [{ entry: { port: 4820, ifTaken: "fail", env: "Y" }, resolved: 4820 }];
        assert.notEqual(portsLabel(base), portsLabel(ifTakenEdit));
        assert.notEqual(portsLabel(base), portsLabel(envEdit));
    });
});

// ---- Docker argument builders -----------------------------------------------------------------------------------------------------------

describe("portPublishArgs / portEnvArgs", () => {
    test("publishes identity-mapped, loopback-only ports", () => {
        const resolved: ResolvedPort[] = [
            { entry: { port: 4820, ifTaken: "next", env: "X" }, resolved: 4821 },
            { entry: { port: 5432, ifTaken: "fail" }, resolved: 5432 },
        ];
        assert.deepEqual(portPublishArgs(resolved), ["-p", "127.0.0.1:4821:4821", "-p", "127.0.0.1:5432:5432"]);
    });

    test("injects env vars only for entries that declare one, carrying the resolved number", () => {
        const resolved: ResolvedPort[] = [
            { entry: { port: 4820, ifTaken: "next", env: "APP_PORT" }, resolved: 4821 },
            { entry: { port: 5432, ifTaken: "fail" }, resolved: 5432 },
        ];
        assert.deepEqual(portEnvArgs(resolved), ["-e", "APP_PORT=4821"]);
    });

    test("both builders return nothing for an empty list", () => {
        assert.deepEqual(portPublishArgs([]), []);
        assert.deepEqual(portEnvArgs([]), []);
    });
});

// ---- Allocation (de)serialization -------------------------------------------------------------------------------------------------------

describe("allocation map (de)serialization", () => {
    test("allocationsOf maps configured port to resolved port", () => {
        const resolved: ResolvedPort[] = [
            { entry: { port: 4820, ifTaken: "next", env: "X" }, resolved: 4821 },
            { entry: { port: 5432 }, resolved: 5432 },
        ];
        assert.deepEqual(
            [...allocationsOf(resolved)],
            [
                [4820, 4821],
                [5432, 5432],
            ],
        );
    });

    test("format then parse round-trips", () => {
        const map = new Map([
            [4820, 4821],
            [5432, 5432],
        ]);
        const str = formatPortAllocations(map);
        assert.equal(str, "4820:4821,5432:5432");
        assert.deepEqual([...parsePortAllocations(str)], [...map]);
    });

    test("parse tolerates an empty string and malformed pairs", () => {
        assert.equal(parsePortAllocations("").size, 0);
        assert.deepEqual(
            [...parsePortAllocations("4820:4821,bogus,,7000:7001")],
            [
                [4820, 4821],
                [7000, 7001],
            ],
        );
    });
});
