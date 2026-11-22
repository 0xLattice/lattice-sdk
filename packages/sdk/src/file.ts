import { decodeDagCbor, isStandardCID, type DagCborValue } from "@adalin/lattice-core";
import type { VolumeClient } from "@adalin/lattice-volumes";

/** A file's chunk size in lattice-storage's layout. */
export const CHUNK_BYTES = 1 << 20;
/** The longest media type a file root may carry. */
const MAX_TYPE_LENGTH = 255;
/** Chunks fetched at once. */
const CHUNKS_IN_FLIGHT = 4;

type Fields = { readonly [key: string]: DagCborValue };

/** The map a Volume's root block holds, with exactly `keys`; else undefined. */
function exactly(value: DagCborValue, keys: readonly string[]): Fields | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value instanceof Uint8Array) return undefined;
  const present = Object.keys(value).sort();
  return present.length === keys.length && [...keys].sort().every((key, i) => key === present[i])
    ? (value as Fields)
    : undefined;
}

/**
 * The file named by `root` in lattice-storage's layout: one block
 * `{ type, size, bytes }`, or a root `{ type, size, chunks }` naming one
 * `{ bytes }` Volume per 1 MiB chunk. The root is checked, and its size held
 * to `maxBytes`, before any chunk is fetched; every chunk is checked against
 * its CID, its place and its length.
 */
export async function readFile(
  volumes: VolumeClient,
  root: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Blob> {
  const fail = (why: string): never => {
    throw new Error(`${root} is not a file: ${why}`);
  };
  const value = decodeDagCbor((await volumes.get(root, signal)).rootBytes());
  const fields =
    exactly(value, ["type", "size", "bytes"]) ?? exactly(value, ["type", "size", "chunks"]);
  if (fields === undefined) return fail("its root is not { type, size, bytes | chunks }");
  const { type, size } = fields;
  if (typeof type !== "string" || type.length > MAX_TYPE_LENGTH) return fail("bad type");
  if (typeof size !== "bigint" || size < 0n) return fail("bad size");
  if (size > BigInt(maxBytes)) {
    throw new RangeError(`${root} holds ${size} bytes, more than maxBytes ${maxBytes}`);
  }
  const length = Number(size);

  if (fields.bytes !== undefined) {
    const { bytes } = fields;
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) return fail("size mismatch");
    return new Blob([new Uint8Array(bytes)], { type });
  }

  const { chunks } = fields;
  if (
    !Array.isArray(chunks) ||
    chunks.length !== Math.ceil(length / CHUNK_BYTES) ||
    !chunks.every((cid) => typeof cid === "string" && isStandardCID(cid))
  ) {
    return fail("its chunks do not cover its size");
  }
  const bytes = new Uint8Array(length);
  const read = async (index: number) => {
    const cid = chunks[index] as string;
    const chunk = exactly(decodeDagCbor((await volumes.get(cid, signal)).rootBytes()), ["bytes"]);
    const expected = Math.min(CHUNK_BYTES, length - index * CHUNK_BYTES);
    if (!(chunk?.bytes instanceof Uint8Array) || chunk.bytes.length !== expected) {
      return fail(`chunk ${index} (${cid}) is not ${expected} bytes`);
    }
    bytes.set(chunk.bytes, index * CHUNK_BYTES);
  };
  for (let at = 0; at < chunks.length; at += CHUNKS_IN_FLIGHT) {
    const batch: Promise<void>[] = [];
    for (let index = at; index < Math.min(chunks.length, at + CHUNKS_IN_FLIGHT); index++) {
      batch.push(read(index));
    }
    await Promise.all(batch);
  }
  return new Blob([bytes], { type });
}
