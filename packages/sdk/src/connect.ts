import { NodeClient, NodeError } from "@adalin/lattice-client";
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
import {
  BatchingVolumeTransport,
  HTTPVolumeTransport,
  VolumeClient,
  type VerifiedVolume,
} from "@adalin/lattice-volumes";
import { findShares } from "./share-search.js";
import { tipChooser, type Source } from "./tip.js";

export { ReadError, type ReadFailure } from "./tip.js";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Payload = ReturnType<typeof transactionPayload>;

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
  /**
   * A node's public read URL, or several run by different operators. The
   * first must host the chain and take writes (public submit); all are read
   * from. With one, that node chooses the tip reads are taken at. With
   * several, a tip is read only once two of them hold it, and the heaviest
   * such tip is read.
   */
  readonly node: string | readonly string[];
  /**
   * The CID of the chain's genesis block, as the app ships it. Every tip
   * read is then walked back to it (or to `checkpoint`, or to a block an
   * earlier read linked) and refused unless each block links to the one
   * before by the header rules. Without it, the tip is not checked against
   * any history.
   */
  readonly genesis?: string;
  /**
   * The CID of a later block of the chain the app ships, to walk back to
   * instead of genesis; reads must descend from it.
   */
  readonly checkpoint?: string;
  /** The most blocks one read walks back before failing `tooFar`. Default: 2,000. */
  readonly maxHeaders?: number;
  /** lattice-sponsor URLs, tried in order, that pay fees for proof of work. */
  readonly sponsors?: readonly string[];
  /**
   * The writer's Ed25519 private key (32 bytes or 64 hex digits). Default: a
   * key made on first use and kept in `localStorage` under `storageKey`.
   */
  readonly key?: Uint8Array | string;
  /** The `localStorage` name of the kept key. Default: `lattice-sdk/key/<chain>`. */
  readonly storageKey?: string;
  /** The most a write without sponsors pays from the key's own balance. Default: 10. */
  readonly maxFee?: bigint;
  /** How long a write waits to be in a block before failing `notConfirmed`. Default: 15 minutes. */
  readonly confirmTimeoutMilliseconds?: number;
  readonly onProgress?: (progress: Progress) => void;
  /** Web Workers to grind in; 0 grinds on this thread. Default: all cores but one. */
  readonly workers?: number;
  /** Stops every read and write of this chain. */
  readonly signal?: AbortSignal;
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
  /**
   * The value under `key` at the tip (see `connect`). The block, its state
   * and every trie node are checked against their CIDs, so the answer is
   * that block's. The tip's history is checked only with `genesis` or
   * `checkpoint`, and no browser check makes a block's state honest: on a
   * chain whose blocks carry little work, any one node can make a block
   * that links to real history and holds any state. Several nodes guard
   * against that: one alone cannot get its block read.
   */
  get(key: string, options?: { readonly signal?: AbortSignal }): Promise<string | undefined>;
  /** The records whose keys start with `prefix`, in key order: at most `limit` (default 100). Read as `get` reads. */
  list(
    prefix?: string,
    options?: { readonly limit?: number; readonly signal?: AbortSignal },
  ): Promise<Entry[]>;
  /** Writes `value` under `key`; resolves once the node shows the write in a block. */
  set(
    key: string,
    value: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly transactionCID: string }>;
  /** Pins `data` for good through a sponsor's storage; resolves to its root CID. */
  put(
    data: Uint8Array | Blob,
    options?: { readonly type?: string; readonly signal?: AbortSignal },
  ): Promise<string>;
}

export type WriteFailure =
  /** No sponsor paid, and the key cannot pay the fee itself. */
  | "insufficientBalance"
  /** The chain refused the write: its policy, or the key's value changed under it. */
  | "rejected"
  /** No sponsor could take the work or sign. */
  | "sponsorUnavailable"
  /** The node, or this client's `maxFee`, would not take the transaction. */
  | "refused"
  /** Sent, but not seen in a block before `confirmTimeoutMilliseconds`. */
  | "notConfirmed";

export class WriteError extends Error {
  readonly code: WriteFailure;

  constructor(code: WriteFailure, detail?: string, cause?: unknown) {
    const plain = {
      insufficientBalance: "insufficient balance",
      rejected: "rejected by the chain's rules",
      sponsorUnavailable: "sponsor unavailable",
      refused: "refused by the node",
      notConfirmed: "not confirmed",
    }[code];
    super(detail === undefined ? plain : `${plain}: ${detail}`, { cause });
    this.name = "WriteError";
    this.code = code;
  }
}

