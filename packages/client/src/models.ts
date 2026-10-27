import {
  array,
  decimal,
  integer,
  optionalBoolean,
  optionalDecimal,
  optionalInteger,
  optionalString,
  record,
  string,
  stringArray,
} from "./wire.js";

export interface NodeStatus {
  readonly phase: string;
  readonly chainPath: readonly string[];
  readonly nexusGenesisCID: string;
  readonly tipCID?: string;
  readonly height?: bigint;
  readonly revision?: bigint;
  readonly mempoolCount: number;
  readonly mempoolBytes: number;
  readonly templateDigest?: string;
  /**
   * Height of the best header chain the node knows; `height` (the deepest
   * executed block on it) trails it while syncing. Absent before any header
   * and from nodes predating it.
   */
  readonly bestHeaderHeight?: bigint;
}

export function parseNodeStatus(value: unknown): NodeStatus {
  const body = record(value, "status");
  return {
    phase: string(body.phase, "status.phase"),
    chainPath: stringArray(body.chainPath, "status.chainPath"),
    nexusGenesisCID: string(body.nexusGenesisCID, "status.nexusGenesisCID"),
    ...(body.tipCID === undefined ? {} : { tipCID: string(body.tipCID, "status.tipCID") }),
    ...(body.height === undefined ? {} : { height: decimal(body.height, "status.height") }),
    ...(body.revision === undefined ? {} : { revision: decimal(body.revision, "status.revision") }),
    mempoolCount: integer(body.mempoolCount, "status.mempoolCount"),
    mempoolBytes: integer(body.mempoolBytes, "status.mempoolBytes"),
    ...(body.templateDigest === undefined
      ? {}
      : { templateDigest: string(body.templateDigest, "status.templateDigest") }),
    ...(body.bestHeaderHeight === undefined
      ? {}
      : { bestHeaderHeight: decimal(body.bestHeaderHeight, "status.bestHeaderHeight") }),
  };
}

export interface BlockView {
  readonly height: bigint;
  readonly hash: string;
  readonly timestamp: bigint;
  readonly previousBlock?: string;
  readonly transactionCount: number;
  readonly childBlockCount: number;
  readonly nonce: bigint;
  readonly version: number;
  readonly target: string;
  readonly nextTarget: string;
  readonly transactionsCID: string;
  readonly postStateCID: string;
  readonly chain: readonly string[];
  readonly rewardRecipient?: string;
  readonly rewardCredited?: bigint;
}

export interface LatestBlockView {
  readonly height: bigint;
  readonly hash: string;
  readonly transactionCount: number;
  readonly timestamp: bigint;
  readonly previousBlock?: string;
  readonly rewardRecipient?: string;
  readonly rewardCredited?: bigint;
}

export function parseLatestBlock(value: unknown): LatestBlockView {
  const body = record(value, "latest block");
  const previousBlock = optionalString(body.previousBlock, "latestBlock.previousBlock");
  const rewardRecipient = optionalString(body.rewardRecipient, "latestBlock.rewardRecipient");
  const rewardCredited = optionalDecimal(body.rewardCredited, "latestBlock.rewardCredited");
  return {
    height: decimal(body.height, "latestBlock.height"),
    hash: string(body.hash, "latestBlock.hash"),
    transactionCount: integer(body.transactionCount, "latestBlock.transactionCount"),
    timestamp: decimal(body.timestamp, "latestBlock.timestamp"),
    ...(previousBlock === undefined ? {} : { previousBlock }),
    ...(rewardRecipient === undefined ? {} : { rewardRecipient }),
    ...(rewardCredited === undefined ? {} : { rewardCredited }),
  };
}

export function parseBlock(value: unknown): BlockView {
  const body = record(value, "block");
  const previousBlock = optionalString(body.previousBlock, "block.previousBlock");
  const rewardRecipient = optionalString(body.rewardRecipient, "block.rewardRecipient");
  const rewardCredited = optionalDecimal(body.rewardCredited, "block.rewardCredited");
  return {
    height: decimal(body.height, "block.height"),
    hash: string(body.hash, "block.hash"),
    timestamp: decimal(body.timestamp, "block.timestamp"),
    ...(previousBlock === undefined ? {} : { previousBlock }),
    transactionCount: integer(body.transactionCount, "block.transactionCount"),
    childBlockCount: integer(body.childBlockCount, "block.childBlockCount"),
    nonce: decimal(body.nonce, "block.nonce"),
    version: integer(body.version, "block.version"),
    target: string(body.target, "block.target"),
    nextTarget: string(body.nextTarget, "block.nextTarget"),
    transactionsCID: string(body.transactionsCID, "block.transactionsCID"),
    postStateCID: string(body.postStateCID, "block.postStateCID"),
    chain: stringArray(body.chain, "block.chain"),
    ...(rewardRecipient === undefined ? {} : { rewardRecipient }),
    ...(rewardCredited === undefined ? {} : { rewardCredited }),
  };
}

