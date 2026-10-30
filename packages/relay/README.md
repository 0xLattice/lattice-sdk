# @adalin/lattice-relay

Requires Node.js 22 or later. This package provides ESM and TypeScript declarations; CommonJS `require()` is not supported.

```sh
npm install @adalin/lattice-relay
```

Explicit transaction submission through an application-selected third-party
relay or private Lattice node.

```ts
import { HTTPTransactionSubmitter } from "@adalin/lattice-relay";

const relay = new HTTPTransactionSubmitter("https://relay.example.org/transactions");
const result = await relay.submit(payload);
```

Submission is deliberately separate from the public read client. Remote
origins require HTTPS; loopback HTTP is available for private-node development.

## Paying in work

A key with no coins can still transact and store files through a
[lattice-sponsor](https://github.com/0xLattice/lattice-sponsor): it grinds
shares of the sponsor's block template, and the sponsor pays the fee, or pins
the file, in return.

```ts
import { SponsorClient, grind } from "@adalin/lattice-relay";
import { signTransactionBody, transactionPayload } from "@adalin/lattice-core";

const sponsor = new SponsorClient("https://sponsor.example.org");

// The fee: shares on the chain, then the sponsor's co-signature.
const work = await sponsor.requestWork({ chain: "Nexus" });
for await (const nonce of grind(work, signal)) {
  const { credit } = await sponsor.submitShare(work.assignment, nonce);
  if (credit >= work.fee) break;
}
const { body, signatures } = await sponsor.sponsorTransaction(work.client, draft);
const own = signTransactionBody(body, privateKey);
await relay.submit(transactionPayload({ ...signatures, [own.publicKey]: own.signature }, body));

// Storage: hold the file's Volumes, then pay for them with `store` work.
await sponsor.store(root, volumes);
const storeWork = await sponsor.requestWork({ chain: "Nexus", store: root });
// ...grind and submit shares as above until (await sponsor.storeStatus(root)).stored
```

`grind` is plain JavaScript (no Node APIs), so it runs in a page or a worker;
it yields to the event loop as it searches and stops on `signal`, at the end of
the range, or when the range expires. A share the sponsor no longer credits
(`expired`, `soldOut`) is answered by asking for new work. `sponsorTransaction`
rebuilds the sponsored body from the draft and refuses one that differs, so the
client only signs the draft plus the sponsor's own debit.

MIT