/** Attempts of one request that the sponsor or node asks to retry. */
const ATTEMPTS = 5;
/** Work requests one payment may take before the sponsor counts as unavailable. */
const WORK_ROUNDS = 8;
/** Times one write may earn more after the sponsor answers `insufficientCredit`. */
const CREDIT_RETRIES = 3;
/** Polls for a paid upload to be pinned. */
const PIN_POLLS = 60;
const POLL_MILLISECONDS = 2_000;
const LONGEST_WAIT = 30_000;

function storedKey(name: string): Uint8Array {
  try {
    const kept = globalThis.localStorage?.getItem(name);
    if (kept && /^[0-9a-f]{64}$/.test(kept)) return hexToBytes(kept);
  } catch {
    // No storage here (a private window, or not a browser): the key lives in memory.
  }
  const key = generatePrivateKey();
  try {
    globalThis.localStorage?.setItem(name, bytesToHex(key));
  } catch {
    // As above.
  }
  return key;
}

/** Waits `milliseconds`, or rejects with `signal`'s reason, clearing its timer either way. */
function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
    };
    const aborted = () => {
      done();
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** A failure to reach a server at all: fetch's network `TypeError`, or a timeout. */
function unreachable(error: unknown): boolean {
  if ((error as Error)?.name === "TimeoutError") return true;
  return (
    error instanceof TypeError && /fetch|network|load failed/i.test(error.message) // browsers' and Node's wording
  );
}

/**
 * How long to wait before trying `error`'s request again, or undefined when
 * it is not worth retrying. Retried: a busy sponsor or node (429, 503) and
 * one out of reach. A `Retry-After` is honoured up to 30 s; a longer one
 * counts as unavailable. Otherwise 1 s, doubling, up to 30 s.
 */
export function retryDelay(error: unknown, attempt: number): number | undefined {
  const status =
    error instanceof SponsorError || error instanceof SubmissionError ? error.status : undefined;
  if (!unreachable(error) && status !== 429 && status !== 503) return undefined;
  if (error instanceof SponsorError && error.refusal === "insufficientFloat") return undefined;
  if (error instanceof SponsorError && error.retryAfterMilliseconds !== undefined) {
    const wait = error.retryAfterMilliseconds;
    return Number.isFinite(wait) && wait >= 0 && wait <= LONGEST_WAIT ? wait : undefined;
  }
  return Math.min(LONGEST_WAIT, 1000 * 2 ** attempt);
}

async function patiently<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      signal?.throwIfAborted();
      const wait = retryDelay(error, attempt);
      if (wait === undefined || attempt + 1 >= ATTEMPTS) throw error;
      await sleep(wait, signal);
    }
  }
}

const refusal = (error: unknown) => (error instanceof SponsorError ? error.refusal : undefined);
/** The sponsor no longer knows the client token: it restarted, and its credit is gone. */
const unknownClient = (error: unknown) => /unknown client token/.test(refusal(error) ?? "");

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
  readonly prefix: string;
  readonly value?: string;
  readonly children: readonly { readonly key: string; readonly rawCID: string }[];
}

/** A general-state trie node as decoded, or a thrown error when it is not one. */
function trieNode(value: unknown, cid: string): TrieNode {
  const node = value as {
    prefix?: unknown;
    value?: unknown;
    children?: unknown;
  } | null;
  const fail = () => {
    throw new Error(`${cid} is not a general-state trie node`);
  };
  if (node === null || typeof node !== "object" || !Array.isArray(node.children)) return fail();
  if (node.prefix !== undefined && typeof node.prefix !== "string") return fail();
  if (node.value !== undefined && typeof node.value !== "string") return fail();
  const children = node.children.map((entry: unknown) => {
    const child = entry as { key?: unknown; value?: { rawCID?: unknown } } | null;
    if (
      typeof child?.key !== "string" ||
      child.key === "" ||
      typeof child.value?.rawCID !== "string"
    ) {
      return fail();
    }
    return { key: child.key, rawCID: child.value.rawCID };
  });
  return {
    prefix: (node.prefix as string | undefined) ?? "",
    ...(node.value === undefined ? {} : { value: node.value as string }),
    children,
  };
}

/**
 * Reads of one general-state root (cashew's Merkle dictionary), each node
 * checked against its CID. A node inside a Volume already fetched is read
 * from it.
 */
