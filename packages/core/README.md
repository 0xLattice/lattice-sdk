# @adalin/lattice-core

Requires Node.js 22 or later. This package provides ESM and TypeScript declarations; CommonJS `require()` is not supported.

```sh
npm install @adalin/lattice-core
```

Canonical Lattice primitives for TypeScript: DAG-CBOR, CIDs, addresses,
Ed25519 signing, transaction construction, typed Block and LatticeState
decoding, proof-of-work checks, and block continuity checks.

```ts
import { buildTransfer, signTransactionBody } from "@adalin/lattice-core";
```

This package implements protocol-facing values. Applications should normally
start with [`@adalin/lattice-sdk`](https://github.com/0xLattice/lattice-sdk),
which also composes node reads and verified content retrieval.

MIT
