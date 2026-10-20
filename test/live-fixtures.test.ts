import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { NodeClient } from "@adalin/lattice-client";

// Bodies captured verbatim with read-only GETs from the public read replica
// (lattice-mainnet-read.fly.dev) and the testnet follower
// (lattice-mainnet-testnet.fly.dev), lattice-node main 1829188.
const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/live/${name}`, import.meta.url), "utf8");

function serving(routes: Record<string, string>, requested: string[] = []) {
  return async (input: string | URL): Promise<Response> => {
    const url = new URL(input);
    const key = `${url.pathname}?${url.searchParams.toString()}`;
    requested.push(key);
    const name = routes[key];
    if (name === undefined) return new Response("{}", { status: 404 });
    return new Response(fixture(name), { headers: { "Content-Type": "application/json" } });
  };
}

const TIP = "bafyreicmsum2butkopy4xxyzxmirzkcagzjxi2cuubzzuyowk7uzq2sh7i";

test("live blocks page parses to exact bigints, newest first", async () => {
  const requested: string[] = [];
  const fetch = serving(
    { "/api/blocks?chainPath=Nexus&before=4483&limit=3": "read-blocks.json" },
    requested,
  );
  const client = new NodeClient("https://reads.example.org", ["Nexus"], { fetch });
  const page = await client.blocks({ before: 4483n, limit: 3 });
  assert.deepEqual(requested, ["/api/blocks?chainPath=Nexus&before=4483&limit=3"]);
  assert.deepEqual(
    page.blocks.map((row) => row.height),
    [4482n, 4481n, 4480n],
  );
  assert.equal(page.nextBefore, 4480n);
  assert.equal(page.blocks[0]?.hash, TIP);
  assert.equal(page.blocks[0]?.timestamp, 1_791_183_227_900n);
  assert.equal(page.blocks[0]?.transactionCount, 0);
  assert.equal(
    page.blocks[0]?.rewardRecipient,
    "bafyreiey2mpyfi3k64xe7ixxjyk2uv4hvaqovezmzivccexhekxxp35fee",
  );
  assert.equal("rewardCredited" in page.blocks[0]!, false);
});

test("the genesis page has no previousBlock, no reward recipient, and no nextBefore", async () => {
  const fetch = serving({
    "/api/blocks?chainPath=Nexus&before=1&limit=5": "read-blocks-genesis.json",
  });
  const client = new NodeClient("https://reads.example.org", ["Nexus"], { fetch });
  const page = await client.blocks({ before: 1n, limit: 5 });
  assert.equal(page.blocks.length, 1);
  assert.equal(page.blocks[0]?.height, 0n);
  assert.equal(page.blocks[0]?.previousBlock, undefined);
  assert.equal(page.blocks[0]?.rewardRecipient, undefined);
  assert.equal(page.nextBefore, undefined);
});

test("blocks rejects out-of-contract arguments before any request", async () => {
  const fetch = async (): Promise<Response> => assert.fail("must not fetch");
  const client = new NodeClient("https://reads.example.org", ["Nexus"], { fetch });
  await assert.rejects(client.blocks({ limit: 26 }), /limit must be an integer from 1 to 25/);
  await assert.rejects(client.blocks({ limit: 0 }), /limit must be an integer from 1 to 25/);
  await assert.rejects(client.blocks({ limit: 1.5 }), /limit must be an integer from 1 to 25/);
  await assert.rejects(client.blocks({ before: -1n }), /before must not be negative/);
});

test("a blocks page that breaks its own contract fails closed", async () => {
  const live = JSON.parse(fixture("read-blocks.json"));
  const answer = (body: unknown) => async (): Promise<Response> =>
    new Response(JSON.stringify(body));
  const client = (body: unknown) =>
    new NodeClient("https://reads.example.org", ["Nexus"], { fetch: answer(body) });
  await assert.rejects(client(live).blocks({ limit: 2 }), /exceeds its limit/);
  await assert.rejects(client(live).blocks({ before: 4482n }), /strictly descending/);
  await assert.rejects(
    client({ ...live, blocks: [...live.blocks].reverse() }).blocks(),
    /strictly descending/,
  );
  await assert.rejects(
    client({ ...live, nextBefore: "4481" }).blocks(),
    /nextBefore does not continue/,
  );
  await assert.rejects(client({ blocks: [], nextBefore: "0" }).blocks(), /nextBefore/);
  // A height this node does not hold is omitted: nextBefore may fall below the last row.
  const holed = await client({ blocks: live.blocks.slice(0, 1), nextBefore: "4480" }).blocks({
    before: 4483n,
    limit: 3,
  });
  assert.equal(holed.nextBefore, 4480n);
  await assert.rejects(
    client({ ...live, blocks: [{ ...live.blocks[0], height: 4482 }] }).blocks(),
    /height must be a canonical decimal string/,
  );
});

test("live chain info carries the relay fee floor and the listener's submit flag", async () => {
  const read = new NodeClient("https://reads.example.org", ["Nexus"], {
    fetch: serving({ "/api/chain/info?chainPath=Nexus": "read-chain-info.json" }),
  });
  const info = await read.chainInfo();
  assert.equal(info.minRelayFee, 0n);
  assert.equal(info.acceptsSubmit, true);
  assert.equal(info.height, 4482n);
  assert.deepEqual(info.chain, ["Nexus"]);

  const follower = new NodeClient("https://follower.example.org", ["Nexus", "testnet"], {
    fetch: serving({
      "/api/chain/info?chainPath=Nexus%2Ftestnet": "testnet-child-chain-info.json",
    }),
  });
  const child = await follower.chainInfo();
  assert.equal(child.acceptsSubmit, false);
  assert.deepEqual(child.chain, ["Nexus", "testnet"]);

  const malformed = new NodeClient("https://reads.example.org", ["Nexus"], {
    fetch: async () => new Response(JSON.stringify({ chain: ["Nexus"], acceptsSubmit: "true" })),
  });
  await assert.rejects(malformed.chainInfo(), /acceptsSubmit must be a boolean/);
  const numericFee = new NodeClient("https://reads.example.org", ["Nexus"], {
    fetch: async () => new Response(JSON.stringify({ chain: ["Nexus"], minRelayFee: 0 })),
  });
  await assert.rejects(numericFee.chainInfo(), /minRelayFee must be a canonical decimal string/);
});

test("live block detail and latest summary report the coinbase", async () => {
  const client = new NodeClient("https://reads.example.org", ["Nexus"], {
    fetch: serving({
      [`/api/block/${TIP}?chainPath=Nexus`]: "read-block.json",
      "/api/block/latest?chainPath=Nexus": "read-latest.json",
    }),
  });
  const block = await client.block(TIP);
  assert.equal(block.rewardCredited, 1_048_576n);
  assert.equal(
    block.rewardRecipient,
    "bafyreiey2mpyfi3k64xe7ixxjyk2uv4hvaqovezmzivccexhekxxp35fee",
  );
  assert.equal(block.childBlockCount, 1);
  const latest = await client.latestBlock();
  assert.equal(latest.hash, TIP);
  assert.equal(latest.rewardCredited, 1_048_576n);
});

test("live block children name each committed child block", async () => {
  const requested: string[] = [];
  const client = new NodeClient("https://reads.example.org", ["Nexus"], {
    fetch: serving(
      { [`/api/block/${TIP}/children?chainPath=Nexus`]: "read-children.json" },
      requested,
    ),
  });
  const children = await client.children(TIP);
  assert.deepEqual(children, [
    {
      directory: "testnet",
      blockHash: "bafyreiaomyjl7iryqain2l4jkz4knp5cvukkhgrbngjfl53llkeql7dnb4",
    },
  ]);
});

test("a node hosting the child reports its height and transaction count", async () => {
  const requested: string[] = [];
  const client = new NodeClient("https://reads.example.org", ["Nexus", "testnet"], {
    fetch: async (input: string | URL) => {
      const url = new URL(input);
      requested.push(`${url.pathname}?${url.searchParams.toString()}`);
      return new Response(
        JSON.stringify({
          children: [
            { directory: "deep", blockHash: "bafychild", height: "12", transactionCount: 2 },
          ],
        }),
      );
    },
  });
  assert.deepEqual(await client.children("bafyparent"), [
    { directory: "deep", blockHash: "bafychild", height: 12n, transactionCount: 2 },
  ]);
  assert.deepEqual(requested, ["/api/block/bafyparent/children?chainPath=Nexus%2Ftestnet"]);
});

test("a transaction outside the canonical executed chain omits inclusion", async () => {
  const cid = "bafyreia734w2h6pyv2isd27m4v3n5p7q72aknkpoecdci2cdfl2bxx2i2y";
  const client = new NodeClient("https://reads.example.org", ["Nexus"], {
    fetch: serving({
      [`/api/transaction/${cid}?chainPath=Nexus`]: "read-transaction-genesis.json",
    }),
  });
  const projection = await client.transaction(cid);
  assert.equal(projection.blockHeight, undefined);
  assert.equal(projection.blockHash, undefined);
  assert.equal(projection.accountActions[0]?.delta, 183_836_344_320n);

  const included = new NodeClient("https://reads.example.org", ["Nexus"], {
    fetch: async () =>
      new Response(
        JSON.stringify({
          ...JSON.parse(fixture("read-transaction-genesis.json")),
          blockHeight: "7",
          blockHash: "bafyblock",
          timestamp: "1791183227900",
        }),
      ),
  });
  const mined = await included.transaction(cid);
  assert.equal(mined.blockHeight, 7n);
  assert.equal(mined.blockHash, "bafyblock");
});
