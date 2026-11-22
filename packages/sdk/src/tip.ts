import { NodeClient } from "@adalin/lattice-client";
import {
  assertBlockContinuity,
  decodeCanonicalBlock,
  decodeLatticeBlock,
  verifyNexusBlockProofOfWork,
  workForTarget,
  type CanonicalBlock,
} from "@adalin/lattice-core";
import { type VerifiedVolume, VolumeClient } from "@adalin/lattice-volumes";

/**
 * Why no tip was read: `unanchored`, a tip that does not link back to the
 * app's `genesis` (or `checkpoint`) by the header rules; `tooFar`, a tip
 * more than `maxHeaders` blocks (or their byte budget) past the newest
 * block already linked; `disagree`, fewer than `minAgree` sources hold any
 * one tip.
 */
export type ReadFailure = "unanchored" | "tooFar" | "disagree";

export class ReadError extends Error {
  readonly code: ReadFailure;

  constructor(code: ReadFailure, detail: string, cause?: unknown) {
    const plain = {
      unanchored: "unanchored tip",
      tooFar: "tip too far",
      disagree: "sources disagree",
    };
    super(`${plain[code]}: ${detail}`, { cause });
    this.name = "ReadError";
    this.code = code;
  }
}

/** One block's Volume, at most, in a walk: a block and its children index. */
export const HEADER_VOLUME_BYTES = 32 * 1024;
/** What a walk may fetch, on average, per block it may walk. */
export const HEADER_BUDGET_BYTES = 4 * 1024;
/** Rows of one page of the chain fetched ahead of a walk. */
const PAGE = 25;
/** How far past this device's clock a block's timestamp may be (Bitcoin's 2 hours). */
const FUTURE_MILLISECONDS = 2 * 60 * 60 * 1000;

/** A node to read from. */
export interface Source {
  readonly node: NodeClient;
  readonly volumes: VolumeClient;
  /** Its Volumes for walks: each held to `HEADER_VOLUME_BYTES`, fetched in batches. */
  readonly headers: VolumeClient;
}

/** The tip reads are taken at: its block, and the source that served it. */
export interface Tip {
  readonly cid: string;
  readonly block: CanonicalBlock;
  /** The source whose Volumes linked it, first, then every other that holds it. */
  readonly holders: readonly Source[];
}

/** Blocks remembered as linked, at most; the least recently used goes first. */
const LINKED = 64;

/** A block this page already linked to the trust root, and the work above the root through it. */
interface Linked {
  readonly height: bigint;
  readonly work: bigint;
}

export interface TipOptions {
  /** Distinct nodes: two URLs of one operator still count as two. */
  readonly sources: readonly Source[];
  readonly chainPath: readonly string[];
  /** The block reads must descend from: the app's checkpoint, or its genesis. */
  readonly root?: string;
  readonly maxHeaders: number;
  /** Sources that must hold a tip before it is read. */
  readonly minAgree: number;
  readonly now?: () => number;
}

function decoded(volume: VerifiedVolume, cid: string): CanonicalBlock {
  const block = decodeLatticeBlock(volume.rootBytes());
  if (block === undefined) throw new ReadError("unanchored", `${cid} is not a Lattice block`);
  return block;
}

const size = (volume: VerifiedVolume) =>
  volume.entries().reduce((total, entry) => total + entry.bytes.length, 0);

/**
 * Chooses the tip to read at, as the SDK's README states:
 *
 * - A tip is read only once `minAgree` sources hold it: name it as their
 *   tip, or have it at its height on their chain.
 * - With a trust `root`, a tip is walked back block by block until it meets
 *   the root or a block this page already linked (kept in memory only):
 *   each link is checked (parent CID, height, prevState = parent's
 *   postState, same spec, later timestamp no more than 2 hours ahead of this
 *   device, target no easier than the parent's nextTarget) and, on Nexus,
 *   each block's proof of work. A walk past `maxHeaders` blocks, or
 *   `maxHeaders × HEADER_BUDGET_BYTES` bytes, fails `tooFar`.
 * - Of the tips that agree and link, the heaviest is read: the sum of
 *   `workForTarget` of each block's stated target above the root (verified
 *   proof of work only on Nexus), or the highest without a root; equal ones
 *   break by smaller CID.
 */
