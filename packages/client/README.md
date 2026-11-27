# @adalin/lattice-client

Read-only access to a Lattice node, composed with content that is checked
against its CID. `NodeClient` reads a node's public JSON API; `LatticeClient`
joins it with a `VolumeClient` so that a block, its state and its
transactions are verified before you see them.

This package cannot submit a transaction. Use
[`@adalin/lattice-relay`](https://github.com/0xLattice/lattice-sdk/blob/main/packages/relay/README.md)
for that.

## Install

```sh
npm install @adalin/lattice-client @adalin/lattice-volumes
```

Requires Node.js 22 or later. This package is an ES module with TypeScript
declarations; CommonJS `require()` is not supported.

## Example

```js
import { LatticeClient, NodeClient } from "@adalin/lattice-client";
import { HTTPVolumeTransport, VolumeClient } from "@adalin/lattice-volumes";

const node = "https://ams.testnet.lattice.build";
const chainPath = ["Nexus", "testnet"];

const client = new LatticeClient(
  new NodeClient(node, chainPath),
  new VolumeClient(new HTTPVolumeTransport(`${node}/volumes`, { chainPath })),
);
const { view, canonical } = await client.latestBlock();
console.log(view.height, canonical.postStateCID);
```

## Documentation

- [API reference](https://github.com/0xLattice/lattice-sdk/blob/main/docs/api.md#adalinlattice-client):
  `NodeClient`, `LatticeClient`, `ChainNodes`, `EndpointResolver`, fee
  pricing and the error types.
- [What is checked, and what is not](https://github.com/0xLattice/lattice-sdk/blob/main/docs/getting-started.md#what-is-checked-and-what-is-not).

MIT
