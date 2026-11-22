import type { SponsorWork } from "@adalin/lattice-relay";

/**
 * The nonces in `[start, start + count)` whose share hash,
 * SHA-256(prefix ‖ nonce as 8 big-endian bytes), is at most the target
 * (both hex), in nonce order. A plain SHA-256 that hashes the prefix's whole
 * blocks once and only the last one or two per nonce.
 *
 * It is its own SHA-256 for two reasons. A blob Web Worker runs this
 * function's source, so it may use nothing outside its own body; and it is
 * 2.3 to 3.4 times as fast as @noble/hashes' midstate `clone()` on a
 * sponsor's 632-byte prefix (2.5 against 0.8 MH/s in Node).
 */
export function searchShares(
  prefixHex: string,
  targetHex: string,
  start: bigint,
  count: number,
): bigint[] {
  const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  // A block's message schedule, from its 16 words at `offset`.
  const expand = (words: Int32Array, offset: number, W: Int32Array): void => {
    for (let i = 0; i < 16; i++) W[i] = words[offset + i]!;
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15]!;
      const w2 = W[i - 2]!;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) | 0;
    }
  };
  // One block, by its schedule `W`, into `state`.
  const compress = (state: Int32Array, W: Int32Array): void => {
    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i]! + W[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    state[0] = (state[0]! + a) | 0;
    state[1] = (state[1]! + b) | 0;
    state[2] = (state[2]! + c) | 0;
    state[3] = (state[3]! + d) | 0;
    state[4] = (state[4]! + e) | 0;
    state[5] = (state[5]! + f) | 0;
    state[6] = (state[6]! + g) | 0;
    state[7] = (state[7]! + h) | 0;
  };

  if (!/^(?:[0-9a-f]{2})*$/.test(prefixHex) || !/^[0-9a-f]{64}$/.test(targetHex)) {
    throw new TypeError("prefix must be hex and the target 64 hex digits");
  }
  const prefixLength = prefixHex.length / 2;
  // The message, padded: prefix ‖ nonce ‖ 0x80 ‖ zeros ‖ bit length.
  const blocks = Math.ceil((prefixLength + 8 + 9) / 64);
  const message = new Uint8Array(blocks * 64);
  for (let i = 0; i < prefixLength; i++) {
    message[i] = parseInt(prefixHex.slice(i * 2, i * 2 + 2), 16);
  }
  message[prefixLength + 8] = 0x80;
  const bits = (prefixLength + 8) * 8;
  message[message.length - 4] = (bits >>> 24) & 0xff;
  message[message.length - 3] = (bits >>> 16) & 0xff;
  message[message.length - 2] = (bits >>> 8) & 0xff;
  message[message.length - 1] = bits & 0xff;
  const words = new Int32Array(blocks * 16);
  const readWords = (from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      words[i] =
        (message[i * 4]! << 24) |
        (message[i * 4 + 1]! << 16) |
        (message[i * 4 + 2]! << 8) |
        message[i * 4 + 3]!;
    }
  };
  readWords(0, words.length);
  // Blocks before the nonce's are hashed once, and blocks after it keep one
  // schedule: only the one or two holding the nonce change with it.
  const first = Math.floor(prefixLength / 64);
  const last = Math.floor((prefixLength + 7) / 64);
  const schedules = Array.from({ length: blocks }, () => new Int32Array(64));
  for (let block = 0; block < blocks; block++) expand(words, block * 16, schedules[block]!);
  const midstate = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  for (let block = 0; block < first; block++) compress(midstate, schedules[block]!);
  const target = new Uint32Array(8);
  for (let i = 0; i < 8; i++) target[i] = parseInt(targetHex.slice(i * 8, i * 8 + 8), 16);

  const found: bigint[] = [];
  const state = new Int32Array(8);
  const fromWord = Math.floor(prefixLength / 4);
  const toWord = Math.floor((prefixLength + 7) / 4) + 1;
  let high = Number(start >> 32n);
  let low = Number(start & 0xffffffffn);
  for (let n = 0; n < count; n++) {
    message[prefixLength] = high >>> 24;
    message[prefixLength + 1] = (high >>> 16) & 0xff;
    message[prefixLength + 2] = (high >>> 8) & 0xff;
    message[prefixLength + 3] = high & 0xff;
    message[prefixLength + 4] = low >>> 24;
    message[prefixLength + 5] = (low >>> 16) & 0xff;
    message[prefixLength + 6] = (low >>> 8) & 0xff;
    message[prefixLength + 7] = low & 0xff;
    readWords(fromWord, toWord);
    state.set(midstate);
    for (let block = first; block < blocks; block++) {
      if (block <= last) expand(words, block * 16, schedules[block]!);
      compress(state, schedules[block]!);
    }
    for (let i = 0; i < 8; i++) {
      const word = state[i]! >>> 0;
      if (word !== target[i]) {
        if (word < target[i]!) found.push((BigInt(high) << 32n) | BigInt(low));
        break;
      }
      if (i === 7) found.push((BigInt(high) << 32n) | BigInt(low));
    }
    low = (low + 1) >>> 0;
    if (low === 0) high = (high + 1) >>> 0;
  }
  return found;
}

/** Nonces hashed per step: about 10 to 30 ms of one core. */
const STEP = 1 << 16;

