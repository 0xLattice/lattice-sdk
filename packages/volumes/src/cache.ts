import type { SerializedVolume, VerifiedVolume, VolumeEntry } from "./index.js";

/**
 * Volumes kept by root CID. A Volume never changes, so one kept is the
 * answer for its CID for good. {@link VolumeClient} puts only Volumes it
 * verified, and verifies again what it takes back, under its own limits: a
 * kept Volume is never trusted as kept. A cache that fails answers nothing:
 * every failure is a miss, never an error.
 */
export interface VolumeCache {
  get(rootCID: string): Promise<SerializedVolume | undefined>;
  put(volume: VerifiedVolume): Promise<void>;
  /** Drops what is kept for `rootCID`: it failed verification. */
  delete?(rootCID: string): Promise<void>;
}

const volumeBytes = (entries: readonly VolumeEntry[]) =>
  entries.reduce((total, entry) => total + entry.bytes.byteLength, 0);

/** Volumes kept in memory, the least recently used dropped past `maximumBytes`. */
export class MemoryVolumeCache implements VolumeCache {
  readonly maximumBytes: number;
  readonly #volumes = new Map<string, { volume: SerializedVolume; bytes: number }>();
  #bytes = 0;

  constructor({ maximumBytes = 32 * 1024 * 1024 }: { maximumBytes?: number } = {}) {
    this.maximumBytes = maximumBytes;
  }

  async get(rootCID: string): Promise<SerializedVolume | undefined> {
    const kept = this.#volumes.get(rootCID);
    if (kept === undefined) return undefined;
    // Most recently used last.
    this.#volumes.delete(rootCID);
    this.#volumes.set(rootCID, kept);
    return kept.volume;
  }

  async put(volume: VerifiedVolume): Promise<void> {
    const entries = volume.entries();
    const bytes = volumeBytes(entries);
    if (bytes > this.maximumBytes || this.#volumes.has(volume.rootCID)) return;
    this.#volumes.set(volume.rootCID, { volume: { rootCID: volume.rootCID, entries }, bytes });
    this.#bytes += bytes;
    for (const [rootCID, kept] of this.#volumes) {
      if (this.#bytes <= this.maximumBytes) break;
      this.#volumes.delete(rootCID);
      this.#bytes -= kept.bytes;
    }
  }

  async delete(rootCID: string): Promise<void> {
    const kept = this.#volumes.get(rootCID);
    if (kept === undefined) return;
    this.#volumes.delete(rootCID);
    this.#bytes -= kept.bytes;
  }
}

// Three stores: the Volumes, a small record of when each was last used and
// its size (so a hit writes a few bytes, not the Volume), and the total
// size. The total changes only inside the transaction that changes what is
// kept, so tabs sharing the database keep one count.
const VOLUMES = "volumes";
const USED = "used";
const TOTAL = "total";

interface Used {
  readonly rootCID: string;
  readonly bytes: number;
  readonly used: number;
}

const isUsed = (value: unknown): value is Used =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Used).rootCID === "string" &&
  Number.isSafeInteger((value as Used).bytes) &&
  (value as Used).bytes >= 0 &&
  Number.isFinite((value as Used).used);

const isVolume = (value: unknown, rootCID: string): value is SerializedVolume =>
  typeof value === "object" &&
  value !== null &&
  (value as SerializedVolume).rootCID === rootCID &&
  Array.isArray((value as SerializedVolume).entries) &&
  (value as SerializedVolume).entries.every(
    (entry) => typeof entry?.cid === "string" && entry.bytes instanceof Uint8Array,
  );

/**
 * Volumes kept in a browser's IndexedDB across visits, the least recently
 * used dropped past `maximumBytes`. Where IndexedDB is missing, refuses or
 * is held by another version (a private window, storage blocked or full), it
 * keeps nothing.
 *
 * A lookup costs little: lookups made together (a trie walk asks for a
 * node's children at once) share one transaction, and a hit's "last used"
 * is written later, with the others made meanwhile, in one transaction
 * `touchAfterMilliseconds` on, or sooner, inside the next `put` (before it
 * decides what to drop).
 */
export class IndexedDBVolumeCache implements VolumeCache {
  readonly maximumBytes: number;
  readonly #database: Promise<IDBDatabase | null>;
  readonly #now: () => number;
  readonly #touchAfter: number;
  // The read transaction lookups share while it is active.
  #reading: IDBObjectStore | null = null;
  // Hits not yet written as used: root CID → when.
  readonly #touched = new Map<string, number>();
  #touching: ReturnType<typeof setTimeout> | null = null;

  constructor({
    name = "lattice-volumes",
    maximumBytes = 64 * 1024 * 1024,
    indexedDB = globalThis.indexedDB,
    now = Date.now,
    touchAfterMilliseconds = 1000,
  }: {
    name?: string;
    maximumBytes?: number;
    indexedDB?: IDBFactory | undefined;
    now?: () => number;
    touchAfterMilliseconds?: number;
  } = {}) {
    this.maximumBytes = maximumBytes;
    this.#now = now;
    this.#touchAfter = touchAfterMilliseconds;
    this.#database = open(indexedDB, name).catch(() => null);
  }