function trie(volumes: VolumeClient, rootCID: string, signal?: AbortSignal) {
  const load = async (cid: string, within?: VerifiedVolume) => {
    const volume = within?.has(cid) ? within : await volumes.get(cid, signal);
    return { node: trieNode(decodeDagCbor(volume.bytes(cid)!), cid), volume };
  };
  // A child is filed under the first Character (grapheme cluster) of its
  // prefix, which may be several code points: the longest key that starts
  // `rest` is the one.
  const child = (node: TrieNode, rest: string) => {
    let best: { key: string; rawCID: string } | undefined;
    for (const entry of node.children) {
      if (rest.startsWith(entry.key) && entry.key.length > (best?.key.length ?? 0)) best = entry;
    }
    return best?.rawCID;
  };

  async function get(key: string): Promise<string | undefined> {
    let { node, volume } = await load(rootCID);
    let rest = key;
    while (rest.length > 0) {
      const cid = child(node, rest);
      if (cid === undefined) return undefined;
      ({ node, volume } = await load(cid, volume));
      if (!rest.startsWith(node.prefix)) return undefined;
      rest = rest.slice(node.prefix.length);
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
      if (rest.startsWith(node.prefix)) rest = rest.slice(node.prefix.length);
      else if (node.prefix.startsWith(rest)) rest = "";
      else return [];
      path += node.prefix;
    }
    const found: Entry[] = [];
    const walk = async (at: TrieNode, within: VerifiedVolume, key: string): Promise<void> => {
      if (found.length >= limit) return;
      if (at.value !== undefined) found.push({ key, value: at.value });
      const sorted = [...at.children].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      for (const entry of sorted) {
        if (found.length >= limit) return;
        const next = await load(entry.rawCID, within);
        await walk(next.node, next.volume, key + next.node.prefix);
      }
    };
    await walk(node, volume, path);
    return found;
  }

  return { get, list };
}

/**
 * A chain to read and write, as a static page can. Reads are taken at a tip
 * block and checked by CID from that block down. With `genesis` (or
 * `checkpoint`) the tip must link back to it; with several nodes, two must
 * hold the tip. Otherwise reads are as honest as the one node's choice of
 * tip. Writes are signed by the visitor's key and paid for in proof of work
 * through a lattice-sponsor (or, with no sponsors, from the key's own
 * balance), one at a time.
 */
