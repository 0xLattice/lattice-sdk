import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";

import {
  accountFromPrivateKey,
  bytesToHex,
  cidV1DagCbor,
  decodeDagCbor,
  encodeDagCbor,
  generatePrivateKey,
  isStandardCID,
  type DagCborValue,
} from "@adalin/lattice-core";
import { encodeVolumeArchive } from "@adalin/lattice-volumes";
import { SponsorClient, SponsorError } from "@adalin/lattice-relay";
import { connect, retryDelay, WriteError } from "@adalin/lattice-sdk";

const CHAIN = ["Nexus", "app"];
const NODE = "https://node.example.org";
const sponsorKey = accountFromPrivateKey(generatePrivateKey());

/** Content-addressed blocks of a chain whose state holds `greeting`, `post/1` and `post/2`. */
function chainContent() {
  const content = new Map<string, Uint8Array>();
  const put = (value: DagCborValue) => {
    const bytes = encodeDagCbor(value);
    const cid = cidV1DagCbor(bytes);
    content.set(cid, bytes);
    return cid;
  };
  const leaf = (prefix: string, value: string) => put({ prefix, value, children: [] });
  const link = (key: string, rawCID: string) => ({ key, value: { rawCID } });
  const posts = put({
    prefix: "post/",
    children: [link("2", leaf("2", "b")), link("1", leaf("1", "a"))],
  });
  const general = put({
    count: 7n,
    children: [
      link("g", leaf("greeting", "hello")),
      link("p", posts),
      // Children are filed under a whole Character: one of several code points.
      link("e", leaf("ex", "plain")),
      link("e\u0301", leaf("e\u0301", "accent")),
      link("👋🏽", leaf("👋🏽", "wave")),
      // A node that is not a trie node: its children are not a list.
      link("z", put({ prefix: "z", value: "x", children: "none" })),
    ],
  });
  const state = put({
    accountState: { rawCID: "accounts" },
    generalState: { rawCID: general },
    depositState: { rawCID: "deposits" },
    receiptState: { rawCID: "receipts" },
  });
  const transactions = put([]);
  const block = put({
    version: 1n,
    transactions: { rawCID: transactions },
    target: "0xff",
    nextTarget: "0xff",
    spec: { rawCID: "spec" },
    parentState: { rawCID: "parent-state" },
    prevState: { rawCID: "previous-state" },
    postState: { rawCID: state },
    children: { rawCID: "children" },
    height: 7n,
    timestamp: 1n,
    nonce: 0n,
  });
  const view = {
    height: "7",
    hash: block,
    timestamp: "1",
    transactionCount: 0,
    childBlockCount: 0,
    nonce: "0",
    version: 1,
    target: "0xff",
    nextTarget: "0xff",
    transactionsCID: transactions,
    postStateCID: state,
    chain: CHAIN,
  };
  return { content, block, view };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

type Route = (request: { path: string; body: any; host: string }) => Response | undefined;

/**
 * A node of the chain and sponsors, answering as they do. `sponsorRoute`
 * may answer a sponsor request first; unanswered ones get a sponsor that
 * hands out work of one share per fee, every nonce a share.
 */
function world(
  options: {
    sponsorRoute?: Route;
    nodeRoute?: Route;
    balance?: bigint;
  } = {},
) {
  const { content, block, view } = chainContent();
  const requests: { host: string; path: string; body: any }[] = [];
  const submitted: any[] = [];
  let polls = 0;
  let assignment = 0;
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const path = url.pathname;
    const request = { host: url.host, path, body };
    requests.push(request);
    if (url.origin === NODE) {
      const answer = options.nodeRoute?.(request);
      if (answer !== undefined) return answer;
      if (path === "/api/chain/info") return json({ chain: CHAIN, minRelayFee: "1" });
      if (path === "/api/block/latest") {
        return json({ height: "7", hash: block, transactionCount: 0, timestamp: "1" });
      }
      if (path === `/api/block/${block}`) return json(view);
      if (path.startsWith("/volumes/")) {
        const cid = decodeURIComponent(path.slice("/volumes/".length));
        const bytes = content.get(cid);
        if (bytes === undefined) return json({ error: "not found" }, 404);
        return new Response(encodeVolumeArchive({ rootCID: cid, entries: [{ cid, bytes }] }), {
          headers: { "Content-Type": "application/vnd.lattice.volume" },
        });
      }
      if (path.startsWith("/api/state/account/")) {
        // The nonce moves on with each transaction sent.
        if (options.balance === undefined && submitted.length === 0) {
          return json({ error: "not found" }, 404);
        }
        return json({
          owner: path.split("/").pop(),
          balance: String(options.balance ?? 0n),
          nonce: String((options.balance === undefined ? 0 : 4) + submitted.length),
        });
      }
      if (path === "/transactions") {
        submitted.push(body);
        return json({ transactionCID: "bafytx" });
      }
      if (path === "/api/transaction/bafytx") {
        polls += 1;
        return json({
          txCID: "bafytx",
          ...(polls > 1 ? { blockHeight: "8", blockHash: "bafyblock" } : {}),
          nonce: "0",
          signers: [],
          chainPath: CHAIN,
          accountActions: [],
          depositActions: [],
          receiptActions: [],
          withdrawalActions: [],
        });
      }
      return json({ error: "no route" }, 404);
    }
    const answer = options.sponsorRoute?.(request);
    if (answer !== undefined) return answer;
    if (path === "/work") {
      assignment += 1;
      return json({
        client: "c".repeat(96),
        assignment: `w.${assignment}`,
        prefixHex: "00ff",
        shareTarget: "f".repeat(64),
        startNonce: "0",
        count: "1000",
        fee: "1",
        pay: "0",
        sharesForFee: "1",
        expiresInMilliseconds: "60000",
      });
    }
    if (path === "/shares") return json({ credit: "1" });
    if (path === "/sponsor") {
      const wire = body.transaction.body;
      return json({
        fee: "1",
        pay: "0",
        transaction: {
          signatures: { [sponsorKey.publicKey]: "ab".repeat(64) },
          body: {
            ...wire,
            accountActions: [...wire.accountActions, { owner: sponsorKey.address, delta: "-1" }],
            signers: [...wire.signers, sponsorKey.address],
          },
        },
      });
    }
    return json({ error: { message: "no route" } }, 404);
  };
  return { fetch, requests, submitted };
}

