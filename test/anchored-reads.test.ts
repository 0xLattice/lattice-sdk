import assert from "node:assert/strict";
import { test } from "node:test";

import { cidV1DagCbor, encodeDagCbor, type DagCborValue } from "@adalin/lattice-core";
import { encodeVolumeArchive } from "@adalin/lattice-volumes";
import { connect, ReadError } from "@adalin/lattice-sdk";

const EASIEST = `0x${"f".repeat(64)}`;
const content = new Map<string, Uint8Array>();
const put = (value: DagCborValue) => {
  const bytes = encodeDagCbor(value);
  const cid = cidV1DagCbor(bytes);
  content.set(cid, bytes);
  return cid;
};
const link = (rawCID: string) => ({ rawCID });
const empty = put({});

interface Block {
  readonly cid: string;
  readonly height: bigint;
  readonly timestamp: bigint;
  readonly postState: string;
  readonly target: string;
}

/** A post-state whose general state holds `greeting`. */
function state(greeting: string) {
  const leaf = put({ prefix: "greeting", value: greeting, children: [] });
  const general = put({ children: [{ key: "g", value: { rawCID: leaf } }] });
  return put({
    accountState: link(empty),
    generalState: link(general),
    depositState: link(empty),
    receiptState: link(empty),
  });
}

/** One block on `parent` (a genesis without), its state greeting `greeting`. */
function block(
  parent: Block | undefined,
  greeting: string,
  changes: { prevState?: string; spec?: string; target?: string } = {},
): Block {
  const height = parent === undefined ? 0n : parent.height + 1n;
  const timestamp = (parent?.timestamp ?? 1_000n) + 1n;
  const target = changes.target ?? EASIEST;
  const postState = state(greeting);
  const cid = put({
    version: 1n,
    ...(parent === undefined ? {} : { parent: link(parent.cid) }),
    transactions: link(empty),
    target,
    nextTarget: target,
    spec: link(changes.spec ?? put({ spec: "app" })),
    parentState: link(empty),
    prevState: link(changes.prevState ?? parent?.postState ?? empty),
    postState: link(postState),
    children: link(empty),
    height,
    timestamp,
    nonce: 0n,
  });
  return { cid, height, timestamp, postState, target };
}

