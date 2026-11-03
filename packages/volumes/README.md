# @adalin/lattice-volumes

Requires Node.js 22 or later. This package provides ESM and TypeScript declarations; CommonJS `require()` is not supported.

```sh
npm install @adalin/lattice-volumes
```

Verified complete-Volume retrieval for Lattice content services and DHTs.
Every member is checked against its CID before it is exposed.

```ts
import { HTTPVolumeTransport, VolumeClient } from "@adalin/lattice-volumes";

const volumes = new VolumeClient(
  new HTTPVolumeTransport("https://content.example.org/volumes", {
    chainPath: ["Nexus"],
  }),
);
const volume = await volumes.get(rootCID);
```

The HTTP transport uses Ivy's canonical binary complete-Volume archive. Native
applications can implement `VolumeTransport` directly over Ivy or a DHT.

## Keeping Volumes, and reading many at once

A Volume never changes, so one verified Volume is the answer for its CID for
good. Give `VolumeClient` a cache and it looks there first and keeps every
Volume it verifies; a failing cache is only a miss.

```ts
import {
  BatchingVolumeTransport,
  HTTPVolumeTransport,
  IndexedDBVolumeCache,
  VolumeClient,
} from "@adalin/lattice-volumes";

const volumes = new VolumeClient(
  // Reads made together (a walk reading a node's children) go as one request
  // to `GET <base>?cids=…`; what the answer leaves out is read on its own.
  new BatchingVolumeTransport(new HTTPVolumeTransport("https://content.example.org/volumes")),
  undefined,
  // Across visits in a browser; `MemoryVolumeCache` for one process.
  { cache: new IndexedDBVolumeCache() },
);
```

Both caches drop the least recently used Volumes past a byte bound
(`maximumBytes`). The IndexedDB cache's lookups made together share one
transaction, and a hit's "last used" is written later, with the others,
in one transaction (`touchAfterMilliseconds`, a second by default) or in
the next `put`, so a hit costs about a hundredth of a millisecond in
Chromium rather than a tenth or more. A gateway without the many-Volumes route is read one Volume
at a time from its first refusal on.

MIT
