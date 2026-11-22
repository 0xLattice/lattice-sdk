import { LatticeClient, NodeClient, NodeError } from "@adalin/lattice-client";
import {
  accountFromPrivateKey,
  bytesToHex,
  cidV1DagCbor,
  decodeCanonicalLatticeState,
  decodeDagCbor,
  encodeDagCbor,
  generatePrivateKey,
  hexToBytes,
  signTransactionBody,
  transactionPayload,
  type Action,
  type DagCborValue,
  type TransactionBody,
} from "@adalin/lattice-core";
import {
  HTTPTransactionSubmitter,
  SponsorClient,
  SponsorError,
  SubmissionError,
  type StoreVolume,
  type SponsorWork,
} from "@adalin/lattice-relay";
import { HTTPVolumeTransport, VolumeClient, type VerifiedVolume } from "@adalin/lattice-volumes";
import { findShares } from "./share-search.js";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** What a write or upload is doing, for `onProgress`. */
export type Progress =
  | {
      /** Grinding a sponsor's work: `shares` found of the `sharesNeeded` it asks. */
      readonly stage: "work";
      readonly sponsor: string;
      readonly hashes: number;
      readonly shares: number;
      readonly sharesNeeded: number;
    }
  | { readonly stage: "submit"; readonly transactionCID?: string }
  | { readonly stage: "confirm"; readonly transactionCID: string }
  | { readonly stage: "store"; readonly sponsor: string; readonly root: string };

export interface ConnectOptions {
  /** The chain's path, as `Nexus/testnet/rsvp`. */
  readonly chain: string;
  /** A node's public read URL; it must host the chain, and take writes (public submit). */
  readonly node: string;
  /** lattice-sponsor URLs, tried in order, that pay fees for proof of work. */
  readonly sponsors?: readonly string[];
  /** The writer's Ed25519 private key (32 bytes or 64 hex digits). Default: one kept in `localStorage`. */
  readonly key?: Uint8Array | string;
  readonly onProgress?: (progress: Progress) => void;
  /** Web Workers to grind in; 0 grinds on this thread. Default: all cores but one. */
  readonly workers?: number;
  readonly fetch?: Fetch;
}

export interface Entry {
  readonly key: string;
  readonly value: string;
}

export interface Chain {
  readonly chain: string;
  /** The writer's address. */
  readonly address: string;
  /** The value under `key` at the node's tip, read by CID from the block down. */
  get(key: string): Promise<string | undefined>;
  /** The records whose keys start with `prefix`, in key order: at most `limit` (default 100). */
  list(prefix?: string, options?: { readonly limit?: number }): Promise<Entry[]>;
  /** Writes `value` under `key`; resolves once the write is in a block. */
  set(key: string, value: string): Promise<{ readonly transactionCID: string }>;
  /** Pins `data` for good through a sponsor's storage; resolves to its root CID. */
  put(data: Uint8Array | Blob, options?: { readonly type?: string }): Promise<string>;
}

export type WriteFailure =
  /** No sponsor paid, and the key cannot pay the fee itself. */
  | "insufficientBalance"
  /** The chain refused the write: its policy, or the key's value changed under it. */
  | "rejected"
  /** No sponsor could take the work or sign. */
  | "sponsorUnavailable"
  /** The node would not take the transaction (its own reasons, such as its fee floor). */
  | "refused";

export class WriteError extends Error {
  readonly code: WriteFailure;

  constructor(code: WriteFailure, detail?: string, cause?: unknown) {
    const plain = {
      insufficientBalance: "insufficient balance",
      rejected: "rejected by the chain's rules",
      sponsorUnavailable: "sponsor unavailable",
      refused: "refused by the node",
    }[code];
    super(detail === undefined ? plain : `${plain}: ${detail}`, { cause });
    this.name = "WriteError";
    this.code = code;
  }
}

const KEY_STORAGE = "lattice-sdk/key";
/** Attempts of one request that the sponsor or node asks to retry. */
const ATTEMPTS = 5;
const POLL_MILLISECONDS = 2_000;

