import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  accountFromPrivateKey,
  bytesToHex,
  canonicalBlockProofOfWorkPreimage,
  decodeCanonicalBlock,
  hexToBytes,
  toWireTransactionBody,
  type TransactionBody,
} from "@adalin/lattice-core";
import { SponsorClient, SponsorError, grind, shareHash } from "@adalin/lattice-relay";

const encoding = JSON.parse(
  readFileSync(new URL("../.cache/lattice-vectors/encoding.json", import.meta.url), "utf8"),
);

test("a share hash is the consensus PoW hash of the template prefix and nonce", () => {
  // Lattice's genesis vector: the sponsor's prefix is the block's PoW
  // preimage without its nonce (`Block.makeProofOfWorkPreimagePrefix`).
  const vector = encoding.vectors.find((entry: { name: string }) => entry.name === "block/genesis");
  const block = decodeCanonicalBlock(hexToBytes(vector.dagCborHex));
  const prefix = bytesToHex(canonicalBlockProofOfWorkPreimage(block).slice(0, -8));
  assert.equal(
    bytesToHex(shareHash(prefix, block.nonce)),
    "ae6610161723772d77741acd0c8bfcc495c1980856ec234dc1a9bf972c10f69b",
  );
});

const big = (bytes: Uint8Array) => BigInt("0x" + bytesToHex(bytes));

test("grind yields exactly the nonces at or under the target, in order", async () => {
  const prefixHex = "00".repeat(40) + "ab";
  const hashes = Array.from({ length: 4096 }, (_, index) =>
    big(shareHash(prefixHex, 100n + BigInt(index))),
  );
  // About one nonce in sixteen.
  const shareTarget = (1n << 252n) - 1n;
  const expected = hashes.flatMap((hash, index) =>
    hash <= shareTarget ? [100n + BigInt(index)] : [],
  );
  assert.ok(expected.length > 0);
  const found: bigint[] = [];
  const work = {
    prefixHex,
    shareTarget,
    startNonce: 100n,
    count: 4096n,
    expiresAt: Date.now() + 60_000,
  };
  for await (const nonce of grind(work)) found.push(nonce);
  assert.deepEqual(found, expected);
  // A target equal to one hash takes it.
  const exact = { ...work, shareTarget: hashes[7]! };
  const atExact: bigint[] = [];
  for await (const nonce of grind(exact)) atExact.push(nonce);
  assert.ok(atExact.includes(107n));
});

test("grind stops when aborted or expired", async () => {
  const work = {
    prefixHex: "01",
    shareTarget: 0n,
    startNonce: 0n,
    count: 1n << 40n,
    expiresAt: Date.now() + 60_000,
  };
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("stop")), 20);
  await assert.rejects(async () => {
    for await (const _ of grind(work, controller.signal)) assert.fail("no hash is zero");
  }, /stop/);
  // An unaligned range is checked from its first nonce.
  const expired: bigint[] = [];
  for await (const nonce of grind({ ...work, startNonce: 3n, expiresAt: Date.now() - 1 }))
    expired.push(nonce);
  assert.deepEqual(expired, []);
});

function fakeSponsor(answer: (path: string, body: any) => unknown, status = 200) {
  const requests: { url: string; method: string; body: any }[] = [];
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ url: String(input), method: init?.method ?? "GET", body });
    const path = new URL(String(input)).pathname.slice(1);
    return new Response(JSON.stringify(answer(path, body)), { status });
  };
  return { client: new SponsorClient("https://sponsor.example.org/", { fetch }), requests };
}

