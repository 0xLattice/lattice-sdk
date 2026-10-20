import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeNodeURL, declaredEndpointURL, getJSON } from "@adalin/lattice-client";
import { encodeDagCbor, decodeDagCbor } from "@adalin/lattice-core";

test("empty query and fragment delimiters cannot control node route suffixes", () => {
  for (const url of [
    "https://node.test/?",
    "https://node.test/#",
    "https://node.test/?x",
    "https://node.test/#x",
  ]) {
    assert.throws(() => normalizeNodeURL(url), /query, or a fragment/);
    assert.equal(declaredEndpointURL(url), undefined);
  }
  assert.equal(normalizeNodeURL("https://node.test/rpc/"), "https://node.test/rpc");
});

test("DAG-CBOR preserves BOM strings and treats __proto__ as data", () => {
  assert.equal(decodeDagCbor(encodeDagCbor("\uFEFFchild")), "\uFEFFchild");
  const input = Object.fromEntries([["__proto__", { polluted: true }]]);
  const result = decodeDagCbor(encodeDagCbor(input)) as Record<string, unknown>;
  assert.ok(Object.hasOwn(result, "__proto__"));
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(result.constructor, undefined);
  const bom = decodeDagCbor(encodeDagCbor({ "\uFEFFkey": "value" })) as Record<string, unknown>;
  assert.equal(bom["\uFEFFkey"], "value");
  assert.equal(bom.key, undefined);
  const copy = { ...result };
  assert.equal(Object.getPrototypeOf(copy), Object.prototype);
  assert.ok(Object.hasOwn(copy, "__proto__"));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("bounded JSON requests forbid redirects and carry cancellation", async () => {
  await getJSON(new URL("https://node.test/rpc/api/deposits"), {
    fetch: async (_url, init) => {
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
      return new Response("{}");
    },
    maximumResponseBytes: 1024,
  });
});

test("bounded JSON rejects an oversized streamed response", async () => {
  await assert.rejects(
    getJSON(new URL("https://node.test"), {
      fetch: async () => new Response("x".repeat(1025)),
      maximumResponseBytes: 1024,
    }),
    /response too large/,
  );
});

test("timeout bounds injected fetch and body even when cancellation is ignored", async () => {
  // Keep a ref'ed timer: AbortSignal.timeout alone does not keep Node alive.
  const keeper = setTimeout(() => {}, 1000);
  try {
    for (const fetch of [
      async () => new Promise<Response>(() => {}),
      async () =>
        new Response(
          new ReadableStream({
            pull: () => new Promise(() => {}),
            cancel: () => new Promise(() => {}),
          }),
        ),
    ]) {
      await assert.rejects(
        getJSON(new URL("https://node.test"), { fetch, timeoutMilliseconds: 30 }),
        { name: "TimeoutError" },
      );
    }
    const controller = new AbortController();
    const pending = getJSON(new URL("https://node.test"), {
      fetch: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })),
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
  } finally {
    clearTimeout(keeper);
  }
});
