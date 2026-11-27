# Contributing to the Lattice SDK

Requires Node.js 22 or newer.

```sh
npm install
npm test
npm run format:check
```

## Protocol changes

A protocol change must identify its authoritative change in `Lattice` or
`lattice-node`.

## Conformance vectors

`vectors.lock.json` pins the authoritative vectors from
[`0xLattice/Lattice`](https://github.com/0xLattice/Lattice/tree/main/Vectors):
a commit, and the SHA-256 of each file. A downloaded vector must match its
SHA-256 before it is cached.

- Do not update a copied fixture to make a failing conformance test pass.
- To take a newer vector set, update the lock to a reviewed Lattice commit
  and run the whole suite:

  ```sh
  npm run vectors:update
  npm test
  ```

- Updating the lock repins both the revision and the content. Review both
  changes, together with any conformance change, rather than accepting a
  regenerated lock.

## Release rules

- Consensus behavior changes only when the pinned Lattice vectors change.
- A node wire change requires coordinated node and SDK tests. There are no
  versioned endpoint aliases.
- A content-service adapter must return complete Volumes, never loose
  entries presented as a verified Volume.
- Submission transports stay separate from public reads.
- A release publishes `@adalin/lattice-core`, `-volumes`, `-client`,
  `-relay` and `-sdk` together, with npm provenance.

## Documentation

The pages under `docs/` and the package READMEs are published at
[lattice.build/docs](https://lattice.build/docs/). Keep one home for each
fact: the [API reference](docs/api.md) for signatures, the
[`connect` reference](docs/connect.md) for `connect`, and
[Architecture](docs/architecture.md) for trust boundaries. Package READMEs
say what the package is, show one example, and link to the reference.
