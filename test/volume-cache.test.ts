import assert from "node:assert/strict";
import { test } from "node:test";

import { IDBFactory } from "fake-indexeddb";

import { cidV1DagCbor, encodeDagCbor } from "@adalin/lattice-core";
import {
  BatchingVolumeTransport,
  decodeVolumeRecords,
  encodeVolumeArchive,
  HTTPVolumeTransport,
  IndexedDBVolumeCache,
  MANY_VOLUMES_MEDIA_TYPE,
  type ManyVolumeTransport,
  MemoryVolumeCache,
  MemoryVolumeTransport,
  type SerializedVolume,
  VolumeClient,
  VolumeTransportError,
  verifyVolume,
} from "@adalin/lattice-volumes";

/** A one-member Volume holding `value`. */
function volumeOf(value: unknown): SerializedVolume {
  const bytes = encodeDagCbor({ value });
  const rootCID = cidV1DagCbor(bytes);
  return { rootCID, entries: [{ cid: rootCID, bytes }] };
}

/** `transport` counting the reads that reach it. */
function counted(volumes: readonly SerializedVolume[]) {
  const memory = new MemoryVolumeTransport(volumes);
  const asked: string[] = [];
  return {
    asked,
    getVolume: (rootCID: string) => (asked.push(rootCID), memory.getVolume(rootCID)),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a kept Volume is read from the cache, and only verified Volumes are kept", async () => {
  const good = volumeOf(1n);
  const forged = { rootCID: volumeOf(2n).rootCID, entries: good.entries };
  const transport = counted([good]);
  const cache = new MemoryVolumeCache();
  const client = new VolumeClient(transport, undefined, { cache });
  await client.get(good.rootCID);
  await settle();
  assert.deepEqual((await client.get(good.rootCID)).rootBytes(), good.entries[0]!.bytes);
  assert.deepEqual(transport.asked, [good.rootCID]);
  // A Volume that fails verification is neither returned nor kept.
  const lying = new VolumeClient({ getVolume: async () => forged }, undefined, { cache });
  await assert.rejects(lying.get(forged.rootCID));
  await settle();
  assert.equal(await cache.get(forged.rootCID), undefined);
});

test("a cache that fails is a miss, never an error", async () => {
  const volume = volumeOf(3n);
  const broken = {
    get: async () => {
      throw new Error("broken");
    },
    put: async () => {
      throw new Error("broken");
    },
  };
  const client = new VolumeClient(new MemoryVolumeTransport([volume]), undefined, {
    cache: broken,
  });
  assert.equal((await client.get(volume.rootCID)).rootCID, volume.rootCID);
});

test("the memory cache drops the least recently used past its bound", async () => {
  const [a, b, c] = [volumeOf("a"), volumeOf("b"), volumeOf("c")].map((v) =>
    verifyVolume(v, v.rootCID),
  );
  const size = a!.entries()[0]!.bytes.byteLength;
  const cache = new MemoryVolumeCache({ maximumBytes: size * 2 });
  await cache.put(a!);
  await cache.put(b!);
  await cache.get(a!.rootCID); // a is used again: b is now the oldest
  await cache.put(c!);
  assert.ok(await cache.get(a!.rootCID));
  assert.equal(await cache.get(b!.rootCID), undefined);
  assert.ok(await cache.get(c!.rootCID));
});

test("IndexedDB keeps Volumes across instances, dropping the least recently used", async () => {
  const indexedDB = new IDBFactory();
  let clock = 0;
  const now = () => ++clock;
  const [a, b, c] = [volumeOf("a"), volumeOf("b"), volumeOf("c")].map((v) =>
    verifyVolume(v, v.rootCID),
  );
  const size = a!.entries()[0]!.bytes.byteLength;
  const first = new IndexedDBVolumeCache({ indexedDB, maximumBytes: size * 2, now });
  await first.put(a!);
  await first.put(b!);
  // A later visit: what was kept is there, checked bytes and all.
  const second = new IndexedDBVolumeCache({ indexedDB, maximumBytes: size * 2, now });
  assert.deepEqual((await second.get(a!.rootCID))?.entries[0]?.bytes, a!.rootBytes());
  await second.put(c!);
  assert.equal(await second.get(b!.rootCID), undefined);
  assert.ok(await second.get(a!.rootCID));
  assert.ok(await second.get(c!.rootCID));
});

