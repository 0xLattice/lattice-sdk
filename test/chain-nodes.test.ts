import assert from "node:assert/strict";
import { test } from "node:test";

import { ChainNodes, ChainOfflineError } from "@adalinxx/lattice-client";

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

test("the list is the start node, then the declared hosts in order", async () => {
  const nodes = new ChainNodes(START, {
    fetch: network({ [START]: ["N", "N/x"], [host("a")]: ["N/x"], [host("b")]: ["N/x"] }, () => ({
      "N/x": [host("a"), START, host("b")],
    })),
  });
  assert.deepEqual(await nodes.list(["N", "x"]), [
    { url: START, found: false },
    { url: host("a"), found: true },
    { url: host("b"), found: true },
  ]);
});

test("a chain the start node lacks is found from its nearest served ancestor, at any depth", async () => {
  const dialed: string[] = [];
  const nodes = new ChainNodes(START, {
    fetch: network(
      { [START]: ["N", "N/S"], [host("a")]: ["N/S/c"], [host("b")]: ["N/S/c/d"] },
      () => ({ "N/S/c": [host("a")], "N/S/c/d": [host("b")] }),
      dialed,
    ),
  });
  assert.deepEqual(await nodes.list(["N", "S", "c", "d"]), [{ url: host("b"), found: true }]);
  assert.ok(dialed.includes(`${START}/api/chain/endpoints N/S/c`));
});

test("a read goes round the list until a node answers", async () => {
  const nodes = new ChainNodes(START, {
    fetch: network({ [START]: ["N", "N/x"], [host("a")]: ["N/x"], [host("b")]: ["N/x"] }, () => ({
      "N/x": [host("a"), host("b")],
    })),
  });
  const tried: string[] = [];
  const answer = await nodes.read(["N", "x"], async ({ url }) => {
    tried.push(url);
    if (url !== host("b")) throw new Error(`${url} failed`);
    return "read";
  });
  assert.equal(answer, "read");
  assert.deepEqual(tried, [START, host("a"), host("b")]);
  // The next read begins one further on, and ends on the last it tried.
  await assert.rejects(
    nodes.read(["N", "x"], async ({ url }) => {
      throw new Error(`${url} failed`);
    }),
    /start\.example\.org failed/,
  );
});

test("reads take turns over the nodes, so each serves an even share", async () => {
  const nodes = new ChainNodes(START, {
    fetch: network(
      { [START]: ["N"], [host("a")]: ["N/x"], [host("b")]: ["N/x"], [host("c")]: ["N/x"] },
      () => ({
        "N/x": [host("a"), host("b"), host("c")],
      }),
    ),
  });
  const served: string[] = [];
  for (let i = 0; i < 6; i += 1) served.push(await nodes.read(["N", "x"], async ({ url }) => url));
  assert.deepEqual(served, [host("a"), host("b"), host("c"), host("a"), host("b"), host("c")]);
  // Each chain keeps its own turn.
  assert.equal(await nodes.read(["N"], async ({ url }) => url), START);
});

test("several start nodes are one level like any other", async () => {
  const [one, two, three] = [host("one"), host("two"), host("three")];
  const dialed: string[] = [];
  const nodes = new ChainNodes([one, two, three], {
    fetch: network(
      { [one]: ["N"], [two]: "down", [three]: ["N"], [host("a")]: ["N/x"] },
      () => ({ "N/x": [host("a")] }),
      dialed,
    ),
  });
  // A start node that is down is passed over; the rest share Nexus reads.
  assert.deepEqual(await nodes.list(["N"]), [
    { url: one, found: false },
    { url: three, found: false },
  ]);
  const served: string[] = [];
  for (let i = 0; i < 4; i += 1) served.push(await nodes.read(["N"], async ({ url }) => url));
  assert.deepEqual(served, [one, three, one, three]);
  // A child is found from a start node that answers: this walk's turn falls
  // on `two`, which is down, so it goes on to `three`.
  assert.deepEqual(await nodes.list(["N", "x"]), [{ url: host("a"), found: true }]);
  assert.ok(dialed.some((key) => key.startsWith(`${three}/api/chain/endpoints`)));
});

