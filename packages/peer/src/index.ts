import {
  cidV1DagCbor,
  decodeChildBlockProof,
  decodeLatticeBlock,
  verifyChildBlockProof,
  verifyNexusBlockProofOfWork,
  workForTarget,
  type CanonicalBlock,
} from "@adalin/lattice-core";

/** The node overlay's topics (lattice-node ChainSyncWire / OverlayWire). */
export const Topic = {
  hello: "lattice.overlay.hello.v1",
  streamRequest: "lattice.overlay.stream.request.v1",
  streamPage: "lattice.overlay.stream.page.v1",
  dataRequest: "lattice.overlay.data.request.v1",
  headersResponse: "lattice.overlay.headers.response.v1",
  ancestorsRequest: "lattice.overlay.ancestors.request.v1",
} as const;

/** The overlay hello's version, and the capability that asks for the tail. */
export const PROTOCOL_VERSION = 6;
export const STREAM_TAIL = "stream-tail";
const TAIL = 18446744073709551615n;

type Json =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly Json[]
  | { readonly [key: string]: Json | undefined };

/**
 * The node's canonical JSON: keys sorted, no whitespace, absent fields left
 * out, `/` unescaped. A bigint is written out in full (a UInt64 past 2^53).
 */
export function canonicalJSON(value: Json): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as { readonly [key: string]: Json | undefined };
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key] as Json)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function base64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** One header the follower checked: its bytes hash to `cid`, and its work is proven. */
export interface FollowedBlock {
  readonly cid: string;
  readonly block: CanonicalBlock;
  /** The work this block's own proof of work shows. */
  readonly work: bigint;
  /** Its work plus its known ancestors' since the follower started. */
  readonly cumulativeWork: bigint;
}

export interface ChainFollowerOptions {
  /** The chain to follow, e.g. `["Nexus", "moniker"]`. */
  readonly chainPath: readonly string[];
  /** The Nexus genesis CID the node's network was started from. */
  readonly nexusGenesisCID: string;
  /** Sends one overlay message on the session to the node. */
  readonly send: (topic: string, payload: Uint8Array) => void;
  /** Called with each new heaviest checked block. */
  readonly onTip?: (tip: FollowedBlock) => void;
  /** Called with a header that failed its check, and why. */
  readonly onRejected?: (cid: string, reason: string) => void;
  /** How many checked blocks to keep, newest first. */
  readonly keep?: number;
}

/**
 * Follows one chain over an authenticated overlay session to a Lattice
 * node, the way a node's own sync does but holding no history: it asks for
 * the node's log tail, is pushed what the node weighs next, fetches each
 * header, and reports the heaviest one whose bytes hash to its CID and whose
 * proof of work (a child chain's: its `ChildBlockProof`) verifies.
 *
 * The assurance is work, not validity: it does not execute blocks or check
 * a block's target against its chain's schedule.
 */
export class ChainFollower {
  readonly chainPath: readonly string[];
  private readonly path: string;
  private readonly options: ChainFollowerOptions;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private nextRequestID = 1;
  private logID: string | undefined;
  private after = 0n;
  private readonly asked = new Set<string>();
  private readonly blocks = new Map<string, FollowedBlock>();
  private readonly waiting = new Map<string, { block: string; proofs: string[] }[]>();
  private heaviest: FollowedBlock | undefined;
  /** Capabilities the node's hello named. */
  capabilities: readonly string[] = [];

  constructor(options: ChainFollowerOptions) {
    this.options = options;
    this.chainPath = options.chainPath;
    this.path = options.chainPath.join("/");
  }

  get tip(): FollowedBlock | undefined {
    return this.heaviest;
  }

  /** Call once the session is open: sends this peer's hello. */
  open() {
    this.send(Topic.hello, {
      chainPath: ["Nexus"],
      nexusGenesisCID: this.options.nexusGenesisCID,
      version: PROTOCOL_VERSION,
    });
  }

  /** Hand every message the session delivers here. */
  deliver(topic: string, payload: Uint8Array) {
    let body: { [key: string]: unknown };
    try {
      body = JSON.parse(this.decoder.decode(payload)) as { [key: string]: unknown };
    } catch {
      return;
    }
    switch (topic) {
      case Topic.hello:
        if (
          body.version !== PROTOCOL_VERSION ||
          body.nexusGenesisCID !== this.options.nexusGenesisCID
        ) {
          throw new Error("the node is on another network");
        }
        this.capabilities = Array.isArray(body.capabilities) ? (body.capabilities as string[]) : [];
        this.askStream(this.capabilities.includes(STREAM_TAIL) ? TAIL : 0n);
        return;
      case Topic.streamRequest:
        // The node reads this peer's log too; it runs none, so it is empty.
        this.send(Topic.streamPage, {
          chainPath: body.chainPath as string[],
          entries: [],
          hasMore: false,
          logID: "",
          requestID: body.requestID as number,
        });
        return;
      case Topic.streamPage:
        if ((body.chainPath as string[]).join("/") === this.path) this.page(body);
        return;
      case Topic.headersResponse:
        if ((body.chainPath as string[]).join("/") === this.path) this.headers(body);
        return;
    }
  }