test("without IndexedDB nothing is kept, and nothing fails", async () => {
  const cache = new IndexedDBVolumeCache({ indexedDB: undefined });
  const volume = volumeOf(4n);
  await cache.put(verifyVolume(volume, volume.rootCID));
  assert.equal(await cache.get(volume.rootCID), undefined);
});

/** A transport answering many at once from `volumes`, recording each request. */
function many(volumes: readonly SerializedVolume[], { route = true } = {}) {
  const memory = new MemoryVolumeTransport(volumes);
  const requests: string[][] = [];
  const transport: ManyVolumeTransport = {
    getVolume: async (rootCID) => (requests.push([rootCID]), memory.getVolume(rootCID)),
    getVolumes: async (rootCIDs) => {
      requests.push([...rootCIDs]);
      if (!route) throw new VolumeTransportError("no such route", 404);
      const found = new Map<string, SerializedVolume>();
      for (const rootCID of rootCIDs) {
        const volume = await memory.getVolume(rootCID);
        if (volume !== null) found.set(rootCID, volume);
      }
      return found;
    },
  };
  return { transport, requests };
}

test("reads made together are one request", async () => {
  const volumes = [volumeOf(1n), volumeOf(2n), volumeOf(3n)];
  const { transport, requests } = many(volumes);
  const batching = new BatchingVolumeTransport(transport);
  const read = await Promise.all(volumes.map((v) => batching.getVolume(v.rootCID)));
  assert.deepEqual(
    read.map((v) => v?.rootCID),
    volumes.map((v) => v.rootCID),
  );
  assert.deepEqual(requests, [volumes.map((v) => v.rootCID)]);
});

test("a root the answer leaves out is read on its own; one nobody holds is null", async () => {
  const held = volumeOf(1n);
  const missing = volumeOf(2n).rootCID;
  const { transport, requests } = many([held]);
  const batching = new BatchingVolumeTransport(transport);
  const [a, b] = await Promise.all([batching.getVolume(held.rootCID), batching.getVolume(missing)]);
  assert.equal(a?.rootCID, held.rootCID);
  assert.equal(b, null);
  assert.deepEqual(requests, [[held.rootCID, missing], [missing]]);
});

test("without the route, reads go one by one from then on", async () => {
  const volumes = [volumeOf(1n), volumeOf(2n)];
  const { transport, requests } = many(volumes, { route: false });
  const batching = new BatchingVolumeTransport(transport);
  await Promise.all(volumes.map((v) => batching.getVolume(v.rootCID)));
  await Promise.all(volumes.map((v) => batching.getVolume(v.rootCID)));
  assert.equal(requests.filter((r) => r.length > 1).length, 1);
  assert.equal(requests.filter((r) => r.length === 1).length, 4);
});

test("a batch is at most maximumBatch roots, and a read's abort is its own", async () => {
  const volumes = [volumeOf(1n), volumeOf(2n), volumeOf(3n)];
  const { transport, requests } = many(volumes);
  const batching = new BatchingVolumeTransport(transport, { maximumBatch: 2 });
  const stop = new AbortController();
  const reads = volumes.map((v, n) =>
    batching.getVolume(v.rootCID, n === 0 ? stop.signal : undefined),
  );
  stop.abort(new Error("stopped"));
  await assert.rejects(reads[0]!, /stopped/);
  assert.equal((await reads[1]!)?.rootCID, volumes[1]!.rootCID);
  assert.equal((await reads[2]!)?.rootCID, volumes[2]!.rootCID);
  assert.ok(requests.every((r) => r.length <= 2));
});

/** A many-Volumes answer, as the node frames it: each archive under the root named. */
function records(
  volumes: readonly SerializedVolume[],
  named = volumes.map((v) => v.rootCID),
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [n, volume] of volumes.entries()) {
    const root = new TextEncoder().encode(named[n]!);
    const archive = encodeVolumeArchive(volume);
    const head = new Uint8Array(2 + root.length + 4);
    const view = new DataView(head.buffer);
    view.setUint16(0, root.length);
    head.set(root, 2);
    view.setUint32(2 + root.length, archive.length);
    parts.push(head, archive);
  }
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}

