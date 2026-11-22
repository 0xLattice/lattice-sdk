import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  bytesToHex,
  canonicalBlockProofOfWorkPreimage,
  decodeCanonicalBlock,
  hexToBytes,
} from "@adalin/lattice-core";
import { shareHash } from "@adalin/lattice-relay";
import { findShares, searchShares } from "@adalin/lattice-sdk";

const encoding = JSON.parse(
  readFileSync(new URL("../.cache/lattice-vectors/encoding.json", import.meta.url), "utf8"),
);
const genesis = () =>
  decodeCanonicalBlock(
    hexToBytes(
      encoding.vectors.find((entry: { name: string }) => entry.name === "block/genesis").dagCborHex,
    ),
  );

test("the proof-of-work preimage writes a target with leading zeros as all 64 hex digits", () => {
  const target = "0x" + "00000fff" + "f".repeat(56);
  const nextTarget = "0x1";
  const text = new TextDecoder().decode(
    canonicalBlockProofOfWorkPreimage({ ...genesis(), target, nextTarget }),
  );
  const fields = text.split("\0");
  // version, parent, transactions, then the two targets.
  assert.equal(fields[3], "00000fff" + "f".repeat(56));
  assert.equal(fields[4], "0".repeat(63) + "1");
});

test("the shares found are exactly the nonces whose share hash is at most the target", () => {
  const target = (1n << 252n) - 1n;
  // Prefix lengths that put the nonce in one block, across two, and before a padding block.
  for (const length of [3, 55, 60, 120, 632]) {
    const prefixHex = bytesToHex(Uint8Array.from({ length }, (_, index) => (index * 37) & 0xff));
    const start = (5n << 32n) | 0xfffff800n; // the nonce's low word wraps inside the range
    const expected: bigint[] = [];
    for (let index = 0n; index < 4096n; index++) {
      const hash = BigInt("0x" + bytesToHex(shareHash(prefixHex, start + index)));
      if (hash <= target) expected.push(start + index);
    }
    assert.ok(expected.length > 0);
    assert.deepEqual(
      searchShares(prefixHex, target.toString(16).padStart(64, "0"), start, 4096),
      expected,
      `prefix of ${length} bytes`,
    );
  }
});

test("a target equal to a share's hash takes it", () => {
  const hash = bytesToHex(shareHash("00ff", 9n));
  assert.deepEqual(searchShares("00ff", hash, 9n, 1), [9n]);
});

test("findShares stops at an expired range and reports its hashing", async () => {
  let hashes = 0;
  const work = {
    prefixHex: "00ff",
    shareTarget: (1n << 256n) - 1n,
    startNonce: 0n,
    count: 3n,
    expiresAt: Date.now() + 60_000,
  };
  const found: bigint[] = [];
  for await (const nonce of findShares(work, { onHashes: (count) => (hashes += count) }))
    found.push(nonce);
  assert.deepEqual(found, [0n, 1n, 2n]);
  assert.equal(hashes, 3);
  const expired: bigint[] = [];
  for await (const nonce of findShares({ ...work, expiresAt: Date.now() - 1 })) expired.push(nonce);
  assert.deepEqual(expired, []);
});
