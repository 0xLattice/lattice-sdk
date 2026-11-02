import { VerifiedVolume, type VolumeEntry } from "./index.js";

/**
 * Volumes kept by root CID once verified. A Volume never changes, so a kept
 * one is the answer for its CID for good; {@link VolumeClient} puts only
 * Volumes it verified and takes them back as they were put. A cache that
 * fails answers nothing: every failure is a miss, never an error.
 */
export interface VolumeCache {
  get(rootCID: string): Promise<VerifiedVolume | undefined>;
  put(volume: VerifiedVolume): Promise<void>;
}

const volumeBytes = (entries: readonly VolumeEntry[]) =>
  entries.reduce((total, entry) => total + entry.bytes.byteLength, 0);

/** Volumes kept in memory, the least recently used dropped past `maximumBytes`. */
export class MemoryVolumeCache implements VolumeCache {
  readonly maximumBytes: number;
  readonly #volumes = new Map<string, { volume: VerifiedVolume; bytes: number }>();
  #bytes = 0;

  constructor({ maximumBytes = 32 * 1024 * 1024 }: { maximumBytes?: number } = {}) {
    this.maximumBytes = maximumBytes;
  }

  async get(rootCID: string): Promise<VerifiedVolume | undefined> {
    const kept = this.#volumes.get(rootCID);
    if (kept === undefined) return undefined;
    // Most recently used last.
    this.#volumes.delete(rootCID);
    this.#volumes.set(rootCID, kept);
    return kept.volume;
  }

  async put(volume: VerifiedVolume): Promise<void> {
    const bytes = volumeBytes(volume.entries());
    if (bytes > this.maximumBytes || this.#volumes.has(volume.rootCID)) return;
    this.#volumes.set(volume.rootCID, { volume, bytes });
    this.#bytes += bytes;
    for (const [rootCID, kept] of this.#volumes) {
      if (this.#bytes <= this.maximumBytes) break;
      this.#volumes.delete(rootCID);
      this.#bytes -= kept.bytes;
    }
  }
}

interface StoredVolume {
  readonly rootCID: string;
  readonly entries: readonly VolumeEntry[];
  readonly bytes: number;
  used: number;
}

const STORE = "volumes";

/**
 * Volumes kept in a browser's IndexedDB across visits, the least recently
 * used dropped past `maximumBytes`. Where IndexedDB is missing or refuses
 * (a private window, storage blocked or full), it keeps nothing.
 */
export class IndexedDBVolumeCache implements VolumeCache {
  readonly maximumBytes: number;
  readonly #database: Promise<IDBDatabase | null>;
  readonly #now: () => number;
  /** The bytes kept, read once at open and kept up to date after. */
  #bytes = 0;

  constructor({
    name = "lattice-volumes",
    maximumBytes = 64 * 1024 * 1024,
    indexedDB = globalThis.indexedDB,
    now = Date.now,
  }: {
    name?: string;
    maximumBytes?: number;
    indexedDB?: IDBFactory | undefined;
    now?: () => number;
  } = {}) {
    this.maximumBytes = maximumBytes;
    this.#now = now;
    this.#database = this.#open(indexedDB, name).catch(() => null);
  }

  async #open(factory: IDBFactory | undefined, name: string): Promise<IDBDatabase | null> {
    if (factory === undefined) return null;
    const database = await request<IDBDatabase>(
      Object.assign(factory.open(name, 1), {
        onupgradeneeded: (event: IDBVersionChangeEvent) => {
          const store = (event.target as IDBOpenDBRequest).result.createObjectStore(STORE, {
            keyPath: "rootCID",
          });
          store.createIndex("used", "used");
        },
      }),
    );
    let bytes = 0;
    await cursor(database.transaction(STORE).objectStore(STORE).openCursor(), (kept) => {
      bytes += (kept.value as StoredVolume).bytes;
    });
    this.#bytes = bytes;
    return database;
  }

  async get(rootCID: string): Promise<VerifiedVolume | undefined> {
    try {
      const database = await this.#database;
      if (database === null) return undefined;
      const store = database.transaction(STORE, "readwrite").objectStore(STORE);
      const kept = await request<StoredVolume | undefined>(store.get(rootCID));
      if (kept === undefined) return undefined;
      kept.used = this.#now();
      store.put(kept);
      return new VerifiedVolume(
        kept.rootCID,
        new Map(kept.entries.map((entry) => [entry.cid, entry.bytes])),
      );
    } catch {
      return undefined;
    }
  }

  async put(volume: VerifiedVolume): Promise<void> {
    try {
      const database = await this.#database;
      if (database === null) return;
      const entries = volume.entries();
      const bytes = volumeBytes(entries);
      if (bytes > this.maximumBytes) return;
      const store = database.transaction(STORE, "readwrite").objectStore(STORE);
      if ((await request(store.count(volume.rootCID))) > 0) return;
      await request(store.put({ rootCID: volume.rootCID, entries, bytes, used: this.#now() }));
      this.#bytes += bytes;
      if (this.#bytes > this.maximumBytes) await this.#evict(database);
    } catch {
      // Not kept: read again next time.
    }
  }

  /** Drops the least recently used until the rest fit. */
  async #evict(database: IDBDatabase): Promise<void> {
    const store = database.transaction(STORE, "readwrite").objectStore(STORE);
    await cursor(store.index("used").openCursor(), (oldest) => {
      if (this.#bytes <= this.maximumBytes) return false;
      this.#bytes -= (oldest.value as StoredVolume).bytes;
      oldest.delete();
      return true;
    });
  }
}

function request<T>(pending: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error);
  });
}

/** Visits each record until `visit` returns false. */
function cursor(
  pending: IDBRequest<IDBCursorWithValue | null>,
  visit: (cursor: IDBCursorWithValue) => boolean | void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => {
      const at = pending.result;
      if (at === null || visit(at) === false) return resolve();
      at.continue();
    };
    pending.onerror = () => reject(pending.error);
  });
}
