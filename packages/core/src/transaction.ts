import { addressFromMultikey } from "./address.js";
import { cidV1DagCbor } from "./cid.js";
import { type DagCborValue, encodeDagCbor } from "./dag-cbor.js";
import { encodeEd25519Multikey } from "./multikey.js";
import { publicKeyFromPrivate, signPreimage } from "./signing.js";
import { utf8 } from "./bytes.js";

export interface AccountAction {
  readonly owner: string;
  readonly delta: bigint;
}

export interface Action {
  readonly key: string;
  readonly oldValue?: string;
  readonly newValue?: string;
}

export interface DepositAction {
  readonly nonce: bigint;
  readonly demander: string;
  readonly amountDemanded: bigint;
  readonly amountDeposited: bigint;
}

export interface ReceiptAction {
  readonly withdrawer: string;
  readonly nonce: bigint;
  readonly demander: string;
  readonly amountDemanded: bigint;
  readonly directory: string;
}

export interface WithdrawalAction {
  readonly withdrawer: string;
  readonly nonce: bigint;
  readonly demander: string;
  readonly amountDemanded: bigint;
  readonly amountWithdrawn: bigint;
}

export interface TransactionBody {
  readonly accountActions: readonly AccountAction[];
  readonly actions: readonly Action[];
  readonly depositActions: readonly DepositAction[];
  readonly receiptActions: readonly ReceiptAction[];
  readonly withdrawalActions: readonly WithdrawalAction[];
  readonly signers: readonly string[];
  readonly nonce: bigint;
  readonly chainPath: readonly string[];
}

export interface TransactionPayload {
  readonly transaction: {
    readonly signatures: Readonly<Record<string, string>>;
    readonly body: WireTransactionBody;
  };
}

export interface WireTransactionBody {
  readonly accountActions: readonly { readonly owner: string; readonly delta: string }[];
  readonly actions: readonly Action[];
  readonly depositActions: readonly {
    readonly nonce: string;
    readonly demander: string;
    readonly amountDemanded: string;
    readonly amountDeposited: string;
  }[];
  readonly receiptActions: readonly {
    readonly withdrawer: string;
    readonly nonce: string;
    readonly demander: string;
    readonly amountDemanded: string;
    readonly directory: string;
  }[];
  readonly withdrawalActions: readonly {
    readonly withdrawer: string;
    readonly nonce: string;
    readonly demander: string;
    readonly amountDemanded: string;
    readonly amountWithdrawn: string;
  }[];
  readonly signers: readonly string[];
  readonly nonce: string;
  readonly chainPath: readonly string[];
}

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;

function assertRange(name: string, value: bigint, minimum: bigint, maximum: bigint): void {
  if (value < minimum || value > maximum) throw new Error(`${name} is out of range`);
}

function assertBody(body: TransactionBody): void {
  assertRange("transaction nonce", body.nonce, 0n, UINT64_MAX);
  if (body.chainPath.length === 0 || body.chainPath.some((part) => part.length === 0)) {
    throw new Error("chainPath must contain non-empty components");
  }
  for (const action of body.accountActions) {
    assertRange("account delta", action.delta, INT64_MIN, INT64_MAX);
  }
  for (const action of [
    ...body.depositActions,
    ...body.receiptActions,
    ...body.withdrawalActions,
  ]) {
    assertRange("cross-chain nonce", action.nonce, 0n, UINT128_MAX);
    // cashew's current canonical DAG-CBOR encoder accepts UInt128 values only
    // through UInt64.max. Keep the sharper error here at the SDK boundary.
    assertRange("encodable cross-chain nonce", action.nonce, 0n, UINT64_MAX);
    assertRange("amount demanded", action.amountDemanded, 0n, UINT64_MAX);
  }
  for (const action of body.depositActions) {
    assertRange("amount deposited", action.amountDeposited, 0n, UINT64_MAX);
  }
  for (const action of body.withdrawalActions) {
    assertRange("amount withdrawn", action.amountWithdrawn, 0n, UINT64_MAX);
  }
}

function actionValue(action: Action): DagCborValue {
  const output: Record<string, DagCborValue> = { key: action.key };
  if (action.oldValue !== undefined) output.oldValue = action.oldValue;
  if (action.newValue !== undefined) output.newValue = action.newValue;
  return output;
}

