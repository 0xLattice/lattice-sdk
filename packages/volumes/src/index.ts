import { assertCID, decodeDagCbor, type DagCborValue } from "@adalin/lattice-core";

export interface VolumeEntry {
  readonly cid: string;
  readonly bytes: Uint8Array;
}

/** A complete Volume boundary, rooted at `rootCID`. */
export interface SerializedVolume {
  readonly rootCID: string;
  readonly entries: readonly VolumeEntry[];
}

/**
 * Transport implemented by the Lattice content service, a DHT client, an
 * application gateway, or an in-memory test source. Transport selection is an
 * application decision; this package owns verification after retrieval.
 */
export interface VolumeTransport {
  getVolume(rootCID: string, signal?: AbortSignal): Promise<SerializedVolume | null>;
}

export interface VolumeLimits {
  readonly maximumEntries: number;
  readonly maximumBytes: number;
}

/** Ivy's complete-Volume archive media type and protocol bounds. */
export const VOLUME_ARCHIVE_MEDIA_TYPE = "application/vnd.lattice.volume";
export const MAXIMUM_VOLUME_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAXIMUM_VOLUME_ARCHIVE_ENTRIES = 0xffff;
export const MAXIMUM_VOLUME_CID_BYTES = 8192;

export const DEFAULT_VOLUME_LIMITS: VolumeLimits = {
  maximumEntries: 4096,
  maximumBytes: 64 * 1024 * 1024,
};

export class VolumeError extends Error {
  readonly code:
    | "not-found"
    | "wrong-root"
    | "missing-root"
    | "duplicate-entry"
    | "too-many-entries"
    | "too-large"
    | "invalid-entry";

  constructor(code: VolumeError["code"], message: string) {
    super(message);
    this.name = "VolumeError";
    this.code = code;
  }
}

export class VolumeTransportError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "VolumeTransportError";
    if (status !== undefined) this.status = status;
  }
}

export class VerifiedVolume {
  readonly rootCID: string;
  readonly #entries: ReadonlyMap<string, Uint8Array>;

  constructor(rootCID: string, entries: ReadonlyMap<string, Uint8Array>) {
    this.rootCID = rootCID;
    this.#entries = entries;
  }

  get size(): number {
    return this.#entries.size;
  }

  has(cid: string): boolean {
    return this.#entries.has(cid);
  }

  bytes(cid: string): Uint8Array | undefined {
    return this.#entries.get(cid)?.slice();
  }

  rootBytes(): Uint8Array {
    return this.#entries.get(this.rootCID)!.slice();
  }

  decodeRoot(): DagCborValue {
    return decodeDagCbor(this.rootBytes());
  }

  entries(): readonly VolumeEntry[] {
    return [...this.#entries].map(([cid, bytes]) => ({ cid, bytes: bytes.slice() }));
  }
}

export function verifyVolume(
  volume: SerializedVolume,
  expectedRoot = volume.rootCID,
  limits: VolumeLimits = DEFAULT_VOLUME_LIMITS,
): VerifiedVolume {
  if (volume.rootCID !== expectedRoot) {
    throw new VolumeError("wrong-root", `expected Volume ${expectedRoot}, got ${volume.rootCID}`);
  }
  if (volume.entries.length > limits.maximumEntries) {
    throw new VolumeError("too-many-entries", "Volume exceeds the entry limit");
  }
  const entries = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const entry of volume.entries) {
    if (entries.has(entry.cid)) {
      throw new VolumeError("duplicate-entry", `Volume repeats ${entry.cid}`);
    }
    totalBytes += entry.bytes.byteLength;
    if (totalBytes > limits.maximumBytes) {
      throw new VolumeError("too-large", "Volume exceeds the byte limit");
    }
    try {
      assertCID(entry.cid, entry.bytes);
    } catch (error) {
      throw new VolumeError(
        "invalid-entry",
        error instanceof Error ? error.message : `invalid Volume entry ${entry.cid}`,
      );
    }
    entries.set(entry.cid, entry.bytes.slice());
  }
  if (!entries.has(expectedRoot)) {
    throw new VolumeError("missing-root", `Volume does not contain its root ${expectedRoot}`);
  }
  return new VerifiedVolume(expectedRoot, entries);
}