export interface AccountState {
  readonly owner: string;
  readonly balance: bigint;
  readonly nonce: bigint;
}

export function parseAccount(value: unknown): AccountState {
  const body = record(value, "account");
  return {
    owner: string(body.owner, "account.owner"),
    balance: decimal(body.balance, "account.balance"),
    nonce: decimal(body.nonce, "account.nonce"),
  };
}

export interface TransactionProjection {
  readonly txCID: string;
  readonly blockHeight?: bigint;
  readonly blockHash?: string;
  readonly timestamp?: bigint;
  readonly nonce: bigint;
  readonly signers: readonly string[];
  readonly chainPath: readonly string[];
  readonly accountActions: readonly { readonly owner: string; readonly delta: bigint }[];
  readonly depositActions: readonly {
    readonly nonce: bigint;
    readonly demander: string;
    readonly amountDemanded: bigint;
    readonly amountDeposited: bigint;
  }[];
  readonly receiptActions: readonly {
    readonly withdrawer: string;
    readonly nonce: bigint;
    readonly demander: string;
    readonly amountDemanded: bigint;
    readonly directory: string;
  }[];
  readonly withdrawalActions: readonly {
    readonly withdrawer: string;
    readonly nonce: bigint;
    readonly demander: string;
    readonly amountDemanded: bigint;
    readonly amountWithdrawn: bigint;
  }[];
}

export function parseTransactionProjection(value: unknown): TransactionProjection {
  const body = record(value, "transaction");
  const blockHeight = optionalDecimal(body.blockHeight, "transaction.blockHeight");
  const blockHash = optionalString(body.blockHash, "transaction.blockHash");
  const timestamp = optionalDecimal(body.timestamp, "transaction.timestamp");
  return {
    txCID: string(body.txCID, "transaction.txCID"),
    ...(blockHeight === undefined ? {} : { blockHeight }),
    ...(blockHash === undefined ? {} : { blockHash }),
    ...(timestamp === undefined ? {} : { timestamp }),
    nonce: decimal(body.nonce, "transaction.nonce"),
    signers: stringArray(body.signers, "transaction.signers"),
    chainPath: stringArray(body.chainPath, "transaction.chainPath"),
    accountActions: array(body.accountActions, "transaction.accountActions", (entry, name) => {
      const action = record(entry, name);
      return {
        owner: string(action.owner, `${name}.owner`),
        delta: decimal(action.delta, `${name}.delta`),
      };
    }),
    depositActions: array(body.depositActions, "transaction.depositActions", (entry, name) => {
      const action = record(entry, name);
      return {
        nonce: decimal(action.nonce, `${name}.nonce`),
        demander: string(action.demander, `${name}.demander`),
        amountDemanded: decimal(action.amountDemanded, `${name}.amountDemanded`),
        amountDeposited: decimal(action.amountDeposited, `${name}.amountDeposited`),
      };
    }),
    receiptActions: array(body.receiptActions, "transaction.receiptActions", (entry, name) => {
      const action = record(entry, name);
      return {
        withdrawer: string(action.withdrawer, `${name}.withdrawer`),
        nonce: decimal(action.nonce, `${name}.nonce`),
        demander: string(action.demander, `${name}.demander`),
        amountDemanded: decimal(action.amountDemanded, `${name}.amountDemanded`),
        directory: string(action.directory, `${name}.directory`),
      };
    }),
    withdrawalActions: array(
      body.withdrawalActions,
      "transaction.withdrawalActions",
      (entry, name) => {
        const action = record(entry, name);
        return {
          withdrawer: string(action.withdrawer, `${name}.withdrawer`),
          nonce: decimal(action.nonce, `${name}.nonce`),
          demander: string(action.demander, `${name}.demander`),
          amountDemanded: decimal(action.amountDemanded, `${name}.amountDemanded`),
          amountWithdrawn: decimal(action.amountWithdrawn, `${name}.amountWithdrawn`),
        };
      },
    ),
  };
}

export interface ChainInfo {
  readonly genesisHash?: string;
  readonly height?: bigint;
  readonly tipCID?: string;
  readonly chain: readonly string[];
  /** This node's relay-policy fee floor; never consensus. */
  readonly minRelayFee?: bigint;
  /** Whether the answering listener accepts `POST /transactions`. */
  readonly acceptsSubmit?: boolean;
}

