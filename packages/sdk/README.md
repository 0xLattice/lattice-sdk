# @adalin/lattice-sdk

Requires Node.js 22 or later. This package provides ESM and TypeScript declarations; CommonJS `require()` is not supported.

```sh
npm install @adalin/lattice-sdk
```

The complete TypeScript developer SDK for Lattice. It re-exports canonical
primitives, verified complete-Volume retrieval, read-only node access, and
explicit relay/private-node submission.

```ts
import { HTTPVolumeTransport, LatticeClient, NodeClient, VolumeClient } from "@adalin/lattice-sdk";

const client = new LatticeClient(
  new NodeClient("https://reads.example.org", ["Nexus"]),
  new VolumeClient(new HTTPVolumeTransport("https://content.example.org/volumes")),
);
```

## In a web page, with no coin and no wallet

`dist/browser.js` is one ES module with no imports, so a static page loads it
straight from a CDN, with no bundler. `connect` gives a chain to read and
write. The visitor's key is made on first use and kept in `localStorage` (in
memory where there is none). Writes are paid for in proof of work: the page
grinds shares of a [lattice-sponsor](https://github.com/0xLattice/lattice-sponsor)'s
work in Web Workers, and the sponsor co-signs the transaction and pays its
fee. Save this as an `.html` file and open it:

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
    // A tip is read once two of these hold it. Give nodes of different
    // operators: these two testnet nodes share one.
    node: ["https://lattice-testnet-apps-iad.fly.dev", "https://ams.testnet.lattice.build"],
    // A block of the chain this page ships (testnet 74,008), refreshed with
    // each release (see below): reads must descend from it.
    checkpoint: "bafyreib2btiyscwrh5ccy2ufxf7fh57gk6hjhxovlxx3awk6ssxinzggbq",
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

- `await chain.get(key)` is the value at the tip, or `undefined`.
  `await chain.list(prefix, { limit })` is `[{ key, value }]` in key order
  (`limit` is a positive integer, 100 by default). Both check the tip block,
  its state and every trie node against their CIDs, so the answer is exactly
  that block's. Which block is the tip is checked as follows:
  - **`genesis` or `checkpoint`** (one of the two): the CID of the
    chain's first block, or of a later one, shipped with the page. Every
    tip is walked back until it meets that block, or a block an earlier
    read on this page linked (kept in memory only: what a page's storage
    says is never trusted). Each block must name its parent, be one higher,
    start from its parent's post-state, keep its spec, be later than its
    parent and no more than 2 hours ahead of this device's clock, and have
    a target no easier than its parent's `nextTarget`; on Nexus, each must
    also meet its proof-of-work target. A tip that does not link fails with
    `ReadError` code `unanchored`.
  - **Bounds.** A walk stops after `maxHeaders` blocks (default 2,000), or
    after fetching 4 KiB a block on average (8 MiB by default); either
    fails `tooFar`. One block's Volume may be at most 32 KiB. Blocks are
    fetched in pages of 25 while the node's own chain lists them, one at a
    time after a page misses. A block is about 1–2.5 KB, so a typical walk
    of 1,000 blocks fetches about 2.5 MB in about 90 requests.
  - **Keeping a checkpoint fresh.** A chain moves past a checkpoint by
    `maxHeaders` blocks in `maxHeaders` × its block time: about a day and a
    half at one block a minute. Each page load walks from the checkpoint
    again, so ship a recent one with every release, read at release time
    from a node you run:
    `curl -s "https://your-node/api/block/latest?chainPath=Nexus/testnet" | jq -r .hash`.
    A page that cannot be re-released can pin `genesis` with a larger
    `maxHeaders`, at about 2.5 KB a block per page load.
  - **Several `node`s**: a tip is read only once `minAgree` of them
    (default 2) hold it, as their tip or at its height on their chain;
    fewer, even because the others are down, fails `disagree` (pass
    `minAgree: 1` to read from whichever answers). URLs are compared
    normalized (case, trailing slash, default port), but two URLs of one
    operator still count as two. Of the tips that agree and link, the
    heaviest is read: the sum of `workForTarget` of each block's **stated**
    target above the pinned block (checked against proof of work only on
    Nexus), or the highest without a pin; equal ones by smaller CID. If a
    node's Volumes fail, another that holds the tip is read from.
  - **What that does not cover.** The SDK does not run the chain's rules,
    so it cannot tell a block's state was honestly reached: a block that
    links is not a block whose state is right. Targets are checked only
    against the parent's stated `nextTarget`, which the SDK does not
    recompute (that needs the chain's ASERT schedule), so on Nexus only
    the first forged block on real history pays real proof of work; the
    forger can schedule the rest at any target. On a child chain, a
    block's work is in proofs the HTTP API does not serve, so no work is
    checked. On a chain whose blocks take about one hash (as hosts make
    them), one node can make a block that links to real history and holds
    any state. Against that, only nodes of different operators help: with
    one node, reads are as honest as that node; with several, as honest as
    any `minAgree` of them. A node can always serve an older tip. Without
    `genesis` or `checkpoint`, a tip is not checked against any history.
- `await chain.set(key, value)` writes a string value and resolves with
  `{ transactionCID }` once the node shows the write in a block. The write
  states the value it replaces, as the chain requires. Writes and uploads
  from one `connect` run one at a time, so each takes the next nonce.
- `await chain.put(bytes | blob)` pins a file for good through a sponsor's
  storage (`--sell-storage`) and resolves to its root CID.
- `sponsors` are tried in order. A sponsor's `429` or `503` is retried after
  its `Retry-After` (up to 30 s; a longer one moves on to the next sponsor),
  or with backoff from 1 s, five attempts in all. Work it no longer takes
  (`unknownAssignment`, `expired`) is replaced with new work, and a sponsor
  that forgot the client token (it restarted) is asked once more without
  one. A sponsor that does not pay within eight rounds of work, or whose
  float the node finds short, gives way to the next. With no `sponsors`,
  the key pays the node's fee floor from its own balance, up to `maxFee`.
- A failed write is a `WriteError` whose `code` is `insufficientBalance`
  (unsponsored and unfunded), `rejected` (the chain's rules refused it),
  `sponsorUnavailable` (no sponsor could pay), `refused` (the node's own
  policy, such as its fee floor or public submit being off, or a fee above
  `maxFee`), or `notConfirmed` (sent, but not in a block in time).
- Options:
  - `key`: a 32-byte private key, or its hex, to bring your own.
  - `storageKey`: the `localStorage` name of the kept key, by default
    `lattice-sdk/key/<chain>`. Any script running on the page's origin can
    read it, so a cross-site scripting hole gives away the visitor's key:
    keep the origin free of third-party script, or pass your own `key`.
  - `maxFee` (default `10`): the most an unsponsored write pays.
  - `confirmTimeoutMilliseconds` (default 15 minutes).
  - `genesis`, `checkpoint`, `maxHeaders`, `minAgree`: see reads, above.
  - `signal`: an `AbortSignal` that stops every call; `get`, `list`, `set`
    and `put` also take `{ signal }`.
  - `workers`: Web Workers to grind in; by default all cores but one, `0`
    for the page's own thread.
  - `onProgress`: hears `work` (with `hashes`, `shares` and
    `sharesNeeded`), `submit`, `confirm` and `store`.

The first `node` must host the chain and accept writes on its public listener
(`--public-submit`; `GET /api/chain/info` says `acceptsSubmit`).

A share at the sponsor's default `--share-work` of 2^24 hashes takes about 1 s
to 2.5 s in Chrome on a 10-core laptop (13.6 MH/s over 9 workers), and 6 s on
one core; a testnet write takes one share.

See the [repository documentation](https://github.com/0xLattice/lattice-sdk)
for verified reads, content gateways, signing, and submission.

MIT
