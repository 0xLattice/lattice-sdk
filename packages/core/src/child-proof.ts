import {
  canonicalBlockProofOfWorkHash,
  decodeCanonicalBlock,
  workForTarget,
  type CanonicalBlock,
} from "./canonical-values.js";
import { cidV1DagCbor, parseCID } from "./cid.js";
import { decodeDagCbor, type DagCborValue } from "./dag-cbor.js";

/**
 * Lattice's `ChildBlockProof`: the sparse content path from a mined root
 * block, through `children[d0] → children[d1] → …`, to one child block.
 */
export interface ChildBlockProof {
  readonly rootCID: string;
  readonly directoryPath: readonly string[];
  readonly entries: readonly { readonly cid: string; readonly data: Uint8Array }[];
}

/** What a verified proof shows: the work the child block's grind carries. */
export interface VerifiedChildEvidence {
  readonly grindID: string;
  readonly rootHash: bigint;
  readonly creditedAncestorWork: bigint;
  readonly childCID: string;
  readonly terminalCarrierCID: string;
  /** Absent when the grind's hash does not meet the child's own target. */
  readonly work?: bigint;
}

/**
 * `malformedEvidence`: the proof does not show what it claims (blame the
 * sender). `protocolInvalid`: it does, but what it shows is not a valid
 * Lattice structure.
 */
export type ChildProofFailure = "malformedEvidence" | "protocolInvalid";

export type ChildProofResult =
  | { readonly ok: true; readonly evidence: VerifiedChildEvidence }
  | { readonly ok: false; readonly failure: ChildProofFailure };

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes the proof wire format; undefined for any bytes Lattice would refuse. */
export function decodeChildBlockProof(bytes: Uint8Array): ChildBlockProof | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 0;
  const u16 = () => {
    if (position + 2 > bytes.length) throw new Error();
    const value = view.getUint16(position, true);
    position += 2;
    return value;
  };
  const u32 = () => {
    if (position + 4 > bytes.length) throw new Error();
    const value = view.getUint32(position, true);
    position += 4;
    return value;
  };
  const take = (length: number) => {
    if (position + length > bytes.length) throw new Error();
    const slice = bytes.subarray(position, position + length);
    position += length;
    return slice;
  };
  const text = (length: number) => decoder.decode(take(length));
  try {
    const rootCID = text(u16());
    const directoryPath: string[] = [];
    for (let count = u16(); count > 0; count -= 1) directoryPath.push(text(u16()));
    const entries: { cid: string; data: Uint8Array }[] = [];
    let previous: string | undefined;
    for (let count = u16(); count > 0; count -= 1) {
      const cid = text(u16());
      const data = take(u32()).slice();
      // Strictly ascending by code unit, as Swift orders these ASCII CIDs.
      if (previous !== undefined && previous >= cid) return undefined;
      previous = cid;
      entries.push({ cid, data });
    }
    if (position !== bytes.length) return undefined;
    return { rootCID, directoryPath, entries };
  } catch {
    return undefined;
  }
}

/** A CIDv1 dag-cbor sha2-256 CID in its one canonical spelling. */
export function isStandardCID(value: string): boolean {
  try {
    const parsed = parseCID(value);
    return parsed.codec === 0x71 && parsed.multihashCode === 0x12 && parsed.digest.length === 32;
  } catch {
    return false;
  }
}

/** A name a block may carry a child under: visible ASCII, no "/", fits a u16. */
export function isValidChildDirectory(value: string): boolean {
  return value.length > 0 && value.length <= 0xffff && /^[\x21-\x2e\x30-\x7e]+$/.test(value);
}

function isLink(value: DagCborValue | undefined): value is { readonly rawCID: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    Object.keys(value).length === 1 &&
    typeof (value as { rawCID?: unknown }).rawCID === "string" &&
    isStandardCID((value as { rawCID: string }).rawCID)
  );
}

const blockFields = new Set([
  "version",
  "parent",
  "transactions",
  "target",
  "nextTarget",
  "spec",
  "parentState",
  "prevState",
  "postState",
  "children",
  "height",
  "timestamp",
  "rewardRecipient",
  "nonce",
]);
const blockLinks = [
  "parent",
  "transactions",
  "spec",
  "parentState",
  "prevState",
  "postState",
  "children",
];

/** A Lattice Block from its bytes, with only standard plain links; else undefined. */
export function decodeLatticeBlock(bytes: Uint8Array): CanonicalBlock | undefined {
  try {
    const value = decodeDagCbor(bytes) as { readonly [key: string]: DagCborValue };
    if (Object.keys(value).some((key) => !blockFields.has(key))) return undefined;
    if (blockLinks.some((key) => value[key] !== undefined && !isLink(value[key]))) return undefined;
    // A target in the one spelling Lattice encodes (`toPrefixedHexString`),
    // so one grind cannot name many blocks by respelling a target.
    if (!isPrefixedHex(value.target) || !isPrefixedHex(value.nextTarget)) return undefined;
    return decodeCanonicalBlock(bytes);
  } catch {
    return undefined;
  }
}

function isPrefixedHex(value: DagCborValue | undefined): boolean {
  return typeof value === "string" && /^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(value);
}

