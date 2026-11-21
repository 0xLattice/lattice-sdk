# @adalin/lattice-peer

Follow one Lattice chain as an overlay peer, from a browser or Node.js, and
check every header you are sent.

`ChainFollower` speaks the node's sync messages over an authenticated Ivy
session (for a browser: Ivy's WebAssembly core over `wss://<node>/ivy`). It
asks the node for its log's tail (nodes that name `stream-tail` in their
hello; older nodes are paged), is pushed what the node weighs next, fetches
each header, and reports the heaviest one whose bytes hash to its CID and
whose proof of work verifies: a child chain's through its `ChildBlockProof`
(`verifyChildBlockProof` in `@adalin/lattice-core`), Nexus's on its own.

```ts
const follower = new ChainFollower({
  chainPath: ["Nexus", "moniker"],
  nexusGenesisCID,
  send: (topic, payload) => ivy.sendMessage(session, topic, payload),
  onTip: (tip) => console.log(tip.block.height, tip.cid),
});
// Ivy delegate: peerConnected → follower.open(); deliver → follower.deliver(topic, payload)
```

The assurance is work, not validity: the follower does not execute blocks
or check a block's target against its chain's schedule.