test("work, shares and storage requests and answers are the sponsor's shapes", async () => {
  const { client, requests } = fakeSponsor((path) => {
    switch (path) {
      case "work":
        return {
          client: "c".repeat(64),
          assignment: "w1.1",
          prefixHex: "00ff",
          shareTarget: "ffffff",
          startNonce: "4294967296",
          count: "4294967296",
          fee: "5",
          pay: "0",
          sharesForFee: "12",
          expiresInMilliseconds: "30000",
        };
      case "shares":
        return { credit: "3" };
      default:
        return {
          root: "bafyroot",
          bytes: "1000",
          needed: { Nexus: "9" },
          credit: "0",
          stored: false,
        };
    }
  });
  const work = await client.requestWork({ chain: "Nexus", store: "bafyroot" });
  assert.deepEqual(requests[0], {
    url: "https://sponsor.example.org/work",
    method: "POST",
    body: { chain: "Nexus", store: "bafyroot" },
  });
  assert.equal(work.shareTarget, 0xffffffn);
  assert.equal(work.startNonce, 1n << 32n);
  assert.equal(work.sharesForFee, 12n);
  assert.ok(work.expiresAt > Date.now() && work.expiresAt <= Date.now() + 30_000);
  assert.deepEqual(await client.submitShare("w1.1", 9_007_199_254_740_993n), { credit: 3n });
  assert.deepEqual(requests[1]?.body, { assignment: "w1.1", nonce: "9007199254740993" });
  const volumes = [{ cid: "bafyroot", entries: { bafyroot: "AAE=" } }];
  const held = await client.store("bafyroot", volumes);
  assert.deepEqual(requests[2]?.body, { root: "bafyroot", volumes });
  assert.deepEqual(held, {
    root: "bafyroot",
    bytes: 1000n,
    needed: { Nexus: 9n },
    credit: 0n,
    stored: false,
  });
  await client.storeStatus("bafyroot");
  assert.deepEqual(requests[3], {
    url: "https://sponsor.example.org/store/bafyroot",
    method: "GET",
    body: undefined,
  });
});

const user = accountFromPrivateKey(hexToBytes("33".repeat(32)));
const sponsorKey = accountFromPrivateKey(hexToBytes("44".repeat(32)));
const draft: TransactionBody = {
  accountActions: [],
  actions: [{ key: "post", newValue: "bafyroot" }],
  depositActions: [],
  receiptActions: [],
  withdrawalActions: [],
  signers: [user.address],
  nonce: 0n,
  chainPath: ["Nexus"],
};

test("a sponsored body is checked to be the draft plus the sponsor's fee", async () => {
  const sponsored = (debit: string) => ({
    transaction: {
      signatures: { [sponsorKey.publicKey]: "ab".repeat(64) },
      body: {
        ...toWireTransactionBody(draft),
        accountActions: [
          { owner: user.address, delta: "2" },
          { owner: sponsorKey.address, delta: debit },
        ],
        signers: [user.address, sponsorKey.address],
      },
    },
    fee: "5",
    pay: "2",
  });
  const honest = fakeSponsor(() => sponsored("-7"));
  const result = await honest.client.sponsorTransaction("token", draft, 2n);
  assert.equal(honest.requests[0]?.body.client, "token");
  assert.equal(honest.requests[0]?.body.pay, "2");
  assert.deepEqual(honest.requests[0]?.body.transaction, {
    signatures: {},
    body: toWireTransactionBody(draft),
  });
  assert.equal(result.fee, 5n);
  assert.deepEqual(result.body.signers, [user.address, sponsorKey.address]);
  assert.deepEqual(result.body.accountActions, [
    { owner: user.address, delta: 2n },
    { owner: sponsorKey.address, delta: -7n },
  ]);
  assert.deepEqual(result.signatures, { [sponsorKey.publicKey]: "ab".repeat(64) });
  // A body debiting the sponsor anything but fee and pay is never returned to sign.
  const greedy = fakeSponsor(() => sponsored("-8"));
  await assert.rejects(greedy.client.sponsorTransaction("token", draft, 2n), SponsorError);
  // The client as its own "sponsor", paying a fee it never chose, is refused.
  const self = sponsored("-7");
  self.transaction.body.signers = [user.address, user.address];
  self.transaction.body.accountActions[1]!.owner = user.address;
  self.transaction.signatures = {};
  await assert.rejects(
    fakeSponsor(() => self).client.sponsorTransaction("token", draft, 2n),
    SponsorError,
  );
  // So is an answer without the sponsor's signature.
  const unsigned = sponsored("-7");
  unsigned.transaction.signatures = {};
  await assert.rejects(
    fakeSponsor(() => unsigned).client.sponsorTransaction("token", draft, 2n),
    SponsorError,
  );
});

test("a refusal carries the sponsor's status and reason", async () => {
  const { client } = fakeSponsor(() => ({ error: { message: "insufficientCredit" } }), 402);
  await assert.rejects(client.sponsorTransaction("token", draft), {
    name: "SponsorError",
    status: 402,
    refusal: "insufficientCredit",
  });
  assert.throws(() => new SponsorClient("http://sponsor.example.org"), /must use HTTPS/);
});
