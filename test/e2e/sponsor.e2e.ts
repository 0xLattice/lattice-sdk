// A key with no coins stores a file and posts a record naming it, paying for
// both in work through lattice-sponsor, and a second node reads both back.
// Needs LATTICE_NODE_BIN (lattice-node's .build/<config>) and
// LATTICE_SPONSOR_BIN (the lattice-sponsor binary). Both nodes run isolated
// on throwaway storage, forking the Nexus genesis privately.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { NodeClient, NodeError } from "@adalin/lattice-client";
import {
  accountFromPrivateKey,
  bytesToHex,
  cidV1DagCbor,
  decodeCanonicalBlock,
  decodeCanonicalLatticeState,
  decodeDagCbor,
  encodeDagCbor,
  generatePrivateKey,
  nodeCookieAuthorization,
  publicKeyFromPrivate,
  signTransactionBody,
  transactionPayload,
  type DagCborValue,
  type TransactionBody,
} from "@adalin/lattice-core";
import {
  HTTPTransactionSubmitter,
  SponsorClient,
  grind,
  type SponsorWork,
} from "@adalin/lattice-relay";
import { HTTPVolumeTransport, VolumeClient } from "@adalin/lattice-volumes";

const bin = process.env.LATTICE_NODE_BIN;
const sponsorBin = process.env.LATTICE_SPONSOR_BIN;
if (bin === undefined || sponsorBin === undefined) {
  throw new Error("set LATTICE_NODE_BIN and LATTICE_SPONSOR_BIN");
}

const run = promisify(execFile);
const sponsorKey = accountFromPrivateKey(generatePrivateKey());
const user = accountFromPrivateKey(generatePrivateKey());
const processes: ChildProcess[] = [];
let directory: string;

interface Node {
  readonly operator: string;
  readonly publicReads: string;
  readonly overlay: number;
  /** The overlay key: the identity's Ed25519 public key. */
  readonly key: string;
  readonly cookie: string;
  readonly authorization: string;
  readonly reads: NodeClient;
}
let writer: Node;
let reader: Node;
let sponsor: SponsorClient;

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
  const deadline = Date.now() + 300_000;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      failure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}; last error: ${failure}`);
}

function start(name: string, executable: string, args: string[]): void {
  const log = openSync(join(directory, `${name}.log`), "a");
  const child = spawn(executable, args, { stdio: ["ignore", log, log] });
  child.once("error", (error) => {
    throw error;
  });
  processes.push(child);
}

async function startNode(name: string, peers: string[]): Promise<Node> {
  const [rpc, read, overlay] = [await freePort(), await freePort(), await freePort()];
  const identity = generatePrivateKey();
  const identityFile = join(directory, `${name}.identity`);
  writeFileSync(identityFile, bytesToHex(identity) + "\n", { mode: 0o600 });
  const data = join(directory, name);
  start(name, join(bin!, "lattice-node"), [
    ...["--data-directory", data],
    ...["--identity-key", identityFile],
    ...(peers.length === 0 ? ["--no-default-peers"] : peers.flatMap((peer) => ["--peer", peer])),
    ...["--listen-port", String(overlay)],
    ...["--rpc-port", String(rpc)],
    ...["--websocket-port", "0"],
    ...["--public-read-port", String(read)],
    ...["--public-read-rate", "0"],
    ...["--public-read-expensive-rate", "0"],
    ...["--public-read-max-rate", "0"],
  ]);
  const operator = `http://127.0.0.1:${rpc}`;
  await until(async () => (await fetch(`${operator}/health`)).ok || undefined, `${name} health`);
  const cookie = join(data, ".cookie");
  const authorization = nodeCookieAuthorization(readFileSync(cookie, "utf8"));
  return {
    operator,
    publicReads: `http://127.0.0.1:${read}`,
    overlay,
    cookie,
    authorization,
    key: bytesToHex(publicKeyFromPrivate(identity)),
    reads: new NodeClient(operator, ["Nexus"], { authorization }),
  };
}

/** One coordinator round, paying the sponsor: it funds the fee float and moves the chain on. */
async function mineOnce(): Promise<void> {
  await run(join(bin!, "lattice-mining-coordinator"), [
    ...["--node", writer.operator, "--workers", "2"],
    ...["--rpc-cookie-file", writer.cookie],
    ...["--recipient", `Nexus=${sponsorKey.address}`, "--once", "--no-stale-probe"],
  ]);
}

async function balance(node: Node, owner: string): Promise<bigint> {
  try {
    return (await node.reads.account(owner)).balance;
  } catch (error) {
    if (error instanceof NodeError && error.status === 404) return 0n;
    throw error;
  }
}

/**
 * Grinds the sponsor's work and posts every share until `paid` says the work
 * has bought what it is for. A share the sponsor no longer credits (its
 * template expired, or its block height sold out) is answered with new work
 * after the chain moves on.
 */
async function payInWork(
  request: { readonly chain: string; readonly store?: string },
  paid: (credit: bigint, work: SponsorWork) => Promise<boolean>,
): Promise<string> {
  let client: string | undefined;
  return until(
    async () => {
      let work: SponsorWork;
      try {
        work = await sponsor.requestWork({
          ...request,
          ...(client === undefined ? {} : { client }),
        });
      } catch (error) {
        await mineOnce();
        throw error;
      }
      client = work.client;
      for await (const nonce of grind(work)) {
        let credit: bigint;
        try {
          ({ credit } = await sponsor.submitShare(work.assignment, nonce));
        } catch (error) {
          await mineOnce();
          throw error;
        }
        if (await paid(credit, work)) return client;
      }
      return undefined;
    },
    `work paying for ${request.store ?? "a fee"}`,
  );
}

