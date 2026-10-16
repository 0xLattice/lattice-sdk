import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  EndpointResolver,
  NodeClient,
  OPERATOR_DECLARED,
  declaredEndpointURL,
} from "@adalinxx/lattice-client";

const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/live/${name}`, import.meta.url), "utf8");

const READ = "https://lattice-mainnet-read.fly.dev";
const FOLLOWER = "https://lattice-mainnet-testnet.fly.dev";
const CHILD = "bafyreiaomyjl7iryqain2l4jkz4knp5cvukkhgrbngjfl53llkeql7dnb4";
const NEXUS = "bafynexusgenesis";

type Routes = Record<string, string | (() => Response | Promise<Response>)>;

function network(routes: Routes, dialed: string[] = []) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const key = `${url.origin}${url.pathname}?${url.searchParams.toString()}`;
    dialed.push(key);
    const route = routes[key];
    if (route === undefined) return new Response("{}", { status: 404 });
    if (typeof route === "function") {
      return new Promise((resolve, reject) => {
        // AbortSignal.timeout's timer does not hold the event loop open.
        const alive = setInterval(() => {}, 1_000);
        init?.signal?.addEventListener("abort", () => {
          clearInterval(alive);
          reject(init.signal?.reason);
        });
        Promise.resolve(route())
          .then(resolve, reject)
          .finally(() => clearInterval(alive));
      });
    }
    return new Response(route);
  };
}

const query = (path: string[]) => encodeURIComponent(path.join("/"));
/** Routes for a host that serves `path` (with a tip) on the network `genesis` names. */
const serving = (host: string, path: string[], genesis = NEXUS): Routes => ({
  [`${host}/api/chain/info?chainPath=${query(path)}`]: JSON.stringify({
    chain: path,
    height: "7",
    tipCID: "bafytip",
  }),
  [`${host}/api/chain/genesis?chainPath=${query(path)}`]: JSON.stringify({ genesisHash: genesis }),
});
const declaring = (
  host: string,
  path: string[],
  endpoints: string[],
  committedBlock?: string | null,
) => ({
  [`${host}/api/chain/endpoints?chainPath=${query(path)}`]: JSON.stringify({
    chainPath: path,
    committedBlock: committedBlock ?? null,
    endpoints,
    submitEndpoints: [],
  }),
});

const liveRoutes: Routes = {
  [`${READ}/api/chain/genesis?chainPath=Nexus`]: JSON.stringify({ genesisHash: NEXUS }),
  [`${READ}/api/chain/endpoints?chainPath=Nexus%2Ftestnet`]: fixture("read-endpoints-testnet.json"),
  ...serving(FOLLOWER, ["Nexus", "testnet"]),
  [`${READ}/api/chain/children?chainPath=Nexus`]: JSON.stringify({
    chainPath: ["Nexus"],
    directories: ["testnet"],
  }),
};

test("the live testnet declaration resolves once the follower serves the chain on this network", async () => {
  const dialed: string[] = [];
  const fetch = network(liveRoutes, dialed);
  const root = new NodeClient(READ, ["Nexus"], { fetch });
  const resolver = new EndpointResolver(root, { fetch });
  assert.deepEqual(await resolver.resolve(["Nexus", "testnet"]), [
    {
      url: FOLLOWER,
      chainPath: ["Nexus", "testnet"],
      declaresSubmit: false,
      trust: OPERATOR_DECLARED,
    },
  ]);
  assert.equal(OPERATOR_DECLARED, "operator-declared, not independently verified");
  assert.deepEqual(dialed, [
    `${READ}/api/chain/genesis?chainPath=Nexus`,
    `${READ}/api/chain/endpoints?chainPath=Nexus%2Ftestnet`,
    `${FOLLOWER}/api/chain/info?chainPath=Nexus%2Ftestnet`,
    `${FOLLOWER}/api/chain/genesis?chainPath=Nexus%2Ftestnet`,
  ]);
  // What the parent commits is never asked for.
  assert.equal(
    dialed.some((key) => key.includes(CHILD)),
    false,
  );
});

test("the tree walk finds children from the root's directory names", async () => {
  const fetch = network(liveRoutes);
  const resolver = new EndpointResolver(new NodeClient(READ, ["Nexus"], { fetch }), {
    fetch,
    maximumDepth: 2,
  });
  const found = await resolver.tree();
  assert.deepEqual(
    found.map((entry) => [entry.chainPath.join("/"), entry.url]),
    [["Nexus/testnet", FOLLOWER]],
  );
});

test("a host is accepted only on a positive answer for the chain, with a tip, on this network", async () => {
  const info = `${FOLLOWER}/api/chain/info?chainPath=Nexus%2Ftestnet`;
  const genesis = `${FOLLOWER}/api/chain/genesis?chainPath=Nexus%2Ftestnet`;
  const refusals: Routes[] = [
    { [info]: JSON.stringify({ chain: ["Nexus"], height: "7" }) },
    { [info]: JSON.stringify({ chain: ["Nexus", "testnet"] }) },
    { [info]: () => new Response("{}", { status: 404 }) },
    { [genesis]: JSON.stringify({ genesisHash: "bafyothernetwork" }) },
    { [genesis]: () => new Response("{}", { status: 500 }) },
  ];
  for (const refusal of refusals) {
    const fetch = network({ ...liveRoutes, ...refusal });
    const resolver = new EndpointResolver(new NodeClient(READ, ["Nexus"], { fetch }), { fetch });
    assert.deepEqual(await resolver.resolve(["Nexus", "testnet"]), [], Object.keys(refusal)[0]);
  }
});

test("a root whose network cannot be read accepts nothing", async () => {
  const fetch = network({
    ...liveRoutes,
    [`${READ}/api/chain/genesis?chainPath=Nexus`]: () => new Response("{}", { status: 503 }),
  });
  const resolver = new EndpointResolver(new NodeClient(READ, ["Nexus"], { fetch }), { fetch });
  assert.deepEqual(await resolver.resolve(["Nexus", "testnet"]), []);
  assert.deepEqual(await resolver.tree(), []);
});

test("declared hosts that are not public HTTPS are never dialed", async () => {
  const declared = [
    "http://reads.example.org",
    "https://localhost:8080",
    "https://127.0.0.1",
    "https://2130706433",
    "https://10.1.2.3",
    "https://172.16.0.1",
    "https://192.168.1.1",
    "https://169.254.169.254",
    "https://100.64.0.1",
    "https://0.0.0.0",
    "https://[::1]",
    "https://[fe80::1]",
    "https://[fd00::1]",
    "https://[::ffff:127.0.0.1]",
    "https://[::ffff:10.0.0.1]",
    "https://[64:ff9b::a00:1]",
    "https://[2002:a00:1::1]",
    "https://[2001:0:4136:e378::1]",
    "https://[2001:db8::1]",
    "https://[100::1]",
    "https://198.51.100.7",
    "https://203.0.113.7",
    "https://192.0.2.7",
    "https://192.88.99.1",
    "https://0x7f.1",
    "https://intranet",
    "https://printer.local",
    "https://db.internal",
    "https://user:pass@reads.example.org",
    "https://reads.example.org/?x=1",
    "not a url",
  ];
  for (const url of declared) assert.equal(declaredEndpointURL(url), undefined, url);
  assert.equal(declaredEndpointURL("https://reads.example.org/"), "https://reads.example.org");
  assert.equal(declaredEndpointURL("https://8.8.8.8"), "https://8.8.8.8");
  assert.equal(declaredEndpointURL("https://192.0.1.1"), "https://192.0.1.1");
  assert.equal(declaredEndpointURL("https://[64:ff9b::808:808]"), "https://[64:ff9b::808:808]");
  assert.equal(declaredEndpointURL("https://[2002:808:808::1]"), "https://[2002:808:808::1]");
  assert.equal(declaredEndpointURL("https://[2001:4860::8888]"), "https://[2001:4860::8888]");

  const dialed: string[] = [];
  const fetch = network(
    {
      [`${READ}/api/chain/genesis?chainPath=Nexus`]: JSON.stringify({ genesisHash: NEXUS }),
      [`${READ}/api/chain/endpoints?chainPath=Nexus%2Ftestnet`]: JSON.stringify({
        chainPath: ["Nexus", "testnet"],
        committedBlock: CHILD,
        endpoints: declared,
        submitEndpoints: declared,
      }),
    },
    dialed,
  );
  const resolver = new EndpointResolver(new NodeClient(READ, ["Nexus"], { fetch }), { fetch });
  assert.deepEqual(await resolver.resolve(["Nexus", "testnet"]), []);
  assert.deepEqual(dialed, [
    `${READ}/api/chain/genesis?chainPath=Nexus`,
    `${READ}/api/chain/endpoints?chainPath=Nexus%2Ftestnet`,
  ]);
});

test("submit capability is declared data only, and the committed block never decides", async () => {
  const fetch = network({
    [`${READ}/api/chain/genesis?chainPath=Nexus`]: JSON.stringify({ genesisHash: NEXUS }),
    [`${READ}/api/chain/endpoints?chainPath=Nexus%2Ftestnet`]: JSON.stringify({
      chainPath: ["Nexus", "testnet"],
      committedBlock: CHILD,
      endpoints: ["https://a.example.org", "https://b.example.org"],
      submitEndpoints: ["https://b.example.org/"],
    }),
    ...serving("https://a.example.org", ["Nexus", "testnet"]),
    ...serving("https://b.example.org", ["Nexus", "testnet"]),
  });
  const resolver = new EndpointResolver(new NodeClient(READ, ["Nexus"], { fetch }), { fetch });
  const resolved = await resolver.resolve(["Nexus", "testnet"]);
  assert.deepEqual(
    resolved.map((entry) => [entry.url, entry.declaresSubmit]),
    [
      ["https://a.example.org", false],
      ["https://b.example.org", true],
    ],
  );
  for (const entry of resolved) assert.equal("submit" in entry, false);

  // Committed nothing, or a block no host serves (one the child chain did not keep): still found.
  for (const committedBlock of [null, "bafylostblock"]) {
    const routed = network({
      [`${READ}/api/chain/genesis?chainPath=Nexus`]: JSON.stringify({ genesisHash: NEXUS }),
      ...declaring(READ, ["Nexus", "testnet"], ["https://a.example.org"], committedBlock),
      ...serving("https://a.example.org", ["Nexus", "testnet"]),
    });
    const resolver2 = new EndpointResolver(new NodeClient(READ, ["Nexus"], { fetch: routed }), {
      fetch: routed,
    });
    assert.deepEqual(
      (await resolver2.resolve(["Nexus", "testnet"])).map((entry) => entry.url),
      ["https://a.example.org"],
      String(committedBlock),
    );
  }
});

test("an older node without submitEndpoints reads as none", async () => {
  const resolver = new EndpointResolver(new NodeClient(READ, ["Nexus"]), {
    fetch: network({
      [`${READ}/api/chain/endpoints?chainPath=Nexus%2Ftestnet`]: JSON.stringify({
        chainPath: ["Nexus", "testnet"],
        committedBlock: CHILD,
        endpoints: [FOLLOWER],
      }),
    }),
  });
  const declared = await resolver.declared(READ, ["Nexus", "testnet"]);
  assert.deepEqual(declared.submitEndpoints, []);
});

test("an answer naming a different chain is refused", async () => {
  const resolver = new EndpointResolver(new NodeClient(READ, ["Nexus"]), {
    fetch: network({
      [`${READ}/api/chain/endpoints?chainPath=Nexus%2Ftestnet`]: JSON.stringify({
        chainPath: ["Nexus", "other"],
        committedBlock: CHILD,
        endpoints: [FOLLOWER],
        submitEndpoints: [],
      }),
    }),
  });
  await assert.rejects(resolver.declared(READ, ["Nexus", "testnet"]), /different chainPath/);
});

test("the walk recurses through accepted hosts only, bounded and timed per request", async () => {
  const many = Array.from({ length: 20 }, (_, index) => `https://h${index}.example.org`);
  const dialed: string[] = [];
  const fetch = network(
    {
      [`${READ}/api/chain/genesis?chainPath=Nexus`]: JSON.stringify({ genesisHash: NEXUS }),
      ...declaring(
        READ,
        ["Nexus", "A"],
        ["https://a.example.org", "https://slow.example.org", ...many],
      ),
      ...serving("https://a.example.org", ["Nexus", "A"]),
      [`https://slow.example.org/api/chain/info?chainPath=Nexus%2FA`]: () => new Promise(() => {}),
      [`https://a.example.org/api/chain/endpoints?chainPath=Nexus%2FA%2FB`]: JSON.stringify({
        chainPath: ["Nexus", "A", "B"],
        committedBlock: null,
        endpoints: ["https://b.example.org"],
        submitEndpoints: ["https://b.example.org"],
      }),
      ...serving("https://b.example.org", ["Nexus", "A", "B"]),
    },
    dialed,
  );
  const resolver = new EndpointResolver(new NodeClient(READ, ["Nexus"], { fetch }), {
    fetch,
    timeoutMilliseconds: 50,
    maximumCandidates: 4,
  });
  const resolved = await resolver.resolve(["Nexus", "A", "B"]);
  assert.deepEqual(
    resolved.map((entry) => [entry.url, entry.chainPath.join("/"), entry.declaresSubmit]),
    [["https://b.example.org", "Nexus/A/B", true]],
  );
  const probes = dialed.filter((key) => key.endsWith("/api/chain/info?chainPath=Nexus%2FA"));
  assert.equal(probes.length, 4);
  // The slow host was never a source for the next level.
  assert.equal(dialed.filter((key) => key.startsWith("https://slow.")).length, 1);

  await assert.rejects(resolver.resolve(["Nexus"]), /descendant/);
  await assert.rejects(resolver.resolve(["Other", "A"]), /descendant/);
});

