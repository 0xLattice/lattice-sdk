# Lattice SDK architecture

How the SDK is divided, and what each part trusts. Read this to decide which
parts an application needs and what their answers are worth. To use the SDK,
start with [Getting started](getting-started.md).

## Where the SDK sits

```text
Lattice              consensus, canonical encoding, proofs, conformance vectors
VolumeBroker / DHT   complete Volume storage and retrieval
lattice-node         chain runtime, bounded public reads, private operator writes
        ↓
lattice-sdk          application-facing composition of those capabilities
```

The SDK is a repository of its own for two reasons. Consensus must not depend
on client transport or application ergonomics, so it is not part of
`Lattice`. Applications must not import a daemon to construct or verify
data, so it is not part of `lattice-node`.

No lower layer imports the SDK.

## Packages

Each package takes one capability from one source:

| Package                   | Source                                            | Responsibility                                                                                             |
| ------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@adalin/lattice-core`    | Lattice's published rules and vectors             | DAG-CBOR, CIDs, addresses, Ed25519 signing, transaction construction, block decoding, proof-of-work checks |
| `@adalin/lattice-volumes` | A content service or DHT transport                | Fetching complete Volumes, with bounds and CID verification                                                |
| `@adalin/lattice-client`  | A node's public reads                             | The read-only node API, and its composition with verified content                                          |
| `@adalin/lattice-relay`   | A private node, a third-party relay, or a sponsor | Transaction submission; paying fees in proof of work                                                       |
| `@adalin/lattice-sdk`     | The four above                                    | Re-exports them, and adds [`connect`](connect.md)                                                          |
| `@adalin/lattice-peer`    | A node's overlay session                          | Following a chain as a peer and checking each header's work                                                |

`@adalin/lattice-sdk` does not re-export `@adalin/lattice-peer`. A release
publishes the first five packages together to npm, with provenance;
`@adalin/lattice-peer` is built from this repository.

The [API reference](api.md) lists what each exports.

## Trust boundaries

The SDK treats node responses, relay responses, DHT providers and Volume
bytes as untrusted input. Each boundary below says what is checked there.

### Node JSON

Node JSON is discovery and presentation data. It tells an application which
chain the node claims to follow and gives the CIDs of canonical objects. A
response is not authoritative because it came from a node endpoint.

Blocks, transactions and state are not copied into a second JSON content
format. A node read finds a Volume's root; the content service or DHT
returns the Volume; the SDK verifies it and follows its authenticated
references.

Every 64- and 128-bit consensus integer is a canonical base-10 JSON string
on the wire and a `bigint` in the SDK. A JSON number in its place is
refused.

### Volumes

A Volume is one root CID and the exact entries published with it.
`VolumeTransport` is the adapter boundary for a content service or DHT: the
transport must return the complete Volume named by the root asked for.
`HTTPVolumeTransport` implements it over a [content gateway](content-gateway.md),
using Ivy's binary Volume archive.

Before the SDK exposes a Volume:

- the returned root must equal the requested root;
- the root entry must be present;
- entry and byte limits are enforced;
- duplicate CIDs are rejected;
- every entry's bytes must hash to its CID.

Entries of one Volume may use different codecs. CID verification is generic;
typed DAG-CBOR decoding is applied only where the referenced Lattice
structure calls for it. An unsupported multihash algorithm fails closed.

### Blocks and the tip

Checking content against a CID shows the content is what the CID names. It
does not show that a block won fork choice. The SDK offers three levels
above it, and none of them executes blocks:

| Part                                       | What it adds                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LatticeClient`                            | Compares the node's JSON with the block it decoded, and checks a non-genesis Nexus block's own proof of work. Which block is the tip is the node's word. `assertBlockContinuity` checks the link between two verified blocks when an application walks them itself. |
| [`connect`](connect.md#what-a-read-checks) | Walks a tip back to a genesis or checkpoint the application pins, by the header rules, with proof of work on Nexus. Given several nodes, reads only a tip that `minAgree` of them (two by default) hold.                                                            |
| `ChainFollower` in `@adalin/lattice-peer`  | Checks the work of every header one node sends, a child chain's through its `ChildBlockProof`, and reports the heaviest.                                                                                                                                            |

What stays outside all three:

- **Execution.** No block's state transition is run, so a block that links
  and carries work can still hold a state that was not honestly reached.
- **The target schedule.** A block's target is compared with its parent's
  stated `nextTarget`, not recomputed.
- **Child-chain work over HTTP.** A child block's work is carried in
  `ChildBlockProof`s, which the HTTP API does not serve. `connect` therefore
  checks no work on a child chain, and a child chain's tip is as honest as
  the nodes that agree on it. Only `ChainFollower` checks it.

An application that needs more than this validates the chain itself, as a
full node does. A successful node read never implies it.

### Submission

`NodeClient` has no write methods. To send a transaction, a caller
constructs a `TransactionSubmitter`, normally an `HTTPTransactionSubmitter`
pointed at a relay it chose or at its own node. Finding a read endpoint
therefore never gives that host the authority to take transactions. A
discovered host's claim to accept submits is reported as data only.

`connect` is the one place that pairs the two: it submits to the first node
the application names.

### Keys

| Part                             | Holds a private key?                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@adalin/lattice-core`           | No. Its functions take a key as an argument and store nothing.                                                                          |
| `connect` with a `key` option    | In memory, for the life of the object. It stores nothing.                                                                               |
| `connect` without a `key` option | Yes. It makes a key on first use and keeps it in the page's `localStorage`, or in memory where there is none ([Keys](connect.md#keys)). |

The SDK has no recovery phrases, hardware wallet support, encrypted vaults
or consent prompts. Those belong to wallets and applications. An
application that must not hold a key leaves signing to the user's wallet and
uses the SDK to read.

### Operator-declared endpoints

`EndpointResolver` and `ChainNodes` find a chain's hosts from what other
nodes relay. A declared host is accepted only when it answers that it serves
the chain at that path on the same network, and every result is labelled
`operator-declared, not independently verified`. What a parent chain commits
never decides which host is accepted.
