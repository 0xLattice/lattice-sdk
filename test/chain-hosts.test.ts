import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chainPeersKey,
  connectToChainHost,
  type DiscoveredProvider,
  type PeerEndpoint,
} from "../packages/peer/src/index.js";

const genesis = "bafyreiggtg4ezifboyekbf4gxst2jr3mpjqcxsbmopy7w6fp46g4ngpgxa";
const entry = "e".repeat(64);
const host = "a".repeat(64);
const other = "b".repeat(64);
const relay = "c".repeat(64);

interface Transport {
  readonly observedHost: string;
  readonly url: string;
}

/**
 * An Ivy whose sockets reach `listening`: URL → the key that answers there.
 * A relay reaches its sessions' peers only.
 */
function fakeIvy(options: {
  providers: DiscoveredProvider[];
  listening: Record<string, string>;
  relayed?: Record<string, string[]>;
}) {
  const connected = [entry];
  const dialed: string[] = [];
  const relaying: string[] = [];
  const asked: string[] = [];
  const ivy = {
    get connectedPeers() {
      return connected;
    },
    async discoverProviders(rootCID: string) {
      asked.push(rootCID);
      return options.providers;
    },
    async connect(endpoint: PeerEndpoint, over: Transport) {
      if (options.listening[over.url] !== endpoint.publicKey)
        throw new Error("identityVerificationFailed");
      connected.push(endpoint.publicKey);
    },
    setRelaying(peer: string, relays: boolean) {
      if (relays) relaying.push(peer);
    },
    async connectViaRelay(endpoint: PeerEndpoint) {
      const reached = relaying.some(
        (peer) => connected.includes(peer) && options.relayed?.[peer]?.includes(endpoint.publicKey),
      );
      if (!reached) throw new Error("noRelayAvailable");
      connected.push(endpoint.publicKey);
    },
  };
  const connectWebSocket = async (url: string): Promise<Transport> => {
    dialed.push(url);
    if (!(url in options.listening)) throw new Error("refused");
    return { url, observedHost: new URL(url).hostname };
  };
  return { ivy, connectWebSocket, dialed, relaying, asked, connected };
}

const moniker = ["Nexus", "moniker"];
const provider = (publicKey: string, webAddresses: DiscoveredProvider["webAddresses"]) => ({
  publicKey,
  host: "10.0.0.1",
  port: 4001,
  webAddresses,
});

test("chainPeersKey is the node's rendezvous key; Nexus has none", () => {
  assert.equal(
    chainPeersKey(genesis, moniker),
    "lattice.chain-peers.v1:bafyreiggtg4ezifboyekbf4gxst2jr3mpjqcxsbmopy7w6fp46g4ngpgxa:Nexus/moniker",
  );
  assert.equal(chainPeersKey(genesis, ["Nexus"]), undefined);
});

test("Nexus is hosted by the entry node", async () => {
  const fake = fakeIvy({ providers: [], listening: {} });
  const key = await connectToChainHost({ ...fake, nexusGenesisCID: genesis, chainPath: ["Nexus"] });
  assert.equal(key, entry);
  assert.deepEqual(fake.asked, []);
  assert.deepEqual(fake.dialed, []);
});

test("an already-connected provider is returned without dialing", async () => {
  const fake = fakeIvy({
    providers: [provider(host, [{ url: "wss://host.example/ivy" }]), provider(entry, [])],
    listening: {},
  });
  const key = await connectToChainHost({ ...fake, nexusGenesisCID: genesis, chainPath: moniker });
  assert.equal(key, entry);
  assert.deepEqual(fake.asked, [chainPeersKey(genesis, moniker)]);
  assert.deepEqual(fake.dialed, []);
});

test("a direct address is preferred over a relayed one", async () => {
  const fake = fakeIvy({
    providers: [
      provider(host, [
        { url: "wss://relay.example/ivy", via: relay },
        { url: "wss://host.example/ivy" },
      ]),
    ],
    listening: { "wss://host.example/ivy": host, "wss://relay.example/ivy": relay },
    relayed: { [relay]: [host] },
  });
  const key = await connectToChainHost({ ...fake, nexusGenesisCID: genesis, chainPath: moniker });
  assert.equal(key, host);
  assert.deepEqual(fake.dialed, ["wss://host.example/ivy"]);
  assert.deepEqual(fake.relaying, []);
});

test("a relayed address dials the relay, then relays to the provider", async () => {
  const fake = fakeIvy({
    providers: [provider(host, [{ url: "wss://relay.example/ivy", via: relay }])],
    listening: { "wss://relay.example/ivy": relay },
    relayed: { [relay]: [host] },
  });
  const key = await connectToChainHost({ ...fake, nexusGenesisCID: genesis, chainPath: moniker });
  assert.equal(key, host);
  assert.deepEqual(fake.dialed, ["wss://relay.example/ivy"]);
  assert.deepEqual(fake.relaying, [relay]);
  assert.ok(fake.connected.includes(host));
});

test("a failing direct address falls through to the next provider", async () => {
  const fake = fakeIvy({
    providers: [
      provider(host, [{ url: "wss://down.example/ivy" }, { url: "wss://impostor.example/ivy" }]),
      provider(other, [{ url: "wss://other.example/ivy" }]),
    ],
    // The impostor answers with another key: the handshake refuses it.
    listening: { "wss://impostor.example/ivy": relay, "wss://other.example/ivy": other },
  });
  const key = await connectToChainHost({ ...fake, nexusGenesisCID: genesis, chainPath: moniker });
  assert.equal(key, other);
  assert.deepEqual(fake.dialed, [
    "wss://down.example/ivy",
    "wss://impostor.example/ivy",
    "wss://other.example/ivy",
  ]);
});

test("no reachable provider gives undefined, after at most eight dials", async () => {
  const providers = Array.from({ length: 5 }, (_, index) =>
    provider(String(index).repeat(64), [
      { url: `wss://p${index}a.example/ivy` },
      { url: `wss://p${index}b.example/ivy` },
    ]),
  );
  const fake = fakeIvy({ providers, listening: {} });
  const key = await connectToChainHost({ ...fake, nexusGenesisCID: genesis, chainPath: moniker });
  assert.equal(key, undefined);
  assert.equal(fake.dialed.length, 8);
});
