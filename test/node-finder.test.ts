import assert from "node:assert/strict";
import { test } from "node:test";

import { ChainNodeFinder, ChainOfflineError } from "@adalinxx/lattice-client";

const NEXUS = "bafynexusgenesis";
const START = "https://start.example.org";
const host = (name: string) => `https://${name}.example.org`;

/**
 * A network of hosts: `serves[url]` lists the chains each answers for, or is
 * "down" / "busy"; `declared[chain]` lists the hosts declared for a chain.
 */
function network(
  serves: Record<string, string[] | "down" | "busy">,
  declared: () => Record<string, string[]> = () => ({}),
  dialed: string[] = [],
) {
  return async (input: string | URL): Promise<Response> => {
    const url = new URL(input);
    const chain = url.searchParams.get("chainPath") ?? "";
    dialed.push(`${url.origin}${url.pathname} ${chain}`);
    const hosting = serves[url.origin];
    if (hosting === "down") throw new TypeError("Failed to fetch");
    if (hosting === "busy") return new Response("{}", { status: 503 });
    if (url.pathname === "/api/chain/endpoints") {
      const urls = declared()[chain];
      if (urls === undefined) return new Response("{}", { status: 404 });
      return new Response(
        JSON.stringify({ chainPath: chain.split("/"), endpoints: urls, submitEndpoints: [] }),
      );
    }
    if (!(hosting ?? []).includes(chain)) return new Response("{}", { status: 404 });
    if (url.pathname === "/api/chain/info") {
      return new Response(JSON.stringify({ chain: chain.split("/"), height: "3" }));
    }
    if (url.pathname === "/api/chain/genesis") {
      return new Response(JSON.stringify({ genesisHash: NEXUS }));
    }
    return new Response("{}", { status: 404 });
  };
}

test("the start node is used for a chain it serves, with no search", async () => {
  const dialed: string[] = [];
  const finder = new ChainNodeFinder(START, {
    fetch: network({ [START]: ["N/S"] }, () => ({}), dialed),
  });
  assert.deepEqual(await finder.nodeFor(["N", "S"]), { url: START, found: false });
  assert.deepEqual(dialed, [`${START}/api/chain/info N/S`]);
});

test("a chain the start node lacks is found from its nearest served ancestor, at any depth", async () => {
  const dialed: string[] = [];
  const finder = new ChainNodeFinder(START, {
    fetch: network(
      { [START]: ["N", "N/S"], [host("a")]: ["N/S/c"], [host("b")]: ["N/S/c/d"] },
      () => ({ "N/S/c": [host("a")], "N/S/c/d": [host("b")] }),
      dialed,
    ),
  });
  assert.deepEqual(await finder.nodeFor(["N", "S", "c", "d"]), { url: host("b"), found: true });
  // The walk starts at N/S, the nearest ancestor the start node serves.
  assert.ok(dialed.includes(`${START}/api/chain/endpoints N/S/c`));
  assert.ok(!dialed.includes(`${START}/api/chain/endpoints N/S`));
});

test("a chain no node serves is offline, and is searched again on the next read", async () => {
  let urls: string[] = [];
  const finder = new ChainNodeFinder(START, {
    fetch: network({ [START]: ["N"], [host("b")]: ["N/x"] }, () => ({ "N/x": urls })),
  });
  await assert.rejects(finder.nodeFor(["N", "x"]), ChainOfflineError);
  urls = [host("b")];
  assert.equal((await finder.nodeFor(["N", "x"])).url, host("b"));
  // No ancestor served: nothing to start from.
  await assert.rejects(
    new ChainNodeFinder(START, { fetch: network({ [START]: [] }) }).nodeFor(["N", "x"]),
    ChainOfflineError,
  );
});

test("a start node that is down or failing is its own failure, not offline", async () => {
  const dialed: string[] = [];
  await assert.rejects(
    new ChainNodeFinder(START, { fetch: network({ [START]: "down" }, () => ({}), dialed) }).nodeFor(
      ["N"],
    ),
    TypeError,
  );
  await assert.rejects(
    new ChainNodeFinder(START, { fetch: network({ [START]: "busy" }, () => ({}), dialed) }).nodeFor(
      ["N"],
    ),
    { status: 503 },
  );
  assert.equal(
    dialed.some((key) => key.includes("endpoints")),
    false,
  );
});