const key = bytesToHex(generatePrivateKey());
const options = (fetch: any, sponsors = ["https://one.example.org"]) => ({
  chain: CHAIN.join("/"),
  node: NODE,
  sponsors,
  key,
  fetch,
});

test("reads come from the tip block the node names, checked by CID", async () => {
  const chain = await connect(options(world().fetch));
  assert.equal(await chain.get("greeting"), "hello");
  assert.equal(await chain.get("post/1"), "a");
  assert.equal(await chain.get("post/"), undefined);
  assert.equal(await chain.get("nothing"), undefined);
  assert.deepEqual(await chain.list("post/"), [
    { key: "post/1", value: "a" },
    { key: "post/2", value: "b" },
  ]);
  assert.deepEqual(await chain.list("post/", { limit: 1 }), [{ key: "post/1", value: "a" }]);
  await assert.rejects(chain.list("", { limit: 0 }), RangeError);
  assert.deepEqual(await chain.list("qq"), []);
});

test("a sponsored write states the value it replaces and resolves once in a block", async () => {
  const { fetch, requests, submitted } = world();
  const stages: string[] = [];
  const chain = await connect({ ...options(fetch), onProgress: (p) => stages.push(p.stage) });
  assert.deepEqual(await chain.set("greeting", "hi"), { transactionCID: "bafytx" });
  assert.equal(submitted.length, 1);
  const { signatures, body } = submitted[0].transaction;
  assert.deepEqual(body.actions, [{ key: "greeting", oldValue: "hello", newValue: "hi" }]);
  assert.deepEqual(body.signers, [chain.address, sponsorKey.address]);
  assert.deepEqual(body.accountActions, [{ owner: sponsorKey.address, delta: "-1" }]);
  assert.deepEqual(body.chainPath, CHAIN);
  assert.equal(Object.keys(signatures).length, 2);
  // The node was asked until the transaction was in a block.
  assert.equal(requests.filter((r) => r.path === "/api/transaction/bafytx").length, 2);
  assert.ok(stages.includes("work") && stages.includes("submit") && stages.includes("confirm"));
});