export function parseChainInfo(value: unknown): ChainInfo {
  const body = record(value, "chain info");
  const genesisHash = optionalString(body.genesisHash, "chainInfo.genesisHash");
  const height = optionalDecimal(body.height, "chainInfo.height");
  const tipCID = optionalString(body.tipCID, "chainInfo.tipCID");
  const minRelayFee = optionalDecimal(body.minRelayFee, "chainInfo.minRelayFee");
  const acceptsSubmit = optionalBoolean(body.acceptsSubmit, "chainInfo.acceptsSubmit");
  return {
    ...(genesisHash === undefined ? {} : { genesisHash }),
    ...(height === undefined ? {} : { height }),
    ...(tipCID === undefined ? {} : { tipCID }),
    chain: stringArray(body.chain, "chainInfo.chain"),
    ...(minRelayFee === undefined ? {} : { minRelayFee }),
    ...(acceptsSubmit === undefined ? {} : { acceptsSubmit }),
  };
}

/** One canonical block summary from `GET /api/blocks`; no `rewardCredited`. */
export interface BlockSummary {
  readonly height: bigint;
  readonly hash: string;
  readonly previousBlock?: string;
  readonly timestamp: bigint;
  readonly transactionCount: number;
  readonly rewardRecipient?: string;
}

export interface BlocksPage {
  readonly blocks: readonly BlockSummary[];
  /** Pass as the next page's `before`; absent once height 0 is listed. */
  readonly nextBefore?: bigint;
}

export function parseBlocksPage(value: unknown): BlocksPage {
  const body = record(value, "blocks page");
  const nextBefore = optionalDecimal(body.nextBefore, "blocks.nextBefore");
  return {
    blocks: array(body.blocks, "blocks.blocks", (entry, name) => {
      const row = record(entry, name);
      const previousBlock = optionalString(row.previousBlock, `${name}.previousBlock`);
      const rewardRecipient = optionalString(row.rewardRecipient, `${name}.rewardRecipient`);
      return {
        height: decimal(row.height, `${name}.height`),
        hash: string(row.hash, `${name}.hash`),
        ...(previousBlock === undefined ? {} : { previousBlock }),
        timestamp: decimal(row.timestamp, `${name}.timestamp`),
        transactionCount: integer(row.transactionCount, `${name}.transactionCount`),
        ...(rewardRecipient === undefined ? {} : { rewardRecipient }),
      };
    }),
    ...(nextBefore === undefined ? {} : { nextBefore }),
  };
}

/** A child commitment from `GET /api/block/:cid/children`. */
export interface BlockChild {
  readonly directory: string;
  readonly blockHash: string;
  /** Omitted when the answering node does not host that child chain. */
  readonly height?: bigint;
  readonly transactionCount?: number;
}

export function parseBlockChildren(value: unknown): BlockChild[] {
  const body = record(value, "block children");
  return array(body.children, "children", (entry, name) => {
    const child = record(entry, name);
    const height = optionalDecimal(child.height, `${name}.height`);
    const transactionCount = optionalInteger(child.transactionCount, `${name}.transactionCount`);
    return {
      directory: string(child.directory, `${name}.directory`),
      blockHash: string(child.blockHash, `${name}.blockHash`),
      ...(height === undefined ? {} : { height }),
      ...(transactionCount === undefined ? {} : { transactionCount }),
    };
  });
}

/** One block of `GET /api/fees`: what this node's pool would put in it. */
export interface ProjectedBlock {
  readonly transactionCount: number;
  readonly bytes: number;
  /**
   * The block's lowest rate, `lowestFee` over `lowestFeeWeight`: a
   * transaction paying a higher rate would have been taken before it.
   */
  readonly lowestFee: bigint;
  readonly lowestFeeBytes: number;
  /** Its weight (`transactionWeight`); `lowestFeeBytes` from an older node. */
  readonly lowestFeeWeight: number;
  /** Whether ready transactions were left for a later block. */
  readonly full: boolean;
}

/**
 * `GET /api/fees`: the blocks this node's pool would fill next, in order.
 * No block, or a first block that is not `full`, means the next block has
 * room: any fee at `minRelayFee` makes it. An estimate from one node's pool,
 * not a promise: other miners' pools and later arrivals differ.
 */
export interface FeeEstimates {
  /** This node's relay floor (policy, never consensus), as in chain info. */
  readonly minRelayFee: bigint;
  readonly blocks: readonly ProjectedBlock[];
  /** What a transaction's weight is measured against; absent from older nodes. */
  readonly weight?: FeeWeight;
}

/** A chain's block limits as `transactionWeight` measures against them, in bytes. */
export interface FeeWeight {
  readonly blockRoom: number;
  readonly growthRoom: number;
  readonly maxTransactions: number;
  /** What a block charges each transaction beyond its bytes. */
  readonly transactionAllowance: number;
}

