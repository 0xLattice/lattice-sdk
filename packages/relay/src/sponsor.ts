import { sha256 } from "@noble/hashes/sha2.js";
import {
  addressFromMultikey,
  hexToBytes,
  toWireTransactionBody,
  type TransactionBody,
} from "@adalin/lattice-core";
import { boundedText, errorMessage, writeURL } from "./http.js";

/**
 * A nonce range of a work-for-fee sponsor's block template (lattice-sponsor
 * `POST /work`). A share is a nonce in the range whose hash,
 * SHA-256(prefix ‖ nonce as 8 big-endian bytes) read as a big-endian
 * integer, is at most `shareTarget`.
 */
export interface SponsorWork {
  /** The client token: send it again to keep earning on the same credit. */
  readonly client: string;
  readonly assignment: string;
  readonly prefixHex: string;
  readonly shareTarget: bigint;
  readonly startNonce: bigint;
  readonly count: bigint;
  /** The chain's fee, and what the sponsor pays the client as well. */
  readonly fee: bigint;
  readonly pay: bigint;
  /** Shares that buy `fee` and `pay` now (zero for storage work). */
  readonly sharesForFee: bigint;
  /** When the range stops earning, in milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** An upload held by a storage sponsor (`POST /store`, `GET /store/:root`). */
export interface StoreStatus {
  readonly root: string;
  readonly bytes: bigint;
  /** Coins of work still owed, by chain path. */
  readonly needed: Readonly<Record<string, bigint>>;
  /** The bytes paid. */
  readonly credit: bigint;
  /** Pinned on the sponsor's node, for good. */
  readonly stored: boolean;
}

/** A Volume of an upload, as the node's `POST /pins` takes it: CID to base64 bytes. */
export interface StoreVolume {
  readonly cid: string;
  readonly entries: Readonly<Record<string, string>>;
}

export class SponsorError extends Error {
  readonly status: number;
  /** The sponsor's refusal, such as `insufficientCredit` or `expired`. */
  readonly refusal?: string;