test("each walk down begins at the next start node", async () => {
  const [one, two] = [host("one"), host("two")];
  const dialed: string[] = [];
  const nodes = new ChainNodes([one, two], {
    fetch: network(
      { [one]: ["N"], [two]: ["N"], [host("a")]: ["N/x", "N/y"] },
      () => ({ "N/x": [host("a")], "N/y": [host("a")] }),
      dialed,
    ),
  });
  await nodes.list(["N", "x"]);
  await nodes.list(["N", "y"]);
  const walkedFrom = dialed
    .filter((key) => key.includes("/api/chain/endpoints"))
    .map((key) => new URL(key.split(" ")[0]!).origin);
  assert.deepEqual(walkedFrom, [one, two]);
});

test("every start node failing is the reader's failure", async () => {
  await assert.rejects(
    new ChainNodes([host("one"), host("two")], {
      fetch: network({ [host("one")]: "down", [host("two")]: "busy" }),
    }).list(["N"]),
    TypeError,
  );
});

test("a chain no node serves is offline, and is looked up again after the ttl", async () => {
  let clock = 0;
  let urls: string[] = [];
  const nodes = new ChainNodes(START, {
    fetch: network({ [START]: ["N"], [host("b")]: ["N/x"] }, () => ({ "N/x": urls })),
    ttlMilliseconds: 100,
    now: () => clock,
  });
  await assert.rejects(
    nodes.read(["N", "x"], async () => "read"),
    ChainOfflineError,
  );
  urls = [host("b")];
  clock = 150;
  assert.equal(await nodes.read(["N", "x"], async ({ url }) => url), host("b"));
  // No ancestor served: nothing to start from.
  await assert.rejects(
    new ChainNodes(START, { fetch: network({ [START]: [] }) }).read(["N", "x"], async () => 0),
    ChainOfflineError,
  );
});

test("the start node failing is its own failure, not offline", async () => {
  await assert.rejects(
    new ChainNodes(START, { fetch: network({ [START]: "down" }) }).list(["N"]),
    TypeError,
  );
  await assert.rejects(new ChainNodes(START, { fetch: network({ [START]: "busy" }) }).list(["N"]), {
    status: 503,
  });
  // Busy on its directory, for a chain it does not serve.
  const directoryBusy = async (input: string | URL): Promise<Response> =>
    new URL(input).pathname === "/api/chain/endpoints"
      ? new Response("{}", { status: 429 })
      : network({ [START]: ["N"] })(input);
  await assert.rejects(new ChainNodes(START, { fetch: directoryBusy }).list(["N", "x"]), {
    status: 429,
  });
  // For a chain it serves, its directory failing costs only the fallbacks.
  const servesIt = async (input: string | URL): Promise<Response> =>
    new URL(input).pathname === "/api/chain/endpoints"
      ? new Response("{}", { status: 429 })
      : network({ [START]: ["N", "N/x"] })(input);
  assert.deepEqual(await new ChainNodes(START, { fetch: servesIt }).list(["N", "x"]), [
    { url: START, found: false },
  ]);
  // Or its answer for the chain above.
  const parentBusy = async (input: string | URL): Promise<Response> => {
    const url = new URL(input);
    return url.pathname === "/api/chain/info" && url.searchParams.get("chainPath") === "N"
      ? new Response("{}", { status: 503 })
      : network({ [START]: ["N", "N/x"] })(input);
  };
  assert.deepEqual(await new ChainNodes(START, { fetch: parentBusy }).list(["N", "x"]), [
    { url: START, found: false },
  ]);
});

test("concurrent reads share one lookup", async () => {
  const dialed: string[] = [];
  const nodes = new ChainNodes(START, {
    fetch: network(
      { [START]: ["N"], [host("a")]: ["N/x"] },
      () => ({ "N/x": [host("a")] }),
      dialed,
    ),
  });
  await Promise.all([nodes.list(["N", "x"]), nodes.list(["N", "x"])]);
  assert.equal(dialed.filter((key) => key.includes("endpoints")).length, 1);
});
