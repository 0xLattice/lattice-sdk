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
 * more than `maxHeaders` blocks past the newest block already linked;
 * `disagree`, several sources answered and no two of them hold one tip.
 */
export type ReadFailure = "unanchored" | "tooFar" | "disagree";

export class ReadError extends Error {
  readonly code: ReadFailure;

  constructor(code: ReadFailure, detail: string, cause?: unknown) {
    super(
      `${{ unanchored: "unanchored tip", tooFar: "tip too far", disagree: "sources disagree" }[code]}: ${detail}`,
      { cause },
    );
    this.name = "ReadError";
    this.code = code;
  }
}

/** A node to read from: its JSON reads, its Volumes, and its Volumes in pages. */
export interface Source {
  readonly node: NodeClient;
  readonly volumes: VolumeClient;
  /** The same Volumes, batched: for walks that fetch many blocks at once. */
  readonly pages: VolumeClient;
}

/** The tip reads are taken at: its block, and the source that served it. */
export interface Tip {
  readonly cid: string;
  readonly block: CanonicalBlock;
  readonly source: Source;
}

/** A block already linked to the trust root: memoized, so a walk can stop at it. */
interface Linked {
  readonly cid: string;
  readonly height: bigint;
  /** Work of the blocks above the trust root, through this one. */
  readonly work: bigint;
}

/** Blocks remembered as linked, newest kept. */
const KEPT = 16;

export interface TipOptions {
  readonly sources: readonly Source[];
  readonly chainPath: readonly string[];
  /** The block reads must descend from: the app's checkpoint, or its genesis. */
  readonly root?: string;
  readonly maxHeaders: number;
  /** Where linked blocks are kept between visits; `localStorage` when it can. */
  readonly storageKey: string;
}

function decoded(volume: VerifiedVolume, cid: string): CanonicalBlock {
  const block = decodeLatticeBlock(volume.rootBytes());
  if (block === undefined) throw new ReadError("unanchored", `${cid} is not a Lattice block`);
  return block;
}

/**
 * Chooses the tip to read at, as the SDK's README states:
 *
 * - With a trust `root`, every tip is walked back block by block until it
 *   meets the root or a block already linked to it: each link is checked
 *   (parent CID, height, prevState = parent's postState, same spec, later
 *   timestamp, target no easier than the parent's nextTarget) and, on
 *   Nexus, each block's proof of work. A walk past `maxHeaders` fails
 *   `tooFar`.
 * - With more than one source answering, a tip counts only once a second
 *   source holds it on its own chain (names it, or has it at that height).
 *   Of the tips that count, the heaviest is read (most work above the root,
 *   or the highest without a root); equal ones break by smaller CID.
 */
