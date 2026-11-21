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