export function tipChooser(options: TipOptions) {
  const { sources, chainPath, root, maxHeaders, minAgree } = options;
  const now = options.now ?? Date.now;
  const isNexus = chainPath.length === 1;
  /** Blocks linked to the root on this page, by CID: never persisted, so never planted. */
  const linked = new Map<string, Linked>();
  const remember = (cid: string, entry: Linked) => {
    linked.delete(cid);
    linked.set(cid, entry);
    for (const oldest of linked.keys()) {
      if (linked.size <= LINKED) break;
      linked.delete(oldest);
    }
  };
  let rootHeight: bigint | undefined;

  /** The block at `tip` and the work above the root through it; throws when they do not link. */
  async function walk(source: Source, tip: string, signal?: AbortSignal) {
    if (rootHeight === undefined) {
      rootHeight = decoded(await source.headers.get(root!, signal), root!).height;
    }
    let budget = maxHeaders * HEADER_BUDGET_BYTES;
    const spend = (volume: VerifiedVolume) => {
      budget -= size(volume);
      return volume;
    };
    const fetched = new Map<string, Promise<VerifiedVolume>>();
    /** The lowest height the last page listed; a page missed stops paging. */
    let paged: bigint | undefined;
    let paging = true;
    /** Fetches the next page of the source's chain below `height`, while pages hit. */
    const prefetch = async (height: bigint) => {
      let floor = rootHeight!;
      for (const known of linked.values()) {
        if (known.height < height && known.height > floor) floor = known.height;
      }
      const limit = Number(height - floor < BigInt(PAGE) ? height - floor : BigInt(PAGE));
      if (limit < 2) return;
      const page = await source.node.blocks({ before: height, limit }, signal);
      paged = page.blocks.at(-1)?.height ?? height;
      for (const row of page.blocks) {
        if (fetched.has(row.hash)) continue;
        const volume = source.headers.get(row.hash, signal).then(spend);
        volume.catch(() => {}); // A row off this walk's chain is never awaited.
        fetched.set(row.hash, volume);
      }
    };

    let cid = tip;
    let child: { cid: string; block: CanonicalBlock } | undefined;
    let first: CanonicalBlock | undefined;
    let work = 0n;
    for (let steps = 0; ; steps++) {
      if (child !== undefined && !fetched.has(cid) && paging) {
        // A page that listed this height without this block was the
        // source's chain, not this tip's: fetch one at a time from here.
        if (paged !== undefined && child.block.height - 1n >= paged) paging = false;
        else await prefetch(child.block.height);
      }
      const block = decoded(
        await (fetched.get(cid) ?? source.headers.get(cid, signal).then(spend)),
        cid,
      );
      if (budget < 0) {
        throw new ReadError(
          "tooFar",
          `walking ${tip} took more than ${maxHeaders * HEADER_BUDGET_BYTES} bytes`,
        );
      }
      first ??= block;
      if (block.timestamp > BigInt(now() + FUTURE_MILLISECONDS)) {
        throw new ReadError("unanchored", `${cid} is stamped more than 2 hours ahead`);
      }
      if (child !== undefined) {
        const next = child.block;
        try {
          assertBlockContinuity(cid, block, next);
        } catch (error) {
          throw new ReadError("unanchored", `${child.cid}: ${(error as Error).message}`, error);
        }
        if (next.specCID !== block.specCID) {
          throw new ReadError("unanchored", `${child.cid} changes the chain's spec`);
        }
        if (next.timestamp <= block.timestamp) {
          throw new ReadError("unanchored", `${child.cid} is not later than its parent`);
        }
        if (BigInt(next.target) > BigInt(block.nextTarget)) {
          throw new ReadError("unanchored", `${child.cid} has an easier target than scheduled`);
        }
      }
      if (cid === root) return { block: first, work };
      const known = linked.get(cid);
      if (known !== undefined) {
        remember(cid, known);
        return { block: first, work: work + known.work };
      }
      if (block.height <= rootHeight || block.parentCID === undefined) {
        throw new ReadError("unanchored", `${cid} does not descend from ${root}`);
      }
      if (isNexus && !verifyNexusBlockProofOfWork(block)) {
        throw new ReadError("unanchored", `${cid} does not meet its proof-of-work target`);
      }
      if (steps >= maxHeaders) {
        throw new ReadError(
          "tooFar",
          `more than ${maxHeaders} blocks from ${root}; ship a newer checkpoint, or raise maxHeaders`,
        );
      }
      work += workForTarget(block.target);
      child = { cid, block };
      cid = block.parentCID;
    }
  }

  /** Whether `source`'s chain holds `cid` at `height`. */
  async function holds(source: Source, cid: string, height: bigint, signal?: AbortSignal) {
    try {
      return (await source.node.block(height, signal)).hash === cid;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }

  /** The block at `cid` and its weight, read through each of `holders` until one answers. */
  async function weigh(cid: string, holders: readonly Source[], signal?: AbortSignal) {
    let failure: unknown;
    for (const [index, source] of holders.entries()) {
      // The holder that answers is read from first, the rest after it.
      const order = [source, ...holders.filter((_, other) => other !== index)];
      try {
        if (root !== undefined) return { holders: order, ...(await walk(source, cid, signal)) };
        const block = decodeCanonicalBlock((await source.volumes.get(cid, signal)).rootBytes());
        if (isNexus && block.height > 0n && !verifyNexusBlockProofOfWork(block)) {
          throw new ReadError("unanchored", `${cid} does not meet its proof-of-work target`);
        }
        return { holders: order, block, work: block.height };
      } catch (error) {
        // A tip that does not link fails alike through every holder; one
        // holder's unreachable, slow or oversized answers do not.
        if (error instanceof ReadError && error.code === "unanchored") throw error;
        signal?.throwIfAborted();
        failure = error;
      }
    }
    throw failure;
  }

  return async function choose(signal?: AbortSignal): Promise<Tip> {
    const answers = await Promise.allSettled(
      sources.map((source) => source.node.latestBlock(signal)),
    );
    signal?.throwIfAborted();
    const answered = sources.filter((_, index) => answers[index]!.status === "fulfilled");
    if (answered.length === 0) throw (answers[0] as PromiseRejectedResult).reason;
    const named = new Map<string, { height: bigint; holders: Source[] }>();
    answers.forEach((answer, index) => {
      if (answer.status !== "fulfilled") return;
      const entry = named.get(answer.value.hash) ?? { height: answer.value.height, holders: [] };
      entry.holders.push(sources[index]!);
      named.set(answer.value.hash, entry);
    });

    let best: (Tip & { work: bigint }) | undefined;
    let failure: unknown;
    for (const [cid, { height, holders }] of named) {
      for (const other of answered) {
        if (holders.length >= minAgree) break;
        if (!holders.includes(other) && (await holds(other, cid, height, signal))) {
          holders.push(other);
        }
      }
      if (holders.length < minAgree) continue;
      try {
        const weighed = await weigh(cid, holders, signal);
        if (
          best === undefined ||
          weighed.work > best.work ||
          (weighed.work === best.work && cid < best.cid)
        ) {
          best = { cid, ...weighed };
        }
      } catch (error) {
        signal?.throwIfAborted();
        failure = error;
      }
    }
    if (best === undefined) {
      throw (
        failure ??
        new ReadError(
          "disagree",
          `${answered.length} of ${sources.length} sources answered and no tip is held by ${minAgree}`,
        )
      );
    }
    if (root !== undefined) remember(best.cid, { height: best.block.height, work: best.work });
    return best;
  };
}
