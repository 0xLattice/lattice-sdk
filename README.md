# Lattice SDK

Requires Node.js 22 or later. Packages provide ESM and TypeScript declarations; CommonJS `require()` is not supported.

```sh
npm install @adalin/lattice-sdk
```

### Low-level JSON transport

`getJSON(url, options)` accepts an options object with `fetch`, `signal`,
`authorization`, `timeoutMilliseconds` (default 8000), and `maximumResponseBytes`
(default 4 MiB). It forbids redirects and bounds both fetch and body reads,
including injected transports that ignore cancellation. An uncooperative
transport may continue running after rejection; cancellation is best-effort.
Callers must validate the base URL with `normalizeNodeURL` before adding route
paths/query parameters. This primitive does not apply endpoint URL policy.

```ts
const base = normalizeNodeURL("https://node.example/rpc");
const result = await getJSON(new URL(`${base}/api/chain/info`), {
  timeoutMilliseconds: 3000,
  maximumResponseBytes: 1024 * 1024,
});
```

DAG-CBOR maps decode to null-prototype objects: absent fields do not inherit
`constructor` or other prototype members. Valid keys, including `__proto__`,
are preserved. Do not copy untrusted maps using `Object.assign({}, decoded)`:
the ordinary destination's legacy prototype setter is still hazardous. Use
`{ ...decoded }` or `Object.assign(Object.create(null), decoded)` instead.

Vector downloads must match each file's SHA-256 in `vectors.lock.json` before
being cached. Updating the lock deliberately repins both revision and content;
review both changes rather than accepting a regenerated lock automatically.

TypeScript-first developer SDK for building applications on Lattice.

This repository sits above the protocol and infrastructure repositories:

```text
Lattice              consensus, canonical encoding, proofs, conformance vectors
VolumeBroker / DHT   complete Volume storage and retrieval
lattice-node         chain runtime, bounded public reads, private operator writes
        ↓
lattice-sdk          application-facing composition of those capabilities
```

The SDK deliberately separates three capabilities:

1. **Read plane:** `@adalin/lattice-client` reads the node's unversioned,
   public, read-only JSON API. Consensus integers become JavaScript `bigint`s.
2. **Content plane:** `@adalin/lattice-volumes` accepts a content-service or
   DHT transport and validates every member of each complete Volume against its
   CID before exposing it.
3. **Submission plane:** `@adalin/lattice-relay` submits only through an
   application-selected third-party relay or private node. The read client has
   no submission method.

Canonical blocks, transactions, and state are not copied into a second JSON
content format. Node reads discover Volume roots; the content service/DHT
returns the complete Volumes; the SDK verifies and follows their authenticated
references.

## Packages

| Package                   | Responsibility                                                       |
| ------------------------- | -------------------------------------------------------------------- |
| `@adalin/lattice-core`    | DAG-CBOR, CIDs, addresses, Ed25519 signing, transaction construction |
| `@adalin/lattice-volumes` | Complete-Volume transport interface, bounds, and CID verification    |
| `@adalin/lattice-client`  | Read-only node API and node/content composition                      |
| `@adalin/lattice-relay`   | Explicit relay or private-node submission                            |
| `@adalin/lattice-sdk`     | Convenience re-export of the four packages                           |

Releases publish all five packages together with npm provenance. See
[`docs/getting-started.md`](docs/getting-started.md) for the application setup
and [`docs/content-gateway.md`](docs/content-gateway.md) for the Ivy-compatible
content bridge contract.

## Example

```ts
import { HTTPVolumeTransport, LatticeClient, NodeClient, VolumeClient } from "@adalin/lattice-sdk";

const content = new HTTPVolumeTransport("https://content.example.org/volumes");

const client = new LatticeClient(
  new NodeClient("https://reads.example.org", ["Nexus"]),
  new VolumeClient(content),
);

const { view, canonical } = await client.latestBlock();
console.log(view.height, canonical.postStateCID);
```

Transaction submission is a separate, explicit capability:

```ts
import {
  HTTPTransactionSubmitter,
  buildTransfer,
  signTransactionBody,
  signedTransactionCID,
  transactionPayload,
} from "@adalin/lattice-sdk";

const body = buildTransfer({
  from,
  to,
  amount: 1000n,
  fee: 2n,
  nonce,
  chainPath: ["Nexus"],
});
const signed = signTransactionBody(body, privateKey);
const payload = transactionPayload({ [signed.publicKey]: signed.signature }, body);

const relay = new HTTPTransactionSubmitter("https://relay.example.org/transactions");
const result = await relay.submit(payload);
// The node's reported CID is recomputable locally; don't trust it blindly.
if (result.transactionCID !== signedTransactionCID(payload.transaction.signatures, body)) {
  throw new Error("relay reported a different transaction");
}
```

A node's own loopback operator port requires the cookie the node writes at
every start (`<data-directory>/.cookie`, bitcoind-style). Pass its content to
both the read client and the submitter; public read endpoints need none:

```ts
const authorization = nodeCookieAuthorization(cookieFileContent);
const reads = new NodeClient("http://127.0.0.1:8080", ["Nexus"], { authorization });
const own = new HTTPTransactionSubmitter("http://127.0.0.1:8080/transactions", { authorization });
```

`NodeClient.health()` reports `height` (executed) and `bestHeaderHeight` (best
known header chain) for sync progress.

## Conformance

`vectors.lock.json` pins the authoritative vectors from
[`adalinxx/Lattice`](https://github.com/adalinxx/Lattice/tree/main/Vectors).
Tests fetch that exact commit and reproduce every address, encoding, CID, and
signature vector. The SDK does not maintain an independent copy of consensus
fixtures.

```sh
npm install
npm test
```

To review a newer vector set:

```sh
npm run vectors:update
npm test
```

The lock-file change and any conformance change must be reviewed together.

## Status

The SDK implements canonical primitives, exact wire integers, Ivy-compatible
complete-Volume archives, CID verification, typed Block and LatticeState roots,
block/state continuity checks, UInt64 sparse-proof verification, the read-only
node client, and explicit submission transports. Full fork-choice validation
remains an application/light-client responsibility and is never implied by a
successful node read.

## License

MIT
