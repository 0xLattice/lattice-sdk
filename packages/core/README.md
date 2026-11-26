# @adalin/lattice-core

Lattice's canonical primitives for TypeScript: DAG-CBOR, CIDs, addresses,
Ed25519 signing, transaction construction, block and state decoding,
proof-of-work checks and block continuity checks. It makes no network
requests.

Most applications start with
[`@adalin/lattice-sdk`](https://github.com/0xLattice/lattice-sdk/blob/main/packages/sdk/README.md),
which re-exports this package and adds node reads and verified content.

## Install

```sh
npm install @adalin/lattice-core
```

Requires Node.js 22 or later. This package is an ES module with TypeScript
declarations; CommonJS `require()` is not supported.

## Example

Build and sign a transfer, and compute the CID a node will report for it:

```js
import {
  accountFromPrivateKey,
  buildTransfer,
  generatePrivateKey,
  signTransactionBody,
  signedTransactionCID,
  transactionPayload,
} from "@adalin/lattice-core";

const privateKey = generatePrivateKey();
const sender = accountFromPrivateKey(privateKey);
const recipient = accountFromPrivateKey(generatePrivateKey());

const body = buildTransfer({
  from: sender.address,
  to: recipient.address,
  amount: 25n,
  fee: 1n,
  nonce: 0n,
  chainPath: ["Nexus", "testnet"],
});
const signed = signTransactionBody(body, privateKey);
const payload = transactionPayload({ [signed.publicKey]: signed.signature }, body);
console.log(signedTransactionCID(payload.transaction.signatures, body));
```

## Documentation

- [API reference](https://github.com/0xLattice/lattice-sdk/blob/main/docs/api.md#adalinlattice-core):
  every function, by topic.

MIT