test("concurrent reads share one search; a found node is searched again when forgotten or after ttl", async () => {
  let clock = 0;
  const dialed: string[] = [];
  const finder = new ChainNodeFinder(START, {
    fetch: network(
      { [START]: ["N"], [host("a")]: ["N/x"], [host("b")]: ["N/x"] },
      () => ({ "N/x": [host("a"), host("b")] }),
      dialed,
    ),
    ttlMilliseconds: 100,
    now: () => clock,
  });
  const searches = () => dialed.filter((key) => key.includes("endpoints")).length;
  const [one] = await Promise.all([finder.nodeFor(["N", "x"]), finder.nodeFor(["N", "x"])]);
  assert.equal(searches(), 1);
  assert.equal(one.url, host("a"));
  await finder.forget(["N", "x"], { url: host("b"), found: true });
  assert.equal(
    await finder.nodeFor(["N", "x"]),
    one,
    "forgetting a node not in use changes nothing",
  );
  // Forgotten: the other host first, until the ttl passes.
  await finder.forget(["N", "x"], one);
  assert.equal((await finder.nodeFor(["N", "x"])).url, host("b"));
  assert.equal(searches(), 2);
  clock = 150;
  assert.equal((await finder.nodeFor(["N", "x"])).url, host("a"), "searched again after ttl");
  assert.equal(searches(), 3);
});

test("the start node is never returned as a found node", async () => {
  const finder = new ChainNodeFinder(START, {
    fetch: network({ [START]: ["N"] }, () => ({ "N/x": [START] })),
  });
  await assert.rejects(finder.nodeFor(["N", "x"]), ChainOfflineError);
});

test("a start node failing during the search is its own failure, not offline", async () => {
  const busy = async (input: string | URL): Promise<Response> => {
    const url = new URL(input);
    const chain = url.searchParams.get("chainPath") ?? "";
    if (url.pathname === "/api/chain/info" && chain === "N") {
      return new Response(JSON.stringify({ chain: ["N"], height: "3" }));
    }
    if (url.pathname === "/api/chain/endpoints") return new Response("{}", { status: 429 });
    if (url.pathname === "/api/chain/genesis") {
      return new Response(JSON.stringify({ genesisHash: NEXUS }));
    }
    return new Response("{}", { status: 404 });
  };
  await assert.rejects(new ChainNodeFinder(START, { fetch: busy }).nodeFor(["N", "x"]), {
    status: 429,
  });
  // The directory answering that no host is known: offline.
  const none = async (input: string | URL): Promise<Response> =>
    new URL(input).pathname === "/api/chain/endpoints"
      ? new Response("{}", { status: 404 })
      : busy(input);
  await assert.rejects(
    new ChainNodeFinder(START, { fetch: none }).nodeFor(["N", "x"]),
    ChainOfflineError,
  );
});

test("a forgotten start node sends the next search to declared hosts, until the ttl", async () => {
  let clock = 0;
  const finder = new ChainNodeFinder(START, {
    fetch: network({ [START]: ["N", "N/x"], [host("a")]: ["N/x"] }, () => ({ "N/x": [host("a")] })),
    ttlMilliseconds: 100,
    now: () => clock,
  });
  const start = await finder.nodeFor(["N", "x"]);
  assert.deepEqual(start, { url: START, found: false });
  await finder.forget(["N", "x"], start);
  assert.deepEqual(await finder.nodeFor(["N", "x"]), { url: host("a"), found: true });
  clock = 150;
  await finder.forget(["N", "x"], { url: host("a"), found: true });
  assert.deepEqual(await finder.nodeFor(["N", "x"]), { url: START, found: false });
  // No declared host: the start node it is, forgotten or not.
  const alone = new ChainNodeFinder(START, { fetch: network({ [START]: ["N", "N/x"] }) });
  await alone.forget(["N", "x"], await alone.nodeFor(["N", "x"]));
  assert.deepEqual(await alone.nodeFor(["N", "x"]), { url: START, found: false });
});
