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
  /**
   * Its work plus its ancestors' from one fixed block of this follower's:
   * comparable between this follower's blocks only.
   */
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
interface Entry {
  readonly block: string;
  readonly proofs: readonly string[];
}

const isRecord = (value: unknown): value is { [key: string]: unknown } =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

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
  private readonly waiting = new Map<string, Entry[]>();
  /** Open ancestors requests: their id, and the parent each asked for. */
  private readonly ancestorRequests = new Map<number, string>();
  /** The request for the first block's own ancestors, while open. */
  private baseRequest: number | undefined;
  /** Ancestors answers that came before the first block's own. */
  private early: { asked: string; entries: readonly Entry[] }[] = [];
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
    let body: unknown;
    try {
      body = JSON.parse(this.decoder.decode(payload));
    } catch {
      return;
    }
    // A node's message is untrusted: one that is not the shape it should
    // be is ignored, never thrown.
    if (!isRecord(body) || !isStrings(body.chainPath)) return;
    switch (topic) {
      case Topic.hello:
        if (
          body.version !== PROTOCOL_VERSION ||
          body.nexusGenesisCID !== this.options.nexusGenesisCID
        ) {
          throw new Error("the node is on another network");
        }
        this.capabilities = isStrings(body.capabilities) ? body.capabilities : [];
        this.askStream(this.capabilities.includes(STREAM_TAIL) ? TAIL : 0n);
        return;
      case Topic.streamRequest:
        // The node reads this peer's log too; it runs none, so it is empty.
        if (!Number.isSafeInteger(body.requestID)) return;
        this.send(Topic.streamPage, {
          chainPath: body.chainPath,
          entries: [],
          hasMore: false,
          logID: "",
          requestID: body.requestID as number,
        });
        return;
      case Topic.streamPage:
        if (body.chainPath.join("/") === this.path) this.page(body);
        return;
      case Topic.headersResponse:
        if (body.chainPath.join("/") === this.path) this.headers(body);
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
    const entries = body.entries;
    if (
      !Array.isArray(entries) ||
      typeof body.logID !== "string" ||
      !entries.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.block === "string" &&
          Number.isSafeInteger(entry.position),
      )
    ) {
      return;
    }
    if (body.requestID !== 0) this.logID = body.logID;
    if (body.logID !== this.logID) return;
    const last = entries.at(-1);
    if (last !== undefined) this.after = BigInt(last.position);
    // Paging the whole log is what a node without the tail can offer: only
    // its last page is worth fetching.
    if (body.requestID !== 0 && body.hasMore === true) {
      this.askStream(this.after);
      return;
    }
    const wanted = [...new Set(entries.map((entry) => entry.block as string))].filter(
      (cid) => !this.asked.has(cid) && !this.blocks.has(cid),
    );
    this.fetch(body.requestID === 0 ? wanted : wanted.slice(-1));
  }

  private fetch(cids: readonly string[]) {
    if (cids.length === 0) return;
    // What is asked is only a hint against asking twice: kept bounded.
    if (this.asked.size > 4096) this.asked.clear();
    for (const cid of cids) this.asked.add(cid);
    this.send(Topic.dataRequest, {
      chainPath: this.chainPath,
      cids,
      requestID: this.nextRequestID++,
    });
  }

  private headers(body: { [key: string]: unknown }) {
    const entries = body.entries;
    if (
      !Array.isArray(entries) ||
      !entries.every(
        (entry) => isRecord(entry) && typeof entry.block === "string" && isStrings(entry.proofs),
      )
    ) {
      return;
    }
    const requestID = body.requestID;
    if (requestID !== undefined && requestID === this.baseRequest) {
      this.baseRequest = undefined;
      this.extendDown(entries as Entry[]);
      const early = this.early;
      this.early = [];
      for (const answer of early) {
        for (const entry of [...answer.entries].reverse()) this.take(entry, true);
        if (!this.blocks.has(answer.asked)) this.waiting.delete(answer.asked);
      }
      return;
    }
    const asked = typeof requestID === "number" ? this.ancestorRequests.get(requestID) : undefined;
    if (asked === undefined) {
      for (const entry of entries as Entry[]) this.take(entry, false);
      return;
    }
    this.ancestorRequests.delete(requestID as number);
    // An ancestors answer runs child to parent: take parents first. Only a
    // branch that reaches a block this follower holds is taken.
    for (const entry of [...(entries as Entry[])].reverse()) this.take(entry, true);
    if (this.blocks.has(asked)) return;
    // A branch that did not connect is let go, unless the first block's own
    // ancestors, which it may connect through, are still on their way: then
    // its answer is taken again once they are in.
    if (this.baseRequest !== undefined && this.early.length < 16) {
      this.early.push({ asked, entries: (entries as Entry[]).slice(0, 64) });
    } else {
      this.waiting.delete(asked);
    }
  }

  /**
   * Takes one header. Work is counted only along blocks that connect to
   * ones this follower holds, so every branch is weighed from the same
   * place: the first block it took. A block whose parent it does not hold
   * waits while that parent's ancestors are fetched; an ancestor that
   * does not connect either is dropped.
   */
  private take(entry: Entry, fromAncestors: boolean) {
    const checked = this.check(entry);
    if (checked === undefined) return;
    const { cid, block, work } = checked;
    const parent = block.parentCID === undefined ? undefined : this.blocks.get(block.parentCID);
    if (parent !== undefined && parent.block.height + 1n !== block.height) {
      return this.options.onRejected?.(cid, "its height does not follow its parent's");
    }
    if (parent === undefined && this.heaviest !== undefined) {
      if (fromAncestors || block.parentCID === undefined) return;
      const waiting = this.waiting.get(block.parentCID);
      if (waiting === undefined) {
        // Branches whose ancestors never came are forgotten, not kept.
        if (this.waiting.size >= 256) {
          this.waiting.clear();
          this.ancestorRequests.clear();
        }
        const requestID = this.nextRequestID++;
        this.ancestorRequests.set(requestID, block.parentCID);
        this.waiting.set(block.parentCID, [entry]);
        this.send(Topic.ancestorsRequest, {
          chainPath: this.chainPath,
          cid: block.parentCID,
          maximum: 64,
          requestID,
        });
      } else if (waiting.length < 16) {
        waiting.push(entry);
      }
      return;
    }
    const followed: FollowedBlock = {
      cid,
      block,
      work,
      cumulativeWork: (parent?.cumulativeWork ?? 0n) + work,
    };
    const first = this.heaviest === undefined;
    this.blocks.set(cid, followed);
    this.prune();
    // Heavier wins; equal work goes to the smaller CID, as in Lattice.
    if (
      this.heaviest === undefined ||
      followed.cumulativeWork > this.heaviest.cumulativeWork ||
      (followed.cumulativeWork === this.heaviest.cumulativeWork && cid < this.heaviest.cid)
    ) {
      this.heaviest = followed;
      this.options.onTip?.(followed);
    }
    if (first && block.parentCID !== undefined) {
      // The first block's own ancestors, so a fork from just below it (a
      // reorg of the tip) still connects.
      this.baseRequest = this.nextRequestID++;
      this.send(Topic.ancestorsRequest, {
        chainPath: this.chainPath,
        cid: block.parentCID,
        maximum: 64,
        requestID: this.baseRequest,
      });
    }
    this.retakeWaiting(cid);
  }

  private retakeWaiting(cid: string) {
    const children = this.waiting.get(cid);
    this.waiting.delete(cid);
    for (const child of children ?? []) this.take(child, false);
  }

  /**
   * The first block's ancestors, child to parent: each held below the one
   * it is the parent of, its total that block's less that block's own work,
   * so every branch is still weighed from one place.
   */
  private extendDown(entries: readonly Entry[]) {
    let lowest = [...this.blocks.values()].reduce<FollowedBlock | undefined>(
      (low, followed) =>
        low === undefined || followed.block.height < low.block.height ? followed : low,
      undefined,
    );
    for (const entry of entries) {
      if (lowest === undefined) return;
      const checked = this.check(entry);
      if (
        checked === undefined ||
        checked.cid !== lowest.block.parentCID ||
        checked.block.height + 1n !== lowest.block.height
      ) {
        return;
      }
      const followed: FollowedBlock = {
        ...checked,
        cumulativeWork: lowest.cumulativeWork - lowest.work,
      };
      this.blocks.set(checked.cid, followed);
      lowest = followed;
      this.retakeWaiting(checked.cid);
    }
  }

  /** One header's CID, block and proven work; undefined if it shows none. */
  private check(entry: Entry): { cid: string; block: CanonicalBlock; work: bigint } | undefined {
    let bytes: Uint8Array;
    try {
      bytes = base64(entry.block);
    } catch {
      return undefined;
    }
    const cid = cidV1DagCbor(bytes);
    this.asked.delete(cid);
    if (this.blocks.has(cid)) return undefined;
    const block = decodeLatticeBlock(bytes);
    if (block === undefined) {
      this.options.onRejected?.(cid, "not a block");
      return undefined;
    }
    const work = this.work(block, bytes, entry.proofs);
    if (work === undefined) {
      this.options.onRejected?.(cid, "its proof of work does not verify");
      return undefined;
    }
    return { cid, block, work };
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
      let result;
      try {
        result = verifyChildBlockProof(proof, bytes, this.chainPath);
      } catch {
        continue;
      }
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
    // The lightest go first: old blocks and cheap branches, never the tip.
    const lightest = [...this.blocks.values()].sort((a, b) =>
      a.cumulativeWork < b.cumulativeWork ? -1 : a.cumulativeWork > b.cumulativeWork ? 1 : 0,
    );
    for (const followed of lightest.slice(0, this.blocks.size - keep))
      this.blocks.delete(followed.cid);
  }
}