test("a sponsor's 429 is retried after its Retry-After", async () => {
  let refused = false;
  const { fetch, submitted } = world({
    sponsorRoute: ({ path }) => {
      if (path !== "/work" || refused) return undefined;
      refused = true;
      return json({ error: { message: "slow down" } }, 429, { "Retry-After": "1" });
    },
  });
  const chain = await connect(options(fetch));
  const started = Date.now();
  await chain.set("new", "value");
  assert.ok(Date.now() - started >= 1000, "waited out the Retry-After");
  assert.equal(submitted[0].transaction.body.actions[0].oldValue, undefined);
});

test("work the sponsor no longer knows is replaced with new work", async () => {
  let refusals = 0;
  const { fetch, requests, submitted } = world({
    sponsorRoute: ({ path, body }) =>
      path === "/shares" && body.assignment === "w.1"
        ? json({ error: { message: refusals++ === 0 ? "unknownAssignment" : "expired" } }, 400)
        : undefined,
  });
  await (await connect(options(fetch))).set("greeting", "hi");
  assert.deepEqual(
    requests.filter((r) => r.path === "/work").map((r) => r.body.chain),
    ["Nexus/app", "Nexus/app"],
  );
  // The second work kept the first's client token.
  assert.equal(requests.filter((r) => r.path === "/work")[1]!.body.client, "c".repeat(96));
  assert.equal(submitted.length, 1);
});

test("sponsors are tried in order: one without float gives way to the next", async () => {
  const { fetch, requests, submitted } = world({
    sponsorRoute: ({ host }) =>
      host === "one.example.org"
        ? json({ error: { message: "insufficientFloat" } }, 503)
        : undefined,
  });
  const chain = await connect(
    options(fetch, ["https://one.example.org", "https://two.example.org"]),
  );
  await chain.set("greeting", "hi");
  assert.equal(submitted.length, 1);
  assert.deepEqual(
    requests.filter((r) => r.path === "/sponsor").map((r) => r.host),
    ["two.example.org"],
  );
});

test("when no sponsor can pay, the write fails as sponsor unavailable", async () => {
  const { fetch, submitted } = world({
    sponsorRoute: () => json({ error: { message: "insufficientFloat" } }, 503),
  });
  const chain = await connect(
    options(fetch, ["https://one.example.org", "https://two.example.org"]),
  );
  await assert.rejects(chain.set("greeting", "hi"), (error: unknown) => {
    assert.ok(error instanceof WriteError);
    assert.equal(error.code, "sponsorUnavailable");
    assert.match(error.message, /^sponsor unavailable: insufficientFloat/);
    return true;
  });
  assert.equal(submitted.length, 0);
});

test("an unsponsored key with no coin is told it has insufficient balance", async () => {
  const { fetch, submitted } = world();
  const chain = await connect(options(fetch, []));
  await assert.rejects(chain.set("greeting", "hi"), (error: unknown) => {
    assert.ok(error instanceof WriteError);
    assert.equal(error.code, "insufficientBalance");
    assert.match(error.message, /^insufficient balance/);
    return true;
  });
  assert.equal(submitted.length, 0);
});

test("an unsponsored key with coin pays the node's fee floor itself", async () => {
  const { fetch, submitted } = world({ balance: 5n });
  const chain = await connect(options(fetch, []));
  await chain.set("greeting", "hi");
  const { body } = submitted[0].transaction;
  assert.deepEqual(body.accountActions, [{ owner: chain.address, delta: "-1" }]);
  assert.equal(body.nonce, "4");
});