export class VolumeClient {
  readonly #transport: VolumeTransport;
  readonly #limits: VolumeLimits;

  constructor(transport: VolumeTransport, limits: VolumeLimits = DEFAULT_VOLUME_LIMITS) {
    this.#transport = transport;
    this.#limits = limits;
  }

  async get(rootCID: string, signal?: AbortSignal): Promise<VerifiedVolume> {
    const serialized = await this.#transport.getVolume(rootCID, signal);
    if (serialized === null) throw new VolumeError("not-found", `Volume ${rootCID} was not found`);
    return verifyVolume(serialized, rootCID, this.#limits);
  }
}

export class MemoryVolumeTransport implements VolumeTransport {
  readonly #volumes = new Map<string, SerializedVolume>();

  constructor(volumes: readonly SerializedVolume[] = []) {
    for (const volume of volumes) this.put(volume);
  }

  put(volume: SerializedVolume): void {
    this.#volumes.set(volume.rootCID, {
      rootCID: volume.rootCID,
      entries: volume.entries.map(({ cid, bytes }) => ({ cid, bytes: bytes.slice() })),
    });
  }

  async getVolume(rootCID: string, _signal?: AbortSignal): Promise<SerializedVolume | null> {
    const volume = this.#volumes.get(rootCID);
    if (volume === undefined) return null;
    return {
      rootCID: volume.rootCID,
      entries: volume.entries.map(({ cid, bytes }) => ({ cid, bytes: bytes.slice() })),
    };
  }
}

function archiveFailure(message: string): never {
  throw new VolumeTransportError(`invalid Volume archive: ${message}`);
}

function checkedUInt16(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    archiveFailure(`${name} exceeds UInt16`);
  }
  return value;
}

function checkedUInt32(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    archiveFailure(`${name} exceeds UInt32`);
  }
  return value;
}

/** Encodes the canonical binary archive used by Ivy's complete-Volume exchange. */
export function encodeVolumeArchive(volume: SerializedVolume): Uint8Array {
  const verified = verifyVolume(volume, volume.rootCID, {
    maximumEntries: MAXIMUM_VOLUME_ARCHIVE_ENTRIES,
    maximumBytes: MAXIMUM_VOLUME_ARCHIVE_BYTES,
  });
  const encoder = new TextEncoder();
  const entries = [...verified.entries()].sort((left, right) =>
    left.cid < right.cid ? -1 : left.cid > right.cid ? 1 : 0,
  );
  checkedUInt16(entries.length, "entry count");
  const encoded = entries.map((entry) => {
    const cid = encoder.encode(entry.cid);
    if (cid.byteLength > MAXIMUM_VOLUME_CID_BYTES) archiveFailure("CID is too long");
    checkedUInt16(cid.byteLength, "CID length");
    checkedUInt32(entry.bytes.byteLength, "entry length");
    return { cid, bytes: entry.bytes };
  });
  const length = encoded.reduce(
    (total, entry) => total + 2 + entry.cid.byteLength + 4 + entry.bytes.byteLength,
    2,
  );
  if (length > MAXIMUM_VOLUME_ARCHIVE_BYTES) archiveFailure("archive is too large");
  const archive = new Uint8Array(length);
  const view = new DataView(archive.buffer);
  view.setUint16(0, encoded.length);
  let offset = 2;
  for (const entry of encoded) {
    view.setUint16(offset, entry.cid.byteLength);
    offset += 2;
    archive.set(entry.cid, offset);
    offset += entry.cid.byteLength;
    view.setUint32(offset, entry.bytes.byteLength);
    offset += 4;
    archive.set(entry.bytes, offset);
    offset += entry.bytes.byteLength;
  }
  return archive;
}

