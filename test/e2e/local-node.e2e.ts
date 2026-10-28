// End-to-end against a local lattice-node: build 0xLattice/lattice-node main and
// run `LATTICE_NODE_BIN=<.build/debug> npm run test:e2e`. The node runs isolated
// (--no-default-peers, no --peer) on throwaway storage, forking the Nexus
// genesis privately; nothing is
// ever submitted to a live chain.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { LatticeClient, NodeClient } from "@adalin/lattice-client";
import {
  accountFromPrivateKey,
  buildTransfer,
  hexToBytes,
  nodeCookieAuthorization,
  signedTransactionCID,
  signTransactionBody,
  transactionPayload,
  type TransactionBody,
} from "@adalin/lattice-core";
import { HTTPTransactionSubmitter, SubmissionError } from "@adalin/lattice-relay";
import { HTTPVolumeTransport, VolumeClient } from "@adalin/lattice-volumes";

const bin = process.env.LATTICE_NODE_BIN;
if (bin === undefined)
  throw new Error("set LATTICE_NODE_BIN to lattice-node's .build/<config> directory");

const run = promisify(execFile);
const sender = accountFromPrivateKey(hexToBytes("11".repeat(32)));
const recipient = accountFromPrivateKey(hexToBytes("22".repeat(32)));
const MIN_RELAY_FEE = 1n;

let node: ChildProcess;
let directory: string;
let operator: string;
let publicListener: string;
/** The operator port's cookie header (the node writes it at start). */
let authorization: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function until<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Mines until the tip is `blocks` higher; one coordinator round may find nothing. */
async function mine(blocks: number): Promise<void> {
  const reads = new NodeClient(operator, ["Nexus"], { authorization });
  const target = ((await reads.chainInfo()).height ?? 0n) + BigInt(blocks);
  await until(async () => {
    await run(join(bin!, "lattice-mining-coordinator"), [
      ...["--node", operator, "--workers", "2"],
      ...["--rpc-cookie-file", join(directory, "data", ".cookie")],
      ...["--recipient", `Nexus=${sender.address}`, "--once", "--no-stale-probe"],
    ]);
    return ((await reads.chainInfo()).height ?? 0n) >= target || undefined;
  }, `height ${target}`);
}

function signed(body: TransactionBody) {
  const { publicKey, signature } = signTransactionBody(body, sender.privateKey);
  return transactionPayload({ [publicKey]: signature }, body);
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "lattice-sdk-e2e-"));
  const [rpc, read, overlay] = [await freePort(), await freePort(), await freePort()];
  operator = `http://127.0.0.1:${rpc}`;
  publicListener = `http://127.0.0.1:${read}`;
  const logFile = openSync(join(directory, "node.log"), "a");
  node = spawn(
    join(bin, "lattice-node"),
    [
      ...["--data-directory", join(directory, "data")],
      ...["--identity-key", join(directory, "identity.key")],
      "--no-default-peers",
      ...["--listen-port", String(overlay)],
      ...["--rpc-port", String(rpc)],
      ...["--public-read-port", String(read)],
      "--public-submit",
      ...["--public-read-rate", "0"],
      ...["--public-read-expensive-rate", "0"],
      ...["--public-read-max-rate", "0"],
      ...["--public-submit-rate", "0"],
      ...["--min-relay-fee", MIN_RELAY_FEE.toString()],
    ],
    { stdio: ["ignore", logFile, logFile] },
  );
  node.once("error", (error) => {
    throw error;
  });
  await until(async () => (await fetch(`${operator}/health`)).ok || undefined, "node health");
  await until(
    async () => (await fetch(`${publicListener}/health`)).ok || undefined,
    "public listener",
  );
  authorization = nodeCookieAuthorization(readFileSync(join(directory, "data", ".cookie"), "utf8"));
});

after(async () => {
  if (node !== undefined && node.exitCode === null) {
    const exited = new Promise((resolve) => node.once("exit", resolve));
    node.kill("SIGTERM");
    await exited;
  }
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
});

