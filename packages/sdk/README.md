# @adalin/lattice-sdk

The complete TypeScript SDK for [Lattice](https://lattice.build/docs/). It
adds `connect`, which gives a web page or a script one chain to read and
write, and re-exports `@adalin/lattice-client`, `@adalin/lattice-volumes`,
`@adalin/lattice-relay` and `@adalin/lattice-core`.

## Install

```sh
npm install @adalin/lattice-sdk
```

Requires Node.js 22 or later. This package is an ES module with TypeScript
declarations; CommonJS `require()` is not supported.

`dist/browser.js` is one ES module with no imports, so a static page can
load it from a CDN with no bundler:

```js
import { connect } from "https://cdn.jsdelivr.net/npm/@adalin/lattice-sdk@0.2.0/dist/browser.js";
```

## Example

Run with the CID of a recent block of the chain as its argument:

```js
import { connect } from "@adalin/lattice-sdk";

const chain = await connect({
  chain: "Nexus/testnet",
  node: ["https://ams.testnet.lattice.build", "https://lattice-testnet-apps-iad.fly.dev"],
  checkpoint: process.argv[2],
  sponsors: ["https://lattice-testnet-apps-iad.fly.dev:8650/sponsor"],
});

const key = `guestbook/${chain.address}`;
await chain.set(key, "hello"); // paid for in proof of work; resolves once in a block
console.log(await chain.get(key)); // read at the tip, checked by CID
```

## Documentation

- [Getting started](https://github.com/0xLattice/lattice-sdk/blob/main/docs/getting-started.md):
  a complete page that reads and writes, and the lower-level calls.
- [`connect` reference](https://github.com/0xLattice/lattice-sdk/blob/main/docs/connect.md):
  options, methods, errors, and exactly what a read checks.
- [API reference](https://github.com/0xLattice/lattice-sdk/blob/main/docs/api.md#adalinlattice-sdk):
  every export.

MIT
