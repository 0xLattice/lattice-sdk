import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { cidV1DagCbor } from "../packages/core/src/index.js";
import {
  ChainFollower,
  Topic,
  canonicalJSON,
  type FollowedBlock,
} from "../packages/peer/src/index.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/child-proof/moniker-243775.json", import.meta.url), "utf8"),
) as { block: string; proofs: string[] };
const cid = cidV1DagCbor(new Uint8Array(Buffer.from(fixture.block, "base64")));
const genesis = "bafyreiggtg4ezifboyekbf4gxst2jr3mpjqcxsbmopy7w6fp46g4ngpgxa";
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function follower() {
  const sent: { topic: string; body: string }[] = [];
  const tips: FollowedBlock[] = [];
  const rejected: string[] = [];
  const peer = new ChainFollower({
    chainPath: ["Nexus", "moniker"],
    nexusGenesisCID: genesis,
    send: (topic, payload) => sent.push({ topic, body: new TextDecoder().decode(payload) }),
    onTip: (tip) => tips.push(tip),
    onRejected: (_, reason) => rejected.push(reason),
  });
  return { peer, sent, tips, rejected };
}

test("canonical JSON sorts keys, drops absent fields and writes a UInt64 in full", () => {
  assert.equal(
    canonicalJSON({ b: 1, a: [true, null], c: undefined, d: 18446744073709551615n }),
    '{"a":[true,null],"b":1,"d":18446744073709551615}',
  );
});

test("a node that offers the tail is asked for it, and a pushed header is checked and becomes the tip", () => {
  const { peer, sent, tips, rejected } = follower();
  peer.open();
  assert.equal(sent[0]!.body, `{"chainPath":["Nexus"],"nexusGenesisCID":"${genesis}","version":6}`);
  peer.deliver(
    Topic.hello,
    json({
      capabilities: ["stream-tail"],
      chainPath: ["Nexus"],
      nexusGenesisCID: genesis,
      version: 6,
    }),
  );
  assert.equal(
    sent[1]!.body,
    '{"after":18446744073709551615,"chainPath":["Nexus","moniker"],"own":"","requestID":1}',
  );
  // The node reads this peer's log: it is answered with the empty one.
  peer.deliver(
    Topic.streamRequest,
    json({ after: 0, chainPath: ["Nexus"], own: "x", requestID: 5 }),
  );
  assert.equal(
    sent[2]!.body,
    '{"chainPath":["Nexus"],"entries":[],"hasMore":false,"logID":"","requestID":5}',
  );
  peer.deliver(
    Topic.streamPage,
    json({
      chainPath: ["Nexus", "moniker"],
      entries: [{ block: cid, cid, position: 9, proof: false }],
      hasMore: false,
      logID: "log",
      requestID: 1,
    }),
  );
  assert.equal(sent[3]!.body, `{"chainPath":["Nexus","moniker"],"cids":["${cid}"],"requestID":2}`);
  peer.deliver(
    Topic.headersResponse,
    json({
      chainPath: ["Nexus", "moniker"],
      entries: [{ block: fixture.block, proofs: fixture.proofs }],
      hasMore: false,
      requestID: 2,
    }),
  );
  assert.deepEqual(rejected, []);
  assert.equal(tips.length, 1);
  assert.equal(tips[0]!.cid, cid);
  assert.equal(tips[0]!.block.height, 243775n);
});

test("a header whose proof does not verify never becomes the tip", () => {
  const { peer, tips, rejected } = follower();
  peer.deliver(Topic.hello, json({ chainPath: ["Nexus"], nexusGenesisCID: genesis, version: 6 }));
  peer.deliver(
    Topic.headersResponse,
    json({
      chainPath: ["Nexus", "moniker"],
      entries: [{ block: fixture.block, proofs: [] }],
      hasMore: false,
      requestID: 0,
    }),
  );
  assert.deepEqual(tips, []);
  assert.deepEqual(rejected, ["its proof of work does not verify"]);
});

test("a node on another network is refused", () => {
  const { peer } = follower();
  assert.throws(() =>
    peer.deliver(
      Topic.hello,
      json({ chainPath: ["Nexus"], nexusGenesisCID: "bafyother", version: 6 }),
    ),
  );
});

// Nexus blocks built here: a target at the maximum is met by any hash (work
// 1); half the maximum (work 2) by a nonce found below.
import {
  canonicalBlockProofOfWorkHash,
  decodeCanonicalBlock,
  encodeDagCbor,
} from "../packages/core/src/index.js";

const link = (seed: string) => ({ rawCID: cidV1DagCbor(new TextEncoder().encode(seed)) });
const EASY = "0x" + "f".repeat(64);
const HALF = "0x7" + "f".repeat(63);
function nexusBlock(parent: string | undefined, height: number, target: string, salt = "") {
  for (let nonce = 0n; ; nonce += 1n) {
    const value = {
      children: link("c"),
      height: BigInt(height),
      nextTarget: target,
      nonce,
      ...(parent === undefined ? {} : { parent: { rawCID: parent } }),
      parentState: link("ps"),
      postState: link(`post${height}${salt}`),
      prevState: link("pre"),
      spec: link("spec"),
      target,
      timestamp: BigInt(height),
      transactions: link(`tx${salt}`),
      version: 1n,
    };
    const bytes = encodeDagCbor(value);
    const hash = BigInt(
      "0x" +
        Buffer.from(canonicalBlockProofOfWorkHash(decodeCanonicalBlock(bytes))).toString("hex"),
    );
    if (hash <= BigInt(target))
      return {
        bytes,
        cid: cidV1DagCbor(bytes),
        entry: { block: Buffer.from(bytes).toString("base64"), proofs: [] },
      };
  }
}