test("requests refuse redirects so a declared host cannot steer them elsewhere", async () => {
  const modes: (RequestRedirect | undefined)[] = [];
  const inner = network(liveRoutes);
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    modes.push(init?.redirect);
    return inner(input, init);
  };
  const resolver = new EndpointResolver(new NodeClient(READ, ["Nexus"], { fetch }), { fetch });
  assert.equal((await resolver.resolve(["Nexus", "testnet"])).length, 1);
  assert.deepEqual(modes, ["error", "error", "error", "error"]);
});

test("with a lookup, a declared name resolving to a private address is never dialed", async () => {
  const dialed: string[] = [];
  const fetch = network(liveRoutes, dialed);
  const looked: string[] = [];
  const resolver = new EndpointResolver(new NodeClient(READ, ["Nexus"], { fetch }), {
    fetch,
    lookup: async (host) => {
      looked.push(host);
      return ["66.241.124.1", "10.0.0.5"];
    },
  });
  assert.deepEqual(await resolver.resolve(["Nexus", "testnet"]), []);
  assert.deepEqual(looked, ["lattice-mainnet-testnet.fly.dev"]);
  assert.equal(dialed.filter((key) => key.startsWith(FOLLOWER)).length, 0);

  const publicOnly = new EndpointResolver(new NodeClient(READ, ["Nexus"], { fetch }), {
    fetch,
    lookup: async () => ["66.241.124.1", "2a09:8280:1::1"],
  });
  assert.equal((await publicOnly.resolve(["Nexus", "testnet"])).length, 1);
});

