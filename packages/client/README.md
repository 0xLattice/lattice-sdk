# @adalin/lattice-client

Requires Node.js 22 or later. This package provides ESM and TypeScript declarations; CommonJS `require()` is not supported.

```sh
npm install @adalin/lattice-client
```

Read-only Lattice node access composed with CID-verified Volume retrieval.

```ts
import { LatticeClient, NodeClient } from "@adalin/lattice-client";
import { HTTPVolumeTransport, VolumeClient } from "@adalin/lattice-volumes";

const client = new LatticeClient(
  new NodeClient("https://reads.example.org", ["Nexus"]),
  new VolumeClient(new HTTPVolumeTransport("https://content.example.org/volumes")),
);
const { view, canonical } = await client.latestBlock();
```

The package has no transaction-submission API. Use an application-selected
third-party relay or private node through `@adalin/lattice-relay`.

MIT
