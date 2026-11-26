# Lattice SDK

The TypeScript SDK for building applications on
[Lattice](https://github.com/0xLattice/Lattice): read a chain and check what
you read, sign transactions, and submit them.

The documentation is published at
[lattice.build/docs](https://lattice.build/docs/build/getting-started/) from
the Markdown in this repository. Edit it here.

## Install

```sh
npm install @adalin/lattice-sdk
```

Requires Node.js 22 or later. The packages are ES modules with TypeScript
declarations; CommonJS `require()` is not supported.

In a web page with no bundler, import the single-file build:

```js
import { connect } from "https://cdn.jsdelivr.net/npm/@adalin/lattice-sdk@0.2.0/dist/browser.js";
```

## Documentation

| Page                                                | For                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md)          | A first page that reads and writes a chain, then the lower-level calls. |
| [`connect` reference](docs/connect.md)              | The options, methods, errors and security model of `connect`.           |
| [API reference](docs/api.md)                        | Every exported class, function and error type, by package.              |
| [Architecture](docs/architecture.md)                | The packages and what each one trusts.                                  |
| [Content gateway contract](docs/content-gateway.md) | The HTTP contract for serving Volumes to the SDK.                       |

## Packages

| Package                                                 | Responsibility                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| [`@adalin/lattice-sdk`](packages/sdk/README.md)         | Everything below except `lattice-peer`, plus `connect`               |
| [`@adalin/lattice-client`](packages/client/README.md)   | Read-only node API, composed with verified content                   |
| [`@adalin/lattice-volumes`](packages/volumes/README.md) | Fetching complete Volumes and checking them against their CIDs       |
| [`@adalin/lattice-relay`](packages/relay/README.md)     | Transaction submission; paying fees in work through a sponsor        |
| [`@adalin/lattice-core`](packages/core/README.md)       | DAG-CBOR, CIDs, addresses, Ed25519 signing, transactions, blocks     |
| [`@adalin/lattice-peer`](packages/peer/README.md)       | Following a chain as an overlay peer and checking each header's work |

A release publishes the first five together to npm, with provenance.
`@adalin/lattice-peer` is not published by the release workflow: build it
from this repository.

## Development

```sh
npm install
npm test
```

Tests fetch the conformance vectors pinned in `vectors.lock.json` from
[`0xLattice/Lattice`](https://github.com/0xLattice/Lattice/tree/main/Vectors)
and reproduce every address, encoding, CID and signature vector. The SDK
keeps no copy of consensus fixtures of its own. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the rules on vectors and releases,
and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

MIT
