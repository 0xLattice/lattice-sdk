# Getting started with the Lattice SDK

This page takes you from nothing to a web page that reads and writes a
Lattice chain, then to the lower-level calls for scripts and services. The
examples run against the public test chain `Nexus/testnet`.

| The examples use | Value                                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| Chain            | `Nexus/testnet`                                                                 |
| Nodes            | `https://ams.testnet.lattice.build`, `https://lattice-testnet-apps-iad.fly.dev` |
| Sponsor          | `https://lattice-testnet-apps-iad.fly.dev:8650/sponsor`                         |

Both nodes belong to one operator. That is enough to try the SDK; an
application that relies on its reads names nodes of different operators
([why](connect.md#several-nodes)).

## Install

For Node.js 22 or later, or a bundler:

```sh
npm install @adalin/lattice-sdk
```

The packages are ES modules with TypeScript declarations. CommonJS
`require()` is not supported.

In a web page with no bundler, import the single-file build from a CDN:

```js
import { connect } from "https://cdn.jsdelivr.net/npm/@adalin/lattice-sdk@0.2.0/dist/browser.js";
```

`@adalin/lattice-sdk` re-exports four smaller packages you can install on
their own ([packages](architecture.md#packages)).

## 1. Build a page that reads and writes

The page below is a guestbook: each visitor signs it with one line. It needs
no coin and no wallet. The visitor's key is made in the page, and the fee is
paid in proof of work through a
[lattice-sponsor](https://github.com/0xLattice/lattice-sponsor).

1. Read a recent block of the chain. The page pins it as its `checkpoint`:
   every read must descend from this block.

   ```sh
   curl -s "https://ams.testnet.lattice.build/api/block/latest?chainPath=Nexus/testnet" | jq -r .hash
   ```

2. Save this as `guestbook.html`, with the CID from step 1 in place of
   `PASTE_THE_CID_HERE`:

   ```html
   <!doctype html>
   <meta charset="utf-8" />
   <title>Guestbook</title>
   <p id="status">Loading…</p>
   <input id="message" placeholder="Say hello" />
   <button id="sign">Sign</button>
   <script type="module">
     import { connect } from "https://cdn.jsdelivr.net/npm/@adalin/lattice-sdk@0.2.0/dist/browser.js";

     const status = document.querySelector("#status");
     const chain = await connect({
       chain: "Nexus/testnet",
       // A tip is read once two of these hold it.
       node: ["https://lattice-testnet-apps-iad.fly.dev", "https://ams.testnet.lattice.build"],
       // Reads must descend from this block.
       checkpoint: "PASTE_THE_CID_HERE",
       sponsors: ["https://lattice-testnet-apps-iad.fly.dev:8650/sponsor"],
       onProgress: (p) => {
         if (p.stage === "work")
           status.textContent = `Working… ${(p.hashes / 1e6).toFixed(0)}M hashes`;
         if (p.stage === "confirm") status.textContent = "Waiting for a block…";
       },
     });
     const key = `guestbook/${chain.address}`;

     // A read at the tip, checked by CID from that block down.
     status.textContent = (await chain.get(key)) ?? "You have not signed yet.";

     // A write: paid for in proof of work, resolved once it is in a block.
     document.querySelector("#sign").onclick = async () => {
       try {
         await chain.set(key, document.querySelector("#message").value);
         status.textContent = `Signed: ${await chain.get(key)}`;
       } catch (error) {
         status.textContent = error.message; // e.g. "insufficient balance", "sponsor unavailable"
       }
     };
   </script>
   ```

3. Open the file in a browser, type a line and press **Sign**. The status
   shows the work, then "Waiting for a block…", then your line.

What the page did:

- **Key.** `connect` made an Ed25519 key for this visitor and kept it in the
  page's `localStorage`, so the same visitor has the same address next time.
  [Keys](connect.md#keys) says what that means for your site.
- **Read.** `chain.get` asked both nodes for their tip, walked it back to the
  checkpoint, and read the key from that block's state, checking every piece
  against its CID.
- **Write.** `chain.set` ground proof of work in Web Workers for the
  sponsor, which co-signed the transaction and paid its fee. The call
  resolved once a node showed the transaction in a block.

A checkpoint goes stale: once the chain is 2,000 blocks past it, reads fail
with `tooFar`. [Keeping a checkpoint fresh](connect.md#keeping-a-checkpoint-fresh)
covers what to ship.

## 2. Read from a script

`connect` works the same in Node.js. Save this as `read.mjs`:

```js
import { connect, ReadError } from "@adalin/lattice-sdk";

const chain = await connect({
  chain: "Nexus/testnet",
  node: ["https://ams.testnet.lattice.build", "https://lattice-testnet-apps-iad.fly.dev"],
  checkpoint: process.argv[2],
});

try {
  // Up to 10 entries whose keys start with "guestbook/", in key order.
  const entries = await chain.list("guestbook/", { limit: 10 });
  for (const { key, value } of entries) console.log(key, value);

  // One key: its value at the tip, or undefined when nothing is stored there.
  if (entries.length > 0) console.log(await chain.get(entries[0].key));
} catch (error) {
  if (!(error instanceof ReadError)) throw error;
  console.error(error.code, error.message); // unanchored, tooFar or disagree
}
```

```sh
node read.mjs "$(curl -s 'https://ams.testnet.lattice.build/api/block/latest?chainPath=Nexus/testnet' | jq -r .hash)"
```

Values are strings. `chain.getFile(root)` reads a file stored with
`chain.put` ([Files](connect.md#files)).

## 3. Write

A write needs a key to sign it and someone to pay its fee. Choose one row:

| Who signs                         | Who pays                    | How                                                                                           |
| --------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| A key `connect` makes in the page | A sponsor, in proof of work | Pass `sponsors`, as the guestbook does.                                                       |
| A key you supply                  | A sponsor, in proof of work | Pass `key` and `sponsors`.                                                                    |
| A key you supply, holding coin    | That key's balance          | Pass `key` and no `sponsors`.                                                                 |
| The user's wallet                 | The user                    | The page holds no key and does not write with `connect` ([below](#through-the-users-wallet)). |

### With a key you supply

Save this as `write.mjs`. It keeps a key in a file beside it and signs the
guestbook with it:

```js
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { bytesToHex, connect, generatePrivateKey, WriteError } from "@adalin/lattice-sdk";

const keyFile = "./guestbook.key";
if (!existsSync(keyFile)) {
  writeFileSync(keyFile, bytesToHex(generatePrivateKey()), { mode: 0o600 });
}

const chain = await connect({
  chain: "Nexus/testnet",
  node: ["https://lattice-testnet-apps-iad.fly.dev", "https://ams.testnet.lattice.build"],
  checkpoint: process.argv[2],
  key: readFileSync(keyFile, "utf8").trim(), // 64 hex digits, or 32 bytes
  sponsors: ["https://lattice-testnet-apps-iad.fly.dev:8650/sponsor"],
  onProgress: (p) => console.error(p.stage),
});

try {
  const { transactionCID } = await chain.set(`guestbook/${chain.address}`, "hello from a script");
  console.log(transactionCID);
} catch (error) {
  if (!(error instanceof WriteError)) throw error;
  console.error(error.code, error.message);
}
```

```sh
node write.mjs "$(curl -s 'https://ams.testnet.lattice.build/api/block/latest?chainPath=Nexus/testnet' | jq -r .hash)"
```

Without `sponsors`, the key pays the node's fee floor from its own balance,
up to `maxFee` (10 by default), and a key with no coin fails with
`insufficientBalance`. The first node in `node` takes the write, so it must
accept public submits
([What the nodes must offer](connect.md#what-the-nodes-must-offer)).

### Through the user's wallet

A page that should hold no key leaves the write to the user's wallet. A
wallet that injects `window.lattice` picks the nonce, signs and submits by
itself; the page uses the SDK only to read. The SDK has no wallet API.
[Client patterns](https://github.com/0xLattice/lattice-skills/blob/main/skills/lattice-app-builder/references/client-patterns.md#write-through-the-users-wallet)
shows the call.

## 4. Use the parts directly

`connect` is built from parts you can use on their own: a read-only node
client, a content client that checks every Volume against its CID, signing,
and a submitter. A Volume is a root CID and the exact entries published with
it. Use the parts for transfers, for a service, or to read blocks and
transactions instead of keys.

### Read a block and check it

```js
import { HTTPVolumeTransport, LatticeClient, NodeClient, VolumeClient } from "@adalin/lattice-sdk";

const node = "https://ams.testnet.lattice.build";
const chainPath = ["Nexus", "testnet"];

const lattice = new LatticeClient(
  new NodeClient(node, chainPath),
  new VolumeClient(new HTTPVolumeTransport(`${node}/volumes`, { chainPath })),
);

const { view, canonical } = await lattice.latestBlock();
console.log(view.height, canonical.postStateCID);

const state = await lattice.postState(view.hash);
console.log(state.canonical.accountStateCID);
```

`view` is the node's JSON. `canonical` is the block decoded from bytes that
hash to its CID, and the two are compared. This does not check that the block
is the chain's tip: that is the node's word
([What is checked](#what-is-checked-and-what-is-not)).

### Build, sign and submit a transfer

This needs a key that holds coin on the chain. Save it as `send.mjs` and run
`node send.mjs <recipient address>`:

```js
import { readFileSync } from "node:fs";
import {
  HTTPTransactionSubmitter,
  NodeClient,
  SubmissionError,
  accountFromPrivateKey,
  buildTransfer,
  hexToBytes,
  signTransactionBody,
  signedTransactionCID,
  transactionPayload,
} from "@adalin/lattice-sdk";

const node = "https://ams.testnet.lattice.build";
const chainPath = ["Nexus", "testnet"];
const privateKey = hexToBytes(readFileSync("./guestbook.key", "utf8").trim());
const account = accountFromPrivateKey(privateKey);

const reads = new NodeClient(node, chainPath);
const { minRelayFee = 1n } = await reads.chainInfo(); // this node's fee floor
const { nonce } = await reads.account(account.address); // the next nonce to use

const body = buildTransfer({
  from: account.address,
  to: process.argv[2],
  amount: 25n,
  fee: minRelayFee,
  nonce,
  chainPath,
});
const signed = signTransactionBody(body, privateKey);
const payload = transactionPayload({ [signed.publicKey]: signed.signature }, body);

// Submission is its own object: the read client cannot send a transaction.
const relay = new HTTPTransactionSubmitter(`${node}/transactions`);
try {
  const result = await relay.submit(payload);
  // The CID is recomputable here: do not take the node's word for it.
  if (result.transactionCID !== signedTransactionCID(payload.transaction.signatures, body)) {
    throw new Error("the node reported a different transaction");
  }
  console.log(result.transactionCID);
} catch (error) {
  if (!(error instanceof SubmissionError)) throw error;
  console.error(error.status, error.reason ?? error.refusal); // e.g. 400 invalidState
}
```

An accepted submission is pooled, not included. Poll
`reads.transaction(cid)`: its `blockHeight` is set once the transaction is in
a block of the node's chain.

A node's fee floor is its own policy and differs between nodes; it is not a
consensus rule.

### Talk to your own node

A node's operator port (loopback) requires the cookie the node writes at
every start, `<data-directory>/.cookie`. Pass its content to both the read
client and the submitter. Public read endpoints need none. Run this with the
cookie file's path:

```js
import { readFileSync } from "node:fs";
import { HTTPTransactionSubmitter, NodeClient, nodeCookieAuthorization } from "@adalin/lattice-sdk";

const authorization = nodeCookieAuthorization(readFileSync(process.argv[2], "utf8"));
const reads = new NodeClient("http://127.0.0.1:8080", ["Nexus"], { authorization });
const own = new HTTPTransactionSubmitter("http://127.0.0.1:8080/transactions", { authorization });

const { height, bestHeaderHeight } = await reads.health();
console.log(height, bestHeaderHeight); // executed height, and the best known header's
```

Remote URLs must be HTTPS. Plain HTTP is accepted for loopback only.

## What is checked, and what is not

| You call                                                         | The SDK checks                                                                                                                                                                                               | It does not check                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `NodeClient` methods                                             | The shape of the JSON.                                                                                                                                                                                       | Anything else: it is one node's answer.                                                           |
| `LatticeClient.block`, `latestBlock`, `postState`, `transaction` | The bytes hash to their CIDs. The node's JSON matches the block. A non-genesis Nexus block meets its own proof-of-work target.                                                                               | That the block is on the chain, or is its tip.                                                    |
| `connect` reads                                                  | All of the above, for the block, its state and every trie node. With `genesis` or `checkpoint`, that the tip links back to it by the header rules. With several nodes, that `minAgree` of them hold the tip. | That the block's state was honestly reached: no block is executed. A child chain's proof of work. |
| `ChainFollower` (`@adalin/lattice-peer`)                         | Each header hashes to its CID and carries the work it claims, a child chain's included.                                                                                                                      | Execution, and the target schedule.                                                               |
| `HTTPTransactionSubmitter.submit`                                | That the answer names a transaction CID, which you can recompute.                                                                                                                                            | Whether the transaction is mined: read it back.                                                   |

No part of the SDK executes blocks, so none of it is full validation. The
[`connect` reference](connect.md#what-a-read-does-not-cover) states the
limits exactly, and [Architecture](architecture.md#trust-boundaries) says
where each boundary is.

## Next

| To                                                      | Read                                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Tune the reads, sponsors, files and errors of `connect` | [`connect` reference](connect.md)                                                                                                 |
| Look up a class, function or error                      | [API reference](api.md)                                                                                                           |
| Understand what each package trusts                     | [Architecture](architecture.md)                                                                                                   |
| Serve Volumes to the SDK from your own gateway          | [Content gateway contract](content-gateway.md)                                                                                    |
| Design an application's chain, state and rules          | [Client patterns](https://github.com/0xLattice/lattice-skills/blob/main/skills/lattice-app-builder/references/client-patterns.md) |
| Call the node without the SDK                           | [HTTP API](https://lattice.build/docs/build/http-api/)                                                                            |