  private send(topic: string, value: Json) {
    this.options.send(topic, this.encoder.encode(canonicalJSON(value)));
  }

  private askStream(after: bigint) {
    this.send(Topic.streamRequest, {
      after,
      chainPath: this.chainPath,
      logID: this.logID,
      own: "",
      requestID: this.nextRequestID++,
    });
  }

  private page(body: { [key: string]: unknown }) {
    const entries = body.entries as { position: number; block: string }[];
    if (body.requestID !== 0) this.logID = body.logID as string;
    if (body.logID !== this.logID) return;
    const last = entries.at(-1);
    if (last !== undefined) this.after = BigInt(last.position);
    // Paging the whole log is what a node without the tail can offer: only
    // its last page is worth fetching.
    if (body.requestID !== 0 && body.hasMore === true) {
      this.askStream(this.after);
      return;
    }
    const wanted = [...new Set(entries.map((entry) => entry.block))].filter(
      (cid) => !this.asked.has(cid) && !this.blocks.has(cid),
    );
    this.fetch(body.requestID === 0 ? wanted : wanted.slice(-1));
  }

  private fetch(cids: readonly string[]) {
    if (cids.length === 0) return;
    for (const cid of cids) this.asked.add(cid);
    this.send(Topic.dataRequest, {
      chainPath: this.chainPath,
      cids,
      requestID: this.nextRequestID++,
    });
  }

  private headers(body: { [key: string]: unknown }) {
    const entries = body.entries as { block: string; proofs: string[] }[];
    // An ancestors answer runs child to parent: take parents first.
    for (const entry of [...entries].reverse()) this.take(entry);
  }

  private take(entry: { block: string; proofs: string[] }) {
    let bytes: Uint8Array;
    try {
      bytes = base64(entry.block);
    } catch {
      return;
    }
    const cid = cidV1DagCbor(bytes);
    this.asked.delete(cid);
    if (this.blocks.has(cid)) return;
    const block = decodeLatticeBlock(bytes);
    if (block === undefined) return this.options.onRejected?.(cid, "not a block");
    const work = this.work(block, bytes, entry.proofs);
    if (work === undefined)
      return this.options.onRejected?.(cid, "its proof of work does not verify");
    const parent = block.parentCID === undefined ? undefined : this.blocks.get(block.parentCID);
    if (parent !== undefined && parent.block.height + 1n !== block.height) {
      return this.options.onRejected?.(cid, "its height does not follow its parent's");
    }
    if (parent === undefined && this.heaviest !== undefined && block.parentCID !== undefined) {
      // A block on a branch this follower has not seen: it waits while its
      // ancestors are fetched back to one the follower has.
      const waiting = this.waiting.get(block.parentCID) ?? [];
      if (waiting.length === 0) {
        this.send(Topic.ancestorsRequest, {
          chainPath: this.chainPath,
          cid: block.parentCID,
          maximum: 64,
          requestID: this.nextRequestID++,
        });
      }
      if (this.waiting.size < 256) this.waiting.set(block.parentCID, [...waiting, entry]);
      return;
    }
    const followed: FollowedBlock = {
      cid,
      block,
      work,
      cumulativeWork: (parent?.cumulativeWork ?? 0n) + work,
    };
    this.blocks.set(cid, followed);
    this.prune();
    if (this.heaviest === undefined || followed.cumulativeWork > this.heaviest.cumulativeWork) {
      this.heaviest = followed;
      this.options.onTip?.(followed);
    }
    const children = this.waiting.get(cid);
    this.waiting.delete(cid);
    for (const child of children ?? []) this.take(child);
  }

  /** The work `block`'s proof shows, or undefined when it shows none. */
  private work(
    block: CanonicalBlock,
    bytes: Uint8Array,
    proofs: readonly string[],
  ): bigint | undefined {
    if (this.chainPath.length === 1) {
      return verifyNexusBlockProofOfWork(block) ? workForTarget(block.target) : undefined;
    }
    let best: bigint | undefined;
    for (const encoded of proofs) {
      let proof;
      try {
        proof = decodeChildBlockProof(base64(encoded));
      } catch {
        continue;
      }
      if (proof === undefined) continue;
      const result = verifyChildBlockProof(proof, bytes, this.chainPath);
      if (
        result.ok &&
        result.evidence.work !== undefined &&
        (best === undefined || result.evidence.work > best)
      ) {
        best = result.evidence.work;
      }
    }
    return best;
  }

  private prune() {
    const keep = this.options.keep ?? 4096;
    if (this.blocks.size <= keep + 256) return;
    const oldest = [...this.blocks.values()].sort((a, b) =>
      a.block.height < b.block.height ? -1 : 1,
    );
    for (const followed of oldest.slice(0, this.blocks.size - keep))
      this.blocks.delete(followed.cid);
  }
}