function storedKey(): Uint8Array {
  try {
    const kept = globalThis.localStorage?.getItem(KEY_STORAGE);
    if (kept && /^[0-9a-f]{64}$/.test(kept)) return hexToBytes(kept);
  } catch {
    // No storage here (a private window, or not a browser): the key lives in memory.
  }
  const key = generatePrivateKey();
  try {
    globalThis.localStorage?.setItem(KEY_STORAGE, bytesToHex(key));
  } catch {
    // As above.
  }
  return key;
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * How long to wait before trying `error`'s request again, or undefined when
 * it is not worth retrying: the sponsor or node is busy (429, 503) or out of
 * reach. A `Retry-After` is honoured; otherwise 1 s, doubling, up to 30 s.
 */
export function retryDelay(error: unknown, attempt: number): number | undefined {
  const status =
    error instanceof SponsorError || error instanceof SubmissionError ? error.status : undefined;
  const unreachable = error instanceof TypeError || (error as Error)?.name === "TimeoutError";
  if (!unreachable && status !== 429 && status !== 503) return undefined;
  if (error instanceof SponsorError && error.refusal === "insufficientFloat") return undefined;
  if (error instanceof SponsorError && error.retryAfterMilliseconds !== undefined) {
    return error.retryAfterMilliseconds;
  }
  return Math.min(30_000, 1000 * 2 ** attempt);
}

async function patiently<T>(request: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      const wait = retryDelay(error, attempt);
      if (wait === undefined || attempt + 1 >= ATTEMPTS) throw error;
      await sleep(wait);
    }
  }
}

const refusal = (error: unknown) => (error instanceof SponsorError ? error.refusal : undefined);

/** A file as lattice-storage lays it out: a root naming 1 MiB chunks. Root first. */
function fileVolumes(type: string, bytes: Uint8Array): StoreVolume[] {
  const volume = (value: DagCborValue): StoreVolume => {
    const block = encodeDagCbor(value);
    const cid = cidV1DagCbor(block);
    return { cid, entries: { [cid]: base64(block) } };
  };
  const chunks: StoreVolume[] = [];
  for (let at = 0; at < bytes.length; at += 1 << 20) {
    chunks.push(volume({ bytes: bytes.subarray(at, at + (1 << 20)) }));
  }
  const root = volume({
    chunks: chunks.map((chunk) => chunk.cid),
    size: BigInt(bytes.length),
    type,
  });
  return [root, ...chunks];
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(text);
}

interface TrieNode {
  readonly prefix?: string;
  readonly value?: string;
  readonly children: readonly {
    readonly key: string;
    readonly value: { readonly rawCID: string };
  }[];
}

/**
 * Reads of one general-state root (cashew's Merkle dictionary), each node
 * checked against its CID. A node inside a Volume already fetched is read
 * from it.
 */
function trie(volumes: VolumeClient, rootCID: string) {
  const load = async (cid: string, within?: VerifiedVolume) => {
    const volume = within?.has(cid) ? within : await volumes.get(cid);
    return { node: decodeDagCbor(volume.bytes(cid)!) as unknown as TrieNode, volume };
  };
  const child = (node: TrieNode, rest: string) =>
    node.children.find((entry) => entry.key === String.fromCodePoint(rest.codePointAt(0)!))?.value
      .rawCID;

  async function get(key: string): Promise<string | undefined> {
    let { node, volume } = await load(rootCID);
    let rest = key;
    while (rest.length > 0) {
      const cid = child(node, rest);
      if (cid === undefined) return undefined;
      ({ node, volume } = await load(cid, volume));
      if (!rest.startsWith(node.prefix ?? "")) return undefined;
      rest = rest.slice((node.prefix ?? "").length);
    }
    return node.value;
  }

  async function list(prefix: string, limit: number): Promise<Entry[]> {
    let { node, volume } = await load(rootCID);
    let path = "";
    let rest = prefix;
    while (rest.length > 0) {
      const cid = child(node, rest);
      if (cid === undefined) return [];
      ({ node, volume } = await load(cid, volume));
      const own = node.prefix ?? "";
      if (rest.startsWith(own)) rest = rest.slice(own.length);
      else if (own.startsWith(rest)) rest = "";
      else return [];
      path += own;
    }
    const found: Entry[] = [];
    const walk = async (at: TrieNode, within: VerifiedVolume, key: string): Promise<void> => {
      if (found.length >= limit) return;
      if (at.value !== undefined) found.push({ key, value: at.value });
      const sorted = [...at.children].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      for (const entry of sorted) {
        if (found.length >= limit) return;
        const next = await load(entry.value.rawCID, within);
        await walk(next.node, next.volume, key + (next.node.prefix ?? ""));
      }
    };
    await walk(node, volume, path);
    return found;
  }

  return { get, list };
}

