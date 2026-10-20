import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertBlockContinuity,
  cidV1,
  cidV1DagCbor,
  decodeCanonicalBlock,
  decodeCanonicalLatticeState,
  encodeDagCbor,
  workForTarget,
} from "@adalin/lattice-core";
import {
  decodeVolumeArchive,
  encodeVolumeArchive,
  HTTPVolumeTransport,
  MemoryVolumeTransport,
  VOLUME_ARCHIVE_MEDIA_TYPE,
  VolumeClient,
  VolumeError,
  VolumeTransportError,
  verifyVolume,
} from "@adalin/lattice-volumes";

function rawArchive(entries: readonly { cid: string; bytes: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const size = entries.reduce(
    (total, entry) => total + 2 + encoder.encode(entry.cid).length + 4 + entry.bytes.length,
    2,
  );
  const result = new Uint8Array(size);
  const view = new DataView(result.buffer);
  view.setUint16(0, entries.length);
  let offset = 2;
  for (const entry of entries) {
    const cid = encoder.encode(entry.cid);
    view.setUint16(offset, cid.length);
    offset += 2;
    result.set(cid, offset);
    offset += cid.length;
    view.setUint32(offset, entry.bytes.length);
    offset += 4;
    result.set(entry.bytes, offset);
    offset += entry.bytes.length;
  }
  return result;
}

test("complete Volumes are CID-verified before use", async () => {
  const leafBytes = encodeDagCbor({ value: 42n });
  const leafCID = cidV1DagCbor(leafBytes);
  const rootBytes = encodeDagCbor({ child: { rawCID: leafCID } });
  const rootCID = cidV1DagCbor(rootBytes);
  const serialized = {
    rootCID,
    entries: [
      { cid: rootCID, bytes: rootBytes },
      { cid: leafCID, bytes: leafBytes },
    ],
  };
  const transport = new MemoryVolumeTransport([serialized]);
  const volume = await new VolumeClient(transport).get(rootCID);
  assert.equal(volume.size, 2);
  assert.deepEqual(
    volume.decodeRoot(),
    Object.assign(Object.create(null), {
      child: Object.assign(Object.create(null), { rawCID: leafCID }),
    }),
  );
});

test("a tampered member invalidates the whole Volume", () => {
  const bytes = encodeDagCbor({ value: 1n });
  const cid = cidV1DagCbor(bytes);
  const tampered = bytes.slice();
  tampered[tampered.length - 1] ^= 1;
  assert.throws(
    () => verifyVolume({ rootCID: cid, entries: [{ cid, bytes: tampered }] }),
    (error: unknown) => error instanceof VolumeError && error.code === "invalid-entry",
  );
});

test("a Volume must contain the requested root", () => {
  const rootBytes = encodeDagCbor({ root: true });
  const rootCID = cidV1DagCbor(rootBytes);
  const otherBytes = encodeDagCbor({ other: true });
  const otherCID = cidV1DagCbor(otherBytes);
  assert.throws(
    () => verifyVolume({ rootCID, entries: [{ cid: otherCID, bytes: otherBytes }] }),
    (error: unknown) => error instanceof VolumeError && error.code === "missing-root",
  );
});

test("Volume verification accepts non-DAG-CBOR members by CID", () => {
  const moduleBytes = Uint8Array.of(0x00, 0x61, 0x73, 0x6d);
  const moduleCID = cidV1(0x55, moduleBytes); // multicodec raw
  const volume = verifyVolume({
    rootCID: moduleCID,
    entries: [{ cid: moduleCID, bytes: moduleBytes }],
  });
  assert.deepEqual(volume.rootBytes(), moduleBytes);
  assert.throws(() => volume.decodeRoot(), /DAG-CBOR/);
});

test("Ivy Volume archives use canonical sorted, big-endian framing", () => {
  const secondBytes = encodeDagCbor({ second: true });
  const secondCID = cidV1DagCbor(secondBytes);
  const rootBytes = encodeDagCbor({ child: { rawCID: secondCID } });
  const rootCID = cidV1DagCbor(rootBytes);
  const entries = [
    { cid: rootCID, bytes: rootBytes },
    { cid: secondCID, bytes: secondBytes },
  ];
  const archive = encodeVolumeArchive({ rootCID, entries: entries.toReversed() });
  const sorted = entries.toSorted((left, right) => left.cid.localeCompare(right.cid));
  assert.deepEqual(archive, rawArchive(sorted));
  assert.deepEqual(decodeVolumeArchive(rootCID, archive), { rootCID, entries: sorted });
});

test("Ivy Volume archive decoding rejects noncanonical and truncated input", () => {
  const firstBytes = encodeDagCbor({ first: true });
  const firstCID = cidV1DagCbor(firstBytes);
  const secondBytes = encodeDagCbor({ second: true });
  const secondCID = cidV1DagCbor(secondBytes);
  const descending = [
    { cid: firstCID, bytes: firstBytes },
    { cid: secondCID, bytes: secondBytes },
  ].toSorted((left, right) => right.cid.localeCompare(left.cid));
  assert.throws(
    () => decodeVolumeArchive(firstCID, rawArchive(descending)),
    /duplicated or out of order/,
  );
  const valid = encodeVolumeArchive({
    rootCID: firstCID,
    entries: [descending[0]!, descending[1]!],
  });
  assert.throws(
    () => decodeVolumeArchive(firstCID, valid.subarray(0, valid.length - 1)),
    /truncated/,
  );
  const trailing = new Uint8Array(valid.length + 1);
  trailing.set(valid);
  assert.throws(() => decodeVolumeArchive(firstCID, trailing), /trailing bytes/);
});

test("every truncation of a valid Ivy archive fails closed", () => {
  const bytes = encodeDagCbor({ loadBearing: true, value: 42n });
  const rootCID = cidV1DagCbor(bytes);
  const archive = encodeVolumeArchive({ rootCID, entries: [{ cid: rootCID, bytes }] });
  for (let length = 0; length < archive.length; length += 1) {
    assert.throws(
      () => decodeVolumeArchive(rootCID, archive.subarray(0, length)),
      undefined,
      `length ${length}`,
    );
  }
  for (let offset = archive.length - bytes.length; offset < archive.length; offset += 1) {
    const mutated = archive.slice();
    mutated[offset] ^= 1;
    assert.throws(() => decodeVolumeArchive(rootCID, mutated), undefined, `payload byte ${offset}`);
  }
});

test("HTTP Volume transport retrieves and verifies Ivy archives", async () => {
  const bytes = encodeDagCbor({ value: 9n });
  const rootCID = cidV1DagCbor(bytes);
  const archive = encodeVolumeArchive({ rootCID, entries: [{ cid: rootCID, bytes }] });
  let request: { url: string; init?: RequestInit } | undefined;
  const transport = new HTTPVolumeTransport("https://content.example.org/volumes", {
    authorization: "Bearer private",
    chainPath: ["Nexus", "Alpha"],
    fetch: async (input, init) => {
      request = { url: String(input), ...(init === undefined ? {} : { init }) };
      return new Response(archive, {
        headers: { "Content-Type": VOLUME_ARCHIVE_MEDIA_TYPE },
      });
    },
  });
  const volume = await new VolumeClient(transport).get(rootCID);
  assert.deepEqual(volume.decodeRoot(), Object.assign(Object.create(null), { value: 9n }));
  assert.equal(
    request?.url,
    `https://content.example.org/volumes/${rootCID}?chainPath=Nexus%2FAlpha`,
  );
  assert.equal(new Headers(request?.init?.headers).get("Authorization"), "Bearer private");
  assert.equal(request?.init?.redirect, "error");
});

test("HTTP Volume transport has a bounded and explicit trust boundary", async () => {
  assert.throws(
    () => new HTTPVolumeTransport("http://content.example.org/volumes"),
    /must use HTTPS/,
  );
  assert.doesNotThrow(() => new HTTPVolumeTransport("http://127.0.0.1:8080/volumes"));
  assert.throws(
    () =>
      new HTTPVolumeTransport("https://content.example.org/volumes", {
        chainPath: [],
      }),
    /nonempty components/,
  );
  const missing = new HTTPVolumeTransport("https://content.example.org/volumes", {
    fetch: async () => new Response(null, { status: 404 }),
  });
  assert.equal(await missing.getVolume("bafyunknown"), null);
  const wrongType = new HTTPVolumeTransport("https://content.example.org/volumes", {
    fetch: async () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
  });
  await assert.rejects(
    wrongType.getVolume("bafyunknown"),
    (error: unknown) =>
      error instanceof VolumeTransportError && /application\/json/.test(error.message),
  );
  const tooLarge = new HTTPVolumeTransport("https://content.example.org/volumes", {
    fetch: async () =>
      new Response(new Uint8Array(), {
        headers: {
          "Content-Type": VOLUME_ARCHIVE_MEDIA_TYPE,
          "Content-Length": String(64 * 1024 * 1024 + 1),
        },
      }),
  });
  await assert.rejects(tooLarge.getVolume("bafyunknown"), /too large/);
});

test("typed state roots and block continuity are verified locally", () => {
  const stateBytes = encodeDagCbor({
    accountState: { rawCID: "accounts" },
    generalState: { rawCID: "general" },
    depositState: { rawCID: "deposits" },
    receiptState: { rawCID: "receipts" },
  });
  assert.deepEqual(decodeCanonicalLatticeState(stateBytes), {
    accountStateCID: "accounts",
    generalStateCID: "general",
    depositStateCID: "deposits",
    receiptStateCID: "receipts",
  });
  const block = (height: bigint, state: string, parent?: string) =>
    decodeCanonicalBlock(
      encodeDagCbor({
        version: 1n,
        ...(parent === undefined ? {} : { parent: { rawCID: parent } }),
        transactions: { rawCID: "transactions" },
        target: "0xff",
        nextTarget: "0xff",
        spec: { rawCID: "spec" },
        parentState: { rawCID: "parent-state" },
        prevState: { rawCID: state },
        postState: { rawCID: `${state}-next` },
        children: { rawCID: "children" },
        height,
        timestamp: 1n,
        nonce: 0n,
      }),
    );
  const parent = block(4n, "s3");
  const child = block(5n, parent.postStateCID, "parent-cid");
  assert.doesNotThrow(() => assertBlockContinuity("parent-cid", parent, child));
  assert.throws(
    () => assertBlockContinuity("other-fork", parent, child),
    /does not commit to the parent/,
  );
});

test("Lattice inclusive target work handles consensus boundaries", () => {
  assert.equal(workForTarget(`0x${"f".repeat(64)}`), 1n);
  assert.equal(workForTarget("0x1"), 1n << 255n);
  assert.equal(workForTarget("0x0"), 0n);
  assert.throws(() => workForTarget("0X01"), /canonical hex/);
});
