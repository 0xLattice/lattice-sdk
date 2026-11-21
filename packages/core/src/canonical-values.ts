import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8 } from "./bytes.js";
import { decodeDagCbor, type DagCborValue } from "./dag-cbor.js";

type DagRecord = { readonly [key: string]: DagCborValue };

function record(value: DagCborValue, name: string): DagRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    throw new TypeError(`${name} must be a DAG-CBOR map`);
  }
  return value as DagRecord;
}

function string(value: DagCborValue | undefined, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function integer(value: DagCborValue | undefined, name: string): bigint {
  if (typeof value !== "bigint") throw new TypeError(`${name} must be an integer`);
  return value;
}

function array(value: DagCborValue | undefined, name: string): readonly DagCborValue[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be a DAG-CBOR array`);
  return value;
}

function unsigned(value: DagCborValue | undefined, name: string, maximum = 0xffff_ffff_ffff_ffffn) {
  const decoded = integer(value, name);
  if (decoded < 0n || decoded > maximum) throw new TypeError(`${name} is out of range`);
  return decoded;
}

function reference(value: DagCborValue | undefined, name: string): string {
  return string(record(value as DagCborValue, name).rawCID, `${name}.rawCID`);
}

export interface CanonicalBlock {
  readonly version: number;
  readonly parentCID?: string;
  readonly transactionsCID: string;
  readonly target: string;
  readonly nextTarget: string;
  readonly specCID: string;
  readonly parentStateCID: string;
  readonly previousStateCID: string;
  readonly postStateCID: string;
  readonly childrenCID: string;
  readonly height: bigint;
  readonly timestamp: bigint;
  readonly rewardRecipient?: string;
  readonly nonce: bigint;
}

/** Decodes the consensus Block value from CID-verified DAG-CBOR bytes. */
export function decodeCanonicalBlock(bytes: Uint8Array): CanonicalBlock {
  const block = record(decodeDagCbor(bytes), "Block");
  const version = unsigned(block.version, "Block.version", 0xffffn);
  const timestamp = integer(block.timestamp, "Block.timestamp");
  if (timestamp < -0x8000_0000_0000_0000n || timestamp > 0x7fff_ffff_ffff_ffffn) {
    throw new TypeError("Block.timestamp is out of range");
  }
  const parentCID =
    block.parent === undefined ? undefined : reference(block.parent, "Block.parent");
  const rewardRecipient =
    block.rewardRecipient === undefined
      ? undefined
      : string(block.rewardRecipient, "Block.rewardRecipient");
  return {
    version: Number(version),
    ...(parentCID === undefined ? {} : { parentCID }),
    transactionsCID: reference(block.transactions, "Block.transactions"),
    target: string(block.target, "Block.target"),
    nextTarget: string(block.nextTarget, "Block.nextTarget"),
    specCID: reference(block.spec, "Block.spec"),
    parentStateCID: reference(block.parentState, "Block.parentState"),
    previousStateCID: reference(block.prevState, "Block.prevState"),
    postStateCID: reference(block.postState, "Block.postState"),
    childrenCID: reference(block.children, "Block.children"),
    height: unsigned(block.height, "Block.height"),
    timestamp,
    ...(rewardRecipient === undefined ? {} : { rewardRecipient }),
    nonce: unsigned(block.nonce, "Block.nonce"),
  };
}

export interface CanonicalLatticeState {
  readonly accountStateCID: string;
  readonly generalStateCID: string;
  readonly depositStateCID: string;
  readonly receiptStateCID: string;
}

export interface CanonicalSignedTransaction {
  readonly bodyCID: string;
  readonly signatures: readonly {
    readonly publicKey: string;
    readonly signature: string;
  }[];
}

/** Decodes the authenticated body link and signatures in a signed Transaction. */
export function decodeCanonicalSignedTransaction(bytes: Uint8Array): CanonicalSignedTransaction {
  const transaction = record(decodeDagCbor(bytes), "Transaction");
  let previousKey: string | undefined;
  const signatures = array(transaction.signatures, "Transaction.signatures").map((value, index) => {
    const signature = record(value, `Transaction.signatures[${index}]`);
    const publicKey = string(signature.key, `Transaction.signatures[${index}].key`);
    if (previousKey !== undefined && previousKey >= publicKey) {
      throw new TypeError("Transaction signatures are duplicated or out of order");
    }
    previousKey = publicKey;
    return {
      publicKey,
      signature: string(signature.value, `Transaction.signatures[${index}].value`),
    };
  });
  return {
    bodyCID: reference(transaction.body, "Transaction.body"),
    signatures,
  };
}

/** Decodes the authenticated roots inside a LatticeState wrapper. */
export function decodeCanonicalLatticeState(bytes: Uint8Array): CanonicalLatticeState {
  const state = record(decodeDagCbor(bytes), "LatticeState");
  return {
    accountStateCID: reference(state.accountState, "LatticeState.accountState"),
    generalStateCID: reference(state.generalState, "LatticeState.generalState"),
    depositStateCID: reference(state.depositState, "LatticeState.depositState"),
    receiptStateCID: reference(state.receiptState, "LatticeState.receiptState"),
  };
}

/** Verifies the authenticated linkage between two already CID-verified blocks. */
export function assertBlockContinuity(
  parentCID: string,
  parent: CanonicalBlock,
  child: CanonicalBlock,
): void {
  if (child.parentCID !== parentCID) throw new Error("child does not commit to the parent block");
  if (child.height !== parent.height + 1n) throw new Error("child block height is not contiguous");
  if (child.previousStateCID !== parent.postStateCID) {
    throw new Error("child does not continue the parent's post-state");
  }
}

function targetInteger(target: string): bigint {
  if (!/^0x[0-9a-f]{1,64}$/.test(target)) throw new TypeError("Block target is not canonical hex");
  return BigInt(target);
}

/** Reproduces Lattice's consensus proof-of-work preimage for one Block. */
export function canonicalBlockProofOfWorkPreimage(block: CanonicalBlock): Uint8Array {
  const separator = Uint8Array.of(0);
  const fields = [
    String(block.version),
    block.parentCID ?? "",
    block.transactionsCID,
    // UInt256 2.0.0's toHexString(), used by consensus: all 64 lower-case
    // hex digits, zero-padded, without the DAG-CBOR field's `0x` prefix.
    targetInteger(block.target).toString(16).padStart(64, "0"),
    targetInteger(block.nextTarget).toString(16).padStart(64, "0"),
    block.specCID,
    block.parentStateCID,
    block.previousStateCID,
    block.postStateCID,
    block.childrenCID,
    String(block.height),
    String(block.timestamp),
  ];
  const nonce = new Uint8Array(8);
  new DataView(nonce.buffer).setBigUint64(0, block.nonce);
  const recipient =
    block.rewardRecipient === undefined
      ? separator
      : concatBytes(Uint8Array.of(1), utf8(block.rewardRecipient), separator);
  return concatBytes(...fields.flatMap((field) => [utf8(field), separator]), recipient, nonce);
}

export function canonicalBlockProofOfWorkHash(block: CanonicalBlock): Uint8Array {
  return sha256(canonicalBlockProofOfWorkPreimage(block));
}

function unsignedBigEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * Validates a Nexus block's own PoW. Descendant blocks require the authenticated
 * Nexus/parent proof context and must not be passed to this standalone check.
 */
export function verifyNexusBlockProofOfWork(block: CanonicalBlock): boolean {
  const target = targetInteger(block.target);
  return target > 0n && unsignedBigEndian(canonicalBlockProofOfWorkHash(block)) <= target;
}

/** Exact inclusive Bitcoin-style work used by Lattice (`2^256 / (target + 1)`). */
export function workForTarget(target: string): bigint {
  const value = targetInteger(target);
  if (value === 0n) return 0n;
  const maximum = (1n << 256n) - 1n;
  if (value === maximum) return 1n;
  return (maximum - value) / (value + 1n) + 1n;
}
