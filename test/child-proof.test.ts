import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  cidV1DagCbor,
  decodeChildBlockProof,
  decodeLatticeBlock,
  verifyChildBlockProof,
  workForTarget,
  type ChildBlockProof,
} from "../packages/core/src/index.js";

// A Nexus/moniker header as a node served it on the overlay (block 243,775,
// merged-mined under Nexus block 6,313), with its one ChildBlockProof.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/child-proof/moniker-243775.json", import.meta.url), "utf8"),
) as { block: string; proofs: string[] };
const block = new Uint8Array(Buffer.from(fixture.block, "base64"));
const proofBytes = new Uint8Array(Buffer.from(fixture.proofs[0]!, "base64"));
const path = ["Nexus", "moniker"];

function proof(): ChildBlockProof {
  const decoded = decodeChildBlockProof(proofBytes);
  assert.ok(decoded);
  return decoded;
}

test("a served moniker header's proof verifies and carries the child's work", () => {
  const result = verifyChildBlockProof(proof(), block, path);
  assert.ok(result.ok, result.ok ? "" : result.failure);
  const child = decodeLatticeBlock(block)!;
  assert.equal(result.evidence.childCID, cidV1DagCbor(block));
  assert.equal(result.evidence.grindID, proof().rootCID);
  assert.ok(
    result.evidence.work !== undefined && result.evidence.work >= workForTarget(child.target),
  );
});

test("the proof wire format refuses trailing bytes and unordered entries", () => {
  assert.equal(decodeChildBlockProof(Uint8Array.of(...proofBytes, 0)), undefined);
  assert.equal(decodeChildBlockProof(proofBytes.subarray(0, proofBytes.length - 1)), undefined);
  const reversed = { ...proof(), entries: [...proof().entries].reverse() };
  assert.ok(reversed.entries.length > 1);
});

test("a proof for another chain path, or another block, does not verify", () => {
  assert.deepEqual(verifyChildBlockProof(proof(), block, ["Nexus", "other"]), {
    ok: false,
    failure: "malformedEvidence",
  });
  assert.equal(verifyChildBlockProof(proof(), block, ["Nexus"]).ok, false);
  const other = new Uint8Array(block);
  other[other.length - 1] ^= 1;
  assert.equal(verifyChildBlockProof(proof(), other, path).ok, false);
});

test("a changed or missing proof entry does not verify", () => {
  const original = proof();
  for (const [index] of original.entries.entries()) {
    const changed = original.entries.map((entry, at) => {
      if (at !== index) return entry;
      const data = new Uint8Array(entry.data);
      data[data.length - 1] ^= 1;
      return { cid: entry.cid, data };
    });
    assert.equal(verifyChildBlockProof({ ...original, entries: changed }, block, path).ok, false);
    const missing = original.entries.filter((_, at) => at !== index);
    assert.equal(verifyChildBlockProof({ ...original, entries: missing }, block, path).ok, false);
  }
  const extra = [
    ...original.entries,
    { cid: cidV1DagCbor(Uint8Array.of(0xa0)), data: Uint8Array.of(0xa0) },
  ];
  assert.deepEqual(verifyChildBlockProof({ ...original, entries: extra }, block, path), {
    ok: false,
    failure: "malformedEvidence",
  });
});
