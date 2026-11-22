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
    // Nodes of different operators: a tip is read once two of them hold it.
    node: ["https://lattice-testnet-apps-iad.fly.dev", "https://ams.testnet.lattice.build"],
    // The chain's first block, as this page ships it: reads must descend from it.
    genesis: "bafyreiaa2fq7zwzrbzhwjld4qpxa23n4am7xhv6h77zz5kronnwbkbtyae",
    // A recent block (here, testnet 74,008) to walk back to instead of
    // genesis; ship a newer one with each release of the page.
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
  - **`genesis`** (the CID of the chain's first block, shipped with the
    page) or **`checkpoint`** (a later block of it): the tip is walked back
    until it meets that block, or a block an earlier read on this browser
    linked (kept in `localStorage`). Each block must name its parent, be
    one higher, start from its parent's post-state, keep its spec, be later,
    and have a target no easier than its parent scheduled; on Nexus, each
    must also meet its proof-of-work target. A tip that does not link fails
    with `ReadError` code `unanchored`. A walk past `maxHeaders` blocks
    (default 2,000) fails `tooFar`: pin a newer `checkpoint`. A walk fetches
    about 2.5 KB a block, in pages of 25.
  - **Several `node`s**: a tip is read only once two of them hold it, and
    the heaviest such tip is read (most work above `genesis`/`checkpoint`,
    else the highest; equal ones by smaller CID). No two agreeing fails
    `disagree`. A node that cannot be reached is passed over.
  - **What that does not cover.** The SDK does not run the chain's rules,
    so it cannot tell a block's state was honestly reached. On a child
    chain, a block's work is in proofs the HTTP API does not serve, so no
    work is checked. On a chain whose blocks take about one hash (as
    hosts make them), one node can make a block that links to real history
    and holds any state. Against that, only nodes of different operators
    help: with one node, reads are as honest as that node; with several,
    as honest as any two of them. A node can always serve an older tip.
    Without `genesis` or `checkpoint`, a tip is not checked against any
    history at all.
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
  - `genesis`, `checkpoint`, `maxHeaders`: see reads, above.
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