test("a write the chain refuses is rejected by the chain's rules", async () => {
  const { fetch } = world({
    nodeRoute: ({ path }) =>
      path === "/transactions" ? json({ error: { message: "invalidState" } }, 400) : undefined,
  });
  const chain = await connect(options(fetch));
  await assert.rejects(chain.set("greeting", "hi"), (error: unknown) => {
    assert.ok(error instanceof WriteError);
    assert.equal(error.code, "rejected");
    assert.match(error.message, /^rejected by the chain's rules/);
    return true;
  });
});

test("a file is pinned through the sponsor's storage and named by its root CID", async () => {
  let paid = false;
  const bytes = new TextEncoder().encode("hello, file");
  // A file of at most 1 MiB is one block, as lattice-storage lays it out.
  const expectedRoot = cidV1DagCbor(
    encodeDagCbor({ bytes, size: BigInt(bytes.length), type: "text/plain" }),
  );
  const status = () => ({
    root: expectedRoot,
    bytes: "300",
    needed: paid ? {} : { "Nexus/other": "1", "Nexus/app": "1" },
    credit: paid ? "300" : "0",
    stored: paid,
  });
  const { fetch, requests } = world({
    sponsorRoute: ({ path }) => {
      if (path === "/store" || path.startsWith("/store/")) return json(status());
      if (path === "/shares") {
        paid = true;
        return json({ credit: "0" });
      }
      return undefined;
    },
  });
  const chain = await connect(options(fetch));
  const root = await chain.put(new Blob([bytes], { type: "text/plain" }));
  assert.equal(root, expectedRoot);
  const upload = requests.find((r) => r.path === "/store")!.body;
  assert.equal(upload.root, expectedRoot);
  assert.equal(upload.volumes.length, 1);
  // Work priced on the connected chain, for the upload.
  assert.deepEqual(
    requests.filter((r) => r.path === "/work").map((r) => [r.body.chain, r.body.store]),
    [["Nexus/app", expectedRoot]],
  );
});

test("without a key, the visitor's key is kept in localStorage", async () => {
  const kept = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (name: string) => kept.get(name) ?? null,
      setItem: (name: string, value: string) => void kept.set(name, value),
    },
  });
  try {
    const { fetch } = world();
    const first = await connect({ chain: CHAIN.join("/"), node: NODE, fetch });
    const second = await connect({ chain: CHAIN.join("/"), node: NODE, fetch });
    assert.equal(first.address, second.address);
    assert.deepEqual([...kept.keys()], ["lattice-sdk/key/Nexus/app"]);
    const own = await connect({ chain: CHAIN.join("/"), node: NODE, fetch, storageKey: "mine" });
    assert.notEqual(own.address, first.address);
    assert.deepEqual([...kept.keys()].sort(), ["lattice-sdk/key/Nexus/app", "mine"]);
  } finally {
    if (descriptor === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else Object.defineProperty(globalThis, "localStorage", descriptor);
  }
});

test("with no localStorage at all, a key is made for the session", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError");
    },
  });
  try {
    const chain = await connect({ chain: CHAIN.join("/"), node: NODE, fetch: world().fetch });
    assert.match(chain.address, /^bafyrei/);
  } finally {
    if (descriptor === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else Object.defineProperty(globalThis, "localStorage", descriptor);
  }
});

test("a key is read whole Characters at a time, emoji and combining marks included", async () => {
  const chain = await connect(options(world().fetch));
  assert.equal(await chain.get("e\u0301"), "accent");
  assert.equal(await chain.get("ex"), "plain");
  assert.equal(await chain.get("👋🏽"), "wave");
  assert.equal(await chain.get("👋"), undefined);
});

test("writes made together are sent one after another, each at the next nonce", async () => {
  const { fetch, requests, submitted } = world();
  const chain = await connect(options(fetch));
  await Promise.all([chain.set("greeting", "one"), chain.set("greeting", "two")]);
  assert.deepEqual(
    submitted.map((payload) => [
      payload.transaction.body.nonce,
      payload.transaction.body.actions[0].newValue,
    ]),
    [
      ["0", "one"],
      ["1", "two"],
    ],
  );
  // The second write's work began only after the first was sent.
  const paths = requests.map((r) => r.path);
  assert.ok(paths.lastIndexOf("/work") > paths.indexOf("/transactions"));
});

test("a sponsor that forgot the client token is asked for work again with none", async () => {
  let restarted = false;
  const { fetch, requests, submitted } = world({
    sponsorRoute: ({ path, body }) =>
      restarted && path === "/work" && body.client !== undefined
        ? json({ error: { message: 'draft("unknown client token")' } }, 400)
        : undefined,
  });
  const chain = await connect(options(fetch));
  await chain.set("greeting", "one");
  restarted = true;
  await chain.set("greeting", "two");
  assert.equal(submitted.length, 2);
  assert.deepEqual(
    requests.filter((r) => r.path === "/work").map((r) => r.body.client !== undefined),
    [false, true, false],
  );
});

