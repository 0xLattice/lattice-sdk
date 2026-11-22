import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accountFromPrivateKey,
  bytesToHex,
  cidV1DagCbor,
  encodeDagCbor,
  generatePrivateKey,
  type DagCborValue,
} from "@adalin/lattice-core";
import { encodeVolumeArchive } from "@adalin/lattice-volumes";
import { connect, WriteError } from "@adalin/lattice-sdk";

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
    count: 3n,
    children: [link("g", leaf("greeting", "hello")), link("p", posts)],
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
        if (options.balance === undefined) return json({ error: "not found" }, 404);
        return json({ owner: path.split("/").pop(), balance: String(options.balance), nonce: "4" });
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

test("reads come from the tip's state, checked by CID", async () => {
  const chain = await connect(options(world().fetch));
  assert.equal(await chain.get("greeting"), "hello");
  assert.equal(await chain.get("post/1"), "a");
  assert.equal(await chain.get("post/"), undefined);
  assert.equal(await chain.get("nothing"), undefined);
  assert.deepEqual(await chain.list("post/"), [
    { key: "post/1", value: "a" },
    { key: "post/2", value: "b" },
  ]);
  assert.deepEqual(await chain.list("", { limit: 2 }), [
    { key: "greeting", value: "hello" },
    { key: "post/1", value: "a" },
  ]);
  assert.deepEqual(await chain.list("zz"), []);
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
  const expectedRoot = (() => {
    const chunk = cidV1DagCbor(encodeDagCbor({ bytes }));
    return cidV1DagCbor(
      encodeDagCbor({ chunks: [chunk], size: BigInt(bytes.length), type: "text/plain" }),
    );
  })();
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
  assert.equal(upload.volumes.length, 2);
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
    assert.equal(kept.size, 1);
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
