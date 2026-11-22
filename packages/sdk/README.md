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
    node: "https://lattice-testnet-apps-iad.fly.dev",
    sponsors: ["https://lattice-testnet-apps-iad.fly.dev:8650/sponsor"],
    onProgress: (p) => {
      if (p.stage === "work")
        status.textContent = `Working… ${(p.hashes / 1e6).toFixed(0)}M hashes`;
      if (p.stage === "confirm") status.textContent = "Waiting for a block…";
    },
  });
  const key = `guestbook/${chain.address}`;

  // A read at the node's tip block, checked by CID from that block down.
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

- `await chain.get(key)` is the value at the tip block the node names, or
  `undefined`. `await chain.list(prefix, { limit })` is `[{ key, value }]` in
  key order (`limit` is a positive integer, 100 by default). Both check that
  block, its state and every trie node against their CIDs, so the answer is
  exactly that block's. **The node chooses the block**: reads are only as
  honest as that choice, and a dishonest node can name a block of a chain it
  made up. Use a node you trust, or compare tips across nodes.
- `await chain.set(key, value)` writes a string value and resolves with
  `{ transactionCID }` once the node shows the write in a block. The write
  states the value it replaces, as the chain requires. Writes and uploads
  from one `connect` run one at a time, so each takes the next nonce.
- `await chain.put(bytes | blob)` pins a file for good through a sponsor's
  storage (`--sell-storage`) and resolves to its root CID.
- `await chain.getFile(root, { maxBytes })` reads that file back from the
  node as a `Blob` with the type it was stored with. The root and every
  1 MiB chunk are checked against their CIDs, their place and their length,
  so a holder can fail to serve a file but cannot serve other bytes. A file
  over `maxBytes` (default 64 MiB) is refused before any chunk is fetched.
  The CID alone, fetched from `/volumes`, is only the file's small root
  listing its chunks.
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
  - `signal`: an `AbortSignal` that stops every call; `get`, `list`, `set`,
    `put` and `getFile` also take `{ signal }`.
  - `workers`: Web Workers to grind in; by default all cores but one, `0`
    for the page's own thread.
  - `onProgress`: hears `work` (with `hashes`, `shares` and
    `sharesNeeded`), `submit`, `confirm` and `store`.

The node must host the chain and accept writes on its public listener
(`--public-submit`; `GET /api/chain/info` says `acceptsSubmit`).

A share at the sponsor's default `--share-work` of 2^24 hashes takes about 1 s
to 2.5 s in Chrome on a 10-core laptop (13.6 MH/s over 9 workers), and 6 s on
one core; a testnet write takes one share.

See the [repository documentation](https://github.com/0xLattice/lattice-sdk)
for verified reads, content gateways, signing, and submission.

MIT