test("a write never seen in a block fails as not confirmed", async () => {
  const { fetch } = world({
    nodeRoute: ({ path }) =>
      path === "/api/transaction/bafytx"
        ? json({
            txCID: "bafytx",
            nonce: "0",
            signers: [],
            chainPath: CHAIN,
            accountActions: [],
            depositActions: [],
            receiptActions: [],
            withdrawalActions: [],
          })
        : undefined,
  });
  const chain = await connect({ ...options(fetch), confirmTimeoutMilliseconds: 50 });
  await assert.rejects(chain.set("greeting", "hi"), (error: unknown) => {
    assert.ok(error instanceof WriteError);
    assert.equal(error.code, "notConfirmed");
    return true;
  });
});

test("a write stops when its signal aborts", async () => {
  const { fetch } = world();
  const chain = await connect(options(fetch));
  const controller = new AbortController();
  const writing = chain.set("greeting", "hi", { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("left the page")), 20);
  await assert.rejects(writing, /left the page/);
});

test("a Retry-After past 30 s counts the sponsor unavailable at once", async () => {
  const { fetch, submitted, requests } = world({
    sponsorRoute: ({ host }) =>
      host === "one.example.org"
        ? json({ error: { message: "busy" } }, 503, { "Retry-After": "99999999999" })
        : undefined,
  });
  const chain = await connect(
    options(fetch, ["https://one.example.org", "https://two.example.org"]),
  );
  const started = Date.now();
  await chain.set("greeting", "hi");
  assert.equal(submitted.length, 1);
  assert.equal(requests.filter((r) => r.host === "one.example.org").length, 1);
  assert.ok(Date.now() - started < 10_000);
});

test("a Retry-After date is honoured as the wait until it", async () => {
  const at = new Date(Date.now() + 5_000).toUTCString();
  const sponsor = new SponsorClient("https://one.example.org", {
    fetch: async () => json({ error: { message: "busy" } }, 503, { "Retry-After": at }),
  });
  const error = await sponsor.requestWork().catch((caught: unknown) => caught);
  assert.ok(error instanceof SponsorError);
  const wait = retryDelay(error, 0)!;
  assert.ok(wait > 3_000 && wait <= 5_000, `waits ${wait} ms`);
});

test("a sponsor whose float the node finds short gives way to the next", async () => {
  let refusals = 0;
  const { fetch, submitted } = world({
    nodeRoute: ({ path }) =>
      path === "/transactions" && refusals++ === 0
        ? json({ error: { message: "insufficientFunds" } }, 400)
        : undefined,
  });
  const chain = await connect(
    options(fetch, ["https://one.example.org", "https://two.example.org"]),
  );
  await chain.set("greeting", "hi");
  assert.equal(submitted.length, 1);
  assert.equal(refusals, 2);
});

test("an unsponsored write refuses a fee above maxFee", async () => {
  const { fetch, submitted } = world({ balance: 100n });
  const chain = await connect({ ...options(fetch, []), maxFee: 0n });
  await assert.rejects(chain.set("greeting", "hi"), (error: unknown) => {
    assert.ok(error instanceof WriteError);
    assert.equal(error.code, "refused");
    assert.match(error.message, /above maxFee 0/);
    return true;
  });
  assert.equal(submitted.length, 0);
});

test("a sponsor that always forgets the client token is given up on, not tried forever", async () => {
  const { fetch, requests, submitted } = world({
    sponsorRoute: ({ path, body }) =>
      (path === "/work" && body.client !== undefined) || path === "/sponsor"
        ? json({ error: { message: 'draft("unknown client token")' } }, 400)
        : undefined,
  });
  const chain = await connect(options(fetch));
  await assert.rejects(chain.set("greeting", "hi"), (error: unknown) => {
    assert.ok(error instanceof WriteError);
    assert.equal(error.code, "sponsorUnavailable");
    assert.match(error.message, /unknown client token/);
    return true;
  });
  // The co-signature was asked once, then again after each of three fresh starts.
  assert.equal(requests.filter((r) => r.path === "/sponsor").length, 4);
  assert.equal(submitted.length, 0);
});