/** Strictly decodes one canonical Ivy complete-Volume archive. */
export function decodeVolumeArchive(
  rootCID: string,
  archive: Uint8Array,
  limits: VolumeLimits = DEFAULT_VOLUME_LIMITS,
): SerializedVolume {
  if (archive.byteLength === 0 || archive.byteLength > MAXIMUM_VOLUME_ARCHIVE_BYTES) {
    archiveFailure("archive is empty or too large");
  }
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let offset = 0;
  const requireBytes = (count: number): void => {
    if (count < 0 || offset + count > archive.byteLength) archiveFailure("truncated field");
  };
  const uint16 = (): number => {
    requireBytes(2);
    const value = view.getUint16(offset);
    offset += 2;
    return value;
  };
  const uint32 = (): number => {
    requireBytes(4);
    const value = view.getUint32(offset);
    offset += 4;
    return value;
  };
  const count = uint16();
  if (count === 0) archiveFailure("archive has no entries");
  if (count > limits.maximumEntries) archiveFailure("archive exceeds the entry limit");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: VolumeEntry[] = [];
  let previous: string | undefined;
  let payloadBytes = 0;
  for (let index = 0; index < count; index += 1) {
    const cidLength = uint16();
    if (cidLength > MAXIMUM_VOLUME_CID_BYTES) archiveFailure("CID is too long");
    requireBytes(cidLength);
    let cid: string;
    try {
      cid = decoder.decode(archive.subarray(offset, offset + cidLength));
    } catch {
      archiveFailure("CID is not UTF-8");
    }
    offset += cidLength;
    if (previous !== undefined && previous >= cid) {
      archiveFailure("entries are duplicated or out of order");
    }
    const dataLength = uint32();
    requireBytes(dataLength);
    payloadBytes += dataLength;
    if (payloadBytes > limits.maximumBytes) archiveFailure("archive exceeds the byte limit");
    entries.push({ cid, bytes: archive.slice(offset, offset + dataLength) });
    offset += dataLength;
    previous = cid;
  }
  if (offset !== archive.byteLength) archiveFailure("archive has trailing bytes");
  // CID verification also proves the requested root is present.
  verifyVolume({ rootCID, entries }, rootCID, limits);
  return { rootCID, entries };
}

export interface HTTPVolumeTransportOptions {
  readonly fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly timeoutMilliseconds?: number;
  readonly limits?: VolumeLimits;
  /** Authorization for a private content gateway; never follows redirects. */
  readonly authorization?: string;
  /** Hosted node chain whose local Volume store should answer the request. */
  readonly chainPath?: readonly string[];
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.[0-9]{1,3}){3}$/.test(host);
}