/** A worker's source: it searches the range it is sent and reports as it goes. */
function shareWorker(search: typeof searchShares): void {
  const scope = globalThis as unknown as {
    onmessage: (event: MessageEvent) => void;
    postMessage: (message: unknown) => void;
  };
  const postMessage = (message: unknown) => scope.postMessage(message);
  scope.onmessage = ({ data }: MessageEvent) => {
    const { prefixHex, targetHex, start, end } = data as {
      prefixHex: string;
      targetHex: string;
      start: bigint;
      end: bigint;
    };
    for (let nonce = start; nonce < end;) {
      const count = Number(end - nonce < 65536n ? end - nonce : 65536n);
      for (const share of search(prefixHex, targetHex, nonce, count)) postMessage({ share });
      postMessage({ hashes: count });
      nonce += BigInt(count);
    }
    postMessage({ done: true });
  };
}

export interface ShareSearchOptions {
  /** Web Workers to search in; 0 searches on this thread. */
  readonly workers?: number;
  readonly signal?: AbortSignal;
  /** Called with each step's count of nonces hashed. */
  readonly onHashes?: (hashes: number) => void;
}

type Work = Pick<SponsorWork, "prefixHex" | "shareTarget" | "startNonce" | "count" | "expiresAt">;

function targetHex(work: Work): string {
  return work.shareTarget.toString(16).padStart(64, "0");
}

/** The default worker count: all cores but one, where Web Workers exist. */
export function defaultWorkers(): number {
  if (typeof Worker === "undefined" || typeof Blob === "undefined") return 0;
  return Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1);
}

/**
 * The shares in `work`'s range as they are found: in Web Workers, each
 * searching its slice, or on this thread, yielding between steps. A worker
 * that fails before it has answered at all (a page whose content policy
 * refuses blob workers) leaves the search to this thread. Stops at the end
 * of the range or when it expires; throws `signal`'s reason.
 */
export async function* findShares(
  work: Work,
  options: ShareSearchOptions = {},
): AsyncGenerator<bigint> {
  const workers = options.workers ?? defaultWorkers();
  const started = workers > 0 ? startWorkers(work, workers) : undefined;
  if (started === undefined) {
    yield* searchHere(work, options);
    return;
  }
  const { pool, events, url } = started;
  const queue: bigint[] = [];
  const yielded = new Set<bigint>();
  let finished = 0;
  let failure: unknown;
  let fallBack = false;
  let wake: (() => void) | undefined;
  events.onShare = (share) => {
    queue.push(share);
    wake?.();
  };
  events.onHashes = (hashes) => options.onHashes?.(hashes);
  events.onDone = () => {
    finished += 1;
    wake?.();
  };
  events.onError = (error, answered) => {
    if (answered) failure = error;
    else fallBack = true;
    wake?.();
  };
  const abort = () => wake?.();
  options.signal?.addEventListener("abort", abort);
  try {
    while (true) {
      options.signal?.throwIfAborted();
      if (failure !== undefined) throw failure;
      if (fallBack) break;
      const share = queue.shift();
      if (share !== undefined) {
        yielded.add(share);
        yield share;
        continue;
      }
      if (finished === pool.length || Date.now() >= work.expiresAt) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, Math.min(0x7fffffff, Math.max(0, work.expiresAt - Date.now())));
      });
      clearTimeout(timer);
      wake = undefined;
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    for (const worker of pool) worker.terminate();
    URL.revokeObjectURL(url);
  }
  for await (const share of searchHere(work, options)) {
    if (!yielded.has(share)) yield share;
  }
}

interface WorkerEvents {
  onShare?: (share: bigint) => void;
  onHashes?: (hashes: number) => void;
  onDone?: () => void;
  /** `answered`: whether the failing worker had sent anything first. */
  onError?: (error: unknown, answered: boolean) => void;
}

/** `count` workers over slices of the range, or undefined where none can start. */
function startWorkers(
  work: Work,
  count: number,
): { pool: Worker[]; events: WorkerEvents; url: string } | undefined {
  const events: WorkerEvents = {};
  const pool: Worker[] = [];
  let url: string;
  try {
    const source = `(${shareWorker.toString()})(${searchShares.toString()});`;
    url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  } catch {
    return undefined;
  }
  try {
    const slice = work.count / BigInt(count) + 1n;
    const end = work.startNonce + work.count;
    for (let index = 0n; index < BigInt(count); index++) {
      const start = work.startNonce + index * slice;
      if (start >= end) break;
      const worker = new Worker(url);
      let answered = false;
      worker.onmessage = ({ data }: MessageEvent) => {
        answered = true;
        if (data.share !== undefined) events.onShare?.(data.share as bigint);
        else if (data.hashes !== undefined) events.onHashes?.(data.hashes as number);
        else if (data.done) events.onDone?.();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        events.onError?.(new Error(`share search failed: ${event.message}`), answered);
      };
      worker.postMessage({
        prefixHex: work.prefixHex,
        targetHex: targetHex(work),
        start,
        end: start + slice < end ? start + slice : end,
      });
      pool.push(worker);
    }
  } catch {
    // A page that refuses blob workers outright searches on its own thread.
    for (const worker of pool) worker.terminate();
    URL.revokeObjectURL(url);
    return undefined;
  }
  return { pool, events, url };
}

async function* searchHere(work: Work, options: ShareSearchOptions): AsyncGenerator<bigint> {
  const target = targetHex(work);
  const end = work.startNonce + work.count;
  for (let nonce = work.startNonce; nonce < end;) {
    options.signal?.throwIfAborted();
    if (Date.now() >= work.expiresAt) return;
    const count = Number(end - nonce < BigInt(STEP) ? end - nonce : BigInt(STEP));
    const shares = searchShares(work.prefixHex, target, nonce, count);
    options.onHashes?.(count);
    nonce += BigInt(count);
    for (const share of shares) yield share;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