/**
 * A chain to read and write, as a static page can: reads are checked by CID
 * from the node's tip block down, and writes are signed by the visitor's key
 * and paid for in proof of work through a lattice-sponsor (or, with no
 * sponsors, from the key's own balance).
 */
export async function connect(options: ConnectOptions): Promise<Chain> {
  const chainPath = options.chain.split("/");
  const fetch: Fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  // A writer needs the tip as it is now, not as a cache kept it.
  const fresh: Fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });
  const node = new NodeClient(options.node, chainPath, { fetch: fresh });
  const volumes = new VolumeClient(new HTTPVolumeTransport(`${node.baseURL}/volumes`, { fetch }));
  const lattice = new LatticeClient(node, volumes);
  const submitter = new HTTPTransactionSubmitter(`${node.baseURL}/transactions`, { fetch });
  const sponsors = (options.sponsors ?? []).map((url) => new SponsorClient(url, { fetch }));
  const privateKey =
    options.key === undefined
      ? storedKey()
      : typeof options.key === "string"
        ? hexToBytes(options.key)
        : options.key;
  const account = accountFromPrivateKey(privateKey);
  const progress = options.onProgress ?? (() => {});
  /** Each sponsor's client token, so credit left from one write pays toward the next. */
  const clients = new Map<SponsorClient, string>();

  const info = await node.chainInfo();

  async function state() {
    const latest = await lattice.latestBlock();
    const post = await volumes.get(latest.canonical.postStateCID);
    return trie(volumes, decodeCanonicalLatticeState(post.rootBytes()).generalStateCID);
  }

  async function nextNonce(): Promise<{ nonce: bigint; balance: bigint }> {
    try {
      return await node.account(account.address);
    } catch (error) {
      // An account no transaction has touched yet.
      if (error instanceof NodeError && error.status === 404) return { nonce: 0n, balance: 0n };
      throw error;
    }
  }

  /** Grinds `sponsor`'s work for `request` until `paid` says the shares cover it. */
  async function earn(
    sponsor: SponsorClient,
    request: { readonly chain: string; readonly store?: string },
    paid: (credit: bigint, work: SponsorWork) => Promise<boolean> | boolean,
  ): Promise<string> {
    let hashes = 0;
    let shares = 0;
    while (true) {
      const client = clients.get(sponsor);
      const work = await patiently(() =>
        sponsor.requestWork({ ...request, ...(client === undefined ? {} : { client }) }),
      );
      clients.set(sponsor, work.client);
      const report = () =>
        progress({
          stage: "work",
          sponsor: sponsor.endpoint,
          hashes,
          shares,
          sharesNeeded: Number(work.sharesForFee),
        });
      report();
      search: for await (const nonce of findShares(work, {
        ...(options.workers === undefined ? {} : { workers: options.workers }),
        onHashes: (count) => {
          hashes += count;
          report();
        },
      })) {
        let credit: bigint;
        try {
          ({ credit } = await patiently(() => sponsor.submitShare(work.assignment, nonce)));
        } catch (error) {
          // The template's block is gone: work on the new one.
          if (refusal(error) === "unknownAssignment" || refusal(error) === "expired") break search;
          if (refusal(error) === "duplicateShare") continue;
          throw error;
        }
        shares += 1;
        report();
        if (await paid(credit, work)) return work.client;
      }
    }
  }

  /** `attempt` at each sponsor in turn, until one does not fail as unavailable. */
  async function viaSponsors<T>(attempt: (sponsor: SponsorClient) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const sponsor of sponsors) {
      try {
        return await attempt(sponsor);
      } catch (error) {
        if (error instanceof WriteError && error.code !== "sponsorUnavailable") throw error;
        last = error;
      }
    }
    throw new WriteError(
      "sponsorUnavailable",
      last instanceof Error ? last.message : "no sponsor given",
      last,
    );
  }

  /** The body co-signed by `sponsor`, its fee paid in work. */
  async function sponsored(sponsor: SponsorClient, draft: TransactionBody) {
    let client = await earn(
      sponsor,
      { chain: options.chain },
      (credit, work) => credit >= work.fee,
    );
    while (true) {
      try {
        return await patiently(() => sponsor.sponsorTransaction(client, draft));
      } catch (error) {
        if (refusal(error) !== "insufficientCredit") throw error;
        client = await earn(
          sponsor,
          { chain: options.chain },
          (credit, work) => credit >= work.fee,
        );
      }
    }
  }

  /** Submits `payload`; the transaction's CID, or a plain error. */
  async function submit(
    payload: ReturnType<typeof transactionPayload>,
    byOwnBalance: boolean,
  ): Promise<string> {
    try {
      return (await patiently(() => submitter.submit(payload))).transactionCID;
    } catch (error) {
      if (!(error instanceof SubmissionError)) throw error;
      const reason = error.refusal ?? `HTTP ${error.status}`;
      if (error.reason === "invalidState") throw new WriteError("rejected", reason, error);
      if (error.reason === "insufficientFunds") {
        // Unsponsored, the key cannot pay; sponsored, the sponsor's float cannot.
        throw new WriteError(
          byOwnBalance ? "insufficientBalance" : "sponsorUnavailable",
          reason,
          error,
        );
      }
      if (error.status === 404 && error.reason === undefined) {
        throw new WriteError(
          "refused",
          "the node takes no transactions (public submit is off)",
          error,
        );
      }
      throw new WriteError("refused", reason, error);
    }
  }

  /** Resolves once `transactionCID` is in a block of the node's chain, sending it again while the node does not know it. */
  async function confirm(
    transactionCID: string,
    payload: ReturnType<typeof transactionPayload>,
    byOwnBalance: boolean,
  ): Promise<void> {
    progress({ stage: "confirm", transactionCID });
    while (true) {
      await sleep(POLL_MILLISECONDS);
      try {
        if ((await node.transaction(transactionCID)).blockHeight !== undefined) return;
      } catch (error) {
        if (!(error instanceof NodeError && error.status === 404)) continue;
        await submit(payload, byOwnBalance);
      }
    }
  }

  return {
    chain: options.chain,
    address: account.address,

    async get(key) {
      return (await state()).get(key);
    },

    async list(prefix = "", { limit = 100 } = {}) {
      return (await state()).list(prefix, limit);
    },

    async set(key, value) {
      const [old, { nonce, balance }] = await Promise.all([
        state().then((reads) => reads.get(key)),
        nextNonce(),
      ]);
      // The chain checks the value being replaced: a write states it.
      const action: Action = {
        key,
        ...(old === undefined ? {} : { oldValue: old }),
        newValue: value,
      };
      const draft: TransactionBody = {
        accountActions: [],
        actions: [action],
        depositActions: [],
        receiptActions: [],
        withdrawalActions: [],
        signers: [account.address],
        nonce,
        chainPath,
      };
      const byOwnBalance = sponsors.length === 0;
      let body: TransactionBody;
      let signatures: Readonly<{ [key: string]: string }> = {};
      if (byOwnBalance) {
        const fee = info.minRelayFee ?? 1n;
        if (balance < fee) {
          throw new WriteError(
            "insufficientBalance",
            `${account.address} holds ${balance} and the fee is ${fee}; give sponsors to pay in work`,
          );
        }
        body = { ...draft, accountActions: [{ owner: account.address, delta: -fee }] };
      } else {
        ({ body, signatures } = await viaSponsors((sponsor) => sponsored(sponsor, draft)));
      }
      const { publicKey, signature } = signTransactionBody(body, privateKey);
      const payload = transactionPayload({ ...signatures, [publicKey]: signature }, body);
      progress({ stage: "submit" });
      const transactionCID = await submit(payload, byOwnBalance);
      await confirm(transactionCID, payload, byOwnBalance);
      return { transactionCID };
    },

    async put(data, { type } = {}) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
      const volumes = fileVolumes(
        type ?? ((data instanceof Uint8Array ? "" : data.type) || "application/octet-stream"),
        bytes,
      );
      const root = volumes[0]!.cid;
      return viaSponsors(async (sponsor) => {
        progress({ stage: "store", sponsor: sponsor.endpoint, root });
        const held = await patiently(() => sponsor.store(root, volumes));
        if (!held.stored) {
          const priced = Object.keys(held.needed);
          const chain = priced.includes(options.chain) ? options.chain : priced[0];
          if (chain === undefined) throw new Error("the sponsor sells no storage");
          if (held.credit < held.bytes) {
            await earn(
              sponsor,
              { chain, store: root },
              async () => (await sponsor.storeStatus(root)).credit >= held.bytes,
            );
          }
          // Paid: the sponsor pins it on its node.
          while (!(await patiently(() => sponsor.storeStatus(root))).stored) {
            await sleep(POLL_MILLISECONDS);
          }
        }
        return root;
      });
    },
  };
}