function nexusFollower() {
  const sent: { topic: string; body: string }[] = [];
  const tips: FollowedBlock[] = [];
  const peer = new ChainFollower({
    chainPath: ["Nexus"],
    nexusGenesisCID: genesis,
    send: (topic, payload) => sent.push({ topic, body: new TextDecoder().decode(payload) }),
    onTip: (tip) => tips.push(tip),
  });
  const headers = (entries: unknown[], requestID = 0) =>
    peer.deliver(
      Topic.headersResponse,
      json({ chainPath: ["Nexus"], entries, hasMore: false, requestID }),
    );
  return { peer, sent, tips, headers };
}

test("a branch from below where the follower started never outweighs the chain it follows", () => {
  const { peer, sent, tips, headers } = nexusFollower();
  const g = nexusBlock(undefined, 0, HALF);
  const a1 = nexusBlock(g.cid, 1, HALF),
    a2 = nexusBlock(a1.cid, 2, HALF);
  const a3 = nexusBlock(a2.cid, 3, HALF),
    a4 = nexusBlock(a3.cid, 4, HALF);
  headers([a3.entry]);
  headers([a4.entry]);
  assert.equal(peer.tip?.cid, a4.cid);
  // A work-1 block on a2, then its ancestors back to genesis: none of them
  // reach a block the follower holds, so none is weighed.
  const x = nexusBlock(a2.cid, 3, EASY, "x");
  headers([x.entry]);
  const ask = JSON.parse(sent.at(-1)!.body);
  assert.equal(sent.at(-1)!.topic, Topic.ancestorsRequest);
  assert.equal(ask.cid, a2.cid);
  headers([a2.entry, a1.entry, g.entry], ask.requestID);
  assert.equal(peer.tip?.cid, a4.cid);
  assert.deepEqual(
    tips.map((tip) => tip.cid),
    [a3.cid, a4.cid],
  );
});

test("a fork that connects is weighed from where it meets the chain", () => {
  const { peer, sent, headers } = nexusFollower();
  const g = nexusBlock(undefined, 0, HALF);
  const a1 = nexusBlock(g.cid, 1, HALF),
    a2 = nexusBlock(a1.cid, 2, HALF);
  headers([a1.entry]);
  headers([a2.entry]);
  const b2 = nexusBlock(a1.cid, 2, HALF, "b"),
    b3 = nexusBlock(b2.cid, 3, HALF, "b");
  headers([b3.entry]);
  const ask = JSON.parse(sent.at(-1)!.body);
  assert.equal(ask.cid, b2.cid);
  headers([b2.entry], ask.requestID);
  assert.equal(peer.tip?.cid, b3.cid);
  assert.equal(peer.tip?.cumulativeWork, 6n);
});

test("a respelled target is not a block", () => {
  const { tips, headers } = nexusFollower();
  const value = decodeCanonicalBlock(nexusBlock(undefined, 0, EASY).bytes);
  const bytes = encodeDagCbor({
    children: link("c"),
    height: 0n,
    nextTarget: EASY,
    nonce: value.nonce,
    parentState: link("ps"),
    postState: link("post0"),
    prevState: link("pre"),
    spec: link("spec"),
    target: "0x0" + "f".repeat(64),
    timestamp: 0n,
    transactions: link("tx"),
    version: 1n,
  });
  headers([{ block: Buffer.from(bytes).toString("base64"), proofs: [] }]);
  assert.deepEqual(tips, []);
});

test("payloads of the wrong shape are ignored, never thrown", () => {
  const { peer, tips } = nexusFollower();
  for (const [topic, body] of [
    [Topic.headersResponse, null],
    [Topic.headersResponse, { chainPath: ["Nexus"], entries: 5 }],
    [Topic.headersResponse, { chainPath: ["Nexus"], entries: [{ block: 1, proofs: "x" }] }],
    [
      Topic.streamPage,
      { chainPath: ["Nexus"], entries: [{ position: "x" }], logID: "l", requestID: 1 },
    ],
    [Topic.streamRequest, { chainPath: "Nexus", requestID: 1 }],
    [Topic.headersResponse, { entries: [] }],
  ] as const) {
    assert.doesNotThrow(() => peer.deliver(topic, json(body)));
  }
  assert.deepEqual(tips, []);
});

test("a reorg of the first block it took still connects, through that block's ancestors", () => {
  const { peer, sent, headers } = nexusFollower();
  const g = nexusBlock(undefined, 0, HALF);
  const a1 = nexusBlock(g.cid, 1, HALF);
  const x = nexusBlock(a1.cid, 2, HALF, "x");
  headers([x.entry]);
  const ask = JSON.parse(sent.at(-1)!.body);
  assert.equal(ask.cid, a1.cid);
  headers([a1.entry, g.entry], ask.requestID);
  const y = nexusBlock(a1.cid, 2, HALF, "y"),
    y3 = nexusBlock(y.cid, 3, HALF, "y");
  headers([y.entry]);
  headers([y3.entry]);
  assert.equal(peer.tip?.cid, y3.cid);
});