test("a sponsor that forgot the token by the co-signature is paid again with a new one", async () => {
  let forgot = false;
  const { fetch, requests, submitted } = world({
    sponsorRoute: ({ path }) => {
      if (path !== "/sponsor" || forgot) return undefined;
      forgot = true;
      return json({ error: { message: 'draft("unknown client token")' } }, 400);
    },
  });
  await (await connect(options(fetch))).set("greeting", "hi");
  assert.equal(submitted.length, 1);
  assert.deepEqual(
    requests.filter((r) => r.path === "/work").map((r) => r.body.client !== undefined),
    [false, false],
  );
});

test("an upload paid for but never pinned stops after 60 polls", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const status = {
    root: "bafyroot",
    bytes: "10",
    needed: { "Nexus/app": "1" },
    credit: "10",
    stored: false,
  };
  const { fetch, requests } = world({
    sponsorRoute: ({ path }) =>
      path === "/store" || path.startsWith("/store/") ? json(status) : undefined,
  });
  const chain = await connect(options(fetch));
  let outcome: unknown;
  const putting = chain.put(new Uint8Array([1, 2, 3])).then(
    () => (outcome = "pinned"),
    (error: unknown) => (outcome = error),
  );
  for (let tick = 0; tick < 500 && outcome === undefined; tick++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(2_000);
  }
  assert.ok(outcome !== undefined, "the wait for the pin ended");
  await putting;
  assert.ok(outcome instanceof WriteError);
  assert.equal(outcome.code, "sponsorUnavailable");
  assert.match(outcome.message, /did not pin/);
  assert.equal(requests.filter((r) => r.path.startsWith("/store/")).length, 60);
});

test("an error in the page's own code is not reported as an unavailable sponsor", async () => {
  const bug = new TypeError("progress display broke");
  const chain = await connect({
    ...options(world().fetch),
    onProgress: (p) => {
      if (p.stage === "work") throw bug;
    },
  });
  await assert.rejects(chain.set("greeting", "hi"), (error: unknown) => error === bug);
});

test("list refuses a limit that is not a positive integer, and reads refuse what is not a trie node", async () => {
  const chain = await connect(options(world().fetch));
  for (const limit of [0, -1, 1.5, Number.NaN, Infinity]) {
    await assert.rejects(chain.list("", { limit }), RangeError, `limit ${limit}`);
  }
  await assert.rejects(chain.get("z"), /is not a general-state trie node/);
  await assert.rejects(chain.list("z"), /is not a general-state trie node/);
});

test("each chain keeps its own key by default", async () => {
  const kept = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (name: string) => kept.get(name) ?? null,
      setItem: (name: string, value: string) => void kept.set(name, value),
    },
  });
  try {
    const { fetch } = world();
    const app = await connect({ chain: "Nexus/app", node: NODE, fetch });
    const other = await connect({ chain: "Nexus/other", node: NODE, fetch });
    const appAgain = await connect({ chain: "Nexus/app", node: NODE, fetch });
    assert.notEqual(app.address, other.address);
    assert.equal(app.address, appAgain.address);
    assert.deepEqual([...kept.keys()].sort(), [
      "lattice-sdk/key/Nexus/app",
      "lattice-sdk/key/Nexus/other",
    ]);
  } finally {
    if (descriptor === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else Object.defineProperty(globalThis, "localStorage", descriptor);
  }
});

test("a write queued behind an aborted one still runs", async () => {
  const { fetch, submitted } = world();
  const chain = await connect(options(fetch));
  const controller = new AbortController();
  const first = chain.set("greeting", "one", { signal: controller.signal });
  const second = chain.set("greeting", "two");
  setTimeout(() => controller.abort(new Error("left the page")), 20);
  await assert.rejects(first, /left the page/);
  // The first was aborted while it waited for its block; the second still went out.
  assert.deepEqual(await second, { transactionCID: "bafytx" });
  assert.equal(submitted.at(-1).transaction.body.actions[0].newValue, "two");
});