test("HTTP: many Volumes in one GET, each decoded and checked against the root asked", async () => {
  const [a, b, stray] = [volumeOf(1n), volumeOf(2n), volumeOf(3n)];
  let url: URL | undefined;
  const transport = new HTTPVolumeTransport("https://node.example/volumes/", {
    chainPath: ["Nexus", "s"],
    fetch: async (input) => {
      url = new URL(input);
      return new Response(records([a!, stray!]), {
        headers: { "content-type": MANY_VOLUMES_MEDIA_TYPE },
      });
    },
  });
  const found = await transport.getVolumes([a!.rootCID, b!.rootCID]);
  assert.equal(url?.pathname, "/volumes");
  assert.equal(url?.searchParams.get("cids"), `${a!.rootCID},${b!.rootCID}`);
  assert.equal(url?.searchParams.get("chainPath"), "Nexus/s");
  // b isn't held; stray wasn't asked for.
  assert.deepEqual([...found.keys()], [a!.rootCID]);
});

test("HTTP: a record whose archive doesn't hold its root fails the answer", async () => {
  const [a, b] = [volumeOf(1n), volumeOf(2n)];
  // b's archive, named as a's.
  const forged = records([b!], [a!.rootCID]);
  const transport = new HTTPVolumeTransport("https://node.example/volumes", {
    fetch: async () =>
      new Response(forged, { headers: { "content-type": MANY_VOLUMES_MEDIA_TYPE } }),
  });
  await assert.rejects(transport.getVolumes([a!.rootCID]));
});

test("HTTP: a node without the route is a transport error with its status", async () => {
  const transport = new HTTPVolumeTransport("https://node.example/volumes", {
    fetch: async () => new Response("", { status: 404 }),
  });
  await assert.rejects(transport.getVolumes(["bafy"]), (error: unknown) => {
    return error instanceof VolumeTransportError && error.status === 404;
  });
});

test("truncated many-Volumes answers are refused", () => {
  const body = records([volumeOf(1n)]);
  assert.throws(() => decodeVolumeRecords(body.subarray(0, body.length - 1)), /truncated/);
  assert.deepEqual(decodeVolumeRecords(new Uint8Array()), []);
});

/** Writes `record` straight into the cache's store, as another script on the origin could. */
async function plant(indexedDB: IDBFactory, store: string, record: unknown, key?: string) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open("lattice-volumes", 1);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, "readwrite");
    if (key === undefined) transaction.objectStore(store).put(record);
    else transaction.objectStore(store).put(record, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

test("a kept Volume that fails verification is a miss, read from the node and dropped", async () => {
  const indexedDB = new IDBFactory();
  const [real, other] = [volumeOf("real"), volumeOf("other")];
  const cache = new IndexedDBVolumeCache({ indexedDB });
  await cache.get(real.rootCID); // opened, stores made
  await plant(indexedDB, "volumes", { rootCID: real.rootCID, entries: other.entries });
  const transport = counted([real]);
  const client = new VolumeClient(transport, undefined, { cache });
  assert.deepEqual((await client.get(real.rootCID)).rootBytes(), real.entries[0]!.bytes);
  assert.deepEqual(transport.asked, [real.rootCID]);
  await settle();
  // The forged one is gone; the real one, verified, kept in its place.
  assert.deepEqual((await cache.get(real.rootCID))?.entries, real.entries);
});

test("a kept Volume is held to the reading client's limits", async () => {
  const big = volumeOf("x".repeat(500));
  const cache = new MemoryVolumeCache();
  await cache.put(verifyVolume(big, big.rootCID));
  const strict = new VolumeClient(
    new MemoryVolumeTransport([]),
    { maximumEntries: 10, maximumBytes: 100 },
    { cache },
  );
  // Over this client's limits: not taken from the cache, so read (and not found) here.
  await assert.rejects(strict.get(big.rootCID), /not found/);
});

test("a cache that never answers keeps a read waiting only a moment", async () => {
  const volume = volumeOf(5n);
  const hung = { get: () => new Promise<undefined>(() => {}), put: async () => {} };
  const client = new VolumeClient(new MemoryVolumeTransport([volume]), undefined, {
    cache: hung,
    cacheWaitMilliseconds: 10,
  });
  assert.equal((await client.get(volume.rootCID)).rootCID, volume.rootCID);
  const throwing = {
    get: () => {
      throw new Error("sync");
    },
    put: async () => {},
  };
  const other = new VolumeClient(new MemoryVolumeTransport([volume]), undefined, {
    cache: throwing,
  });
  assert.equal((await other.get(volume.rootCID)).rootCID, volume.rootCID);
});

test("records that aren't sizes are dropped, and the bound still holds", async () => {
  const indexedDB = new IDBFactory();
  const volumes = ["a", "b", "c", "d", "e"].map((v) =>
    verifyVolume(volumeOf(v), volumeOf(v).rootCID),
  );
  const size = volumes[0]!.entries()[0]!.bytes.byteLength;
  const cache = new IndexedDBVolumeCache({ indexedDB, maximumBytes: size * 2 });
  await cache.get("x");
  await plant(indexedDB, "used", { rootCID: "legacy", used: 0 });
  await plant(indexedDB, "total", Number.NaN, "total");
  for (const volume of volumes) await cache.put(volume);
  const kept = await Promise.all(volumes.map((v) => cache.get(v.rootCID)));
  assert.equal(kept.filter(Boolean).length, 2);
});

test("tabs sharing the database keep one total", async () => {
  const indexedDB = new IDBFactory();
  const volumes = ["a", "b", "c", "d"].map((v) => verifyVolume(volumeOf(v), volumeOf(v).rootCID));
  const size = volumes[0]!.entries()[0]!.bytes.byteLength;
  const one = new IndexedDBVolumeCache({ indexedDB, maximumBytes: size * 3 });
  const two = new IndexedDBVolumeCache({ indexedDB, maximumBytes: size * 3 });
  for (const [n, volume] of volumes.entries()) await (n % 2 ? two : one).put(volume);
  const kept = await Promise.all(volumes.map((v) => one.get(v.rootCID)));
  assert.equal(kept.filter(Boolean).length, 3);
});

test("a transport that throws at once fails its reads instead of leaving them waiting", async () => {
  const transport: ManyVolumeTransport = {
    getVolume: () => {
      throw new Error("refused at once");
    },
    getVolumes: async () => new Map(),
  };
  const batching = new BatchingVolumeTransport(transport);
  const reads = [batching.getVolume("bafya"), batching.getVolume("bafyb")];
  for (const read of reads) await assert.rejects(read, /refused at once/);
});

test("an abort reaches the fetch once no other read waits on it", async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const transport: ManyVolumeTransport = {
    getVolume: (_root, signal) => {
      signals.push(signal);
      return new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason)),
      );
    },
    getVolumes: async () => new Map(),
  };
  const batching = new BatchingVolumeTransport(transport);
  const [first, second] = [new AbortController(), new AbortController()];
  const reads = [
    batching.getVolume("bafya", first.signal),
    batching.getVolume("bafya", second.signal),
  ];
  await settle();
  first.abort(new Error("first"));
  await assert.rejects(reads[0]!, /first/);
  assert.equal(signals[0]?.aborted, false); // the second still waits on it
  second.abort(new Error("second"));
  await assert.rejects(reads[1]!, /second/);
  assert.equal(signals[0]?.aborted, true);
});