function bodyValue(body: TransactionBody): DagCborValue {
  assertBody(body);
  return {
    accountActions: body.accountActions.map((action) => ({
      owner: action.owner,
      delta: action.delta,
    })),
    actions: body.actions.map(actionValue),
    depositActions: body.depositActions.map((action) => ({
      nonce: action.nonce,
      demander: action.demander,
      amountDemanded: action.amountDemanded,
      amountDeposited: action.amountDeposited,
    })),
    receiptActions: body.receiptActions.map((action) => ({
      withdrawer: action.withdrawer,
      nonce: action.nonce,
      demander: action.demander,
      amountDemanded: action.amountDemanded,
      directory: action.directory,
    })),
    withdrawalActions: body.withdrawalActions.map((action) => ({
      withdrawer: action.withdrawer,
      nonce: action.nonce,
      demander: action.demander,
      amountDemanded: action.amountDemanded,
      amountWithdrawn: action.amountWithdrawn,
    })),
    signers: [...body.signers],
    nonce: body.nonce,
    chainPath: [...body.chainPath],
  };
}

export function encodeTransactionBody(body: TransactionBody): {
  readonly bytes: Uint8Array;
  readonly cid: string;
} {
  const bytes = encodeDagCbor(bodyValue(body));
  return { bytes, cid: cidV1DagCbor(bytes) };
}

export function transactionSigningPreimage(
  bodyCID: string,
  chainPath: readonly string[],
  nonce: bigint,
): string {
  const lines = ["domain:13:lattice-tx-v1", `chainPath.count:${chainPath.length}`];
  for (const component of chainPath) {
    lines.push(`chainPath.component:${utf8(component).length}:${component}`);
  }
  lines.push(`nonce:${nonce}`, `bodyCID:${utf8(bodyCID).length}:${bodyCID}`);
  return lines.join("\n");
}

/**
 * Canonical DAG-CBOR of a signed transaction envelope, as the node stores it:
 * `{ body: { rawCID }, signatures: [{ key, value }] }` with signature entries
 * sorted by lowercase-hex public key (ed25519 Multikey keys, 64-byte
 * signatures; a `0x` prefix or upper-case hex is normalized as the node does). The returned CID is the
 * `transactionCID` a node reports on submission, so a client can verify it.
 * `bodyCID` must be the canonical CIDv1 string (as `encodeTransactionBody`
 * returns it); prefer `signedTransactionCID`, which derives it.
 */
export function encodeSignedTransaction(
  signatures: Readonly<Record<string, string>>,
  bodyCID: string,
): { readonly bytes: Uint8Array; readonly cid: string } {
  // The node rewrites a parseable key/signature to lowercase hex without a
  // `0x` prefix and keeps anything else verbatim; only the parseable forms
  // can be valid, so accept exactly those and refuse the rest.
  const canonical = (value: string, pattern: RegExp, what: string): string => {
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    if (!pattern.test(hex)) throw new Error(`${what} is not canonical hex`);
    return hex.toLowerCase();
  };
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(signatures)) {
    const normalizedKey = canonical(key, /^[eE][dD]01[0-9a-fA-F]{64}$/, "signature key");
    if (entries.has(normalizedKey)) throw new Error("duplicate signature key");
    entries.set(normalizedKey, canonical(value, /^[0-9a-fA-F]{128}$/, "signature"));
  }
  const sorted = [...entries.keys()].sort();
  const bytes = encodeDagCbor({
    body: { rawCID: bodyCID },
    signatures: sorted.map((key) => ({ key, value: entries.get(key)! })),
  });
  return { bytes, cid: cidV1DagCbor(bytes) };
}

/**
 * The bytes a node's pool counts for `body` once each of its signers has
 * signed it: the body plus the envelope, as `encodeTransactionBody` and
 * `encodeSignedTransaction` encode them. Keys and signatures have fixed
 * lengths, so this is exact before signing; a fee priced from a node's fee
 * rate (`feeToOutbid`) needs it.
 */
export function signedTransactionSize(body: TransactionBody): number {
  const encoded = encodeTransactionBody(body);
  const signatures = Object.fromEntries(
    body.signers.map((_, index) => [
      "ed01" + index.toString(16).padStart(64, "0"),
      "0".repeat(128),
    ]),
  );
  return encoded.bytes.length + encodeSignedTransaction(signatures, encoded.cid).bytes.length;
}

/**
 * The most state `body` can add to a block, from the body alone, as Lattice's
 * `TransactionBody.stateGrowthCeiling` counts it (spec §6.6): its actions'
 * deltas, `len(owner) + 8` for each owner it nets a credit to and
 * `len("_nonce_" + signer) + 8` for its first signer, each taken as new.
 * Removals are never credited, so it may be negative only through deleted
 * action keys. A node weighs a transaction by it (`transactionWeight`).
 */
