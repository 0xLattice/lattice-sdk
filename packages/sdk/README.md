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

  // A read, checked by CID from the node's latest block down.
  status.textContent = (await chain.get(key)) ?? "You have not signed yet.";

  // A write: paid for in proof of work, resolved once it is in a block.
  document.querySelector("#sign").onclick = async () => {
    try {
      await chain.set(key, document.querySelector("#message").value);
      status.textContent = `Signed: ${await chain.get(key)}`;
    } catch (error) {
      status.textContent = error.message; // "insufficient balance", "rejected by the chain's rules", "sponsor unavailable"
    }
  };
</script>
```

- `await chain.get(key)` is the value at the node's latest block, or
  `undefined`. `await chain.list(prefix, { limit })` is `[{ key, value }]` in
  key order (`limit` defaults to 100). Both read the block, its state and
  every trie node by CID: the node names the block, and serves nothing else
  unchecked.
- `await chain.set(key, value)` writes a string value and resolves with
  `{ transactionCID }` once the write is in a block of the node's chain. The
  write states the value it replaces, as the chain requires.
- `await chain.put(bytes | blob)` pins a file for good through a sponsor's
  storage (`--sell-storage`) and resolves to its root CID.
- `sponsors` are tried in order. A sponsor's `429` or `503` is retried after
  its `Retry-After`, or with backoff from 1 s; work it no longer takes
  (`unknownAssignment`, `expired`) is replaced with new work. With no
  `sponsors`, the key pays the node's fee floor from its own balance.
- A failed write is a `WriteError` whose `code` is `insufficientBalance`
  (unsponsored and unfunded), `rejected` (the chain's rules refused it),
  `sponsorUnavailable` (no sponsor could pay), or `refused` (the node's own
  policy, such as its fee floor or public submit being off).
- Options: `key` (a 32-byte private key, or its hex) to bring your own,
  `workers` (Web Workers to grind in; default all cores but one, `0` for the
  page's own thread), and `onProgress`, which hears `work` (with `hashes`,
  `shares` and `sharesNeeded`), `submit`, `confirm` and `store`.

The node must host the chain and accept writes on its public listener
(`--public-submit`; `GET /api/chain/info` says `acceptsSubmit`).

A share at the sponsor's default `--share-work` of 2^24 hashes takes about 1 s
to 2.5 s in Chrome on a 10-core laptop (13.6 MH/s over 9 workers), and 6 s on
one core; a testnet write takes one share.

See the [repository documentation](https://github.com/0xLattice/lattice-sdk)
for verified reads, content gateways, signing, and submission.

MIT