test("after a failed many-Volumes request, reads go one at a time for a while", async () => {
  let clock = 0;
  const volumes = [volumeOf(1n), volumeOf(2n)];
  const memory = new MemoryVolumeTransport(volumes);
  let manyAsked = 0;
  const transport: ManyVolumeTransport = {
    getVolume: (root) => memory.getVolume(root),
    getVolumes: async () => {
      manyAsked += 1;
      throw new VolumeTransportError("busy", 503);
    },
  };
  const batching = new BatchingVolumeTransport(transport, {
    backoffMilliseconds: 100,
    now: () => clock,
  });
  const round = () => Promise.all(volumes.map((v) => batching.getVolume(v.rootCID)));
  await round();
  await round();
  assert.equal(manyAsked, 1);
  clock = 200;
  await round();
  assert.equal(manyAsked, 2);
});

test("reads behind an IndexedDB cache are still asked together", async () => {
  const volumes = [volumeOf(1n), volumeOf(2n), volumeOf(3n), volumeOf(4n)];
  const { transport, requests } = many(volumes);
  const cache = new IndexedDBVolumeCache({ indexedDB: new IDBFactory() });
  const client = new VolumeClient(new BatchingVolumeTransport(transport), undefined, { cache });
  await Promise.all(volumes.map((v) => client.get(v.rootCID)));
  assert.deepEqual(requests, [volumes.map((v) => v.rootCID)]);
});

test("a many-Volumes request that can't reach the node fails its reads at once", async () => {
  const asked: string[] = [];
  const transport: ManyVolumeTransport = {
    getVolume: async (root) => (asked.push(root), null),
    getVolumes: async () => {
      throw new TypeError("Failed to fetch");
    },
  };
  const batching = new BatchingVolumeTransport(transport);
  const reads = [batching.getVolume("bafya"), batching.getVolume("bafyb")];
  for (const read of reads) await assert.rejects(read, /Failed to fetch/);
  // Not asked again one by one on the same node: the reader moves on.
  assert.deepEqual(asked, []);
});
