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
    random: () => 0,
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
  const fetch = network(
    { [START]: ["N"], [host("a")]: ["N/x"], [host("b")]: ["N/x"], [host("c")]: ["N/x"] },
    () => ({ "N/x": [host("a"), host("b"), host("c")] }),
  );
  const nodes = new ChainNodes(START, { fetch, random: () => 0 });
  const served: string[] = [];
  for (let i = 0; i < 6; i += 1) served.push(await nodes.read(["N", "x"], async ({ url }) => url));
  assert.deepEqual(served, [host("a"), host("b"), host("c"), host("a"), host("b"), host("c")]);
  // Each chain keeps its own turn.
  assert.equal(await nodes.read(["N"], async ({ url }) => url), START);
  // Readers begin at a random node, so many fresh readers spread too.
  const nodesAt = (random: number) => new ChainNodes(START, { fetch, random: () => random });
  const firsts = new Set<string>();
  for (const random of [0, 1 / 3, 2 / 3])
    firsts.add(await nodesAt(random).read(["N", "x"], async ({ url }) => url));
  assert.equal(firsts.size, 3);
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
    random: () => 0,
  });
  // A start node that is down is passed over; the rest share Nexus reads.
  assert.deepEqual(await nodes.list(["N"]), [
    { url: one, found: false },
    { url: three, found: false },
  ]);
  const served: string[] = [];
  for (let i = 0; i < 4; i += 1) served.push(await nodes.read(["N"], async ({ url }) => url));
  assert.deepEqual(served, [one, three, one, three]);
  // A child is found from a start node that answers; the one that is down is
  // not walked from.
  dialed.length = 0;
  assert.deepEqual(await nodes.list(["N", "x"]), [{ url: host("a"), found: true }]);
  assert.ok(dialed.some((key) => key.startsWith(`${one}/api/chain/endpoints`)));
  assert.ok(!dialed.some((key) => key.startsWith(`${two}/api/chain/endpoints`)));
});

test("each walk down a chain begins at the next start node", async () => {
  const [one, two] = [host("one"), host("two")];
  const dialed: string[] = [];
  let clock = 0;
  const nodes = new ChainNodes([one, two], {
    fetch: network(
      { [one]: ["N"], [two]: ["N"], [host("a")]: ["N/x"] },
      () => ({ "N/x": [host("a")] }),
      dialed,
    ),
    random: () => 0,
    ttlMilliseconds: 100,
    now: () => clock,
  });
  await nodes.list(["N", "x"]);
  clock = 150;
  await nodes.list(["N", "x"]);
  const walkedFrom = dialed
    .filter((key) => key.includes("/api/chain/endpoints"))
    .map((key) => new URL(key.split(" ")[0]!).origin);
  assert.deepEqual(walkedFrom, [one, two]);
});

test("a chain is offline only when every start node answered", async () => {
  let down = true;
  const serves = { [host("one")]: ["M"], [host("two")]: ["M"] } as Record<
    string,
    string[] | "down"
  >;
  const base = network(serves);
  const fetch = (input: string | URL) => {
    serves[host("one")] = down ? "down" : ["M"];
    return base(input);
  };
  const nodes = new ChainNodes([host("one"), host("two")], { fetch, random: () => 0 });
  // `one` might be the node that serves it: its failure is thrown, not kept.
  await assert.rejects(
    nodes.read(["N", "x"], async () => 0),
    TypeError,
  );
  down = false;
  await assert.rejects(
    nodes.read(["N", "x"], async () => 0),
    ChainOfflineError,
  );
});

test("a start node failing is not kept as the chain being offline", async () => {
  let busy = true;
  const s1 = host("s1");
  const s2 = host("s2");
  const base = network({ [s1]: ["N", "N/x"], [s2]: ["N"] }, () => ({ "N/x": [s1] }));
  const fetch = async (input: string | URL): Promise<Response> => {
    const url = new URL(input);
    if (busy && url.origin === s1 && url.searchParams.get("chainPath") === "N/x") {
      return new Response("{}", { status: 503 });
    }
    return base(input);
  };
  const nodes = new ChainNodes([s1, s2], { fetch, random: () => 0 });
  await assert.rejects(nodes.list(["N", "x"]), { status: 503 });
  busy = false;
  // Not kept: the next list finds it.
  assert.deepEqual(await nodes.list(["N", "x"]), [{ url: s1, found: false }]);
});

test("a start node whose check failed is kept when the walk finds it", async () => {
  const s1 = host("s1");
  const s2 = host("s2");
  let checks = 0;
  const base = network({ [s1]: ["N", "N/x"], [s2]: ["N"] }, () => ({ "N/x": [s1] }));
  const fetch = async (input: string | URL): Promise<Response> => {
    const url = new URL(input);
    // s1's first answer for N/x (the start check) fails; later ones answer.
    if (
      url.origin === s1 &&
      url.pathname === "/api/chain/info" &&
      url.searchParams.get("chainPath") === "N/x"
    ) {
      checks += 1;
      if (checks === 1) return new Response("{}", { status: 503 });
    }
    return base(input);
  };
  const nodes = new ChainNodes([s1, s2], { fetch, random: () => 0.5 });
  assert.deepEqual(await nodes.list(["N", "x"]), [{ url: s1, found: true }]);
});

test("a start node that hangs is waited for only its timeout, and not walked from", async () => {
  const hang = host("hang");
  const dialed: string[] = [];
  const base = network(
    { [START]: ["N"], [host("a")]: ["N/x"] },
    () => ({ "N/x": [host("a")] }),
    dialed,
  );
  const fetch = (input: string | URL, init?: RequestInit): Promise<Response> =>
    new URL(input).origin === hang
      ? new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
        )
      : base(input);
  const nodes = new ChainNodes([hang, START], { fetch, timeoutMilliseconds: 50, random: () => 0 });
  assert.deepEqual(await nodes.list(["N", "x"]), [{ url: host("a"), found: true }]);
  assert.ok(dialed.some((key) => key.startsWith(`${START}/api/chain/endpoints`)));
});

test("a slow start node that serves the chain is still listed", async () => {
  const slow = host("slow");
  const base = network({ [START]: [], [slow]: ["N"] });
  const fetch = async (input: string | URL): Promise<Response> => {
    if (new URL(input).origin === slow) await new Promise((done) => setTimeout(done, 1_200));
    return base(input);
  };
  const nodes = new ChainNodes([START, slow], { fetch });
  assert.deepEqual(await nodes.list(["N"]), [{ url: slow, found: false }]);
});

test("one start node's walk failing is not offline, though another serves no ancestor", async () => {
  const [a, b] = [host("a"), host("b")];
  const base = network({ [a]: [], [b]: [] });
  const fetch = async (input: string | URL): Promise<Response> => {
    const url = new URL(input);
    if (url.origin === b && url.searchParams.get("chainPath") === "N") {
      return new Response("{}", { status: 503 });
    }
    return base(input);
  };
  for (const random of [0, 0.5]) {
    await assert.rejects(
      new ChainNodes([a, b], { fetch, random: () => random }).read(["N", "x"], async () => 0),
      { status: 503 },
    );
  }
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
