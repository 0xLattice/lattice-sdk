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

See the [repository documentation](https://github.com/adalinxx/lattice-sdk)
for verified reads, content gateways, signing, and submission.

MIT