test("accepted hosts keep their declared order, whatever height they claim", async () => {
  const hosts = ["https://a.example.org", "https://b.example.org", "https://c.example.org"];
  const routes: Routes = {
    [`${READ}/api/chain/genesis?chainPath=Nexus`]: JSON.stringify({ genesisHash: NEXUS }),
    ...declaring(READ, ["Nexus", "A"], hosts),
  };
  for (const [index, host] of hosts.entries()) {
    Object.assign(routes, serving(host, ["Nexus", "A"]));
    routes[`${host}/api/chain/info?chainPath=Nexus%2FA`] = JSON.stringify({
      chain: ["Nexus", "A"],
      height: String(10 ** (index + 1)),
    });
  }
  const fetch = network(routes);
  const resolver = new EndpointResolver(new NodeClient(READ, ["Nexus"], { fetch }), { fetch });
  assert.deepEqual(
    (await resolver.resolve(["Nexus", "A"])).map((entry) => entry.url),
    hosts,
  );
});

test("a walk stops at its request budget however wide the declared tree is", async () => {
  let requests = 0;
  const fetch = async (input: string | URL): Promise<Response> => {
    requests += 1;
    const url = new URL(input);
    const path = (url.searchParams.get("chainPath") ?? "").split("/");
    if (url.pathname === "/api/chain/genesis") {
      return new Response(JSON.stringify({ genesisHash: NEXUS }));
    }
    if (url.pathname === "/api/chain/children") {
      return new Response(
        JSON.stringify({
          chainPath: path,
          directories: Array.from({ length: 50 }, (_, index) => `c${index}`),
        }),
      );
    }
    if (url.pathname === "/api/chain/endpoints") {
      return new Response(
        JSON.stringify({
          chainPath: path,
          committedBlock: "bafychild",
          endpoints: Array.from({ length: 20 }, (_, index) => `https://h${index}.example.org`),
          submitEndpoints: [],
        }),
      );
    }
    return new Response(JSON.stringify({ chain: path, height: "1" }));
  };
  const resolver = new EndpointResolver(new NodeClient(READ, ["Nexus"], { fetch }), {
    fetch,
    maximumRequests: 30,
  });
  const found = await resolver.tree();
  assert.ok(requests <= 30, `made ${requests} requests`);
  assert.ok(found.length > 0);
});