/**
 * What a node's fee rate is over for a transaction of `size` bytes adding at
 * most `growth` state (`stateGrowthCeiling`): the most of a block it takes of
 * any limit, in the block's bytes, as the node's `FeeWeight` weighs it. Its
 * size plus `transactionAllowance`; its growth times `blockRoom / growthRoom`,
 * rounded up (past `growthRoom`, the whole block); and
 * `blockRoom / maxTransactions`. Its size where `weight` is absent (an older
 * node, which ranks per byte).
 */
export function transactionWeight(size: number, growth: number, weight?: FeeWeight): number {
  if (!weight) return Math.max(1, size);
  let result = Math.max(1, size + weight.transactionAllowance);
  if (weight.blockRoom <= 0) return result;
  if (growth > 0) {
    if (weight.growthRoom <= 0 || growth >= weight.growthRoom) result = Math.max(result, weight.blockRoom);
    else {
      const share = (BigInt(growth) * BigInt(weight.blockRoom) + BigInt(weight.growthRoom) - 1n) / BigInt(weight.growthRoom);
      result = Math.max(result, Number(share));
    }
  }
  if (weight.maxTransactions > 0) result = Math.max(result, Math.floor(weight.blockRoom / weight.maxTransactions));
  return result;
}

export function parseFeeEstimates(value: unknown): FeeEstimates {
  const body = record(value, "fees");
  const weight = body.weight === undefined ? undefined : record(body.weight, "fees.weight");
  return {
    ...(weight && {
      weight: {
        blockRoom: integer(weight.blockRoom, "fees.weight.blockRoom"),
        growthRoom: integer(weight.growthRoom, "fees.weight.growthRoom"),
        maxTransactions: integer(weight.maxTransactions, "fees.weight.maxTransactions"),
        transactionAllowance: integer(weight.transactionAllowance, "fees.weight.transactionAllowance"),
      },
    }),
    minRelayFee: decimal(body.minRelayFee, "fees.minRelayFee"),
    blocks: array(body.blocks, "fees.blocks", (entry, name) => {
      const block = record(entry, name);
      const lowestFeeBytes = integer(block.lowestFeeBytes, `${name}.lowestFeeBytes`);
      if (lowestFeeBytes <= 0) throw new TypeError(`${name}.lowestFeeBytes must be positive`);
      const lowestFeeWeight = optionalInteger(block.lowestFeeWeight, `${name}.lowestFeeWeight`) ?? lowestFeeBytes;
      if (lowestFeeWeight <= 0) throw new TypeError(`${name}.lowestFeeWeight must be positive`);
      const full = optionalBoolean(block.full, `${name}.full`);
      if (full === undefined) throw new TypeError(`${name}.full must be a boolean`);
      return {
        transactionCount: integer(block.transactionCount, `${name}.transactionCount`),
        bytes: integer(block.bytes, `${name}.bytes`),
        lowestFee: decimal(block.lowestFee, `${name}.lowestFee`),
        lowestFeeBytes,
        lowestFeeWeight,
        full,
      };
    }),
  };
}

/**
 * The smallest fee for a transaction of `weight` (`transactionWeight`; its
 * size where the node serves none) to rank ahead of `block`'s lowest-rate
 * transaction, and so be taken into that block or an earlier one: a rate
 * strictly above `lowestFee / lowestFeeWeight` (equal rates break by CID,
 * which a sender does not choose).
 */
export function feeToOutbid(block: ProjectedBlock, weight: number): bigint {
  if (!Number.isSafeInteger(weight) || weight <= 0)
    throw new RangeError("weight must be a positive integer");
  return (block.lowestFee * BigInt(weight)) / BigInt(block.lowestFeeWeight) + 1n;
}

/** `GET /api/chain/spec`: the chain's consensus parameters. */
export interface ChainSpec {
  /** Milliseconds the difficulty adjustment aims for between blocks. */
  readonly targetBlockTime: bigint;
  readonly initialReward: bigint;
  readonly halvingInterval: bigint;
  readonly maxBlockSize: number;
  readonly maxNumberOfTransactionsPerBlock: bigint;
  readonly premine: bigint;
  readonly halfLife: bigint;
}

export function parseChainSpec(value: unknown): ChainSpec {
  const body = record(value, "chain spec");
  return {
    targetBlockTime: decimal(body.targetBlockTime, "chainSpec.targetBlockTime"),
    initialReward: decimal(body.initialReward, "chainSpec.initialReward"),
    halvingInterval: decimal(body.halvingInterval, "chainSpec.halvingInterval"),
    maxBlockSize: integer(body.maxBlockSize, "chainSpec.maxBlockSize"),
    maxNumberOfTransactionsPerBlock: decimal(
      body.maxNumberOfTransactionsPerBlock,
      "chainSpec.maxNumberOfTransactionsPerBlock",
    ),
    premine: decimal(body.premine, "chainSpec.premine"),
    halfLife: decimal(body.halfLife, "chainSpec.halfLife"),
  };
}