test("an upload aborted while it waits its turn ends without sending anything", async () => {
  const { fetch, requests } = world();
  const chain = await connect(options(fetch));
  const controller = new AbortController();
  const writing = chain.set("greeting", "one");
  const uploading = chain.put(new Uint8Array([1]), { signal: controller.signal });
  controller.abort(new Error("cancelled"));
  await assert.rejects(uploading, /cancelled/);
  await writing;
  assert.equal(requests.filter((r) => r.path === "/store").length, 0);
});

test("an unsponsored write pays the node's fee floor as it is at the time", async () => {
  let floor = 1;
  const { fetch, submitted } = world({
    balance: 100n,
    nodeRoute: ({ path }) =>
      path === "/api/chain/info" ? json({ chain: CHAIN, minRelayFee: String(floor) }) : undefined,
  });
  const chain = await connect(options(fetch, []));
  await chain.set("greeting", "one");
  floor = 3;
  await chain.set("greeting", "two");
  assert.deepEqual(
    submitted.map((payload) => payload.transaction.body.accountActions[0].delta),
    ["-1", "-3"],
  );
});

/** A node that also serves `files`, Volumes of one block each, by CID. */
function fileWorld(files: Map<string, Uint8Array>) {
  const { fetch, requests } = world({
    nodeRoute: ({ path }) => {
      if (!path.startsWith("/volumes/")) return undefined;
      const cid = decodeURIComponent(path.slice("/volumes/".length));
      const bytes = files.get(cid);
      if (bytes === undefined) return undefined;
      return new Response(encodeVolumeArchive({ rootCID: cid, entries: [{ cid, bytes }] }), {
        headers: { "Content-Type": "application/vnd.lattice.volume" },
      });
    },
  });
  return { fetch, requests };
}

/** Stores `value` as one block; its CID. */
function stored(files: Map<string, Uint8Array>, value: DagCborValue) {
  const bytes = encodeDagCbor(value);
  const cid = cidV1DagCbor(bytes);
  files.set(cid, bytes);
  return cid;
}

test("a file put stored reads back whole, with its type", async () => {
  // 2.5 MiB: two whole chunks and a part.
  const data = new Uint8Array((5 << 20) / 2).map((_, i) => (i * 7) & 0xff);
  const files = new Map<string, Uint8Array>();
  const { fetch } = fileWorld(files);
  let root = "";
  const chain = await connect({
    ...options(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/store") {
        // The sponsor keeps what was uploaded, and the node serves it.
        const upload = JSON.parse(String(init!.body));
        root = upload.root;
        for (const volume of upload.volumes) {
          for (const [cid, base64] of Object.entries(volume.entries)) {
            files.set(cid, new Uint8Array(Buffer.from(base64 as string, "base64")));
          }
        }
        return json({ root, bytes: "0", needed: {}, credit: "0", stored: true });
      }
      return fetch(input, init);
    }),
  });
  assert.equal(await chain.put(new Blob([data], { type: "image/png" })), root);
  const file = await chain.getFile(root);
  assert.equal(file.type, "image/png");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), data);
});

test("a small file stored as one block reads back", async () => {
  const files = new Map<string, Uint8Array>();
  const bytes = new TextEncoder().encode("hello");
  const root = stored(files, { type: "text/plain", size: 5n, bytes });
  const chain = await connect(options(fileWorld(files).fetch));
  const file = await chain.getFile(root);
  assert.equal(file.type, "text/plain");
  assert.equal(await file.text(), "hello");
});

test("a file whose chunks do not add up to its size is refused", async () => {
  const files = new Map<string, Uint8Array>();
  const chunk = stored(files, { bytes: new Uint8Array(10) });
  const short = stored(files, { type: "", size: 11n, chunks: [chunk] });
  const missing = stored(files, { type: "", size: 10n, chunks: [] });
  const extra = stored(files, { type: "", size: 10n, chunks: [chunk], name: "x" });
  const chain = await connect(options(fileWorld(files).fetch));
  await assert.rejects(chain.getFile(short), /chunk 0 .* is not 11 bytes/);
  await assert.rejects(chain.getFile(missing), /chunks do not cover its size/);
  await assert.rejects(chain.getFile(extra), /not \{ type, size, bytes \| chunks \}/);
  // A block whose bytes are not its CID never reaches the reader.
  files.set(chunk, encodeDagCbor({ bytes: new Uint8Array(10).fill(1) }));
  const swapped = stored(files, { type: "", size: 10n, chunks: [chunk] });
  await assert.rejects(chain.getFile(swapped));
});

