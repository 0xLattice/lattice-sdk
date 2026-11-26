# `connect` reference

`connect` gives a web page or a script one chain to read and write. This page
lists its options and methods, and states exactly what its reads check. For a
first example, see [Getting started](getting-started.md).

```ts
import { connect } from "@adalin/lattice-sdk";

function connect(options: ConnectOptions): Promise<Chain>;
```

`connect` asks the first node for the chain's info before it resolves, so it
rejects when that node does not host the chain.

## Options

| Option                       | Default                          | Meaning                                                                                                                                      |
| ---------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain`                      | required                         | The chain's path, as `Nexus/testnet`.                                                                                                        |
| `node`                       | required                         | One node's public read URL, or several. All are read from; the first takes writes ([What the nodes must offer](#what-the-nodes-must-offer)). |
| `genesis`                    | none                             | The CID of the chain's first block. Every tip read must link back to it. Give this or `checkpoint`, not both.                                |
| `checkpoint`                 | none                             | The CID of a later block to link back to instead ([Keeping a checkpoint fresh](#keeping-a-checkpoint-fresh)).                                |
| `maxHeaders`                 | 2,000                            | The most blocks one read walks back, with a byte budget of 4 KiB for each (8 MiB).                                                           |
| `minAgree`                   | 2 with several nodes, 1 with one | How many nodes must hold a tip before it is read ([Several nodes](#several-nodes)).                                                          |
| `sponsors`                   | none                             | lattice-sponsor URLs, tried in order, that pay fees for proof of work ([Sponsors](#sponsors)).                                               |
| `key`                        | a key made and kept by `connect` | The writer's Ed25519 private key: 32 bytes, or 64 hex digits ([Keys](#keys)).                                                                |
| `storageKey`                 | `lattice-sdk/key/<chain>`        | The `localStorage` name of the key `connect` keeps.                                                                                          |
| `maxFee`                     | `10n`                            | The most a write without sponsors pays from the key's own balance.                                                                           |
| `confirmTimeoutMilliseconds` | 15 minutes                       | How long a write waits to be in a block before failing `notConfirmed`.                                                                       |
| `workers`                    | all cores but one                | Web Workers to grind in. `0` grinds on the calling thread. Where there are no Web Workers, the calling thread is used.                       |
| `onProgress`                 | none                             | Called as a write or upload proceeds ([Progress](#progress)).                                                                                |
| `signal`                     | none                             | An `AbortSignal` that stops every call. Each method also takes `{ signal }`.                                                                 |
| `fetch`                      | the global `fetch`               | The transport to use.                                                                                                                        |

Passing both `genesis` and `checkpoint`, an empty `node`, a `minAgree` outside
1 to the number of nodes, or a `maxHeaders` below 1 rejects with `RangeError`.

## Methods

`connect` resolves to a `Chain`:

| Member                                | Returns               | Meaning                                                                                                                          |
| ------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `chain`                               | `string`              | The chain's path.                                                                                                                |
| `address`                             | `string`              | The writer's address.                                                                                                            |
| `get(key, { signal })`                | `string \| undefined` | The value under `key` at the tip.                                                                                                |
| `list(prefix, { limit, signal })`     | `{ key, value }[]`    | The entries whose keys start with `prefix` (all keys when omitted), in key order. `limit` is a positive integer, 100 by default. |
| `set(key, value, { signal })`         | `{ transactionCID }`  | Writes a string value. Resolves once the first node shows the write in a block.                                                  |
| `put(data, { type, signal })`         | `string`              | Stores a `Uint8Array` or `Blob` through a sponsor and resolves to its root CID ([Files](#files)).                                |
| `getFile(root, { maxBytes, signal })` | `Blob`                | Reads a stored file back, with the type it was stored with.                                                                      |

Writes and uploads from one `connect` run one at a time, so each takes the
next nonce.

## What a read checks

`get` and `list` read at a tip block. The block, its state and every trie
node are checked against their CIDs, so the answer is exactly that block's.
The rest of this section is about which block is taken as the tip.

### The anchor: `genesis` or `checkpoint`

Give one of the two, shipped with the page. Every tip is walked back, block
by block, until it meets that block or a block an earlier read on this page
already linked. Linked blocks are remembered in memory only: what a page's
storage says is never trusted.

Each block on the walk must:

- name its parent, and be one higher than it;
- start from its parent's post-state;
- keep its parent's spec;
- be later than its parent, and no more than 2 hours ahead of this device's
  clock;
- have a target no easier than its parent's `nextTarget`;
- on Nexus, meet its proof-of-work target.

A tip that does not link fails with `ReadError` code `unanchored`.

Without `genesis` or `checkpoint`, a tip is not checked against any history.
A Nexus tip must still meet its own proof-of-work target.

### Bounds on a walk

| Bound              | Value                                           | Failure                                           |
| ------------------ | ----------------------------------------------- | ------------------------------------------------- |
| Blocks walked      | `maxHeaders` (2,000)                            | `tooFar`                                          |
| Bytes fetched      | 4 KiB a block on average (8 MiB at the default) | `tooFar`                                          |
| One block's Volume | 32 KiB                                          | the walk moves to another node that holds the tip |
| One request        | 15 s                                            | the walk moves to another node that holds the tip |

Blocks are fetched in pages of 25 while the node's own chain lists them, and
one at a time after a page misses. A block is about 1 to 2.5 KB, so a walk of
1,000 blocks fetches about 2.5 MB in about 90 requests.

### Keeping a checkpoint fresh

A chain moves `maxHeaders` blocks past a checkpoint in `maxHeaders` times its
block time: about a day and a half at one block a minute. Each page load
walks from the checkpoint again, so ship a recent one with every release,
read at release time from a node you run:

```sh
curl -s "https://your-node/api/block/latest?chainPath=Nexus/testnet" | jq -r .hash
```

A page that cannot be re-released can pin `genesis` with a larger
`maxHeaders`, at about 2.5 KB a block on each page load.

### Several nodes

With several `node`s, a tip is read only once `minAgree` of them hold it, as
their tip or at its height on their chain.

- Fewer than `minAgree`, even because the others are down, fails with
  `disagree`. Pass `minAgree: 1` to read from whichever node answers.
- URLs are compared normalized (case, trailing slash, default port), and a
  URL given twice counts once. Two URLs of one operator still count as two,
  so give one URL per operator.
- Of the tips that agree and link, the heaviest is read: the sum of
  `workForTarget` of each block's stated target above the pinned block.
  Without a pin, the highest is read. Equal ones go to the smaller CID.
- If a node's Volumes fail, time out or overrun the walk's bounds, the tip
  and its state are read through another node that holds it.

### What a read does not cover

- **Execution.** The SDK does not run the chain's rules, so it cannot tell
  that a block's state was honestly reached. A block that links is not a
  block whose state is right.
- **The target schedule.** A target is checked only against the parent's
  stated `nextTarget`, which the SDK does not recompute (that needs the
  chain's ASERT schedule). On Nexus, only the first forged block on real
  history pays real proof of work; the forger can schedule the rest at any
  target.
- **A child chain's work.** A child block's work is in proofs the HTTP API
  does not serve, so no work is checked on a child chain. On a chain whose
  blocks take about one hash, one node can make a block that links to real
  history and holds any state. To check child-chain work, follow the chain
  as a peer with
  [`@adalin/lattice-peer`](https://github.com/0xLattice/lattice-sdk/blob/main/packages/peer/README.md).
- **Freshness.** A node can always serve an older tip.

Against a forged state, only nodes of different operators help. With one
node, reads are as honest as that node. With several, they are as honest as
any `minAgree` of them.

## Writes

`set(key, value)` builds one transaction with one action and the writer's
key as its only signer.

1. It reads the key's current value and the writer's next nonce. The write
   states the value it replaces, as the chain requires, so a value changed
   by someone else in between makes the write fail instead of overwriting.
2. It pays the fee: through a sponsor, or from the key's balance.
3. It submits to the first node.
4. It polls that node every 2 seconds until the transaction is in a block,
   sending it again while the node does not know it. Past
   `confirmTimeoutMilliseconds` it fails `notConfirmed`.

### Sponsors

A [lattice-sponsor](https://github.com/0xLattice/lattice-sponsor) hands out
ranges of its block template to grind. The page finds shares in Web Workers;
the sponsor co-signs the transaction and pays its fee in return.

| Situation                                                                             | What `connect` does                                                                                                                      |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Several sponsors                                                                      | Tries them in order.                                                                                                                     |
| `429` or `503`, or the sponsor is out of reach                                        | Retries after its `Retry-After` (up to 30 s; a longer one moves on to the next sponsor), or with backoff from 1 s. Five attempts in all. |
| Work the sponsor no longer takes (`unknownAssignment`, `expired`)                     | Asks for new work.                                                                                                                       |
| The sponsor forgot the client token (it restarted; its credit is gone)                | Asks once more without one.                                                                                                              |
| No payment within eight rounds of work, or the node finds the sponsor's balance short | Moves on to the next sponsor.                                                                                                            |
| No sponsor could pay                                                                  | Fails `sponsorUnavailable`.                                                                                                              |

Credit left with a sponsor after one write counts toward the next one from
the same `connect`.

With no `sponsors`, the key pays the node's fee floor (`minRelayFee` of
`GET /api/chain/info`) from its own balance. A floor above `maxFee` fails
`refused`; a balance below the floor fails `insufficientBalance`.

A share at the sponsor's default `--share-work` of 2^24 hashes takes about
1 s to 2.5 s in Chrome on a 10-core laptop (13.6 MH/s over 9 workers), and
6 s on one core. A testnet write takes one share.

### Progress

`onProgress` is called with one of:

| `stage`   | Other fields                                  | When                                    |
| --------- | --------------------------------------------- | --------------------------------------- |
| `work`    | `sponsor`, `hashes`, `shares`, `sharesNeeded` | While grinding a sponsor's work.        |
| `submit`  | none                                          | The transaction is being sent.          |
| `confirm` | `transactionCID`                              | Sent; waiting for a block.              |
| `store`   | `sponsor`, `root`                             | An upload is being handed to a sponsor. |

## Files

`put(bytes | blob, { type })` stores a file through a sponsor that
sells storage (`--sell-storage`), paid for in proof of work, and resolves to
its root CID. The sponsor pins the file on its node, where it stays until
the sponsor's operator takes it down; store a file you must keep with more
than one sponsor, or pin it on a node you run. `type` defaults to the blob's own type, else
`application/octet-stream`, and is at most 255 characters.

Files are laid out as
[lattice-storage](https://github.com/0xLattice/lattice-storage) reads them:

| File size   | Layout                                                                         |
| ----------- | ------------------------------------------------------------------------------ |
| Up to 1 MiB | One block `{ type, size, bytes }`.                                             |
| Over 1 MiB  | A root `{ type, size, chunks }` naming one `{ bytes }` Volume per 1 MiB chunk. |

`getFile(root, { maxBytes })` reads a file back as a `Blob`, from the nodes
that hold the tip, each in turn until one serves it.

- The root and every chunk are checked against their CIDs, their place and
  their length. A holder can fail to serve a file but cannot serve other
  bytes.
- A file over `maxBytes` (64 MiB by default) is refused before any chunk is
  fetched. No one Volume is taken past 1 MiB and its encoding as it arrives.
- A chunk that fails stops the others.
- For a file over 1 MiB, the CID alone fetched from a node's `/volumes` is
  only its root, which lists the chunks.

### Upgrading from 0.2.0

Version 0.2.0 stored small files chunked too. A small file stored now has a
different root CID than the same file stored by 0.2.0. Both read with
`getFile`.

## Keys

Which party holds the writer's private key depends on how `connect` is
called:

| Call                                                                                          | Where the key is                                                                               |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| No `key` option, in a browser                                                                 | `connect` makes a key on first use and keeps it, as hex, in `localStorage` under `storageKey`. |
| No `key` option, where there is no `localStorage` (a private window that refuses it, Node.js) | `connect` makes a key and holds it in memory. It is gone when the page or process ends.        |
| `key` given                                                                                   | The caller holds it. `connect` uses it in memory and stores nothing.                           |

A key kept in `localStorage` can be read by any script running on the page's
origin, so a cross-site scripting hole gives away the visitor's key. Keep
the origin free of third-party script, or pass your own `key`.

`connect` never hands a key to a wallet and never asks one to sign. A page
that should hold no key writes through the user's wallet instead
([Getting started](getting-started.md#through-the-users-wallet)).

## Errors

A failed read of the tip is a `ReadError` with a `code`:

| `code`       | Meaning                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `unanchored` | The tip does not link back to `genesis` or `checkpoint` by the header rules.                                                                 |
| `tooFar`     | The tip is more than `maxHeaders` blocks, or their byte budget, past the newest linked block. Ship a newer checkpoint or raise `maxHeaders`. |
| `disagree`   | Fewer than `minAgree` nodes hold any one tip.                                                                                                |

A failed write or upload is a `WriteError` with a `code`:

| `code`                | Meaning                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `insufficientBalance` | No sponsor was given and the key cannot pay the fee itself.                                                                     |
| `rejected`            | The chain refused the write: its policy, or the key's value changed under it.                                                   |
| `sponsorUnavailable`  | No sponsor could take the work, sign or pay.                                                                                    |
| `refused`             | The node's own policy would not take the transaction (its fee floor, or public submit being off), or the fee is above `maxFee`. |
| `notConfirmed`        | Sent, but not in a block before `confirmTimeoutMilliseconds`.                                                                   |

`error.cause` holds the underlying `SubmissionError` or `SponsorError` when
there is one. Other failures (a node out of reach, a Volume that does not
verify, an aborted `signal`) are thrown as they are.

## What the nodes must offer

- Every `node` is a public read URL: HTTPS, or HTTP on loopback.
- The first `node` must host the chain and accept writes on its public
  listener (`--public-submit`). `GET /api/chain/info` reports this as
  `acceptsSubmit`.
- Each node serves Volumes at `<node>/volumes`
  ([Content gateway contract](content-gateway.md)).