/** A peer's Ivy route: its public key (lower-case hex) and where it listens. */
export interface PeerEndpoint {
  readonly publicKey: string;
  readonly host: string;
  readonly port: number;
}

/**
 * A provider found on the DHT and the web addresses its record carries.
 * Without `via` it listens at `url`; with it, it is reached by connecting
 * to peer `via` at `url` and relaying through that peer.
 */
export interface DiscoveredProvider extends PeerEndpoint {
  readonly webAddresses: readonly { readonly url: string; readonly via?: string }[];
}

/** A dialed stream, and the host its peer was observed at. */
export interface ChainHostTransport {
  readonly observedHost: string;
}

/** What `connectToChainHost` uses of an Ivy node (Ivy's TypeScript shell). */
export interface ChainHostIvy<T extends ChainHostTransport> {
  readonly connectedPeers: readonly string[];
  discoverProviders(
    rootCID: string,
    options?: { signal?: AbortSignal },
  ): Promise<readonly DiscoveredProvider[]>;
  connect(endpoint: PeerEndpoint, over: T, options?: { signal?: AbortSignal }): Promise<void>;
  setRelaying(peer: string, relays: boolean): void;
  connectViaRelay(endpoint: PeerEndpoint, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface ConnectToChainHostOptions<T extends ChainHostTransport> {
  readonly ivy: ChainHostIvy<NoInfer<T>>;
  /** Opens a stream to a `ws://` or `wss://` URL (Ivy's `connectWebSocket`). */
  readonly connectWebSocket: (url: string) => Promise<T>;
  readonly nexusGenesisCID: string;
  readonly chainPath: readonly string[];
  readonly signal?: AbortSignal;
}

/** The most streams `connectToChainHost` opens before giving up. */
const MAX_DIALS = 8;

/**
 * The DHT key a chain's hosts provide under, or undefined for Nexus, which
 * every node hosts.
 */
export function chainPeersKey(
  nexusGenesisCID: string,
  chainPath: readonly string[],
): string | undefined {
  if (chainPath.length <= 1) return undefined;
  return `lattice.chain-peers.v1:${nexusGenesisCID}:${chainPath.join("/")}`;
}

/**
 * Connects to a node hosting `chainPath` and returns its public key, or
 * undefined if none was reached. Nexus: any connected peer (every node
 * hosts it). A child: a provider already connected, else each provider's
 * direct addresses, then its relayed ones, at most eight dials in all.
 * The session's handshake proves the key, so an address claiming another
 * node's key fails and the next is tried.
 */
export async function connectToChainHost<T extends ChainHostTransport>(
  options: ConnectToChainHostOptions<T>,
): Promise<string | undefined> {
  const { ivy, connectWebSocket, signal } = options;
  const request = signal ? { signal } : {};
  const key = chainPeersKey(options.nexusGenesisCID, options.chainPath);
  if (key === undefined) return ivy.connectedPeers[0];
  const providers = await ivy.discoverProviders(key, request);
  signal?.throwIfAborted();
  const connected = providers.find((provider) => ivy.connectedPeers.includes(provider.publicKey));
  if (connected) return connected.publicKey;

  let dials = 0;
  const dial = async (publicKey: string, url: string): Promise<boolean> => {
    if (dials >= MAX_DIALS) return false;
    dials += 1;
    try {
      const parsed = new URL(url);
      const port = Number(parsed.port) || (parsed.protocol === "wss:" ? 443 : 80);
      const transport = await connectWebSocket(url);
      signal?.throwIfAborted();
      await ivy.connect({ publicKey, host: transport.observedHost, port }, transport, request);
      return true;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  };

  for (const provider of providers) {
    const endpoint = { publicKey: provider.publicKey, host: provider.host, port: provider.port };
    for (const address of provider.webAddresses) {
      if (address.via === undefined && (await dial(provider.publicKey, address.url))) {
        return provider.publicKey;
      }
    }
    for (const { url, via } of provider.webAddresses) {
      if (via === undefined) continue;
      if (!ivy.connectedPeers.includes(via) && !(await dial(via, url))) continue;
      ivy.setRelaying(via, true);
      try {
        await ivy.connectViaRelay(endpoint, request);
        return provider.publicKey;
      } catch {
        signal?.throwIfAborted();
      }
    }
  }
  return undefined;
}
