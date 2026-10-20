import assert from "node:assert/strict";
import { test } from "node:test";

import { NodeClient } from "@adalin/lattice-client";
import { nodeCookieAuthorization } from "@adalin/lattice-core";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("the node client uses unversioned read routes and exact bigint fields", async () => {
  const requested: string[] = [];
  const fetch = async (input: string | URL): Promise<Response> => {
    const url = new URL(input);
    requested.push(`${url.pathname}?${url.searchParams.toString()}`);
    return response({ owner: "alice", balance: "18446744073709551615", nonce: "9007199254740993" });
  };
  const client = new NodeClient("https://reads.example.org", ["Nexus", "Alpha"], { fetch });
  const account = await client.account("alice");
  assert.equal(account.balance, 18_446_744_073_709_551_615n);
  assert.equal(account.nonce, 9_007_199_254_740_993n);
  assert.deepEqual(requested, ["/api/state/account/alice?chainPath=Nexus%2FAlpha"]);
  assert.equal("submit" in client, false);
});

test("legacy JSON-number consensus fields are rejected", async () => {
  const fetch = async (): Promise<Response> => response({ owner: "alice", balance: 1, nonce: "0" });
  const client = new NodeClient("https://reads.example.org", ["Nexus"], { fetch });
  await assert.rejects(client.account("alice"), /balance must be a canonical decimal string/);
});

test("latest block is its own summary wire shape", async () => {
  const fetch = async (): Promise<Response> =>
    response({
      height: "42",
      hash: "bafylatest",
      transactionCount: 3,
      timestamp: "1000",
      rewardCredited: "25",
    });
  const client = new NodeClient("https://reads.example.org", ["Nexus"], { fetch });
  const latest = await client.latestBlock();
  assert.equal(latest.height, 42n);
  assert.equal(latest.hash, "bafylatest");
  assert.equal(latest.rewardCredited, 25n);
});

test("insecure remote node URLs are rejected", () => {
  assert.throws(() => new NodeClient("http://reads.example.org", ["Nexus"]), /must use HTTPS/);
  assert.doesNotThrow(() => new NodeClient("http://127.0.0.1:8080", ["Nexus"]));
});

test("the default fetch is called with a valid receiver (browser Illegal invocation)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = function (this: unknown) {
    // Browsers throw "Illegal invocation" when fetch's receiver is not the global.
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(response({ owner: "alice", balance: "1", nonce: "0" }));
  } as typeof fetch;
  try {
    const client = new NodeClient("https://reads.example.org", ["Nexus"]);
    assert.equal((await client.account("alice")).balance, 1n);
  } finally {
    globalThis.fetch = original;
  }
});

test("an operator-port client sends the node cookie; health parses bestHeaderHeight", async () => {
  const seen: (string | null)[] = [];
  const fetch = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
    seen.push(new Headers(init?.headers).get("Authorization"));
    return response({
      phase: "active",
      chainPath: ["Nexus"],
      nexusGenesisCID: "bafygenesis",
      tipCID: "bafytip",
      height: "40",
      mempoolCount: 0,
      mempoolBytes: 0,
      bestHeaderHeight: "57",
    });
  };
  const authorization = nodeCookieAuthorization("__cookie__:abc123\n");
  assert.equal(authorization, `Basic ${btoa("__cookie__:abc123")}`);
  assert.equal(nodeCookieAuthorization("abc123"), "Bearer abc123");
  assert.throws(() => nodeCookieAuthorization("  "), /non-empty/);
  const operator = new NodeClient("http://127.0.0.1:8080", ["Nexus"], { fetch, authorization });
  const status = await operator.health();
  assert.equal(status.height, 40n);
  assert.equal(status.bestHeaderHeight, 57n);
  await new NodeClient("https://reads.example.org", ["Nexus"], { fetch }).health();
  assert.deepEqual(seen, [authorization, null]);
});
