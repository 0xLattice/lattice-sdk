import assert from "node:assert/strict";
import { test } from "node:test";

import { LatticeClient, NodeClient } from "@adalin/lattice-client";
import {
  cidV1DagCbor,
  encodeDagCbor,
  encodeSignedTransaction,
  encodeTransactionBody,
} from "@adalin/lattice-core";
import { MemoryVolumeTransport, VolumeClient } from "@adalin/lattice-volumes";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

function volume(rootCID: string, bytes: Uint8Array) {
  return { rootCID, entries: [{ cid: rootCID, bytes }] };
}

test("state and transaction-list traversal refuses redirected node projections", async () => {
  const stateBytes = encodeDagCbor({
    accountState: { rawCID: "accounts" },
    generalState: { rawCID: "general" },
    depositState: { rawCID: "deposits" },
    receiptState: { rawCID: "receipts" },
  });
  const stateCID = cidV1DagCbor(stateBytes);
  const redirectedStateBytes = encodeDagCbor({
    accountState: { rawCID: "attacker-accounts" },
    generalState: { rawCID: "attacker-general" },
    depositState: { rawCID: "attacker-deposits" },
    receiptState: { rawCID: "attacker-receipts" },
  });
  const redirectedStateCID = cidV1DagCbor(redirectedStateBytes);
  const transactionsBytes = encodeDagCbor([]);
  const transactionsCID = cidV1DagCbor(transactionsBytes);
  const redirectedTransactionsBytes = encodeDagCbor(["attacker-transaction"]);
  const redirectedTransactionsCID = cidV1DagCbor(redirectedTransactionsBytes);
  const blockBytes = encodeDagCbor({
    version: 1n,
    transactions: { rawCID: transactionsCID },
    target: "0xff",
    nextTarget: "0xff",
    spec: { rawCID: "spec" },
    parentState: { rawCID: "parent-state" },
    prevState: { rawCID: "previous-state" },
    postState: { rawCID: stateCID },
    children: { rawCID: "children" },
    height: 0n,
    timestamp: 1n,
    nonce: 0n,
  });
  const blockCID = cidV1DagCbor(blockBytes);
  const volumes = new VolumeClient(
    new MemoryVolumeTransport([
      volume(blockCID, blockBytes),
      volume(stateCID, stateBytes),
      volume(redirectedStateCID, redirectedStateBytes),
      volume(transactionsCID, transactionsBytes),
      volume(redirectedTransactionsCID, redirectedTransactionsBytes),
    ]),
  );
  const blockView = (postStateCID: string, transactionRoot: string) => ({
    height: "0",
    hash: blockCID,
    timestamp: "1",
    transactionCount: 0,
    childBlockCount: 0,
    nonce: "0",
    version: 1,
    target: "0xff",
    nextTarget: "0xff",
    transactionsCID: transactionRoot,
    postStateCID,
    chain: ["Nexus"],
  });
  const client = (view: unknown) =>
    new LatticeClient(
      new NodeClient("https://reads.example.org", ["Nexus"], {
        fetch: async () => json(view),
      }),
      volumes,
    );

  await assert.rejects(
    client(blockView(redirectedStateCID, transactionsCID)).postState(0n),
    /post-state does not match canonical Block content/,
  );
  await assert.rejects(
    client(blockView(stateCID, redirectedTransactionsCID)).transactions(0n),
    /transactions does not match canonical Block content/,
  );
});

test("transaction bodies follow the CID-verified envelope, not a node-supplied body link", async () => {
  const body = {
    accountActions: [],
    actions: [],
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [],
    nonce: 0n,
    chainPath: ["Nexus"],
  };
  const encodedBody = encodeTransactionBody(body);
  const decoyBytes = encodeDagCbor({ decoy: true });
  const decoyCID = cidV1DagCbor(decoyBytes);
  const key = `ed01${"00".repeat(32)}`;
  const encodedTransaction = encodeSignedTransaction({ [key]: "00".repeat(64) }, encodedBody.cid);
  const volumes = new VolumeClient(
    new MemoryVolumeTransport([
      {
        rootCID: encodedTransaction.cid,
        entries: [
          { cid: encodedTransaction.cid, bytes: encodedTransaction.bytes },
          { cid: encodedBody.cid, bytes: encodedBody.bytes },
        ],
      },
      volume(decoyCID, decoyBytes),
    ]),
  );
  let nodeContentRouteCalled = false;
  const node = new NodeClient("https://reads.example.org", ["Nexus"], {
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith("/transactions/")) {
        nodeContentRouteCalled = true;
        return json({
          cid: encodedTransaction.cid,
          transaction: { body: { rawCID: decoyCID } },
        });
      }
      return json({
        txCID: encodedTransaction.cid,
        nonce: "0",
        signers: [],
        chainPath: ["Nexus"],
        accountActions: [],
        depositActions: [],
        receiptActions: [],
        withdrawalActions: [],
      });
    },
  });

  const result = await new LatticeClient(node, volumes).transaction(encodedTransaction.cid);
  assert.equal(result.canonical.bodyCID, encodedBody.cid);
  assert.deepEqual(result.body, encodedBody.bytes);
  assert.equal(nodeContentRouteCalled, false);
});