function contentBaseURL(input: string): URL {
  const url = new URL(input);
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("content URL must not contain credentials, query parameters, or a fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("content URL must use HTTPS, except for loopback HTTP");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

async function boundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      throw new VolumeTransportError("Volume response is too large", response.status);
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new VolumeTransportError("Volume response is too large", response.status);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Complete-Volume gateway transport. The gateway serves Ivy's canonical
 * binary archive from `GET <base>/<root CID>`; it does not expose a second
 * JSON representation of canonical content.
 */
export class HTTPVolumeTransport implements VolumeTransport {
  readonly endpoint: string;
  readonly #fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly #timeoutMilliseconds: number;
  readonly #limits: VolumeLimits;
  readonly #authorization: string | undefined;
  readonly #chainPath: string | undefined;

  constructor(endpoint: string, options: HTTPVolumeTransportOptions = {}) {
    this.endpoint = contentBaseURL(endpoint).toString();
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
    this.#limits = options.limits ?? DEFAULT_VOLUME_LIMITS;
    this.#authorization = options.authorization;
    if (options.chainPath !== undefined) {
      if (
        options.chainPath.length === 0 ||
        options.chainPath.some((component) => component === "")
      ) {
        throw new Error("content chainPath must contain nonempty components");
      }
      this.#chainPath = options.chainPath.join("/");
    }
  }

  async getVolume(rootCID: string, signal?: AbortSignal): Promise<SerializedVolume | null> {
    const url = new URL(encodeURIComponent(rootCID), this.endpoint);
    if (this.#chainPath !== undefined) url.searchParams.set("chainPath", this.#chainPath);
    const timeout = AbortSignal.timeout(this.#timeoutMilliseconds);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const response = await this.#fetch(url, {
      headers: {
        Accept: VOLUME_ARCHIVE_MEDIA_TYPE,
        ...(this.#authorization === undefined ? {} : { Authorization: this.#authorization }),
      },
      redirect: "error",
      signal: combined,
    });
    if (response.status === 404) return null;
    if (!response.ok)
      throw new VolumeTransportError(
        `content gateway returned HTTP ${response.status}`,
        response.status,
      );
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== VOLUME_ARCHIVE_MEDIA_TYPE) {
      throw new VolumeTransportError(
        `content gateway returned ${mediaType ?? "no content type"}`,
        response.status,
      );
    }
    const archive = await boundedBytes(response, MAXIMUM_VOLUME_ARCHIVE_BYTES);
    return decodeVolumeArchive(rootCID, archive, this.#limits);
  }
}

export interface Uint64SparseProof {
  readonly rootCID: string;
  readonly key: string;
  readonly value?: bigint;
  readonly entries: readonly VolumeEntry[];
}

function object(value: DagCborValue): { readonly [key: string]: DagCborValue } | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
    ? (value as { readonly [key: string]: DagCborValue })
    : undefined;
}

function referencedCID(value: DagCborValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  const header = object(value);
  return typeof header?.rawCID === "string" ? header.rawCID : undefined;
}

/**
 * Verifies a Lattice sparse-radix proof for an optional UInt64 value. The proof
 * is sealed to its supplied entries: a missing referenced child is invalid and
 * never triggers a network fetch.
 */
export function verifyUint64SparseProof(proof: Uint64SparseProof): boolean {
  if (proof.value !== undefined && (proof.value < 0n || proof.value > 0xffff_ffff_ffff_ffffn)) {
    return false;
  }
  let volume: VerifiedVolume;
  try {
    volume = verifyVolume({ rootCID: proof.rootCID, entries: proof.entries });
  } catch {
    return false;
  }
  let cid = proof.rootCID;
  let remaining = proof.key;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(cid)) return false;
    visited.add(cid);
    const bytes = volume.bytes(cid);
    if (bytes === undefined) return false;
    let node: { readonly [key: string]: DagCborValue } | undefined;
    try {
      node = object(decodeDagCbor(bytes));
    } catch {
      return false;
    }
    if (node === undefined) return false;
    if (node.prefix !== undefined) {
      if (typeof node.prefix !== "string") return false;
      if (!remaining.startsWith(node.prefix)) return proof.value === undefined;
      remaining = remaining.slice(node.prefix.length);
    }
    if (remaining.length === 0) {
      if (node.value === undefined) return proof.value === undefined;
      return typeof node.value === "bigint" && node.value === proof.value;
    }
    if (!Array.isArray(node.children)) return false;
    let next: string | undefined;
    for (const childValue of node.children) {
      const child = object(childValue);
      if (child === undefined || typeof child.key !== "string" || child.key.length !== 1) {
        return false;
      }
      const childCID = referencedCID(child.value);
      if (childCID === undefined) return false;
      if (child.key === remaining[0]) {
        if (next !== undefined) return false;
        next = childCID;
      }
    }
    if (next === undefined) return proof.value === undefined;
    if (!volume.has(next)) return false;
    cid = next;
  }
}