test("a file over maxBytes is refused before any chunk is fetched", async () => {
  const files = new Map<string, Uint8Array>();
  const chunk = stored(files, { bytes: new Uint8Array(10) });
  const root = stored(files, { type: "", size: 10n, chunks: [chunk] });
  const { fetch, requests } = fileWorld(files);
  const chain = await connect(options(fetch));
  await assert.rejects(chain.getFile(root, { maxBytes: 9 }), RangeError);
  assert.ok(!requests.some((r) => r.path === `/volumes/${chunk}`));
  assert.equal((await chain.getFile(root, { maxBytes: 10 })).size, 10);
});

test("a file read stops when its signal aborts", async () => {
  const files = new Map<string, Uint8Array>();
  const root = stored(files, { type: "", size: 1n, bytes: new Uint8Array(1) });
  const chain = await connect(options(fileWorld(files).fetch));
  const stop = new AbortController();
  stop.abort(new Error("stopped"));
  await assert.rejects(chain.getFile(root, { signal: stop.signal }), /stopped/);
});

/**
 * lattice-storage's reader (0xLattice/lattice-storage `client/file.mjs` at
 * fc24f13): `readRoot` over `readBlock`, ported line for line. A root it
 * takes, or undefined.
 */
function storageReadRoot(volume: { cid: string; entries: Record<string, string> }) {
  const CHUNK_BYTES = 1 << 20;
  const encoded = volume?.entries?.[volume.cid];
  if (typeof encoded !== "string") return undefined;
  let root: any;
  try {
    const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
    if (cidV1DagCbor(bytes) !== volume.cid) return undefined;
    root = decodeDagCbor(bytes);
    if (Buffer.compare(encodeDagCbor(root), bytes) !== 0) return undefined;
  } catch {
    return undefined;
  }
  if (typeof root !== "object" || root === null || Object.keys(root).length !== 3) return undefined;
  const { type, size, bytes, chunks } = root;
  if (typeof type !== "string" || type.length > 255 || typeof size !== "bigint") return undefined;
  if (bytes instanceof Uint8Array) {
    return BigInt(bytes.length) === size && size <= BigInt(CHUNK_BYTES) ? root : undefined;
  }
  const count = (size + BigInt(CHUNK_BYTES) - 1n) / BigInt(CHUNK_BYTES);
  if (!Array.isArray(chunks) || size <= BigInt(CHUNK_BYTES)) return undefined;
  if (
    BigInt(chunks.length) !== count ||
    !chunks.every(
      (cid) => typeof cid === "string" && /^b[a-z2-7]+$/.test(cid) && isStandardCID(cid),
    )
  ) {
    return undefined;
  }
  return root;
}

test("files put stores are roots lattice-storage's reader takes, small and large", async () => {
  for (const length of [0, 11, 1 << 20, (1 << 20) + 1]) {
    let upload: any;
    const { fetch } = world({
      sponsorRoute: ({ path, body }) => {
        if (path !== "/store") return undefined;
        upload = body;
        return json({ root: body.root, bytes: "0", needed: {}, credit: "0", stored: true });
      },
    });
    const chain = await connect(options(fetch));
    await chain.put(new Uint8Array(length), { type: "text/plain" });
    const root = storageReadRoot(upload.volumes[0]);
    assert.ok(root, `a ${length}-byte file's root`);
    assert.equal(root.size, BigInt(length));
    assert.equal(upload.volumes.length, length <= 1 << 20 ? 1 : 3);
  }
});

test("a small file stored chunked, as earlier versions of put did, still reads", async () => {
  const files = new Map<string, Uint8Array>();
  const bytes = new TextEncoder().encode("hello, file");
  const chunk = stored(files, { bytes });
  const root = stored(files, { chunks: [chunk], size: BigInt(bytes.length), type: "text/plain" });
  const chain = await connect(options(fileWorld(files).fetch));
  assert.equal(await (await chain.getFile(root)).text(), "hello, file");
});
