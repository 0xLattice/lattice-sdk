import { type SerializedVolume, type VolumeTransport, VolumeTransportError } from "./index.js";

/** A transport that can also answer many Volumes in one request. */
export interface ManyVolumeTransport extends VolumeTransport {
  /**
   * The Volumes it answers for, by root CID; a root left out is not held
   * there and may still be read on its own. Throws when it can't be asked.
   */
  getVolumes(
    rootCIDs: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, SerializedVolume>>;
}

export interface BatchingVolumeTransportOptions {
  /** Roots asked in one request at most; the node's bound is 32. */
  readonly maximumBatch?: number;
  /** How long a read waits for others to join its request. */
  readonly windowMilliseconds?: number;
}

interface Waiting {
  readonly rootCID: string;
  readonly resolve: (volume: SerializedVolume | null) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Reads made together, as a walk reads a node's children, asked in one
 * request: each `getVolume` waits `windowMilliseconds` for others, and the
 * lot goes to `getVolumes`. A root the answer leaves out is read on its own,
 * and so is everything once the transport can't be asked for many (a node
 * without the route, say). Only a read's own fetch is ever aborted by its
 * signal; it never aborts the request it shares.
 */
export class BatchingVolumeTransport implements VolumeTransport {
  readonly #transport: ManyVolumeTransport;
  readonly #maximumBatch: number;
  readonly #window: number;
  #waiting: Waiting[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #many = true;

  constructor(transport: ManyVolumeTransport, options: BatchingVolumeTransportOptions = {}) {
    this.#transport = transport;
    this.#maximumBatch = options.maximumBatch ?? 32;
    this.#window = options.windowMilliseconds ?? 0;
  }

  getVolume(rootCID: string, signal?: AbortSignal): Promise<SerializedVolume | null> {
    if (!this.#many) return this.#transport.getVolume(rootCID, signal);
    signal?.throwIfAborted();
    const read = new Promise<SerializedVolume | null>((resolve, reject) => {
      this.#waiting.push({ rootCID, resolve, reject });
    });
    if (this.#waiting.length >= this.#maximumBatch) this.#flush();
    else this.#timer ??= setTimeout(() => this.#flush(), this.#window);
    if (signal === undefined) return read;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      read.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  #flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const batch = this.#waiting;
    this.#waiting = [];
    void this.#ask(batch);
  }

  async #ask(batch: readonly Waiting[]): Promise<void> {
    const roots = [...new Set(batch.map(({ rootCID }) => rootCID))];
    let found = new Map<string, SerializedVolume>();
    if (roots.length > 1 && this.#many) {
      try {
        found = await this.#transport.getVolumes(roots);
      } catch (error) {
        // Not a route here: each read goes on its own from now on.
        if (
          error instanceof VolumeTransportError &&
          [400, 403, 404, 405, 501].includes(error.status ?? 0)
        ) {
          this.#many = false;
        }
      }
    }
    const alone = new Map<string, Promise<SerializedVolume | null>>();
    for (const { rootCID, resolve, reject } of batch) {
      const volume = found.get(rootCID);
      if (volume !== undefined) {
        resolve(volume);
        continue;
      }
      if (!alone.has(rootCID)) alone.set(rootCID, this.#transport.getVolume(rootCID));
      alone.get(rootCID)!.then(resolve, reject);
    }
  }
}

export const MANY_VOLUMES_MEDIA_TYPE = "application/vnd.lattice.volumes";

/**
 * The records of a many-Volumes answer: per Volume, a big-endian u16 root
 * CID length, the root CID, a big-endian u32 archive length and the archive.
 */
export function decodeVolumeRecords(body: Uint8Array): { rootCID: string; archive: Uint8Array }[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records: { rootCID: string; archive: Uint8Array }[] = [];
  let offset = 0;
  const need = (length: number) => {
    if (offset + length > body.byteLength) {
      throw new VolumeTransportError("invalid many-Volumes answer: truncated record");
    }
  };
  while (offset < body.byteLength) {
    need(2);
    const rootLength = view.getUint16(offset);
    offset += 2;
    need(rootLength);
    const rootCID = decoder.decode(body.subarray(offset, offset + rootLength));
    offset += rootLength;
    need(4);
    const archiveLength = view.getUint32(offset);
    offset += 4;
    need(archiveLength);
    records.push({ rootCID, archive: body.subarray(offset, offset + archiveLength) });
    offset += archiveLength;
  }
  return records;
}
