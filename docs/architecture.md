# Architecture

## Repository boundary

The SDK is not part of `Lattice` because consensus must not depend on client
transport or application ergonomics. It is not part of `lattice-node` because
applications must not import a daemon runtime to construct or verify data.

The dependency direction is one way:

```text
published Lattice rules and vectors ──→ core
content service / DHT transport      ──→ volumes
public lattice-node reads            ──→ client
private node or third-party relay    ──→ relay
```

No lower layer imports this SDK.

## Trust boundaries

### Node JSON

Node JSON is bounded discovery and presentation data. It tells an application
which chain the node claims to follow and provides CIDs for canonical objects.
A response is not made cryptographically authoritative merely because it came
from a node endpoint.

All 64- and 128-bit consensus integers use canonical base-10 JSON strings and
are parsed to `bigint`. The SDK intentionally rejects the old JSON-number
spelling; there is one wire contract and no migration branch.

### Volumes

`VolumeTransport` is the adapter boundary for the existing content service or
DHT. The transport must return the complete Volume named by the requested root.
`HTTPVolumeTransport` implements the web-client bridge using Ivy's canonical
binary `VolumeArchive`; it does not translate content into JSON.
Before the SDK exposes it:

- the returned root must equal the requested root;
- the root entry must be present;
- entry and byte limits are enforced;
- duplicate CIDs are rejected; and
- every entry's bytes must hash to its CID.

Volume members may use different codecs. CID verification is generic; typed
DAG-CBOR decoding is applied only when the referenced Lattice structure calls
for it. Unsupported multihash algorithms fail closed.

Typed traversal additionally validates Block and LatticeState structure and
authenticated references. The client cross-checks node block projections with
the canonical Block, verifies each non-genesis Nexus block's own proof of work,
and exposes explicit parent/state continuity verification.
Generic CID verification alone does not establish that a block won fork
choice. `connect` walks a tip back to an app-pinned genesis or checkpoint by
the header rules (with proof of work on Nexus) and, given several nodes,
reads only a tip `minAgree` (default two) of them hold; it does not execute blocks, and child-chain
work (carried in `ChildBlockProof`s) is not served over HTTP, so a child
chain's tip is as honest as the nodes that agree on it.

### Submission

`NodeClient` has no write methods. A caller that wants to send a transaction
must explicitly construct a `TransactionSubmitter`, normally with a selected
third-party relay or a private node. This prevents endpoint discovery from
silently granting a read host transaction-submission authority.

### Keys

The core package provides raw key operations and signing. Mnemonic policy,
hardware wallets, encrypted vaults, user consent, and key persistence belong to
wallets and applications. They are intentionally not hidden inside a network
client.

## Release rules

- Consensus behavior changes only when the pinned Lattice vectors change.
- Node wire changes require coordinated node and SDK tests; there are no
  versioned endpoint aliases.
- Content-service adapters must return complete Volumes, never loose entries
  presented as a verified Volume.
- Submission transports remain separate from public reads.
