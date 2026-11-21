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
or check a block's target against its chain's schedule, so a miner may pick
an easy target and a header can cost little.

The node it connects to picks where it starts: the first header the
follower takes (the node's tip) and that block's 64 ancestors are the
window every branch is weighed in. A branch that does not connect to a
block in the window is dropped; the follower cannot reorg below it. The
node also controls liveness: it can withhold what it has. As it holds more
than `keep` blocks (4,096), the lightest are let go, which raises the
window's floor. So the tip it reports is the heaviest branch connected
within the window, among the headers that one node sent, each of which hashes to its CID and carries
the work it claims.
