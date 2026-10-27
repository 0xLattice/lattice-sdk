import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTransfer, transactionPayload, type TransactionPayload } from "@adalin/lattice-core";
import {
  HTTPTransactionSubmitter,
  SUBMISSION_REFUSALS,
  SubmissionError,
} from "@adalin/lattice-relay";

test("submission is explicit and preserves integers as decimal strings", async () => {
  let submitted: TransactionPayload | undefined;
  const fetch = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
    submitted = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ transactionCID: "bafytransaction" }), { status: 200 });
  };
  const body = buildTransfer({
    from: "alice",
    to: "bob",
    amount: 9_007_199_254_740_993n,
    fee: 1n,
    nonce: 9_007_199_254_740_993n,
    chainPath: ["Nexus"],
  });
  const payload = transactionPayload({ ed01: "signature" }, body);
  const submitter = new HTTPTransactionSubmitter("https://relay.example.org/transactions", {
    fetch,
  });
  assert.equal((await submitter.submit(payload)).transactionCID, "bafytransaction");
  assert.equal(submitted?.transaction.body.nonce, "9007199254740993");
  assert.equal(submitted?.transaction.body.accountActions[0]?.delta, "-9007199254740994");
});

test("a relay endpoint must be explicitly secure or loopback", () => {
  assert.throws(
    () => new HTTPTransactionSubmitter("http://relay.example.org/transactions"),
    /must use HTTPS/,
  );
  assert.doesNotThrow(() => new HTTPTransactionSubmitter("http://localhost:8080/transactions"));
});

test("the submitter posts exactly the node's POST /transactions shape", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    request = { url: String(input), ...(init === undefined ? {} : { init }) };
    return new Response(
      JSON.stringify({ transactionCID: "bafytx", mempoolCount: 4, mempoolBytes: 2600 }),
    );
  };
  const body = buildTransfer({
    from: "alice",
    to: "bob",
    amount: 10n,
    fee: 2n,
    nonce: 0n,
    chainPath: ["Nexus", "Alpha"],
  });
  const submitter = new HTTPTransactionSubmitter("https://relay.example.org/transactions", {
    fetch,
  });
  assert.deepEqual(await submitter.submit(transactionPayload({ ed01key: "sig" }, body)), {
    transactionCID: "bafytx",
    mempoolCount: 4,
    mempoolBytes: 2600,
  });
  assert.equal(request?.url, "https://relay.example.org/transactions");
  assert.equal(request?.init?.method, "POST");
  assert.deepEqual(request?.init?.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    transaction: {
      signatures: { ed01key: "sig" },
      body: {
        accountActions: [
          { owner: "alice", delta: "-12" },
          { owner: "bob", delta: "10" },
        ],
        actions: [],
        depositActions: [],
        receiptActions: [],
        withdrawalActions: [],
        signers: ["alice"],
        nonce: "0",
        chainPath: ["Nexus", "Alpha"],
      },
    },
  });
});

test("named node refusals surface as typed submission errors", async () => {
  const refusing = (status: number, body: string) =>
    new HTTPTransactionSubmitter("https://relay.example.org/transactions", {
      fetch: async () => new Response(body, { status }),
    });
  const payload = transactionPayload(
    {},
    buildTransfer({ from: "a", to: "b", amount: 1n, fee: 0n, nonce: 0n, chainPath: ["Nexus"] }),
  );
  for (const [status, name] of [
    [400, "belowMinRelayFee"],
    [400, "feeTooLow"],
    [400, "nonceAhead"],
    [400, "unavailable"],
    [400, "insufficientFunds"],
    [404, "unknownChain"],
    [429, "full"],
  ] as const) {
    // Hummingbird's JSON error envelope, as the node sends it.
    const error = await refusing(status, JSON.stringify({ error: { message: name } }))
      .submit(payload)
      .catch((caught: unknown) => caught);
    assert.ok(error instanceof SubmissionError);
    assert.equal(error.status, status);
    assert.equal(error.refusal, name);
    assert.equal(error.reason, name);
  }
  assert.ok(SUBMISSION_REFUSALS.includes("belowMinRelayFee"));

  const unnamed = await refusing(400, JSON.stringify({ error: { message: "something new" } }))
    .submit(payload)
    .catch((caught: unknown) => caught);
  assert.ok(unnamed instanceof SubmissionError);
  assert.equal(unnamed.refusal, "something new");
  assert.equal(unnamed.reason, undefined);

  // Public submit off: a bare 404 is a refusal by status, not an encoding fault.
  const off = await refusing(404, "")
    .submit(payload)
    .catch((caught: unknown) => caught);
  assert.ok(off instanceof SubmissionError);
  assert.equal(off.status, 404);
  assert.equal(off.refusal, undefined);
});

test("the default fetch is called with a valid receiver (browser Illegal invocation)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = function (this: unknown) {
    // Browsers throw "Illegal invocation" when fetch's receiver is not the global.
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response(JSON.stringify({ transactionCID: "bafy" })));
  } as typeof fetch;
  try {
    const body = buildTransfer({
      from: "alice",
      to: "bob",
      amount: 1n,
      fee: 1n,
      nonce: 0n,
      chainPath: ["Nexus"],
    });
    const submitter = new HTTPTransactionSubmitter("https://relay.example.org/transactions");
    const result = await submitter.submit(transactionPayload({ ed01: "signature" }, body));
    assert.equal(result.transactionCID, "bafy");
  } finally {
    globalThis.fetch = original;
  }
});

test("an operator-port submitter sends the node cookie", async () => {
  let seen: string | null = null;
  let redirect: RequestRedirect | undefined;
  const fetch = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
    seen = new Headers(init?.headers).get("Authorization");
    redirect = init?.redirect;
    return new Response(JSON.stringify({ transactionCID: "bafytransaction" }), { status: 200 });
  };
  const body = buildTransfer({
    from: "alice",
    to: "bob",
    amount: 1n,
    fee: 1n,
    nonce: 0n,
    chainPath: ["Nexus"],
  });
  const submitter = new HTTPTransactionSubmitter("http://127.0.0.1:8080/transactions", {
    fetch,
    authorization: "Bearer abc123",
  });
  await submitter.submit(transactionPayload({ ed01: "signature" }, body));
  assert.equal(seen, "Bearer abc123");
  assert.equal(redirect, "error", "the cookie never follows a redirect");
});