function hasWellFormedRewardRecipient(block: CanonicalBlock): boolean {
  return block.rewardRecipient === undefined || isStandardCID(block.rewardRecipient);
}

function bigEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Lattice's `validateProofOfWork(nexusHash:)`: a positive target the hash meets. */
function meets(block: CanonicalBlock, hash: bigint): boolean {
  const target = BigInt(block.target);
  return target > 0n && target >= hash;
}

/**
 * Verifies that `proof` commits a mined root to `childBytes` along
 * `chainPath` and derives the work it carries: Lattice 57's
 * `ChildBlockProof.verifySecuringWork(child:chainPath:)`. Carrier validity,
 * the child's own validity, and canonicity are outside the proof, as there.
 */
export function verifyChildBlockProof(
  proof: ChildBlockProof,
  childBytes: Uint8Array,
  chainPath: readonly string[],
): ChildProofResult {
  const fail = (failure: ChildProofFailure): ChildProofResult => ({ ok: false, failure });
  const { rootCID, directoryPath, entries } = proof;
  if (
    chainPath[0] !== "Nexus" ||
    directoryPath.length === 0 ||
    directoryPath.length > 0xffff ||
    chainPath.length !== directoryPath.length + 1 ||
    directoryPath.some((directory, index) => directory !== chainPath[index + 1]) ||
    entries.length === 0
  ) {
    return fail("malformedEvidence");
  }
  const child = decodeLatticeBlock(childBytes);
  if (child === undefined) return fail("malformedEvidence");
  const childCID = cidV1DagCbor(childBytes);

  const proofEntries = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (proofEntries.has(entry.cid)) return fail("malformedEvidence");
    proofEntries.set(entry.cid, entry.data);
  }
  const rootData = proofEntries.get(rootCID);
  if (rootData === undefined || cidV1DagCbor(rootData) !== rootCID)
    return fail("malformedEvidence");
  const root = decodeLatticeBlock(rootData);
  if (root === undefined || !hasWellFormedRewardRecipient(root)) return fail("protocolInvalid");
  const rootHash = bigEndian(canonicalBlockProofOfWorkHash(root));

  // Each link resolves from the proof's own entries: present, hashing to
  // the link, and decoding.
  const consumed = new Set([rootCID]);
  const resolve = (cid: string): Uint8Array | undefined => {
    const data = proofEntries.get(cid);
    if (data === undefined || cidV1DagCbor(data) !== cid) return undefined;
    consumed.add(cid);
    return data;
  };

  const carriers: { block: CanonicalBlock; cid: string }[] = [{ block: root, cid: rootCID }];
  let current = root;
  for (const [index, directory] of directoryPath.entries()) {
    const childrenData = resolve(current.childrenCID);
    let children: { readonly [key: string]: DagCborValue };
    try {
      if (childrenData === undefined) return fail("malformedEvidence");
      const decoded = decodeDagCbor(childrenData);
      if (
        decoded === null ||
        typeof decoded !== "object" ||
        Array.isArray(decoded) ||
        decoded instanceof Uint8Array
      ) {
        return fail("malformedEvidence");
      }
      children = decoded as { readonly [key: string]: DagCborValue };
    } catch {
      return fail("malformedEvidence");
    }
    const link = children[directory];
    if (link === undefined || !Object.hasOwn(children, directory)) return fail("malformedEvidence");
    // The named entry resolves before the map's well-formedness is judged.
    const linkCID =
      link !== null &&
      typeof link === "object" &&
      !Array.isArray(link) &&
      !(link instanceof Uint8Array)
        ? (link as { rawCID?: unknown }).rawCID
        : undefined;
    const nextData = typeof linkCID === "string" ? resolve(linkCID) : undefined;
    const next = nextData === undefined ? undefined : decodeLatticeBlock(nextData);
    if (next === undefined) return fail("malformedEvidence");
    const wellFormed = Object.entries(children).every(
      ([key, value]) => isValidChildDirectory(key) && isLink(value),
    );
    if (!wellFormed) return fail("protocolInvalid");

    if (index === directoryPath.length - 1) {
      if (linkCID !== childCID) return fail("malformedEvidence");
      if (child.parentStateCID !== current.previousStateCID) return fail("protocolInvalid");
      if (consumed.size !== proofEntries.size) return fail("malformedEvidence");
      const deepest = carriers[carriers.length - 1]!;
      // Priced by the highest chain the grind met: the first carrier,
      // root-ward, whose target the hash beat.
      const credited = carriers.find((carrier) => meets(carrier.block, rootHash));
      const creditedAncestorWork =
        credited === undefined ? 0n : workForTarget(credited.block.target);
      const own = workForTarget(child.target);
      return {
        ok: true,
        evidence: {
          grindID: rootCID,
          rootHash,
          creditedAncestorWork,
          childCID,
          terminalCarrierCID: deepest.cid,
          ...(meets(child, rootHash)
            ? { work: creditedAncestorWork > own ? creditedAncestorWork : own }
            : {}),
        },
      };
    }
    if (!hasWellFormedRewardRecipient(next) || next.parentStateCID !== current.previousStateCID) {
      return fail("protocolInvalid");
    }
    current = next;
    carriers.push({ block: next, cid: linkCID as string });
  }
  return fail("malformedEvidence");
}