export function stateGrowthCeiling(body: TransactionBody): number {
  const length = (value: string) => utf8(value).length;
  let growth = 0;
  for (const action of body.actions) {
    if (action.oldValue === undefined) growth += length(action.key) + length(action.newValue ?? "");
    else if (action.newValue === undefined) growth -= length(action.key) + length(action.oldValue);
    else growth += length(action.newValue) - length(action.oldValue);
  }
  for (const deposit of body.depositActions) growth += 32 + length(deposit.demander);
  for (const receipt of body.receiptActions) {
    growth +=
      length(receipt.withdrawer) + length(receipt.demander) + length(receipt.directory) + 24;
  }
  for (const withdrawal of body.withdrawalActions) {
    growth += length(withdrawal.withdrawer) + length(withdrawal.demander) + 32;
  }
  const net = new Map<string, bigint>();
  const add = (owner: string, delta: bigint) => net.set(owner, (net.get(owner) ?? 0n) + delta);
  for (const action of body.accountActions) add(action.owner, action.delta);
  for (const receipt of body.receiptActions) {
    add(receipt.withdrawer, -receipt.amountDemanded);
    add(receipt.demander, receipt.amountDemanded);
  }
  for (const [owner, delta] of net) if (delta > 0n) growth += length(owner) + 8;
  const signer = body.signers[0];
  if (signer !== undefined) growth += length("_nonce_" + signer) + 8;
  return growth;
}

/** The CID of a signed transaction (see `encodeSignedTransaction`). */
export function signedTransactionCID(
  signatures: Readonly<Record<string, string>>,
  body: TransactionBody,
): string {
  return encodeSignedTransaction(signatures, encodeTransactionBody(body).cid).cid;
}

export function toWireTransactionBody(body: TransactionBody): WireTransactionBody {
  assertBody(body);
  return {
    accountActions: body.accountActions.map(({ owner, delta }) => ({
      owner,
      delta: delta.toString(),
    })),
    actions: body.actions.map((action) => ({ ...action })),
    depositActions: body.depositActions.map((action) => ({
      ...action,
      nonce: action.nonce.toString(),
      amountDemanded: action.amountDemanded.toString(),
      amountDeposited: action.amountDeposited.toString(),
    })),
    receiptActions: body.receiptActions.map((action) => ({
      ...action,
      nonce: action.nonce.toString(),
      amountDemanded: action.amountDemanded.toString(),
    })),
    withdrawalActions: body.withdrawalActions.map((action) => ({
      ...action,
      nonce: action.nonce.toString(),
      amountDemanded: action.amountDemanded.toString(),
      amountWithdrawn: action.amountWithdrawn.toString(),
    })),
    signers: [...body.signers],
    nonce: body.nonce.toString(),
    chainPath: [...body.chainPath],
  };
}

export function transactionPayload(
  signatures: Readonly<Record<string, string>>,
  body: TransactionBody,
): TransactionPayload {
  return { transaction: { signatures: { ...signatures }, body: toWireTransactionBody(body) } };
}

export function signTransactionBody(
  body: TransactionBody,
  privateKey: Uint8Array,
): { readonly bodyCID: string; readonly publicKey: string; readonly signature: string } {
  const publicKey = encodeEd25519Multikey(publicKeyFromPrivate(privateKey));
  const { cid } = encodeTransactionBody(body);
  return {
    bodyCID: cid,
    publicKey,
    signature: signPreimage(
      transactionSigningPreimage(cid, body.chainPath, body.nonce),
      privateKey,
    ),
  };
}

export function buildTransfer(args: {
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  readonly fee: bigint;
  readonly nonce: bigint;
  readonly chainPath: readonly string[];
}): TransactionBody {
  const { from, to, amount, fee, nonce, chainPath } = args;
  if (amount <= 0n) throw new Error("amount must be positive");
  if (fee < 0n) throw new Error("fee must not be negative");
  if (amount + fee > INT64_MAX) throw new Error("amount plus fee is too large");
  if (from === to) throw new Error("sender and recipient must differ");
  return {
    accountActions: [
      { owner: from, delta: -(amount + fee) },
      { owner: to, delta: amount },
    ],
    actions: [],
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [from],
    nonce,
    chainPath: [...chainPath],
  };
}

export function accountFromPrivateKey(privateKey: Uint8Array): {
  readonly privateKey: Uint8Array;
  readonly publicKey: string;
  readonly address: string;
} {
  const publicKey = encodeEd25519Multikey(publicKeyFromPrivate(privateKey));
  return { privateKey: privateKey.slice(), publicKey, address: addressFromMultikey(publicKey) };
}