test("a lookup that never answers is timed like any request", async () => {
  const fetch = network(liveRoutes);
  const resolver = new EndpointResolver(new NodeClient(READ, ["Nexus"], { fetch }), {
    fetch,
    timeoutMilliseconds: 50,
    lookup: (_host, signal) =>
      new Promise(() => {
        const alive = setInterval(() => {}, 1_000);
        signal?.addEventListener("abort", () => clearInterval(alive));
      }),
  });
  assert.deepEqual(await resolver.resolve(["Nexus", "testnet"]), []);
});

test("the resolver's default fetch is called with a valid receiver", async () => {
  const original = globalThis.fetch;
  const routed = network(liveRoutes);
  globalThis.fetch = function (this: unknown, input: string | URL, init?: RequestInit) {
    // Browsers throw "Illegal invocation" when fetch's receiver is not the global.
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return routed(input, init);
  } as typeof fetch;
  try {
    const resolver = new EndpointResolver(new NodeClient(READ, ["Nexus"]));
    assert.equal((await resolver.resolve(["Nexus", "testnet"]))[0]?.url, FOLLOWER);
  } finally {
    globalThis.fetch = original;
  }
});

test("a directory listing naming another chain is refused", async () => {
  const fetch = network({
    [`${READ}/api/chain/children?chainPath=Nexus`]: JSON.stringify({
      chainPath: ["Nexus", "other"],
      directories: ["testnet"],
    }),
  });
  await assert.rejects(
    new NodeClient(READ, ["Nexus"], { fetch }).childDirectories(),
    /different chainPath/,
  );
});