  async get(rootCID: string): Promise<SerializedVolume | undefined> {
    try {
      const database = await this.#database;
      if (database === null) return undefined;
      const kept = await request<unknown>(this.#lookup(database, rootCID));
      if (kept === undefined) return undefined;
      if (!isVolume(kept, rootCID)) {
        void this.delete(rootCID);
        return undefined;
      }
      this.#touch(rootCID);
      return kept;
    } catch {
      return undefined;
    }
  }

  /** A lookup in the read transaction now active, or in a new one. */
  #lookup(database: IDBDatabase, rootCID: string): IDBRequest<unknown> {
    if (this.#reading !== null) {
      try {
        return this.#reading.get(rootCID);
      } catch {
        // It has finished: lookups from here on start another.
      }
    }
    const transaction = database.transaction(VOLUMES);
    const store = transaction.objectStore(VOLUMES);
    this.#reading = store;
    const finished = () => {
      if (this.#reading === store) this.#reading = null;
    };
    transaction.oncomplete = finished;
    transaction.onabort = finished;
    return store.get(rootCID);
  }

  /** Marks `rootCID` used now, written with the others in a moment. */
  #touch(rootCID: string): void {
    this.#touched.set(rootCID, this.#now());
    this.#touching ??= setTimeout(() => void this.#writeTouches(), this.#touchAfter);
  }

  /** Writes the hits made since the last write, in one transaction. */
  async #writeTouches(): Promise<void> {
    this.#touching = null;
    if (this.#touched.size === 0) return;
    try {
      const database = await this.#database;
      if (database === null) return;
      const transaction = database.transaction(USED, "readwrite");
      const done = completion(transaction);
      await this.#applyTouches(transaction.objectStore(USED));
      await done;
    } catch {
      // Their ages are a little off: they may be dropped a little early.
    }
  }

  /** Writes the pending hits as used, in `used`'s transaction: a few bytes each, never the Volume. */
  async #applyTouches(used: IDBObjectStore): Promise<void> {
    const touched = [...this.#touched];
    this.#touched.clear();
    const records = await Promise.all(
      touched.map(([rootCID]) => request<unknown>(used.get(rootCID))),
    );
    records.forEach((record, n) => {
      if (isUsed(record)) used.put({ ...record, used: Math.max(record.used, touched[n]![1]) });
    });
  }

  async put(volume: VerifiedVolume): Promise<void> {
    try {
      const database = await this.#database;
      if (database === null) return;
      const entries = volume.entries();
      const bytes = volumeBytes(entries);
      if (bytes > this.maximumBytes) return;
      const transaction = database.transaction([VOLUMES, USED, TOTAL], "readwrite");
      const volumes = transaction.objectStore(VOLUMES);
      const used = transaction.objectStore(USED);
      const totals = transaction.objectStore(TOTAL);
      const done = completion(transaction);
      // What was used meanwhile counts as used before anything is dropped.
      await this.#applyTouches(used);
      if ((await request(volumes.count(volume.rootCID))) > 0) return void (await done);
      let total = await totalOf(totals, used);
      volumes.put({ rootCID: volume.rootCID, entries });
      used.put({ rootCID: volume.rootCID, bytes, used: this.#now() });
      total += bytes;
      // The least recently used go first, in the same transaction.
      await cursor(used.index("used").openCursor(), (oldest) => {
        if (total <= this.maximumBytes) return false;
        const record = oldest.value as unknown;
        if (isUsed(record)) total -= record.bytes;
        volumes.delete(oldest.primaryKey);
        oldest.delete();
        return true;
      });
      totals.put(Math.max(0, total), TOTAL);
      await done;
    } catch {
      // Not kept: read again next time.
    }
  }

  async delete(rootCID: string): Promise<void> {
    try {
      const database = await this.#database;
      if (database === null) return;
      const transaction = database.transaction([VOLUMES, USED, TOTAL], "readwrite");
      const used = transaction.objectStore(USED);
      const totals = transaction.objectStore(TOTAL);
      const done = completion(transaction);
      const total = await totalOf(totals, used);
      const record = await request<unknown>(used.get(rootCID));
      transaction.objectStore(VOLUMES).delete(rootCID);
      used.delete(rootCID);
      totals.put(Math.max(0, total - (isUsed(record) ? record.bytes : 0)), TOTAL);
      await done;
    } catch {
      // Left as it is; it fails verification again next time.
    }
  }
}

async function open(factory: IDBFactory | undefined, name: string): Promise<IDBDatabase | null> {
  if (factory === undefined) return null;
  const opening = factory.open(name, 1);
  opening.onupgradeneeded = () => {
    const database = opening.result;
    database.createObjectStore(VOLUMES, { keyPath: "rootCID" });
    database.createObjectStore(USED, { keyPath: "rootCID" }).createIndex("used", "used");
    database.createObjectStore(TOTAL);
  };
  const database = await new Promise<IDBDatabase | null>((resolve, reject) => {
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
    // Another tab holds an older version open: keep nothing this visit.
    opening.onblocked = () => resolve(null);
  });
  // A newer version elsewhere: let it open.
  if (database !== null) database.onversionchange = () => database.close();
  return database;
}

/**
 * The total kept, as stored; counted again from the records when the stored
 * one is missing or not a size, and records that aren't sizes are dropped.
 */
async function totalOf(totals: IDBObjectStore, used: IDBObjectStore): Promise<number> {
  const stored = await request<unknown>(totals.get(TOTAL));
  if (Number.isSafeInteger(stored) && (stored as number) >= 0) return stored as number;
  let total = 0;
  const volumes = used.transaction.objectStore(VOLUMES);
  await cursor(used.openCursor(), (record) => {
    if (isUsed(record.value)) total += record.value.bytes;
    else {
      volumes.delete(record.primaryKey);
      record.delete();
    }
  });
  return total;
}

function request<T>(pending: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error);
  });
}

/** Resolves once `transaction` commits; rejects if it aborts. */
function completion(transaction: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
  done.catch(() => {});
  return done;
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
