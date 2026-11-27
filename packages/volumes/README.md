# @adalin/lattice-volumes

Fetches Lattice content and checks it before you see it. A Volume is one
root CID and the exact entries published with it; `VolumeClient` returns a
Volume only once every entry's bytes hash to its CID.

## Install

```sh
npm install @adalin/lattice-volumes
```

Requires Node.js 22 or later. This package is an ES module with TypeScript
declarations; CommonJS `require()` is not supported.

## Example

Run with a root CID, such as a block's hash, as its argument:

```js
import { HTTPVolumeTransport, VolumeClient } from "@adalin/lattice-volumes";

const volumes = new VolumeClient(
  new HTTPVolumeTransport("https://ams.testnet.lattice.build/volumes", {
    chainPath: ["Nexus", "testnet"],
  }),
);
const volume = await volumes.get(process.argv[2]);
console.log(volume.size, volume.decodeRoot());
```

The HTTP transport reads Ivy's binary Volume archive from a
[content gateway](https://github.com/0xLattice/lattice-sdk/blob/main/docs/content-gateway.md).
A native application can implement `VolumeTransport` directly over Ivy or a
DHT.

## Documentation

- [API reference](https://github.com/0xLattice/lattice-sdk/blob/main/docs/api.md#adalinlattice-volumes):
  `VolumeClient`, the transports, the caches (`MemoryVolumeCache`,
  `IndexedDBVolumeCache`), batching, and the error types.

MIT
