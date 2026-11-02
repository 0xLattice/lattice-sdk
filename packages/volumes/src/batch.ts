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
  /**
   * How long a read waits for others to join its request: a few
   * milliseconds, so reads that each looked in a cache first (answered in
   * separate tasks) still meet.
   */
  readonly windowMilliseconds?: number;
  /** How long reads go one at a time after a many-Volumes request fails. */
  readonly backoffMilliseconds?: number;
  readonly now?: () => number;
}

interface Waiting {
  readonly rootCID: string;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (volume: SerializedVolume | null) => void;
  readonly reject: (error: unknown) => void;
}

/** Aborts once every one of `signals` has; never, if any read can't be aborted. */
function allAborted(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  if (signals.some((signal) => signal === undefined)) return undefined;
  if (signals.length === 1) return signals[0];
  const all = new AbortController();
  const check = () => {
    if (signals.every((signal) => signal!.aborted)) all.abort(signals[0]!.reason);
  };
  for (const signal of signals) signal!.addEventListener("abort", check, { once: true });
  check();
  return all.signal;
}

/**
 * Reads made together, as a walk reads a node's children, asked in one
 * request: each `getVolume` waits `windowMilliseconds` for others, and the
 * lot goes to `getVolumes`. A root the answer leaves out is read on its own.
 * A gateway that refuses the route (400, 403, 404, 405, 501) is read one at
 * a time from then on; one whose answer fails otherwise, for
 * `backoffMilliseconds`; one that can't be reached fails the reads at once.
 * A read's abort ends that read, and its fetch once no other read waits on
 * it.
 */
export class BatchingVolumeTransport implements VolumeTransport {
  readonly #transport: ManyVolumeTransport;
  readonly #maximumBatch: number;
  readonly #window: number;
  readonly #backoff: number;
  readonly #now: () => number;
  #waiting: Waiting[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Until when reads go one at a time: Infinity once the route is refused. */
  #aloneUntil = 0;

  constructor(transport: ManyVolumeTransport, options: BatchingVolumeTransportOptions = {}) {
    this.#transport = transport;
    this.#maximumBatch = options.maximumBatch ?? 32;
    this.#window = options.windowMilliseconds ?? 4;
    this.#backoff = options.backoffMilliseconds ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  #alone(rootCID: string, signal?: AbortSignal): Promise<SerializedVolume | null> {
    return Promise.resolve().then(() => this.#transport.getVolume(rootCID, signal));
  }

  getVolume(rootCID: string, signal?: AbortSignal): Promise<SerializedVolume | null> {
    if (this.#now() < this.#aloneUntil) return this.#alone(rootCID, signal);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const read = new Promise<SerializedVolume | null>((resolve, reject) => {
      this.#waiting.push({ rootCID, signal, resolve, reject });
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
    // A read already aborted has its answer: nothing to fetch for it.
    const batch = this.#waiting.filter(({ signal }) => !signal?.aborted);
    this.#waiting = [];
    void this.#ask(batch).catch((error: unknown) => {
      for (const { reject } of batch) reject(error);
    });
  }

  async #ask(batch: readonly Waiting[]): Promise<void> {
    const byRoot = new Map<string, Waiting[]>();
    for (const waiting of batch) {
      byRoot.set(waiting.rootCID, [...(byRoot.get(waiting.rootCID) ?? []), waiting]);
    }
    let found = new Map<string, SerializedVolume>();
    if (byRoot.size > 1 && this.#now() >= this.#aloneUntil) {
      try {
        found = await this.#transport.getVolumes([...byRoot.keys()]);
      } catch (error) {
        // The node can't be reached or didn't answer: the reads fail now, so
        // the reader can move on, rather than waiting on it once per root.
        if (!(error instanceof VolumeTransportError)) {
          for (const waiting of batch) waiting.reject(error);
          return;
        }
        const refused =
          error instanceof VolumeTransportError &&
          [400, 403, 404, 405, 501].includes(error.status ?? 0);
        this.#aloneUntil = refused ? Infinity : this.#now() + this.#backoff;
      }
    }
    for (const [rootCID, waiting] of byRoot) {
      const volume = found.get(rootCID);
      const read =
        volume !== undefined
          ? Promise.resolve(volume)
          : this.#alone(rootCID, allAborted(waiting.map(({ signal }) => signal)));
      read.then(
        (answer) => waiting.forEach(({ resolve }) => resolve(answer)),
        (error: unknown) => waiting.forEach(({ reject }) => reject(error)),
      );
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
