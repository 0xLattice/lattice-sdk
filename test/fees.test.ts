import assert from "node:assert/strict";
import { test } from "node:test";

import { NodeClient, feeToOutbid } from "@adalin/lattice-client";
import {
  accountFromPrivateKey,
  buildTransfer,
  encodeSignedTransaction,
  encodeTransactionBody,
  signTransactionBody,
  signedTransactionSize,
} from "@adalin/lattice-core";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("fees and chain spec read the node's routes with exact integers", async () => {
  const requested: string[] = [];
  const fetch = async (input: string | URL): Promise<Response> => {
    const url = new URL(input);
    requested.push(`${url.pathname}?${url.searchParams.toString()}`);
    return url.pathname === "/api/fees"
      ? response({
          minRelayFee: "1",
          blocks: [
            {
              transactionCount: 5000,
              bytes: 900000,
              lowestFee: "18446744073709551615",
              lowestFeeBytes: 300,
              full: true,
            },
          ],
        })
      : response({
          targetBlockTime: "3600000",
          initialReward: "1048576",
          halvingInterval: "876600",
          maxBlockSize: 1000000,
          maxNumberOfTransactionsPerBlock: "5000",
          premine: "175320",
          halfLife: "120",
        });
  };
  const client = new NodeClient("https://reads.example.org", ["Nexus", "Alpha"], { fetch });
  const fees = await client.fees();
  assert.equal(fees.minRelayFee, 1n);
  assert.deepEqual(fees.blocks, [
    {
      transactionCount: 5000,
      bytes: 900000,
      lowestFee: 18_446_744_073_709_551_615n,
      lowestFeeBytes: 300,
      lowestFeeWeight: 300,
      full: true,
    },
  ]);
  const spec = await client.chainSpec();
  assert.equal(spec.targetBlockTime, 3_600_000n);
  assert.equal(spec.maxBlockSize, 1_000_000);
  assert.deepEqual(requested, [
    "/api/fees?chainPath=Nexus%2FAlpha",
    "/api/chain/spec?chainPath=Nexus%2FAlpha",
  ]);
});

test("a fee projection without a positive rate size or a full flag is refused", async () => {
  const block = { transactionCount: 1, bytes: 300, lowestFee: "1", lowestFeeBytes: 0, full: false };
  const client = (body: unknown) =>
    new NodeClient("https://reads.example.org", ["Nexus"], { fetch: async () => response(body) });
  await assert.rejects(
    client({ minRelayFee: "0", blocks: [block] }).fees(),
    /lowestFeeBytes must be positive/,
  );
  await assert.rejects(
    client({
      minRelayFee: "0",
      blocks: [{ ...block, lowestFeeBytes: 300, full: undefined }],
    }).fees(),
    /full must be a boolean/,
  );
  await assert.rejects(
    client({ minRelayFee: 0, blocks: [] }).fees(),
    /minRelayFee must be a canonical decimal string/,
  );
});

test("feeToOutbid pays strictly more than the block's lowest rate", () => {
  const block = {
    transactionCount: 2,
    bytes: 600,
    lowestFee: 10n,
    lowestFeeBytes: 300,
    lowestFeeWeight: 300,
    full: true,
  };
  assert.equal(feeToOutbid(block, 300), 11n, "same size: one more");
  assert.equal(feeToOutbid(block, 450), 16n, "15 is the same rate; 16 is above it");
  assert.equal(feeToOutbid({ ...block, lowestFee: 0n }, 300), 1n, "above a zero-fee block");
  assert.throws(() => feeToOutbid(block, 0), /weight must be a positive integer/);
});

test("signedTransactionSize is the size of the signed transaction, before signing", () => {
  const sender = accountFromPrivateKey(new Uint8Array(32).fill(7));
  const recipient = accountFromPrivateKey(new Uint8Array(32).fill(9));
  for (const [amount, fee, chainPath] of [
    [1n, 0n, ["Nexus"]],
    [123_456_789n, 4_294_967_296n, ["Nexus", "Alpha"]],
  ] as const) {
    const body = buildTransfer({
      from: sender.address,
      to: recipient.address,
      amount,
      fee,
      nonce: 3n,
      chainPath,
    });
    const signed = signTransactionBody(body, sender.privateKey);
    const actual =
      encodeTransactionBody(body).bytes.length +
      encodeSignedTransaction({ [signed.publicKey]: signed.signature }, signed.bodyCID).bytes
        .length;
    assert.equal(signedTransactionSize(body), actual);
  }
});

test("fees: weight is the most of a block a transaction takes of any limit", async () => {
  const { transactionWeight, parseFeeEstimates } = await import("@adalin/lattice-client");
  const { stateGrowthCeiling } = await import("@adalin/lattice-core");
  const body = (accountActions: { owner: string; delta: bigint }[], actions: { key: string; oldValue?: string; newValue?: string }[] = [], signer = "ab") => ({
    accountActions, actions, depositActions: [], receiptActions: [], withdrawalActions: [], signers: [signer], nonce: 0n, chainPath: ["Nexus"],
  });
  // As Lattice counts it: a write (+2), "ab" credited (2 + 8), "_nonce_ab" (9 + 8).
  assert.equal(stateGrowthCeiling(body([{ owner: "ab", delta: 5n }], [{ key: "k", newValue: "v" }])), 2 + 10 + 17);
  // "ab" pays new "cdef": the payee (4 + 8) and the nonce, never a removal.
  assert.equal(stateGrowthCeiling(body([{ owner: "ab", delta: -1n }, { owner: "cdef", delta: 1n }])), 12 + 17);
  assert.equal(stateGrowthCeiling(body([], [{ key: "k", oldValue: "v" }])), -2 + 17);
  // As the node weighs it.
  const room = 998_208;
  assert.equal(transactionWeight(300, 300), 300, "an older node: size");
  assert.equal(transactionWeight(300, 300, { blockRoom: room, growthRoom: room, maxTransactions: room }), 300);
  assert.equal(transactionWeight(300, 100, { blockRoom: room, growthRoom: room / 8, maxTransactions: room }), 800);
  assert.equal(transactionWeight(300, 0, { blockRoom: room, growthRoom: room, maxTransactions: 10 }), Math.floor(room / 10));
  const fees = parseFeeEstimates({
    minRelayFee: "1",
    blocks: [{ transactionCount: 1, bytes: 300, lowestFee: "50", lowestFeeBytes: 300, lowestFeeWeight: 600, full: true }],
    weight: { blockRoom: room, growthRoom: room, maxTransactions: 5000 },
  });
  assert.equal(fees.blocks[0]?.lowestFeeWeight, 600);
  assert.equal(feeToOutbid(fees.blocks[0]!, 600), 51n, "a rate over weight");
  assert.equal(parseFeeEstimates({ minRelayFee: "1", blocks: [{ transactionCount: 1, bytes: 300, lowestFee: "50", lowestFeeBytes: 300, full: true }] }).blocks[0]?.lowestFeeWeight, 300);
});
