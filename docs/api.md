# Lattice SDK API reference

Every class, function, constant and error type the SDK's packages export,
with its signature and what it does. To learn the SDK, start with
[Getting started](getting-started.md).

| Package                                             | Exports                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`@adalin/lattice-sdk`](#adalinlattice-sdk)         | `connect`, share search, and everything in the four packages below.                |
| [`@adalin/lattice-client`](#adalinlattice-client)   | Read-only node access, verified block reads, finding a chain's nodes, fee pricing. |
| [`@adalin/lattice-volumes`](#adalinlattice-volumes) | Fetching Volumes and checking them against their CIDs; caches.                     |
| [`@adalin/lattice-relay`](#adalinlattice-relay)     | Submitting transactions; paying fees in work through a sponsor.                    |
| [`@adalin/lattice-core`](#adalinlattice-core)       | Encoding, CIDs, keys, signing, transactions, blocks, proof of work.                |
| [`@adalin/lattice-peer`](#adalinlattice-peer)       | Following a chain as an overlay peer. Not re-exported by `@adalin/lattice-sdk`.    |

Conventions that hold throughout:

- Every 64- and 128-bit integer is a `bigint`. On the wire it is a base-10
  JSON string; a JSON number is refused.
- A CID, an address, a public key and a signature are `string`s. A public key
  is Multikey hex (`ed01` and 64 hex digits); a signature is 128 hex digits.
- A chain path is `readonly string[]`, as `["Nexus", "testnet"]`.
- A trailing `signal?: AbortSignal` cancels the call. It is left out of the
  tables below where it is the only optional argument.
- Remote URLs must be HTTPS. HTTP is accepted on loopback only. No request
  follows a redirect.

## `@adalin/lattice-sdk`

### `connect`

| Export                                         | Signature                                                  | Does                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `connect`                                      | `(options: ConnectOptions) => Promise<Chain>`              | A chain to read and write. See the [`connect` reference](connect.md).                                                                |
| `ConnectOptions`, `Chain`, `Entry`, `Progress` | types                                                      | The options, the returned object, a `{ key, value }` entry, and a progress event.                                                    |
| `retryDelay`                                   | `(error: unknown, attempt: number) => number \| undefined` | How long `connect` waits before retrying a request that failed with `error`, in milliseconds, or `undefined` when it is not retried. |

### Share search

`connect` uses these to find a sponsor's shares; call them directly only to
drive a [sponsor](#paying-a-fee-in-work) yourself.

| Export               | Signature                                                                          | Does                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `findShares`         | `(work, options?: ShareSearchOptions) => AsyncGenerator<bigint>`                   | The shares in `work`'s nonce range as they are found, in Web Workers or on the calling thread. Stops at the end of the range or when it expires. |
| `searchShares`       | `(prefixHex: string, targetHex: string, start: bigint, count: number) => bigint[]` | The nonces in one slice whose hash is at most the target, in nonce order. Synchronous.                                                           |
| `defaultWorkers`     | `() => number`                                                                     | All cores but one where Web Workers exist, else `0`.                                                                                             |
| `ShareSearchOptions` | `{ workers?, signal?, onHashes? }`                                                 | `workers: 0` searches on the calling thread.                                                                                                     |

### Errors

| Error        | Fields                        | Thrown when                                                                                                               |
| ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ReadError`  | `code: ReadFailure`           | No tip could be read: `"unanchored"`, `"tooFar"` or `"disagree"`.                                                         |
| `WriteError` | `code: WriteFailure`, `cause` | A write or upload failed: `"insufficientBalance"`, `"rejected"`, `"sponsorUnavailable"`, `"refused"` or `"notConfirmed"`. |

Each code is explained under [Errors](connect.md#errors) in the `connect`
reference.

## `@adalin/lattice-client`

### `NodeClient`

Reads a node's public JSON API for one chain. It has no method that submits
a transaction.

```ts
new NodeClient(baseURL: string, chainPath: readonly string[], options?: NodeClientOptions)
```

| Option                 | Default            | Meaning                                                                                                    |
| ---------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `fetch`                | the global `fetch` | The transport.                                                                                             |
| `timeoutMilliseconds`  | 8,000              | Per request.                                                                                               |
| `maximumResponseBytes` | 4 MiB              | Per response.                                                                                              |
| `authorization`        | none               | The `Authorization` header for a node's operator port ([`nodeCookieAuthorization`](#node-authentication)). |

| Member                                 | Returns                       | Route                                                                                            |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `baseURL`, `chainPath`                 | `string`, `readonly string[]` | The normalized URL and the chain.                                                                |
| `health()`                             | `NodeStatus`                  | `GET /health`                                                                                    |
| `latestBlock()`                        | `LatestBlockView`             | `GET /api/block/latest`                                                                          |
| `block(id: string \| bigint)`          | `BlockView`                   | `GET /api/block/:height-or-cid`                                                                  |
| `blocks({ before?, limit? })`          | `BlocksPage`                  | `GET /api/blocks`: block summaries, newest first. `before` is exclusive; `limit` is 1 to 25.     |
| `children(blockCID)`                   | `BlockChild[]`                | `GET /api/block/:cid/children`: the child blocks one block commits.                              |
| `childDirectories({ after?, limit? })` | `ChildDirectoriesPage`        | `GET /api/chain/children`: one page of the child directories this chain's blocks have committed. |
| `nexusGenesis()`                       | `string`                      | `GET /api/chain/genesis`: which network the node is on.                                          |
| `account(owner)`                       | `AccountState`                | `GET /api/state/account/:addr`: balance and next nonce at the tip.                               |
| `transaction(cid)`                     | `TransactionProjection`       | `GET /api/transaction/:cid`: `blockHeight` is set once it is in a block.                         |
| `transactionContent(cid)`              | `{ cid, bodyCID }`            | `GET /transactions/:cid`                                                                         |
| `chainInfo()`                          | `ChainInfo`                   | `GET /api/chain/info`: `minRelayFee`, `acceptsSubmit`, height and tip.                           |
| `chainSpec()`                          | `ChainSpec`                   | `GET /api/chain/spec`                                                                            |
| `fees()`                               | `FeeEstimates`                | `GET /api/fees`                                                                                  |
| `mempool()`                            | `{ count, transactions }`     | `GET /api/mempool`                                                                               |

Every method takes a trailing `signal` and returns a promise. A response
that is not the expected shape throws `TypeError`; a page that does not
continue the one asked for is refused the same way.

The routes themselves are documented in the node's
[HTTP API](https://lattice.build/docs/build/http-api/reads-and-transactions/).

### `LatticeClient`

Joins a `NodeClient` with a [`VolumeClient`](#volumeclient): the node says
which block, and the content is fetched and checked against its CID.

```ts
new LatticeClient(node: NodeClient, volumes: VolumeClient)
```

| Method                        | Returns                                        | Checks                                                                                                                                                         |
| ----------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `latestBlock()`               | `{ view, volume, canonical }`                  | As `block`, for the node's latest block.                                                                                                                       |
| `block(id: string \| bigint)` | `{ view, volume, canonical }`                  | The block's bytes hash to its CID; the node's JSON (`view`) matches the decoded block (`canonical`); a non-genesis Nexus block meets its proof-of-work target. |
| `postState(id)`               | `{ volume, canonical }`                        | The block as above, then its post-state Volume by CID. `canonical` holds the four state roots.                                                                 |
| `transactions(id)`            | `VerifiedVolume`                               | The block as above, then its transactions Volume by CID.                                                                                                       |
| `transaction(cid)`            | `{ projection, transaction, canonical, body }` | The transaction Volume by CID, that the node's projection names the same CID, and that the Volume holds the body.                                              |

None of these checks that a block is on the chain or is its tip
([What is checked](getting-started.md#what-is-checked-and-what-is-not)).

### Finding a chain's nodes

| Export                      | Signature                                                                         | Does                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChainNodes`                | `new ChainNodes(start: string \| readonly string[], options?: ChainNodesOptions)` | The nodes that serve a chain: the start nodes that host it, then the hosts its parent chain's hosts declare for it.                                   |
| `ChainNodes.list`           | `(chainPath) => Promise<ChainNode[]>`                                             | Start nodes first, then found hosts, in declared order. Kept for `ttlMilliseconds` (30 s).                                                            |
| `ChainNodes.read`           | `<T>(chainPath, read: (node: ChainNode) => Promise<T>) => Promise<T>`             | Runs `read` on the next node in turn, then the rest until one answers. Throws the last failure, or `ChainOfflineError` when no node serves the chain. |
| `EndpointResolver`          | `new EndpointResolver(root: NodeClient, options?: EndpointResolverOptions)`       | Walks declared endpoints down from a node you chose.                                                                                                  |
| `EndpointResolver.resolve`  | `(chainPath, signal?) => Promise<ResolvedEndpoint[]>`                             | The accepted hosts of `chainPath`, which must extend the root's path. Ends within `maximumRequests` requests.                                         |
| `EndpointResolver.walk`     | `(signal?) => AsyncGenerator<ResolvedEndpoint>`                                   | Every chain below the root whose hosts answer, breadth first, until the tree ends or the caller stops.                                                |
| `EndpointResolver.declared` | `(sourceURL, chainPath, signal?) => Promise<DeclaredEndpoints>`                   | One node's raw, unverified declaration.                                                                                                               |
| `declaredEndpointURL`       | `(input: string) => string \| undefined`                                          | A declared URL normalized, or `undefined` when it must not be dialed: HTTPS only, a public host only, no credentials, query or fragment.              |
| `isPublicAddress`           | `(address: string) => boolean`                                                    | Whether an IP address literal is public.                                                                                                              |
| `OPERATOR_DECLARED`         | `"operator-declared, not independently verified"`                                 | The `trust` label every `ResolvedEndpoint` carries.                                                                                                   |

A declared endpoint is a claim by the host's operator, relayed by another
node. The resolver accepts a host only when it answers that it serves the
chain at that path, with a tip, on the root's network. That is a consistency
check, not proof. A host's `declaresSubmit` is data only: to send a
transaction, construct a submitter yourself.

Pass `lookup` in `EndpointResolverOptions` (for example Node's
`dns.promises.lookup` with `all: true`) to dial a declared name only when
every address it resolves to is public. Without it only literal hosts are
judged.

### Fee pricing

| Export              | Signature                                                      | Does                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transactionWeight` | `(size: number, growth: number, weight?: FeeWeight) => number` | What a node's fee rate is over for a transaction of `size` bytes adding at most `growth` state: the most of a block it takes of any limit. Its size where `weight` is absent. |
| `feeToOutbid`       | `(block: ProjectedBlock, weight: number) => bigint`            | The smallest fee for a transaction of `weight` to rank ahead of `block`'s lowest-rate transaction.                                                                            |

`FeeEstimates` (from `NodeClient.fees()`) lists the blocks one node's pool
would fill next. No block, or a first block that is not `full`, means the
next block has room and a fee at `minRelayFee` makes it. It is an estimate
from one node's pool, not a promise. Size a transaction with
[`signedTransactionSize`](#transactions) and
[`stateGrowthCeiling`](#transactions).

### Low-level JSON transport

| Export             | Signature                                                      | Does                                                                                                                     |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `getJSON`          | `(url: URL, options?: JSONRequestOptions) => Promise<unknown>` | A bounded JSON `GET`.                                                                                                    |
| `normalizeNodeURL` | `(input: string) => string`                                    | A node URL without a trailing slash; throws unless it is HTTPS or loopback HTTP, with no credentials, query or fragment. |

`getJSON` options: `fetch`, `signal`, `authorization`, `timeoutMilliseconds`
(8,000) and `maximumResponseBytes` (4 MiB). It forbids redirects and bounds
both the fetch and the body read, including an injected transport that
ignores cancellation. Such a transport may keep running after the call
rejects: cancellation is best-effort.

`getJSON` does not check the URL. Validate the base with `normalizeNodeURL`
before adding a route path or query:

```ts
import { getJSON, normalizeNodeURL } from "@adalin/lattice-client";

const base = normalizeNodeURL("https://ams.testnet.lattice.build");
const info = await getJSON(new URL(`${base}/api/chain/info?chainPath=Nexus/testnet`), {
  timeoutMilliseconds: 3000,
  maximumResponseBytes: 1024 * 1024,
});
```

### Response types and parsers

`NodeStatus`, `LatestBlockView`, `BlockView`, `BlockSummary`, `BlocksPage`,
`BlockChild`, `ChildDirectoriesPage`, `AccountState`,
`TransactionProjection`, `ChainInfo`, `ChainSpec`, `FeeEstimates`,
`ProjectedBlock`, `FeeWeight`, `DeclaredEndpoints`, `ResolvedEndpoint` and
`ChainNode` are the shapes the methods above return.

Each has a parser that takes decoded JSON and throws `TypeError` on any
other shape: `parseNodeStatus`, `parseLatestBlock`, `parseBlock`,
`parseBlocksPage`, `parseBlockChildren`, `parseAccount`,
`parseTransactionProjection`, `parseChainInfo`, `parseChainSpec`,
`parseFeeEstimates`, `parseDeclaredEndpoints`.

### Errors

| Error               | Fields                               | Thrown when                                                                                                               |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `NodeError`         | `status: number`, `refusal?: string` | A node answered with an error status, an oversized body, or a body that is not JSON. `refusal` is the node's own message. |
| `ChainOfflineError` | `chainPath`                          | `ChainNodes` found no node serving the chain, and every start node answered.                                              |

## `@adalin/lattice-volumes`

A Volume is one root CID and the exact `(CID, bytes)` entries published with
it. A transport fetches Volumes; `VolumeClient` checks them.

### `VolumeClient`

```ts
new VolumeClient(transport: VolumeTransport, limits?: VolumeLimits, options?: VolumeClientOptions)
```

| Member | Signature                                               | Does                                                                                              |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `get`  | `(rootCID: string, signal?) => Promise<VerifiedVolume>` | Fetches the Volume and verifies it. Throws `VolumeError` when it is not found or does not verify. |

`limits` defaults to `DEFAULT_VOLUME_LIMITS`: 4,096 entries and 64 MiB.
Options: `cache` (a [`VolumeCache`](#caches)) and `cacheWaitMilliseconds`
(1,000), how long a read waits on the cache before reading past it.

Before a Volume is returned:

- its root must be the root asked for, and the root entry must be present;
- the entry and byte limits are enforced;
- a duplicate CID is refused;
- every entry's bytes must hash to its CID. An unsupported hash algorithm
  fails.

### `VerifiedVolume`

| Member         | Returns                   | Meaning                             |
| -------------- | ------------------------- | ----------------------------------- |
| `rootCID`      | `string`                  | The root.                           |
| `size`         | `number`                  | How many entries.                   |
| `has(cid)`     | `boolean`                 | Whether the Volume holds the entry. |
| `bytes(cid)`   | `Uint8Array \| undefined` | A copy of one entry's bytes.        |
| `rootBytes()`  | `Uint8Array`              | A copy of the root entry's bytes.   |
| `decodeRoot()` | `DagCborValue`            | The root entry decoded as DAG-CBOR. |
| `entries()`    | `readonly VolumeEntry[]`  | Every entry, copied.                |

### Transports

| Export                    | Signature                                                                         | Does                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `VolumeTransport`         | `{ getVolume(rootCID, signal?): Promise<SerializedVolume \| null> }`              | The interface to implement over a gateway, Ivy or a DHT. `null` means not found.                                               |
| `HTTPVolumeTransport`     | `new HTTPVolumeTransport(endpoint: string, options?: HTTPVolumeTransportOptions)` | Reads a [content gateway](content-gateway.md): one Volume from `GET <endpoint>/<root CID>`, many from `GET <endpoint>?cids=…`. |
| `BatchingVolumeTransport` | `new BatchingVolumeTransport(transport: ManyVolumeTransport, options?)`           | Sends reads made together as one many-Volumes request; what the answer leaves out is read on its own.                          |
| `MemoryVolumeTransport`   | `new MemoryVolumeTransport(volumes?: readonly SerializedVolume[])`                | An in-memory source for tests, with `put(volume)`.                                                                             |

`HTTPVolumeTransportOptions`: `fetch`, `timeoutMilliseconds` (15,000),
`limits`, `authorization` (for a private gateway), and `chainPath` (the
hosted chain whose Volume store should answer, sent as `?chainPath=`).

`BatchingVolumeTransport` options: `maximumBatch` (32, the node's bound),
`windowMilliseconds` (4), how long a read waits for others to join its
request, and `backoffMilliseconds` (30,000), how long reads go one at a time
after a many-Volumes request fails. A gateway without the many-Volumes route
is read one Volume at a time from its first refusal on.

### Caches

A Volume never changes, so one verified Volume is the answer for its CID for
good. Give `VolumeClient` a cache and it looks there first and keeps every
Volume it verifies. What comes back from a cache is verified again, and a
cache that fails is only a miss.

```ts
import {
  BatchingVolumeTransport,
  HTTPVolumeTransport,
  IndexedDBVolumeCache,
  VolumeClient,
} from "@adalin/lattice-volumes";

const volumes = new VolumeClient(
  new BatchingVolumeTransport(new HTTPVolumeTransport("https://ams.testnet.lattice.build/volumes")),
  undefined, // the default limits
  { cache: new IndexedDBVolumeCache() },
);
```

| Export                 | Signature                                                                     | Keeps                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `MemoryVolumeCache`    | `new MemoryVolumeCache({ maximumBytes? })`                                    | Volumes in memory, for one process. 32 MiB by default.                                        |
| `IndexedDBVolumeCache` | `new IndexedDBVolumeCache({ name?, maximumBytes?, touchAfterMilliseconds? })` | Volumes across visits in a browser. 64 MiB by default, in a database named `lattice-volumes`. |
| `VolumeCache`          | `{ get(rootCID), put(volume), delete?(rootCID) }`                             | The interface to implement your own.                                                          |

Both caches drop the least recently used Volumes past `maximumBytes`. The
IndexedDB cache's lookups made together share one transaction. A hit's
"last used" is written later, with the others, in one transaction
(`touchAfterMilliseconds`, a second by default) or in the next `put`, so a
hit costs about a hundredth of a millisecond in Chromium.

### Archives and proofs

| Export                    | Signature                                                              | Does                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `verifyVolume`            | `(volume: SerializedVolume, expectedRoot?, limits?) => VerifiedVolume` | The checks listed under [`VolumeClient`](#volumeclient).                                                                                |
| `encodeVolumeArchive`     | `(volume: SerializedVolume) => Uint8Array`                             | Encodes Ivy's binary Volume archive.                                                                                                    |
| `decodeVolumeArchive`     | `(rootCID: string, archive: Uint8Array, limits?) => SerializedVolume`  | Strictly decodes one archive and verifies it.                                                                                           |
| `decodeVolumeRecords`     | `(body: Uint8Array) => { rootCID, archive }[]`                         | Splits a many-Volumes answer into its archives.                                                                                         |
| `verifyUint64SparseProof` | `(proof: Uint64SparseProof) => boolean`                                | Verifies a sparse-radix proof of an optional `UInt64` value from the entries supplied. A missing child is invalid and is never fetched. |

Constants: `VOLUME_ARCHIVE_MEDIA_TYPE` (`application/vnd.lattice.volume`),
`MANY_VOLUMES_MEDIA_TYPE` (`application/vnd.lattice.volumes`),
`MAXIMUM_VOLUME_ARCHIVE_BYTES` (64 MiB), `MAXIMUM_VOLUME_ARCHIVE_ENTRIES`
(65,535), `MAXIMUM_VOLUME_CID_BYTES` (8,192), `DEFAULT_VOLUME_LIMITS`.

Types: `VolumeEntry` (`{ cid, bytes }`), `SerializedVolume`
(`{ rootCID, entries }`), `VolumeLimits`
(`{ maximumEntries, maximumBytes }`), `ManyVolumeTransport`,
`VolumeClientOptions`, `HTTPVolumeTransportOptions`,
`BatchingVolumeTransportOptions`, `Uint64SparseProof`.

### Errors

| Error                  | Fields            | Thrown when                                                                                                                                                             |
| ---------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VolumeError`          | `code`            | A Volume is missing or does not verify: `"not-found"`, `"wrong-root"`, `"missing-root"`, `"duplicate-entry"`, `"too-many-entries"`, `"too-large"` or `"invalid-entry"`. |
| `VolumeTransportError` | `status?: number` | The transport failed: an error status, an oversized response, or an archive that does not decode.                                                                       |

## `@adalin/lattice-relay`

### Submitting

| Export                            | Signature                                                                        | Does                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `HTTPTransactionSubmitter`        | `new HTTPTransactionSubmitter(endpoint: string, options?: HTTPSubmitterOptions)` | Posts a transaction to a node's `POST /transactions` or a relay.                                       |
| `HTTPTransactionSubmitter.submit` | `(payload: TransactionPayload, signal?) => Promise<SubmitResult>`                | Resolves to `{ transactionCID, mempoolCount?, mempoolBytes? }`; throws `SubmissionError` on a refusal. |
| `TransactionSubmitter`            | `{ submit(payload, signal?) }`                                                   | The interface, for a transport of your own.                                                            |

`HTTPSubmitterOptions`: `fetch`, `timeoutMilliseconds` (8,000),
`maximumResponseBytes` (1 MiB) and `authorization` (for a node's operator
port).

An accepted submission is pooled, not included. Recompute the CID with
[`signedTransactionCID`](#transactions) rather than trusting the answer, and
read the transaction back to see it in a block.

### Paying a fee in work

A key with no coin can still transact and store files through a
[lattice-sponsor](https://github.com/0xLattice/lattice-sponsor): it grinds
shares of the sponsor's block template, and the sponsor pays the fee, or
pins the file, in return. [`connect`](connect.md#sponsors) does all of this
for you.

| Export               | Signature                                                                                                    | Does                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `SponsorClient`      | `new SponsorClient(endpoint: string, options?: SponsorClientOptions)`                                        | A client of one sponsor. Requests time out after 30 s by default.                                              |
| `requestWork`        | `({ client?, chain?, pay?, store? }, signal?) => Promise<SponsorWork>`                                       | A nonce range to grind. Without `store`, its shares buy `chain`'s fee; with `store`, they pay for that upload. |
| `submitShare`        | `(assignment: string, nonce: bigint, signal?) => Promise<{ credit }>`                                        | Posts one share; answers the client's credit on that chain.                                                    |
| `sponsorTransaction` | `(client: string, draft: TransactionBody, pay?: bigint, signal?) => Promise<{ body, signatures, fee, pay }>` | The sponsor's co-signature on `draft`, paid from the client's credit.                                          |
| `store`              | `(root: string, volumes: readonly StoreVolume[], signal?) => Promise<StoreStatus>`                           | Hands over an upload to be paid for in work.                                                                   |
| `storeStatus`        | `(root: string, signal?) => Promise<StoreStatus>`                                                            | Whether an upload is paid for and pinned. A pin lasts until the sponsor's operator takes it down.              |
| `grind`              | `(work, signal?) => AsyncGenerator<bigint>`                                                                  | The shares in `work`'s range, in nonce order, on the calling thread.                                           |
| `shareHash`          | `(prefixHex: string, nonce: bigint) => Uint8Array`                                                           | A share's hash: SHA-256 of the prefix and the nonce as 8 big-endian bytes.                                     |

The sequence, as a fragment (it assumes a `draft` `TransactionBody` whose
only signer is your key, a `privateKey`, and a `relay` submitter):

```ts
import { SponsorClient, grind } from "@adalin/lattice-relay";
import { signTransactionBody, transactionPayload } from "@adalin/lattice-core";

const sponsor = new SponsorClient("https://lattice-testnet-apps-iad.fly.dev:8650/sponsor");

// The fee: shares on the chain, then the sponsor's co-signature.
const work = await sponsor.requestWork({ chain: "Nexus/testnet" });
for await (const nonce of grind(work)) {
  const { credit } = await sponsor.submitShare(work.assignment, nonce);
  if (credit >= work.fee) break;
}
const { body, signatures } = await sponsor.sponsorTransaction(work.client, draft);
const own = signTransactionBody(body, privateKey);
await relay.submit(transactionPayload({ ...signatures, [own.publicKey]: own.signature }, body));
```

- `sponsorTransaction` rebuilds the sponsored body from the draft and
  refuses one that differs. The client only ever signs its draft plus the
  sponsor's own debit.
- `grind` is plain JavaScript with no Node APIs, so it runs in a page or a
  worker. It yields to the event loop as it searches, and stops on `signal`,
  at the end of the range, or one hour after the work was requested.
  That hour is the sponsor's `expiresInMilliseconds`, which is a constant
  and not a deadline: work stays valid until the chain's tip moves.
- A share refused as `unknownAssignment` (the usual one, after a block
  lands) or `expired` is answered by asking for new work with the same
  `client`. `soldOut` is a `503` with `Retry-After`: retry once the chain
  moves on.
- A client token does not survive a restart of the sponsor. A token it no
  longer knows is refused; ask for work without one, and earn the credit
  again.
- The example's sponsor URL ends in `/sponsor` because that deployment
  serves the sponsor behind a proxy under that prefix. A sponsor itself
  serves `/work`, `/shares` and the rest at its root: give `SponsorClient`
  the URL those routes are under.
- Storage works the same way: `store(root, volumes)`, then
  `requestWork({ chain, store: root })`, then shares until
  `storeStatus(root)` reports `stored`.

`SponsorClient` covers part of what a sponsor serves: work for a fee or for
storage, shares, the co-signature and uploads. It has no call for a
sponsor's terms, coin payments, funds, payouts or serving standing
(`GET /terms`, `POST /pay`, `GET /fund`, `GET /earnings`, and the `peer` and
`payTo` options of `POST /work`). The whole service is in the
[lattice-sponsor API](https://github.com/0xLattice/lattice-sponsor/blob/main/docs/api.md).

Types: `SponsorWork`, `StoreStatus`, `StoreVolume`, `SponsorClientOptions`,
`SubmitResult`, `HTTPSubmitterOptions`.

### Errors

| Error             | Fields                                                     | Thrown when                                                                                                                     |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SubmissionError` | `status`, `refusal?: string`, `reason?: SubmissionRefusal` | The node or relay refused a transaction. `refusal` is its text; `reason` is set when that text is one of `SUBMISSION_REFUSALS`. |
| `SponsorError`    | `status`, `refusal?: string`, `retryAfterMilliseconds?`    | A sponsor refused a request, such as `insufficientCredit` or `expired`.                                                         |

`SUBMISSION_REFUSALS` lists the refusals the SDK recognizes by name:
`belowMinRelayFee`, `feeTooLow`, `conflictingNonce`, `nonceAhead`,
`unavailable`, `insufficientFunds`, `invalidState`, `tooLarge`, `full`,
`unresolved`, `contextChanged`, `unknownChain`, `shuttingDown` and
`requestTooLarge`. Their meanings, and which to retry, are in the node's
[HTTP API](https://lattice.build/docs/build/http-api/reads-and-transactions/). A `429` with no body
is a rate limit; a `429` named `full` is the node's pool. A fee floor
(`belowMinRelayFee`) is one node's choice, never a consensus rule.

## `@adalin/lattice-core`

### Keys and addresses

| Export                  | Signature                                                        | Does                                                      |
| ----------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| `generatePrivateKey`    | `() => Uint8Array`                                               | A new random Ed25519 private key, 32 bytes.               |
| `publicKeyFromPrivate`  | `(privateKey: Uint8Array) => Uint8Array`                         | The 32-byte public key.                                   |
| `accountFromPrivateKey` | `(privateKey: Uint8Array) => { privateKey, publicKey, address }` | The Multikey public key and the address of a private key. |
| `encodeEd25519Multikey` | `(publicKey: Uint8Array) => string`                              | `ed01` and the key's hex.                                 |
| `decodeEd25519Multikey` | `(multikey: string) => Uint8Array`                               | The reverse; throws on any other key type.                |
| `addressFromPublicKey`  | `(publicKey: Uint8Array) => string`                              | The address: the CID of `{ key: <Multikey> }`.            |
| `addressFromMultikey`   | `(multikey: string) => string`                                   | The same, from the Multikey string.                       |

These functions take a private key as an argument and store nothing. Where
a key is kept is the caller's choice; only [`connect`](connect.md#keys) keeps
one itself.

### Transactions

| Export                       | Signature                                                                              | Does                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `buildTransfer`              | `({ from, to, amount, fee, nonce, chainPath }) => TransactionBody`                     | A transfer of `amount` with `fee`, signed by `from`.                                         |
| `signTransactionBody`        | `(body: TransactionBody, privateKey: Uint8Array) => { bodyCID, publicKey, signature }` | Signs the body's domain-separated envelope.                                                  |
| `transactionPayload`         | `(signatures: Record<string, string>, body: TransactionBody) => TransactionPayload`    | The JSON `POST /transactions` takes; `signatures` maps public key to signature.              |
| `signedTransactionCID`       | `(signatures, body) => string`                                                         | The CID a node reports for the signed transaction, so a client can check it.                 |
| `encodeTransactionBody`      | `(body) => { bytes, cid }`                                                             | The body's DAG-CBOR and its CID.                                                             |
| `encodeSignedTransaction`    | `(signatures, bodyCID: string) => { bytes, cid }`                                      | The signed envelope as the node stores it. Prefer `signedTransactionCID`.                    |
| `transactionSigningPreimage` | `(bodyCID: string, chainPath, nonce: bigint) => string`                                | The envelope text that is signed.                                                            |
| `toWireTransactionBody`      | `(body) => WireTransactionBody`                                                        | The body with its integers as decimal strings.                                               |
| `signedTransactionSize`      | `(body) => number`                                                                     | The bytes a node's pool counts for `body` once each signer has signed. Exact before signing. |
| `stateGrowthCeiling`         | `(body) => number`                                                                     | The most state `body` can add to a block, as the protocol counts it.                         |
| `signPreimage`               | `(preimage: string, privateKey: Uint8Array) => string`                                 | An Ed25519 signature over `SIGNATURE_DOMAIN + preimage`, as hex.                             |
| `verifyPreimage`             | `(preimage: string, signature: string, publicKey: Uint8Array) => boolean`              | Checks such a signature.                                                                     |
| `SIGNATURE_DOMAIN`           | `"lattice-tx-v1:"`                                                                     | The signing prefix.                                                                          |

A `TransactionBody` is
`{ accountActions, actions, depositActions, receiptActions, withdrawalActions, signers, nonce, chainPath }`.
Its parts are the types `AccountAction` (`{ owner, delta }`), `Action`
(`{ key, oldValue?, newValue? }`), `DepositAction`, `ReceiptAction` and
`WithdrawalAction`. `TransactionPayload` and `WireTransactionBody` are the
wire forms. The fields are described in
[Transaction format](https://github.com/0xLattice/lattice-skills/blob/main/skills/lattice-transactions/references/transaction-format.md).

### Blocks, state and proof of work

| Export                                                               | Signature                                                                         | Does                                                                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `decodeCanonicalBlock`                                               | `(bytes: Uint8Array) => CanonicalBlock`                                           | Decodes a block from CID-verified bytes; throws `TypeError` on a bad field.                          |
| `decodeLatticeBlock`                                                 | `(bytes: Uint8Array) => CanonicalBlock \| undefined`                              | The stricter decoder: only the known fields, standard links and canonical targets; else `undefined`. |
| `decodeCanonicalLatticeState`                                        | `(bytes) => CanonicalLatticeState`                                                | The four state roots: account, general, deposit and receipt.                                         |
| `decodeCanonicalSignedTransaction`                                   | `(bytes) => CanonicalSignedTransaction`                                           | A signed transaction's body CID and signatures.                                                      |
| `assertBlockContinuity`                                              | `(parentCID: string, parent: CanonicalBlock, child: CanonicalBlock) => void`      | Throws unless `child` names `parentCID`, is one higher, and starts from the parent's post-state.     |
| `verifyNexusBlockProofOfWork`                                        | `(block: CanonicalBlock) => boolean`                                              | Whether a Nexus block's own hash meets its target. Not for child-chain blocks.                       |
| `workForTarget`                                                      | `(target: string) => bigint`                                                      | The work a target stands for: `2^256 / (target + 1)`.                                                |
| `canonicalBlockProofOfWorkPreimage`, `canonicalBlockProofOfWorkHash` | `(block) => Uint8Array`                                                           | The consensus proof-of-work preimage of a block, and its SHA-256.                                    |
| `verifyChildBlockProof`                                              | `(proof: ChildBlockProof, childBytes: Uint8Array, chainPath) => ChildProofResult` | Verifies that a mined root commits a child block along `chainPath`, and derives the work it carries. |
| `decodeChildBlockProof`                                              | `(bytes) => ChildBlockProof \| undefined`                                         | Decodes the proof's wire format.                                                                     |
| `isStandardCID`                                                      | `(value: string) => boolean`                                                      | A CIDv1 dag-cbor sha2-256 CID in its one canonical spelling.                                         |
| `isValidChildDirectory`                                              | `(value: string) => boolean`                                                      | A name a block may carry a child under: visible ASCII with no `/`.                                   |

`verifyChildBlockProof` answers `{ ok: true, evidence }` or
`{ ok: false, failure }`, where `failure` is `"malformedEvidence"` (the
proof does not show what it claims) or `"protocolInvalid"` (it does, but
what it shows is not a valid structure). The carrier's validity, the child's
own validity and which block is canonical are outside the proof.

Types: `CanonicalBlock`, `CanonicalLatticeState`,
`CanonicalSignedTransaction`, `ChildBlockProof`, `VerifiedChildEvidence`,
`ChildProofFailure`, `ChildProofResult`.

### CIDs

| Export                                 | Signature                                                | Does                                                                                           |
| -------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `cidV1DagCbor`                         | `(blockBytes: Uint8Array) => string`                     | The CID of DAG-CBOR bytes.                                                                     |
| `cidV1`                                | `(codec: number, blockBytes: Uint8Array) => string`      | A CIDv1 with a SHA-256 hash for any codec.                                                     |
| `verifyCID`, `assertCID`               | `(cid: string, content: Uint8Array) => boolean` / `void` | Whether content hashes to a CID, for any codec. Only SHA-256 and identity hashes are accepted. |
| `verifyDagCborCID`, `assertDagCborCID` | `(cid, blockBytes) => boolean` / `void`                  | The same, and the CID must be dag-cbor with SHA-256.                                           |
| `parseCID`                             | `(cid: string) => ParsedCID`                             | A canonical base32 CIDv1's codec, hash code and digest.                                        |
| `dagCborCIDBytes`                      | `(cid: string) => Uint8Array`                            | The binary form of a dag-cbor SHA-256 CID.                                                     |
| `base32Encode`, `base32Decode`         | `Uint8Array ↔ string`                                    | Lowercase unpadded base32.                                                                     |

### DAG-CBOR and bytes

| Export                     | Signature                                 | Does                                                                                                      |
| -------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `encodeDagCbor`            | `(value: DagCborValue) => Uint8Array`     | Canonical DAG-CBOR. Numbers must be safe integers; there are no floats.                                   |
| `decodeDagCbor`            | `(bytes: Uint8Array) => DagCborValue`     | Strict decoding: a non-canonical integer, map order or trailing byte throws. Integers decode to `bigint`. |
| `hexToBytes`, `bytesToHex` | `string ↔ Uint8Array`                     | Lowercase hex; `hexToBytes` accepts a `0x` prefix.                                                        |
| `utf8`                     | `(value: string) => Uint8Array`           | UTF-8 bytes.                                                                                              |
| `concatBytes`              | `(...arrays: Uint8Array[]) => Uint8Array` | Concatenation.                                                                                            |
| `equalBytes`               | `(left, right) => boolean`                | Equality without an early exit.                                                                           |

Decoded maps are null-prototype objects: an absent field does not inherit
`constructor` or any other prototype member, and every valid key, `__proto__`
included, is kept. Do not copy an untrusted map with
`Object.assign({}, decoded)`: the ordinary destination's legacy prototype
setter is still hazardous. Use `{ ...decoded }` or
`Object.assign(Object.create(null), decoded)`.

### Node authentication

| Export                    | Signature                    | Does                                                                                                                                      |
| ------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `nodeCookieAuthorization` | `(cookie: string) => string` | The `Authorization` header for a node's operator port. Give the cookie file's content (sent as Basic) or the bare token (sent as Bearer). |

## `@adalin/lattice-peer`

Follows one chain over an authenticated Ivy session and checks every header
it is sent. Its [README](../packages/peer/README.md) explains what the
follower assures and shows how to wire it to Ivy.

| Export                                     | Signature                                                              | Does                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ChainFollower`                            | `new ChainFollower(options: ChainFollowerOptions)`                     | Follows one chain on one session.                                                                                         |
| `ChainFollower.open`                       | `() => void`                                                           | Call once the session is open: sends this peer's hello.                                                                   |
| `ChainFollower.deliver`                    | `(topic: string, payload: Uint8Array) => void`                         | Hand it every message the session delivers. A malformed message is ignored.                                               |
| `ChainFollower.tip`                        | `FollowedBlock \| undefined`                                           | The heaviest checked block so far.                                                                                        |
| `ChainFollower.capabilities`               | `readonly string[]`                                                    | The capabilities the node's hello named.                                                                                  |
| `connectToChainHost`                       | `(options: ConnectToChainHostOptions) => Promise<string \| undefined>` | Connects to a node hosting the chain and returns its public key, or `undefined` if none was reached. At most eight dials. |
| `chainPeersKey`                            | `(nexusGenesisCID: string, chainPath) => string \| undefined`          | The DHT key a chain's hosts provide under; `undefined` for Nexus, which every node hosts.                                 |
| `canonicalJSON`                            | `(value) => string`                                                    | The node's canonical JSON: keys sorted, no whitespace, absent fields left out.                                            |
| `Topic`, `PROTOCOL_VERSION`, `STREAM_TAIL` | constants                                                              | The overlay's topic names, the hello version, and the capability that asks for a log's tail.                              |

`ChainFollowerOptions`: `chainPath`, `nexusGenesisCID`, `send(topic,
payload)`, `onTip?(tip)`, `onRejected?(cid, reason)` and `keep?` (how many
checked blocks to hold, 4,096 by default).

A `FollowedBlock` is `{ cid, block, work, cumulativeWork }`. `cumulativeWork`
is comparable between one follower's blocks only.

Types: `FollowedBlock`, `ChainFollowerOptions`, `PeerEndpoint`,
`DiscoveredProvider`, `ChainHostTransport`, `ChainHostIvy`,
`ConnectToChainHostOptions`.
