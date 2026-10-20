# Getting started

Install the composed package or only the capabilities your application needs:

```sh
npm install @adalin/lattice-sdk
```

## Verified reads

```ts
import { HTTPVolumeTransport, LatticeClient, NodeClient, VolumeClient } from "@adalin/lattice-sdk";

const lattice = new LatticeClient(
  new NodeClient("https://reads.example.org", ["Nexus"]),
  new VolumeClient(new HTTPVolumeTransport("https://content.example.org/volumes")),
);

const { view, canonical } = await lattice.latestBlock();
console.log(view.height, canonical.postStateCID);

const state = await lattice.postState(view.hash);
console.log(state.canonical.accountStateCID);
```

For a hosted child chain, pass the same `chainPath` to `NodeClient` and
`HTTPVolumeTransport`; lattice-node keeps each chain's complete Volumes in its
own local content store.

The node projection is checked against the CID-verified canonical Block. A
non-genesis Nexus block's consensus PoW preimage and target are also verified.
A matching block proves content integrity and its own work, not chain selection: an application
that needs trustless fork choice must begin from its checkpoint and validate
header work and continuity. `assertBlockContinuity` verifies parent CID,
height, and state continuity between two verified blocks.

## Submission

Submission is intentionally a separate capability. Use an application-chosen
third-party relay or a private node, never a read endpoint merely because it
advertises itself:

```ts
const relay = new HTTPTransactionSubmitter("https://relay.example.org/transactions");
const result = await relay.submit(payload);
```

The SDK reports named node refusals through `SubmissionError.reason`. Relay fee
floors are policy and can differ between relays; they are not consensus.

## Network configuration

Keep node reads, content retrieval, and submission as three explicit origins.
Production remote origins must use HTTPS. Loopback HTTP is accepted for local
development. Pin the expected Nexus genesis CID in application configuration;
do not choose a network solely from a server-provided name.
