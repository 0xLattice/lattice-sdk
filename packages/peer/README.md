# @adalin/lattice-peer

Follow one Lattice chain as an overlay peer, from a browser or Node.js, and
check every header you are sent. This is the only part of the SDK that
checks a child chain's proof of work.

## Install

The release workflow does not publish this package to npm. Build it from
the [lattice-sdk repository](https://github.com/0xLattice/lattice-sdk):

```sh
git clone https://github.com/0xLattice/lattice-sdk
cd lattice-sdk
npm install
npm run build
```

It needs an Ivy node to carry its messages: Ivy's TypeScript shell, which
for a browser runs Ivy's WebAssembly core over `wss://<node>/ivy`.

## Following a chain

`ChainFollower` speaks the node's sync messages over an authenticated Ivy
session. It
asks the node for its log's tail (nodes that name `stream-tail` in their
hello; older nodes are paged), is pushed what the node weighs next, fetches
each header, and reports the heaviest one whose bytes hash to its CID and
whose proof of work verifies: a child chain's through its `ChildBlockProof`
(`verifyChildBlockProof` in `@adalin/lattice-core`), Nexus's on its own.

A fragment: it assumes `ivy`, an Ivy node, `session`, an open session to a
Lattice node, and `nexusGenesisCID`, the genesis of the network you follow.

```ts
import { ChainFollower } from "@adalin/lattice-peer";

const follower = new ChainFollower({
  chainPath: ["Nexus", "moniker"],
  nexusGenesisCID,
  send: (topic, payload) => ivy.sendMessage(session, topic, payload),
  onTip: (tip) => console.log(tip.block.height, tip.cid),
});
// Ivy delegate: peerConnected → follower.open(); deliver → follower.deliver(topic, payload)
```

## What the follower assures

The tip it reports is the heaviest branch connected within its window,
among the headers that one node sent, each of which hashes to its CID and
carries the work it claims.

- **Work, not validity.** The follower does not execute blocks or check a
  block's target against its chain's schedule, so a miner may pick an easy
  target and a header can cost little.
- **The node picks where it starts.** The first header the follower takes
  (the node's tip) and that block's 64 ancestors are the window every branch
  is weighed in. A branch that does not connect to a block in the window is
  dropped; the follower cannot reorg below it.
- **The node controls liveness.** It can withhold what it has.
- **The window's floor rises.** As the follower holds more than `keep`
  blocks (4,096), the lightest are let go.

## Finding a chain's hosts

Every node hosts Nexus; a child chain's hosts provide under its DHT key,
`chainPeersKey(nexusGenesisCID, chainPath)`. `connectToChainHost` finds one
and connects to it: a provider already connected, else each provider's
direct web addresses, then the ones it is relayed at. The session's
handshake checks the key, so an address that claims another node's fails
and the next is tried. It takes Ivy's `connectWebSocket` rather than
depending on Ivy.

A node drops a session that sends no chain hello within its timeout, so
keep the entry session open by following Nexus on it while the lookup runs
(every node hosts Nexus). Route each delivered message to the follower of
the session it came from.

A fragment: it assumes `ivy`, an Ivy node, `entryEndpoint`, the
`PeerEndpoint` of a node you know, and `nexusGenesisCID`.

```ts
import { ChainFollower, connectToChainHost } from "@adalin/lattice-peer";
import { connectWebSocket } from "ivy"; // Ivy's TypeScript shell
const followers = new Map<string, ChainFollower>(); // by session key
const follow = (peer: string, chainPath: string[]) => {
  const follower = new ChainFollower({
    chainPath,
    nexusGenesisCID,
    send: (topic, payload) => ivy.sendMessage(peer, topic, payload),
    onTip: (tip) => console.log(chainPath.join("/"), tip.block.height, tip.cid),
  });
  followers.set(peer, follower);
  follower.open();
};
// In Ivy's delegate, keyed by hex (`from.key` is the key's bytes):
// deliver(message, from) {
//   const key = Array.from(from.key, (b) => b.toString(16).padStart(2, "0")).join("");
//   followers.get(key)?.deliver(message.topic, message.payload) }

await ivy.connect(entryEndpoint, await connectWebSocket("wss://node.example/ivy"));
follow(entryEndpoint.publicKey, ["Nexus"]);
const host = await connectToChainHost({
  ivy,
  connectWebSocket,
  nexusGenesisCID,
  chainPath: ["Nexus", "moniker"],
});
if (host === undefined) throw new Error("no host of Nexus/moniker reachable");
follow(host, ["Nexus", "moniker"]);
```

## Documentation

- [API reference](https://github.com/0xLattice/lattice-sdk/blob/main/docs/api.md#adalinlattice-peer):
  every export.
- [What `connect` does not check](https://github.com/0xLattice/lattice-sdk/blob/main/docs/connect.md#what-a-read-does-not-cover),
  and why a child chain's work needs this package.

MIT