test("local node: fund, submit via the operator and public relays, observe inclusion", async () => {
  // The operator port refuses reads without the node's cookie.
  await assert.rejects(new NodeClient(operator, ["Nexus"]).chainInfo(), { status: 401 });
  const reads = new NodeClient(operator, ["Nexus"], { authorization });
  const publicReads = new NodeClient(publicListener, ["Nexus"]);

  const info = await reads.chainInfo();
  assert.equal(info.acceptsSubmit, true);
  assert.equal(info.minRelayFee, MIN_RELAY_FEE);
  assert.equal((await publicReads.chainInfo()).acceptsSubmit, true);

  await mine(3);
  const funded = await reads.account(sender.address);
  assert.ok(funded.balance > 0n, "mining funded the sender");
  const page = await reads.blocks({ limit: 25 });
  assert.equal(page.blocks[0]?.height, 3n);
  assert.equal(page.blocks[0]?.rewardRecipient, sender.address);
  assert.equal((await reads.block(3n)).rewardCredited, funded.balance / 3n);

  // The web content bridge serves Ivy's complete binary Volume. The SDK
  // verifies every member CID, decodes the canonical Block, and cross-checks
  // the node's JSON projection. Public reads need no content-specific format.
  const verified = new LatticeClient(
    publicReads,
    new VolumeClient(new HTTPVolumeTransport(`${publicListener}/volumes`)),
  );
  const latest = await verified.latestBlock();
  assert.equal(latest.canonical.height, 3n);
  assert.equal(latest.canonical.postStateCID, latest.view.postStateCID);
  const postState = await verified.postState(latest.view.hash);
  assert.ok(postState.canonical.accountStateCID.startsWith("bafy"));

  const operatorRelay = new HTTPTransactionSubmitter(`${operator}/transactions`, {
    authorization,
  });
  const publicRelay = new HTTPTransactionSubmitter(`${publicListener}/transactions`);
  const transfer = (amount: bigint, fee: bigint, nonce: bigint, chainPath = ["Nexus"]) =>
    buildTransfer({ from: sender.address, to: recipient.address, amount, fee, nonce, chainPath });

  // Named refusals surface as typed errors.
  const refusal = (submission: Promise<unknown>): Promise<SubmissionError> =>
    submission.then(
      () => assert.fail("expected a named refusal"),
      (error: unknown) => {
        assert.ok(error instanceof SubmissionError);
        return error;
      },
    );
  const below = await refusal(operatorRelay.submit(signed(transfer(10n, 0n, 0n))));
  assert.equal(below.reason, "belowMinRelayFee");
  assert.equal(below.status, 400);
  const unknown = await refusal(
    operatorRelay.submit(signed(transfer(10n, 2n, 0n, ["Nexus", "Nope"]))),
  );
  assert.equal(unknown.reason, "unknownChain");
  assert.equal(unknown.status, 404);

  // Operator (loopback) route. The CID the node reports is recomputable locally.
  const firstBody = transfer(1_000n, 5n, 0n);
  const firstPayload = signed(firstBody);
  const first = await operatorRelay.submit(firstPayload);
  assert.equal(
    signedTransactionCID(firstPayload.transaction.signatures, firstBody),
    first.transactionCID,
  );
  const cheaper = await refusal(operatorRelay.submit(signed(transfer(999n, 2n, 0n))));
  assert.equal(cheaper.reason, "feeTooLow");
  assert.equal((await reads.transaction(first.transactionCID)).blockHeight, undefined);
  const included = await until(async () => {
    await mine(1);
    const projection = await reads.transaction(first.transactionCID);
    return projection.blockHeight === undefined ? undefined : projection;
  }, "operator-route inclusion");
  const block = await reads.block(included.blockHeight!);
  assert.equal(block.hash, included.blockHash);
  assert.equal(block.transactionCount, 1);
  assert.equal(block.rewardCredited, (await reads.block(1n)).rewardCredited! + 5n);
  const verifiedTransaction = await verified.transaction(first.transactionCID);
  const expectedBodyCID = signTransactionBody(firstBody, sender.privateKey).bodyCID;
  assert.equal(verifiedTransaction.canonical.bodyCID, expectedBodyCID);
  assert.equal(verifiedTransaction.transaction.has(expectedBodyCID), true);

  // Public listener with --public-submit.
  const secondPayload = signed(transfer(2_000n, 3n, 1n));
  const second = await publicRelay.submit(secondPayload);
  assert.equal(
    signedTransactionCID(secondPayload.transaction.signatures, transfer(2_000n, 3n, 1n)),
    second.transactionCID,
  );
  const viaPublic = await until(async () => {
    await mine(1);
    const projection = await publicReads.transaction(second.transactionCID);
    return projection.blockHeight === undefined ? undefined : projection;
  }, "public-route inclusion");
  assert.ok(viaPublic.blockHeight! > included.blockHeight!);
  assert.equal((await reads.account(recipient.address)).balance, 3_000n);
  assert.equal((await reads.account(sender.address)).nonce, 2n);
});