export function tipChooser(options: TipOptions) {
  const { sources, chainPath, root, maxHeaders, storageKey } = options;
  const isNexus = chainPath.length === 1;
  let linked: Linked[] = load();
  let rootHeight: bigint | undefined;

  function load(): Linked[] {
    try {
      const kept = JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? "[]") as unknown;
      if (!Array.isArray(kept)) return [];
      return kept.flatMap((entry: { cid?: unknown; height?: unknown; work?: unknown }) =>
        typeof entry?.cid === "string" &&
        typeof entry.height === "string" &&
        typeof entry.work === "string" &&
        /^\d+$/.test(entry.height) &&
        /^\d+$/.test(entry.work)
          ? [{ cid: entry.cid, height: BigInt(entry.height), work: BigInt(entry.work) }]
          : [],
      );
    } catch {
      return [];
    }
  }

  function keep(entry: Linked) {
    linked = [entry, ...linked.filter((known) => known.cid !== entry.cid)].slice(0, KEPT);
    try {
      globalThis.localStorage?.setItem(
        storageKey,
        JSON.stringify(
          linked.map((known) => ({
            cid: known.cid,
            height: known.height.toString(),
            work: known.work.toString(),
          })),
        ),
      );
    } catch {
      // No storage: linked blocks are remembered for this page only.
    }
  }

  /** The work above `root` of the blocks from `cid` down to it; throws when they do not link. */
  async function walk(source: Source, cid: string, signal?: AbortSignal) {
    if (rootHeight === undefined) {
      rootHeight = decoded(await source.volumes.get(root!, signal), root!).height;
    }
    const fetched = new Map<string, Promise<VerifiedVolume>>();
    /** Starts fetching the next page of the source's chain below `height`. */
    const prefetch = async (height: bigint) => {
      const floor = linked.reduce(
        (best, known) => (known.height < height && known.height > best ? known.height : best),
        rootHeight!,
      );
      const limit = Number(height - floor < 25n ? height - floor : 25n);
      if (limit < 2) return;
      const page = await source.node.blocks({ before: height, limit }, signal);
      for (const row of page.blocks) {
        if (fetched.has(row.hash)) continue;
        const volume = source.pages.get(row.hash, signal);
        volume.catch(() => {}); // A row off this walk's chain is never awaited.
        fetched.set(row.hash, volume);
      }
    };

    let child: { cid: string; block: CanonicalBlock } | undefined;
    let work = 0n;
    let tip: CanonicalBlock | undefined;
    for (let steps = 0; ; steps++) {
      if (child !== undefined && !fetched.has(cid)) await prefetch(child.block.height);
      const block = decoded(await (fetched.get(cid) ?? source.volumes.get(cid, signal)), cid);
      tip ??= block;
      if (child !== undefined) {
        const parent = block;
        const next = child.block;
        try {
          assertBlockContinuity(cid, parent, next);
        } catch (error) {
          throw new ReadError("unanchored", `${child.cid}: ${(error as Error).message}`, error);
        }
        if (next.specCID !== parent.specCID) {
          throw new ReadError("unanchored", `${child.cid} changes the chain's spec`);
        }
        if (next.timestamp <= parent.timestamp) {
          throw new ReadError("unanchored", `${child.cid} is not later than its parent`);
        }
        if (BigInt(next.target) > BigInt(parent.nextTarget)) {
          throw new ReadError("unanchored", `${child.cid} has an easier target than scheduled`);
        }
      }
      if (cid === root) return { block: tip, work };
      const known = linked.find((entry) => entry.cid === cid);
      if (known !== undefined) return { block: tip, work: work + known.work };
      if (block.height <= rootHeight || block.parentCID === undefined) {
        throw new ReadError("unanchored", `${cid} does not descend from ${root}`);
      }
      if (isNexus && !verifyNexusBlockProofOfWork(block)) {
        throw new ReadError("unanchored", `${cid} does not meet its proof-of-work target`);
      }
      if (steps >= maxHeaders) {
        throw new ReadError(
          "tooFar",
          `more than ${maxHeaders} blocks from the newest block linked to ${root}; pin a newer checkpoint, or raise maxHeaders`,
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
    } catch (error) {
      signal?.throwIfAborted();
      return false;
    }
  }

  return async function choose(signal?: AbortSignal): Promise<Tip> {
    const answers = await Promise.allSettled(
      sources.map((source) => source.node.latestBlock(signal)),
    );
    const named = new Map<string, { height: bigint; by: Source[] }>();
    answers.forEach((answer, index) => {
      if (answer.status !== "fulfilled") return;
      const entry = named.get(answer.value.hash) ?? { height: answer.value.height, by: [] };
      entry.by.push(sources[index]!);
      named.set(answer.value.hash, entry);
    });
    const answered = sources.filter((_, index) => answers[index]!.status === "fulfilled");
    if (answered.length === 0) throw (answers[0] as PromiseRejectedResult).reason;

    let best: (Tip & { weight: bigint }) | undefined;
    let refused: unknown;
    for (const [cid, { height, by }] of named) {
      if (answered.length > 1 && by.length < 2) {
        let seconded = false;
        for (const other of answered) {
          if (!by.includes(other) && (await holds(other, cid, height, signal))) {
            seconded = true;
            break;
          }
        }
        if (!seconded) continue;
      }
      const source = by[0]!;
      let block: CanonicalBlock;
      let weight: bigint;
      try {
        if (root === undefined) {
          block = decodeCanonicalBlock((await source.volumes.get(cid, signal)).rootBytes());
          weight = block.height;
        } else {
          ({ block, work: weight } = await walk(source, cid, signal));
        }
      } catch (error) {
        if (!(error instanceof ReadError) || answered.length === 1) throw error;
        refused = error;
        continue;
      }
      if (
        best === undefined ||
        weight > best.weight ||
        (weight === best.weight && cid < best.cid)
      ) {
        best = { cid, block, source, weight };
      }
    }
    if (best === undefined) {
      if (refused !== undefined) throw refused;
      throw new ReadError(
        "disagree",
        `${answered.length} sources answered and no two of them hold the same tip`,
      );
    }
    if (root !== undefined) keep({ cid: best.cid, height: best.block.height, work: best.weight });
    return best;
  };
}
