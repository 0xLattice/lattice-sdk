import {
  decodeCanonicalBlock,
  decodeCanonicalLatticeState,
  decodeCanonicalSignedTransaction,
  verifyNexusBlockProofOfWork,
  type CanonicalBlock,
  type CanonicalLatticeState,
  type CanonicalSignedTransaction,
} from "@adalin/lattice-core";
import { type VerifiedVolume, VolumeClient } from "@adalin/lattice-volumes";
import { type BlockView, type TransactionProjection } from "./models.js";
import { NodeClient } from "./node-client.js";

/** Composes the node's bounded read plane with the content service/DHT plane. */
export class LatticeClient {
  readonly node: NodeClient;
  readonly volumes: VolumeClient;

  constructor(node: NodeClient, volumes: VolumeClient) {
    this.node = node;
    this.volumes = volumes;
  }

  async latestBlock(signal?: AbortSignal): Promise<{
    readonly view: BlockView;
    readonly volume: VerifiedVolume;
    readonly canonical: CanonicalBlock;
  }> {
    const latest = await this.node.latestBlock(signal);
    return this.block(latest.hash, signal);
  }

  async block(
    id: string | bigint,
    signal?: AbortSignal,
  ): Promise<{
    readonly view: BlockView;
    readonly volume: VerifiedVolume;
    readonly canonical: CanonicalBlock;
  }> {
    const view = await this.node.block(id, signal);
    const volume = await this.volumes.get(view.hash, signal);
    const canonical = decodeCanonicalBlock(volume.rootBytes());
    const expected = [
      ["height", canonical.height, view.height],
      ["timestamp", canonical.timestamp, view.timestamp],
      ["nonce", canonical.nonce, view.nonce],
      ["version", canonical.version, view.version],
      ["parent", canonical.parentCID, view.previousBlock],
      ["target", canonical.target, view.target],
      ["next target", canonical.nextTarget, view.nextTarget],
      ["transactions", canonical.transactionsCID, view.transactionsCID],
      ["post-state", canonical.postStateCID, view.postStateCID],
      ["reward recipient", canonical.rewardRecipient, view.rewardRecipient],
    ] as const;
    for (const [name, content, projection] of expected) {
      if (content !== projection)
        throw new Error(`node ${name} does not match canonical Block content`);
    }
    if (
      this.node.chainPath.length === 1 &&
      canonical.height > 0n &&
      !verifyNexusBlockProofOfWork(canonical)
    ) {
      throw new Error("canonical Nexus Block does not satisfy its proof-of-work target");
    }
    return { view, volume, canonical };
  }

  async postState(
    id: string | bigint,
    signal?: AbortSignal,
  ): Promise<{
    readonly volume: VerifiedVolume;
    readonly canonical: CanonicalLatticeState;
  }> {
    const block = await this.block(id, signal);
    const volume = await this.volumes.get(block.canonical.postStateCID, signal);
    return { volume, canonical: decodeCanonicalLatticeState(volume.rootBytes()) };
  }

  async transactions(id: string | bigint, signal?: AbortSignal): Promise<VerifiedVolume> {
    const block = await this.block(id, signal);
    return this.volumes.get(block.canonical.transactionsCID, signal);
  }

  async transaction(
    cid: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly projection: TransactionProjection;
    readonly transaction: VerifiedVolume;
    readonly canonical: CanonicalSignedTransaction;
    readonly body: Uint8Array;
  }> {
    const [projection, transaction] = await Promise.all([
      this.node.transaction(cid, signal),
      this.volumes.get(cid, signal),
    ]);
    if (projection.txCID !== cid)
      throw new Error(`node returned transaction projection ${projection.txCID} for ${cid}`);
    const canonical = decodeCanonicalSignedTransaction(transaction.rootBytes());
    const body = transaction.bytes(canonical.bodyCID);
    if (body === undefined) throw new Error("transaction Volume does not contain its body");
    return {
      projection,
      transaction,
      canonical,
      body,
    };
  }
}
