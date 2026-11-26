# @adalin/lattice-relay

Submits transactions to a Lattice node or relay that the application
chooses, and pays fees in proof of work through a
[lattice-sponsor](https://github.com/0xLattice/lattice-sponsor).

Submission is separate from reading on purpose: the read client in
`@adalin/lattice-client` has no way to send a transaction.

## Install

```sh
npm install @adalin/lattice-relay @adalin/lattice-core
```

Requires Node.js 22 or later. This package is an ES module with TypeScript
declarations; CommonJS `require()` is not supported.

## Example

A fragment: it assumes `payload`, a signed `TransactionPayload` built with
`@adalin/lattice-core`
([complete example](https://github.com/0xLattice/lattice-sdk/blob/main/docs/getting-started.md#build-sign-and-submit-a-transfer)).

```js
import { HTTPTransactionSubmitter, SubmissionError } from "@adalin/lattice-relay";

const relay = new HTTPTransactionSubmitter("https://ams.testnet.lattice.build/transactions");
try {
  const { transactionCID } = await relay.submit(payload);
  console.log(transactionCID);
} catch (error) {
  if (!(error instanceof SubmissionError)) throw error;
  console.error(error.status, error.reason ?? error.refusal);
}
```

Remote endpoints must be HTTPS. HTTP is accepted on loopback, for a node of
your own.

## Documentation

- [API reference](https://github.com/0xLattice/lattice-sdk/blob/main/docs/api.md#adalinlattice-relay):
  the submitter, `SubmissionError` and its named refusals.
- [Paying a fee in work](https://github.com/0xLattice/lattice-sdk/blob/main/docs/api.md#paying-a-fee-in-work):
  `SponsorClient` and `grind`.

MIT