export async function connect(options: ConnectOptions): Promise<Chain> {
  const chainPath = options.chain.split("/");
  const fetch: Fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  // A writer needs the tip as it is now, not as a cache kept it.
  const fresh: Fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });
  const urls = typeof options.node === "string" ? [options.node] : options.node;
  if (urls.length === 0) throw new RangeError("node must name at least one node");
  const sources: Source[] = urls.map((url) => {
    const node = new NodeClient(url, chainPath, { fetch: fresh });
    const transport = new HTTPVolumeTransport(`${node.baseURL}/volumes`, { fetch });
    return {
      node,
      volumes: new VolumeClient(transport),
      pages: new VolumeClient(new BatchingVolumeTransport(transport)),
    };
  });
  const { node } = sources[0]!;
  const maxHeaders = options.maxHeaders ?? 2_000;
  if (!Number.isSafeInteger(maxHeaders) || maxHeaders < 1) {
    throw new RangeError("maxHeaders must be a positive integer");
  }
  const root = options.checkpoint ?? options.genesis;
  const chooseTip = tipChooser({
    sources,
    chainPath,
    ...(root === undefined ? {} : { root }),
    maxHeaders,
    storageKey: `lattice-sdk/linked/${options.chain}/${root}`,
  });
  const submitter = new HTTPTransactionSubmitter(`${node.baseURL}/transactions`, { fetch });
  const sponsors = (options.sponsors ?? []).map((url) => new SponsorClient(url, { fetch }));
  const privateKey =
    options.key === undefined
      ? storedKey(options.storageKey ?? `lattice-sdk/key/${options.chain}`)
      : typeof options.key === "string"
        ? hexToBytes(options.key)
        : options.key;
  const account = accountFromPrivateKey(privateKey);
  const progress = options.onProgress ?? (() => {});
  const maxFee = options.maxFee ?? 10n;
  const confirmTimeout = options.confirmTimeoutMilliseconds ?? 15 * 60_000;
  /** Each sponsor's client token, so credit left from one write pays toward the next. */
  const clients = new Map<SponsorClient, string>();
  /** Writes run one after another: each reads the nonce and values the last one left. */
  let writes: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(signal: AbortSignal | undefined, write: () => Promise<T>): Promise<T> => {
    // A write aborted while it waited its turn ends without running.
    const turn = () => {
      signal?.throwIfAborted();
      return write();
    };
    const next = writes.then(turn, turn);
    writes = next.catch(() => {});
    return next;
  };
  const signalFor = (signal?: AbortSignal) => {
    const signals = [options.signal, signal].filter((s): s is AbortSignal => s !== undefined);
    return signals.length < 2 ? signals[0] : AbortSignal.any(signals);
  };

  // The node must host the chain.
  await node.chainInfo(options.signal);

  async function state(signal?: AbortSignal) {
    const tip = await chooseTip(signal);
    const post = await tip.source.volumes.get(tip.block.postStateCID, signal);
    return trie(
      tip.source.volumes,
      decodeCanonicalLatticeState(post.rootBytes()).generalStateCID,
      signal,
    );
  }

  async function nextNonce(signal?: AbortSignal): Promise<{ nonce: bigint; balance: bigint }> {
    try {
      return await node.account(account.address, signal);
    } catch (error) {
      // An account no transaction has touched yet.
      if (error instanceof NodeError && error.status === 404) return { nonce: 0n, balance: 0n };
      throw error;
    }
  }

  /**
   * Grinds `sponsor`'s work for `request` until `paid` says the shares cover
   * it, over at most `WORK_ROUNDS` work requests.
   */
  async function earn(
    sponsor: SponsorClient,
    request: { readonly chain: string; readonly store?: string },
    paid: (credit: bigint, work: SponsorWork) => Promise<boolean> | boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    let hashes = 0;
    let shares = 0;
    let forgotten = false;
    for (let round = 0; round < WORK_ROUNDS; round++) {
      const client = clients.get(sponsor);
      let work: SponsorWork;
      try {
        work = await patiently(
          () =>
            sponsor.requestWork(
              { ...request, ...(client === undefined ? {} : { client }) },
              signal,
            ),
          signal,
        );
      } catch (error) {
        // A restarted sponsor: start again with a new token, once.
        if (!unknownClient(error) || client === undefined || forgotten) throw error;
        clients.delete(sponsor);
        forgotten = true;
        continue;
      }
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
        ...(signal === undefined ? {} : { signal }),
        onHashes: (count) => {
          hashes += count;
          report();
        },
      })) {
        let credit: bigint;
        try {
          ({ credit } = await patiently(
            () => sponsor.submitShare(work.assignment, nonce, signal),
            signal,
          ));
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
    throw new WriteError("sponsorUnavailable", `no credit after ${WORK_ROUNDS} rounds of work`);
  }

  /**
   * `attempt` at each sponsor in turn, until one does not fail as
   * unavailable: a refusal, a sponsor out of reach, or no credit. Any other
   * error is thrown as it is.
   */
  async function viaSponsors<T>(attempt: (sponsor: SponsorClient) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const sponsor of sponsors) {
      try {
        return await attempt(sponsor);
      } catch (error) {
        const unavailable =
          error instanceof SponsorError ||
          unreachable(error) ||
          (error instanceof WriteError && error.code === "sponsorUnavailable");
        if (!unavailable) throw error;
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
  async function sponsored(sponsor: SponsorClient, draft: TransactionBody, signal?: AbortSignal) {
    const feePaid = (credit: bigint, work: SponsorWork) => credit >= work.fee;
    let client = await earn(sponsor, { chain: options.chain }, feePaid, signal);
    for (let retry = 0; ; retry++) {
      try {
        return await patiently(() => sponsor.sponsorTransaction(client, draft, 0n, signal), signal);
      } catch (error) {
        const restarted = unknownClient(error);
        if ((refusal(error) !== "insufficientCredit" && !restarted) || retry >= CREDIT_RETRIES) {
          throw error;
        }
        // Short of the fee, or a restarted sponsor that forgot the credit: earn it again.
        if (restarted) clients.delete(sponsor);
        client = await earn(sponsor, { chain: options.chain }, feePaid, signal);
      }
    }
  }

  /** Submits `payload`; the transaction's CID, or a plain error. */
  async function submit(
    payload: Payload,
    byOwnBalance: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      return (await patiently(() => submitter.submit(payload, signal), signal)).transactionCID;
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

  /**
   * Resolves once the node shows `transactionCID` in a block of its chain,
   * sending it again while the node does not know it; fails `notConfirmed`
   * past the deadline.
   */
  async function confirm(
    transactionCID: string,
    payload: Payload,
    byOwnBalance: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    progress({ stage: "confirm", transactionCID });
    const deadline = Date.now() + confirmTimeout;
    while (Date.now() < deadline) {
      await sleep(Math.min(POLL_MILLISECONDS, Math.max(0, deadline - Date.now())), signal);
      try {
        if ((await node.transaction(transactionCID, signal)).blockHeight !== undefined) return;
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof NodeError && error.status === 404)) continue;
        await submit(payload, byOwnBalance, signal);
      }
    }
    throw new WriteError(
      "notConfirmed",
      `${transactionCID} was not in a block after ${confirmTimeout} ms`,
    );
  }

  async function set(key: string, value: string, signal?: AbortSignal) {
    const [old, { nonce, balance }] = await Promise.all([
      state(signal).then((reads) => reads.get(key)),
      nextNonce(signal),
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
    const signed = (body: TransactionBody, signatures: Readonly<{ [key: string]: string }>) => {
      const { publicKey, signature } = signTransactionBody(body, privateKey);
      return transactionPayload({ ...signatures, [publicKey]: signature }, body);
    };
    const byOwnBalance = sponsors.length === 0;
    let sent: { payload: Payload; transactionCID: string };
    if (byOwnBalance) {
      // The node's fee floor as it is now: it is its policy, and may change.
      const fee = (await node.chainInfo(signal)).minRelayFee ?? 1n;
      if (fee > maxFee) {
        throw new WriteError("refused", `the node's fee floor ${fee} is above maxFee ${maxFee}`);
      }
      if (balance < fee) {
        throw new WriteError(
          "insufficientBalance",
          `${account.address} holds ${balance} and the fee is ${fee}; give sponsors to pay in work`,
        );
      }
      const payload = signed(
        { ...draft, accountActions: [{ owner: account.address, delta: -fee }] },
        {},
      );
      progress({ stage: "submit" });
      sent = { payload, transactionCID: await submit(payload, true, signal) };
    } else {
      // A sponsor whose float cannot cover the fee at the node gives way to the next.
      sent = await viaSponsors(async (sponsor) => {
        const { body, signatures } = await sponsored(sponsor, draft, signal);
        const payload = signed(body, signatures);
        progress({ stage: "submit" });
        return { payload, transactionCID: await submit(payload, false, signal) };
      });
    }
    await confirm(sent.transactionCID, sent.payload, byOwnBalance, signal);
    return { transactionCID: sent.transactionCID };
  }

  async function put(data: Uint8Array | Blob, type: string | undefined, signal?: AbortSignal) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
    const volumes = fileVolumes(
      type ?? ((data instanceof Uint8Array ? "" : data.type) || "application/octet-stream"),
      bytes,
    );
    const root = volumes[0]!.cid;
    return viaSponsors(async (sponsor) => {
      progress({ stage: "store", sponsor: sponsor.endpoint, root });
      const held = await patiently(() => sponsor.store(root, volumes, signal), signal);
      if (held.stored) return root;
      const priced = Object.keys(held.needed);
      const chain = priced.includes(options.chain) ? options.chain : priced[0];
      if (chain === undefined) throw new WriteError("sponsorUnavailable", "it sells no storage");
      if (held.credit < held.bytes) {
        await earn(
          sponsor,
          { chain, store: root },
          async () => (await sponsor.storeStatus(root, signal)).credit >= held.bytes,
          signal,
        );
      }
      // Paid: the sponsor pins it on its node.
      for (let poll = 0; poll < PIN_POLLS; poll++) {
        if ((await patiently(() => sponsor.storeStatus(root, signal), signal)).stored) return root;
        await sleep(POLL_MILLISECONDS, signal);
      }
      throw new WriteError("sponsorUnavailable", "paid, but the sponsor did not pin it");
    });
  }

  return {
    chain: options.chain,
    address: account.address,

    async get(key, { signal } = {}) {
      return (await state(signalFor(signal))).get(key);
    },

    async list(prefix = "", { limit = 100, signal } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError("limit must be a positive integer");
      }
      return (await state(signalFor(signal))).list(prefix, limit);
    },

    set(key, value, { signal } = {}) {
      const combined = signalFor(signal);
      return oneAtATime(combined, () => set(key, value, combined));
    },

    put(data, { type, signal } = {}) {
      const combined = signalFor(signal);
      return oneAtATime(combined, () => put(data, type, combined));
    },
  };
}