  constructor(status: number, refusal?: string) {
    super(refusal ?? `sponsor request failed with HTTP ${status}`);
    this.name = "SponsorError";
    this.status = status;
    if (refusal !== undefined) this.refusal = refusal;
  }
}

export interface SponsorClientOptions {
  readonly fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly timeoutMilliseconds?: number;
  readonly maximumResponseBytes?: number;
}

function decimal(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be a canonical decimal string`);
  }
  return BigInt(value);
}

function hexTarget(value: unknown): bigint {
  if (typeof value !== "string" || !/^[0-9a-f]{1,64}$/.test(value)) {
    throw new TypeError("shareTarget must be lower-case hex");
  }
  return BigInt("0x" + value);
}

function parseStatus(value: Record<string, unknown>): StoreStatus {
  const needed = value.needed as Record<string, unknown>;
  if (needed === null || typeof needed !== "object" || typeof value.root !== "string") {
    throw new TypeError("not a store status");
  }
  if (typeof value.stored !== "boolean") throw new TypeError("stored must be a boolean");
  return {
    root: value.root,
    bytes: decimal(value.bytes, "bytes"),
    needed: Object.fromEntries(
      Object.entries(needed).map(([chain, coins]) => [chain, decimal(coins, "needed")]),
    ),
    credit: decimal(value.credit, "credit"),
    stored: value.stored,
  };
}

/**
 * A client of a lattice-sponsor: work for a fee or for storage, the shares
 * that pay for it, and the co-signed transaction. Grind with `grind`.
 */
export class SponsorClient {
  readonly endpoint: string;
  readonly #fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly #timeoutMilliseconds: number;
  readonly #maximumResponseBytes: number;

  constructor(endpoint: string, options: SponsorClientOptions = {}) {
    this.endpoint = writeURL(endpoint, "sponsor").replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 1024 * 1024;
  }

  async #call(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.#timeoutMilliseconds);
    const response = await this.#fetch(`${this.endpoint}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    const text = await boundedText(response, this.#maximumResponseBytes);
    if (text === undefined) throw new SponsorError(response.status, "response too large");
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new SponsorError(response.status, response.ok ? "invalid JSON response" : undefined);
    }
    if (!response.ok) throw new SponsorError(response.status, errorMessage(decoded));
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new SponsorError(response.status, "invalid sponsor response");
    }
    return decoded as Record<string, unknown>;
  }

  /**
   * A nonce range to grind. Without `store`, its shares buy `chain`'s fee
   * (and `pay`); with `store`, they pay for that upload instead.
   */
  async requestWork(
    request: {
      readonly client?: string;
      readonly chain?: string;
      readonly pay?: bigint;
      readonly store?: string;
    } = {},
    signal?: AbortSignal,
  ): Promise<SponsorWork> {
    const sent = Date.now();
    const work = await this.#call(
      "work",
      {
        ...(request.client === undefined ? {} : { client: request.client }),
        ...(request.chain === undefined ? {} : { chain: request.chain }),
        ...(request.pay === undefined ? {} : { pay: request.pay.toString() }),
        ...(request.store === undefined ? {} : { store: request.store }),
      },
      signal,
    );
    for (const name of ["client", "assignment", "prefixHex"] as const) {
      if (typeof work[name] !== "string") throw new TypeError(`${name} must be a string`);
    }
    hexToBytes(work.prefixHex as string);
    return {
      client: work.client as string,
      assignment: work.assignment as string,
      prefixHex: work.prefixHex as string,
      shareTarget: hexTarget(work.shareTarget),
      startNonce: decimal(work.startNonce, "startNonce"),
      count: decimal(work.count, "count"),
      fee: decimal(work.fee, "fee"),
      pay: decimal(work.pay, "pay"),
      sharesForFee: decimal(work.sharesForFee, "sharesForFee"),
      // From the request, not the answer: the range never outlives the sponsor's word.
      expiresAt: sent + Number(decimal(work.expiresInMilliseconds, "expiresInMilliseconds")),
    };
  }

  /** Post one share; answers the client's fee credit on the work's chain, in whole coins. */
  async submitShare(
    assignment: string,
    nonce: bigint,
    signal?: AbortSignal,
  ): Promise<{ readonly credit: bigint }> {
    const answer = await this.#call("shares", { assignment, nonce: nonce.toString() }, signal);
    return { credit: decimal(answer.credit, "credit") };
  }

  /**
   * The sponsor's co-signature on `draft` (one signer, the client's, and
   * balanced on its own), paid from `client`'s credit. The sponsored body is
   * the draft plus a credit of `pay` to the client and a debit of the fee and
   * `pay` from the sponsor, which becomes the second signer. It is rebuilt
   * here and must match the sponsor's exactly, so the client never signs a
   * body it did not expect. The client signs `body` and submits it with
   * `signatures` added.
   */
  async sponsorTransaction(
    client: string,
    draft: TransactionBody,
    pay = 0n,
    signal?: AbortSignal,
  ): Promise<{
    readonly body: TransactionBody;
    readonly signatures: Readonly<Record<string, string>>;
    readonly fee: bigint;
    readonly pay: bigint;
  }> {
    const answer = await this.#call(
      "sponsor",
      {
        client,
        transaction: { signatures: {}, body: toWireTransactionBody(draft) },
        ...(pay === 0n ? {} : { pay: pay.toString() }),
      },
      signal,
    );
    const fee = decimal(answer.fee, "fee");
    if (decimal(answer.pay, "pay") !== pay) throw new SponsorError(200, "sponsor changed pay");
    const transaction = answer.transaction as {
      signatures?: Record<string, unknown>;
      body?: { signers?: unknown[] };
    };
    const sponsor = transaction?.body?.signers?.[1];
    const signer = draft.signers[0];
    if (typeof sponsor !== "string" || signer === undefined || draft.signers.length !== 1) {
      throw new SponsorError(200, "not a sponsored transaction");
    }
    const body: TransactionBody = {
      ...draft,
      accountActions: [
        ...draft.accountActions,
        ...(pay > 0n ? [{ owner: signer, delta: pay }] : []),
        { owner: sponsor, delta: -(fee + pay) },
      ],
      signers: [signer, sponsor],
    };
    const expected = JSON.parse(JSON.stringify(toWireTransactionBody(body)));
    if (!sameJSON(expected, transaction.body)) {
      throw new SponsorError(200, "the sponsored body is not the draft plus the fee");
    }
    const signatures: Record<string, string> = {};
    for (const [key, value] of Object.entries(transaction.signatures ?? {})) {
      if (typeof value !== "string" || addressFromMultikey(key) !== sponsor) {
        throw new SponsorError(200, "a signature is not the sponsor's");
      }
      signatures[key] = value;
    }
    return { body, signatures, fee, pay };
  }

  /** Hold an upload of `volumes` (root included) under `root`, to be paid for in work. */
  async store(
    root: string,
    volumes: readonly StoreVolume[],
    signal?: AbortSignal,
  ): Promise<StoreStatus> {
    return parseStatus(await this.#call("store", { root, volumes }, signal));
  }

  async storeStatus(root: string, signal?: AbortSignal): Promise<StoreStatus> {
    return parseStatus(await this.#call(`store/${encodeURIComponent(root)}`, undefined, signal));
  }
}

function sameJSON(left: unknown, right: unknown): boolean {
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return left === right;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) =>
      sameJSON((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}

function nonceBytes(nonce: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, nonce);
  return bytes;
}

/** A share's hash: SHA-256(prefix ‖ nonce as 8 big-endian bytes), as lattice-sponsor checks it. */
export function shareHash(prefixHex: string, nonce: bigint): Uint8Array {
  return sha256.create().update(hexToBytes(prefixHex)).update(nonceBytes(nonce)).digest();
}

/**
 * The shares in `work`'s range, in nonce order, as they are found. Stops at
 * the end of the range, when the range expires, or when `signal` aborts
 * (throwing its reason). Pure JavaScript, so it runs in a browser or a
 * worker; it yields to the event loop as it goes.
 */
export async function* grind(
  work: Pick<SponsorWork, "prefixHex" | "shareTarget" | "startNonce" | "count" | "expiresAt">,
  signal?: AbortSignal,
): AsyncGenerator<bigint> {
  const midstate = sha256.create().update(hexToBytes(work.prefixHex));
  const target = new Uint8Array(32);
  for (let index = 31, rest = work.shareTarget; index >= 0; index -= 1, rest >>= 8n) {
    target[index] = Number(rest & 0xffn);
  }
  const nonceBuffer = new Uint8Array(8);
  const view = new DataView(nonceBuffer.buffer);
  signal?.throwIfAborted();
  const end = work.startNonce + work.count;
  for (let nonce = work.startNonce; nonce < end; nonce += 1n) {
    if ((nonce & 0x3fffn) === 0n) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
      if (Date.now() >= work.expiresAt) return;
    }
    view.setBigUint64(0, nonce);
    if (atMost(midstate.clone().update(nonceBuffer).digest(), target)) yield nonce;
  }
}

function atMost(hash: Uint8Array, target: Uint8Array): boolean {
  for (let index = 0; index < 32; index += 1) {
    if (hash[index] !== target[index]) return hash[index]! < target[index]!;
  }
  return true;
}