/** The file's Volumes in lattice-storage's layout (client/file.mjs), root first. */
const CHUNK_BYTES = 1 << 20;
function fileVolumes(type: string, bytes: Uint8Array) {
  const volume = (value: DagCborValue) => {
    const block = encodeDagCbor(value);
    const cid = cidV1DagCbor(block);
    return { cid, entries: { [cid]: Buffer.from(block).toString("base64") } };
  };
  const chunks = [];
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
    chunks.push(volume({ bytes: bytes.subarray(at, at + CHUNK_BYTES) }));
  }
  const root = volume({
    chunks: chunks.map((chunk) => chunk.cid),
    size: BigInt(bytes.length),
    type,
  });
  return [root, ...chunks];
}

/** The value under `key` in a general-state trie (cashew's Merkle dictionary). */
async function stateGet(volumes: VolumeClient, rootCID: string, key: string) {
  const load = async (cid: string) =>
    decodeDagCbor((await volumes.get(cid)).rootBytes()) as Record<string, any>;
  let node = await load(rootCID);
  let rest = key;
  while (rest.length > 0) {
    const child = node.children.find((entry: { key: string }) => entry.key === rest[0]);
    if (child === undefined) return undefined;
    node = await load(child.value.rawCID);
    if (!rest.startsWith(node.prefix)) return undefined;
    rest = rest.slice(node.prefix.length);
  }
  return node.value;
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "lattice-sdk-e2e-"));
  writer = await startNode("writer", []);
  // Fund the sponsor's fee float.
  await until(async () => {
    await mineOnce();
    return (await balance(writer, sponsorKey.address)) > 0n || undefined;
  }, "a funded sponsor");
  const keyFile = join(directory, "sponsor.key");
  writeFileSync(
    keyFile,
    JSON.stringify({
      privateKey: bytesToHex(sponsorKey.privateKey),
      publicKey: sponsorKey.publicKey,
    }),
    { mode: 0o600 },
  );
  const port = await freePort();
  start("sponsor", sponsorBin, [
    ...["--node", writer.operator, "--cookie-file", writer.cookie, "--key", keyFile],
    ...["--share-work", "2^8", "--port", String(port)],
    ...["--sell-storage", "--storage-rate", "Nexus=1000000"],
    ...["--storage-file", join(directory, "sponsor-storage.json")],
  ]);
  sponsor = new SponsorClient(`http://127.0.0.1:${port}`);
  reader = await startNode("reader", [`${writer.key}@127.0.0.1:${writer.overlay}`]);
});

after(async () => {
  for (const child of processes.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
});

test("a coinless key stores a file and posts it, paying in work; another node reads both", async () => {
  // An image of more than one chunk.
  const image = new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...randomBytes(CHUNK_BYTES + 4096),
  ]);
  const volumes = fileVolumes("image/png", image);
  const root = volumes[0]!.cid;

  // Storage, bought with work: the sponsor pins every Volume once paid.
  const held = await until(() => sponsor.store(root, volumes), "the upload held");
  await payInWork({ chain: "Nexus", store: root }, async () => {
    return (await sponsor.storeStatus(root)).credit >= held.bytes;
  });
  await until(async () => (await sponsor.storeStatus(root)).stored || undefined, "the file pinned");

  // The record, its fee bought with work.
  const draft: TransactionBody = {
    accountActions: [],
    actions: [{ key: `photo/${user.address}`, newValue: root }],
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [user.address],
    nonce: 0n,
    chainPath: ["Nexus"],
  };
  const client = await payInWork({ chain: "Nexus" }, async (credit, work) => credit >= work.fee);
  const sponsored = await sponsor.sponsorTransaction(client, draft);
  const { publicKey, signature } = signTransactionBody(sponsored.body, user.privateKey);
  const submitted = await new HTTPTransactionSubmitter(`${writer.operator}/transactions`, {
    authorization: writer.authorization,
  }).submit(
    transactionPayload({ ...sponsored.signatures, [publicKey]: signature }, sponsored.body),
  );

  // The reader follows the writer; once it has the record's block, it reads
  // the record from its own state, and the file from the network.
  await until(async () => {
    if ((await reader.reads.transaction(submitted.transactionCID)).blockHeight !== undefined) {
      return true;
    }
    await mineOnce();
    return undefined;
  }, "the record mined and on the reader");
  const volumesOnReader = new VolumeClient(
    new HTTPVolumeTransport(`${reader.publicReads}/volumes`),
  );
  const record = await until(async () => {
    const tip = decodeCanonicalBlock(
      (await volumesOnReader.get((await reader.reads.latestBlock()).hash)).rootBytes(),
    );
    const state = decodeCanonicalLatticeState(
      (await volumesOnReader.get(tip.postStateCID)).rootBytes(),
    );
    return stateGet(volumesOnReader, state.generalStateCID, `photo/${user.address}`);
  }, "the record in the reader's state");
  assert.equal(record, root);

  const file = await until(async () => {
    const top = (await volumesOnReader.get(record)).decodeRoot() as {
      chunks: string[];
      size: bigint;
      type: string;
    };
    assert.equal(top.type, "image/png");
    const parts = [];
    for (const chunk of top.chunks) {
      parts.push(((await volumesOnReader.get(chunk)).decodeRoot() as { bytes: Uint8Array }).bytes);
    }
    const bytes = new Uint8Array(Buffer.concat(parts));
    assert.equal(BigInt(bytes.length), top.size);
    return bytes;
  }, "the file from the reader");
  assert.equal(bytesToHex(file), bytesToHex(image));

  // Neither the record nor the file cost the user a coin.
  assert.equal(await balance(writer, user.address), 0n);
  assert.equal(await balance(reader, user.address), 0n);
});