/** `length` more blocks on `from` (a new chain without), greeting `name/<height>`. */
function chain(length: number, name: string, from: Block[] = []): Block[] {
  const blocks = [...from];
  while (blocks.length < from.length + length) {
    blocks.push(block(blocks.at(-1), `${name}/${blocks.length}`));
  }
  return blocks;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const view = (b: Block, path: readonly string[]) => ({
  height: String(b.height),
  hash: b.cid,
  timestamp: String(b.timestamp),
  transactionCount: 0,
  childBlockCount: 0,
  nonce: "0",
  version: 1,
  target: b.target,
  nextTarget: b.target,
  transactionsCID: empty,
  postStateCID: b.postState,
  chain: path,
});

/**
 * Nodes at `https://<name>.example.org`, each serving the chain it holds
 * (its blocks by height), as `nodes[name]` says at the time of each request.
 */
function nodes(held: Record<string, Block[]>, path: readonly string[] = ["Nexus", "app"]) {
  const requests: { host: string; path: string }[] = [];
  const fetch = async (input: string | URL): Promise<Response> => {
    const url = new URL(String(input));
    const host = url.host.split(".")[0]!;
    requests.push({ host, path: url.pathname });
    const blocks = held[host];
    if (blocks === undefined) throw new TypeError("fetch failed");
    const tip = blocks.at(-1)!;
    const at = url.pathname;
    if (at === "/api/chain/info") return json({ chain: path });
    if (at === "/api/block/latest") {
      return json({
        height: String(tip.height),
        hash: tip.cid,
        transactionCount: 0,
        timestamp: String(tip.timestamp),
      });
    }
    if (at === "/api/blocks") {
      const before = BigInt(url.searchParams.get("before") ?? String(tip.height + 1n));
      const limit = Number(url.searchParams.get("limit") ?? "10");
      const rows = blocks
        .filter((b) => b.height < before)
        .reverse()
        .slice(0, limit)
        .map((b) => ({
          height: String(b.height),
          hash: b.cid,
          timestamp: String(b.timestamp),
          transactionCount: 0,
        }));
      return json({ blocks: rows });
    }
    if (at.startsWith("/api/block/")) {
      const id = decodeURIComponent(at.slice("/api/block/".length));
      const found = /^\d+$/.test(id) ? blocks[Number(id)] : blocks.find((b) => b.cid === id);
      return found === undefined ? json({ error: "not found" }, 404) : json(view(found, path));
    }
    if (at.startsWith("/volumes/")) {
      const cid = decodeURIComponent(at.slice("/volumes/".length));
      const bytes = content.get(cid);
      if (bytes === undefined) return json({ error: "not found" }, 404);
      return new Response(encodeVolumeArchive({ rootCID: cid, entries: [{ cid, bytes }] }), {
        headers: { "Content-Type": "application/vnd.lattice.volume" },
      });
    }
    return json({ error: "no route" }, 404);
  };
  return { fetch, requests };
}

const real = chain(30, "real");
const genesis = real[0]!.cid;
const at = (name: string) => `https://${name}.example.org`;
const reader = (fetch: any, node: string | string[], more: object = {}) =>
  connect({ chain: "Nexus/app", node, genesis, fetch, key: "11".repeat(32), ...more });

test("a tip that links back to the app's genesis is read", async () => {
  const app = await reader(nodes({ a: real }).fetch, at("a"));
  assert.equal(await app.get("greeting"), "real/29");
});

test("a made-up chain is refused though every CID checks: another genesis", async () => {
  const app = await reader(nodes({ a: chain(30, "made-up") }).fetch, at("a"));
  await assert.rejects(app.get("greeting"), (error: unknown) => {
    assert.ok(error instanceof ReadError);
    assert.equal(error.code, "unanchored");
    return true;
  });
});

test("a made-up tip on real history is refused when it does not link", async () => {
  const tip = real.at(-1)!;
  const forgeries = [
    // A post-state the parent never had.
    [...real, block(tip, "forged", { prevState: state("forged/before") })],
    // Another chain's spec.
    [...real, block(tip, "forged", { spec: put({ spec: "other" }) })],
    // An easier target than its parent scheduled.
    ((hard) => [...real, hard, block(hard, "forged")])(block(tip, "hard", { target: "0x1" })),
  ];
  for (const forged of forgeries) {
    const app = await reader(nodes({ a: forged }).fetch, at("a"));
    await assert.rejects(app.get("greeting"), { name: "ReadError", code: "unanchored" });
  }
});

test("a stale but real tip is read", async () => {
  const held = { a: real };
  const app = await reader(nodes(held).fetch, at("a"));
  assert.equal(await app.get("greeting"), "real/29");
  held.a = real.slice(0, 11);
  assert.equal(await app.get("greeting"), "real/10");
});

test("a read walks back only to the newest block an earlier read linked", async () => {
  const held = { a: real.slice(0, 20) };
  const { fetch, requests } = nodes(held);
  const app = await reader(fetch, at("a"));
  await app.get("greeting");
  held.a = real.slice(0, 22);
  const before = requests.length;
  assert.equal(await app.get("greeting"), "real/21");
  const walked = requests.slice(before).filter((r) => r.path.startsWith("/volumes/"));
  // Two new blocks, the one already linked, and the state: root, trie, leaf.
  assert.equal(walked.length, 3 + 3);
});

test("a walk is bounded: past maxHeaders it fails, and a checkpoint shortens it", async () => {
  const { fetch } = nodes({ a: real });
  const far = await reader(fetch, at("a"), { maxHeaders: 10 });
  await assert.rejects(far.get("greeting"), { name: "ReadError", code: "tooFar" });
  const near = await reader(fetch, at("a"), { maxHeaders: 10, checkpoint: real[25]!.cid });
  assert.equal(await near.get("greeting"), "real/29");
  // A tip that does not descend from the checkpoint is refused.
  const fork = chain(10, "fork", real.slice(0, 22));
  const other = await reader(nodes({ a: fork }).fetch, at("a"), {
    checkpoint: real[25]!.cid,
  });
  await assert.rejects(other.get("greeting"), { name: "ReadError", code: "unanchored" });
});

test("of several nodes, the heaviest tip two of them hold is read", async () => {
  const { fetch } = nodes({ a: real.slice(0, 21), b: real, c: real });
  const app = await reader(fetch, [at("a"), at("b"), at("c")]);
  assert.equal(await app.get("greeting"), "real/29");
  // b alone ahead: a and c hold its parent, which is read.
  const { fetch: two } = nodes({ a: real, b: chain(1, "real", real), c: real });
  assert.equal(await (await reader(two, [at("a"), at("b"), at("c")])).get("greeting"), "real/29");
});

test("a longer fork one node made up is not read over what two nodes hold", async () => {
  // Every block links and its CIDs check: on a chain of easy targets one
  // node can make such a fork for a hash a block, heavier than the real one.
  const fork = chain(30, "fork", real.slice(0, 25));
  const { fetch } = nodes({ a: fork, b: real, c: real });
  const app = await reader(fetch, [at("a"), at("b"), at("c")]);
  assert.equal(await app.get("greeting"), "real/29");
  // With only that node and one other, neither tip is held by two.
  const { fetch: pair } = nodes({ a: fork, b: real });
  await assert.rejects((await reader(pair, [at("a"), at("b")])).get("greeting"), {
    name: "ReadError",
    code: "disagree",
  });
});

test("a node that cannot be reached is passed over", async () => {
  const { fetch } = nodes({ b: real });
  // The first node takes writes, so it must answer at connect; others need not.
  const app = await reader(fetch, [at("b"), at("a")]);
  assert.equal(await app.get("greeting"), "real/29");
});

test("on Nexus, every block walked must meet its proof-of-work target", async () => {
  const nexus = chain(3, "nexus");
  const hard = block(nexus.at(-1), "nexus/3", { target: "0x1" });
  const { fetch } = nodes({ a: [...nexus, hard] }, ["Nexus"]);
  const app = await connect({
    chain: "Nexus",
    node: at("a"),
    genesis: nexus[0]!.cid,
    fetch,
    key: "11".repeat(32),
  });
  await assert.rejects(app.get("greeting"), /proof-of-work/);
});
