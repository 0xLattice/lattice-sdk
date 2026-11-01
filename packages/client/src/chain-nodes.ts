import { EndpointResolver, type EndpointResolverOptions } from "./endpoints.js";
import { NodeError } from "./http.js";
import { type Fetch, NodeClient, normalizeNodeURL } from "./node-client.js";

/** No node serves the chain, as far as the start node's directory says. */
export class ChainOfflineError extends Error {
  readonly chainPath: readonly string[];
  constructor(chainPath: readonly string[]) {
    super(`No node serves ${chainPath.join("/")}`);
    this.name = "ChainOfflineError";
    this.chainPath = [...chainPath];
  }
}

/** A node to read a chain from. */
export interface ChainNode {
  readonly url: string;
  /** True for a node found through the directory, not a start node. */
  readonly found: boolean;
}

export interface ChainNodesOptions {
  readonly fetch?: Fetch;
  /** How long a chain's list is kept before it is looked up again. */
  readonly ttlMilliseconds?: number;
  /** Per `/api/chain/info` check of a start node. */
  readonly timeoutMilliseconds?: number;
  /** For the directory walk. */
  readonly resolver?: Omit<EndpointResolverOptions, "fetch">;
  readonly now?: () => number;
  /** In [0, 1): where each chain's turns begin, so readers do not all begin at the same node. */
  readonly random?: () => number;
}

/** A chain's list, as it is being made and once it is made. */
interface ListEntry {
  /** The start nodes that serve the chain, known before the walk ends; empty if none or the checks failed. */
  readonly own: Promise<ChainNode[]>;
  list: Promise<ChainNode[]>;
  /** The list, once made. */
  whole?: ChainNode[];
  until: number;
}

/**
 * The nodes that serve a chain: the start nodes (the ones the reader chose,
 * or an app's defaults) that serve the chain, then the hosts the chain's
 * rendezvous declares ({@link EndpointResolver}), walked down from the
 * nearest ancestor a start node serves. A found node serves the chain at that
 * path on the start node's network and is read at its own tip; what a parent
 * commits never decides.
 *
 * Every level is read the same way, round robin: each {@link read} of a chain
 * begins at the next node in its list and goes on through the rest until one
 * answers, so reads spread evenly over the nodes that serve it. A read does
 * not wait for the walk when a start node serves the chain: it begins on the
 * start nodes that do, and goes on to the found hosts only if they all fail. Each walk
 * down begins at the next start node the same way. Turns begin at a random
 * node, so many readers with the same start nodes spread too.
 *
 * A chain is offline ({@link ChainOfflineError}) only when the list is empty
 * and every start node answered. A start node failing while the list is made
 * (unreachable, or any answer but 404) is passed over while another answers,
 * and is not walked from; when none does, or when the list would be empty
 * without it, the failure is thrown as is: it is the reader's nodes, not the
 * chain, that failed. A list is shared by concurrent callers and kept for
 * `ttlMilliseconds`.
 */
export class ChainNodes {
  readonly startURLs: readonly string[];
  readonly #fetch: Fetch;
  readonly #ttl: number;
  readonly #timeout: number;
  readonly #resolver: Omit<EndpointResolverOptions, "fetch">;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #lists = new Map<string, ListEntry>();
  /** Per chain, the next turn of its reads and of its walks down. */
  readonly #turns = new Map<string, { read: number; walk: number }>();

  constructor(start: string | readonly string[], options: ChainNodesOptions = {}) {
    const urls = (typeof start === "string" ? [start] : start).map(normalizeNodeURL);
    if (urls.length === 0) throw new RangeError("ChainNodes needs at least one start node");
    this.startURLs = [...new Set(urls)];
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#ttl = options.ttlMilliseconds ?? 30_000;
    this.#timeout = options.timeoutMilliseconds ?? 15_000;
    this.#resolver = options.resolver ?? {};
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  /** The next turn of `kind` for `key`'s chain, beginning at a random one. */
  #turn(key: string, kind: "read" | "walk"): number {
    let turns = this.#turns.get(key);
    if (turns === undefined) {
      const first = Math.floor(this.#random() * 2 ** 32);
      turns = { read: first, walk: first };
      this.#turns.set(key, turns);
    }
    return turns[kind]++;
  }

  /** The nodes serving `chainPath`: start nodes first, then found hosts, in declared order. */
  list(chainPath: readonly string[]): Promise<ChainNode[]> {
    return this.#entry(chainPath).list;
  }

  #entry(chainPath: readonly string[]): ListEntry {
    const key = JSON.stringify(chainPath);
    const kept = this.#lists.get(key);
    if (kept !== undefined && this.#now() < kept.until) return kept;
    let own!: (nodes: ChainNode[]) => void;
    const entry: ListEntry = {
      own: new Promise((resolve) => (own = resolve)),
      list: Promise.resolve([]),
      // Kept from when the list is made, not asked for.
      until: Infinity,
    };
    entry.list = this.#list([...chainPath], own);
    this.#lists.set(key, entry);
    entry.list.then(
      (nodes) => {
        entry.whole = nodes;
        entry.until = this.#now() + this.#ttl;
      },
      () => {
        own([]);
        if (this.#lists.get(key) === entry) this.#lists.delete(key);
      },
    );
    return entry;
  }

  /**
   * `read` on the nodes serving `chainPath`, beginning at the next node in
   * turn and going round the list until one answers; else the last failure.
   * While the walk is out, the start nodes that serve the chain are the list,
   * and the found hosts are waited for only once they have all failed.
   */
  async read<T>(chainPath: readonly string[], read: (node: ChainNode) => Promise<T>): Promise<T> {
    const entry = this.#entry(chainPath);
    const turn = this.#turn(JSON.stringify(chainPath), "read");
    let nodes = entry.whole ?? (await entry.own);
    if (nodes.length === 0) nodes = await entry.list;
    if (nodes.length === 0) throw new ChainOfflineError(chainPath);
    const tried = new Set<string>();
    let failure: unknown;
    for (;;) {
      for (let step = 0; step < nodes.length; step += 1) {
        const node = nodes[(turn + step) % nodes.length]!;
        if (tried.has(node.url)) continue;
        tried.add(node.url);
        try {
          return await read(node);
        } catch (error) {
          failure = error;
        }
      }
      // Only the start nodes were tried: go on to the hosts the walk finds.
      if (nodes === entry.whole) throw failure;
      nodes = await entry.list.catch(() => nodes);
      if (nodes.every(({ url }) => tried.has(url))) throw failure;
    }
  }

  /** Whether `startURL` answers for `chainPath`: false on 404, throws on any other failure. */
  async #serves(startURL: string, chainPath: readonly string[]): Promise<boolean> {
    const client = new NodeClient(startURL, chainPath, {
      fetch: this.#fetch,
      timeoutMilliseconds: this.#timeout,
    });
    try {
      const info = await client.chainInfo();
      return info.chain.join("/") === chainPath.join("/");
    } catch (error) {
      if (error instanceof NodeError && error.status === 404) return false;
      throw error;
    }
  }

  /** The whole list; `own` hears the start nodes that serve the chain as soon as they are known. */
  async #list(chainPath: string[], own: (nodes: ChainNode[]) => void): Promise<ChainNode[]> {
    // Asked together, each within its timeout, like the hosts of any level.
    const checks = await Promise.allSettled(
      this.startURLs.map((url) => this.#serves(url, chainPath)),
    );
    const failure = checks.find((check) => check.status === "rejected");
    if (checks.every((check) => check.status === "rejected")) throw failure!.reason;
    const serving: ChainNode[] = this.startURLs
      .filter((_, index) => {
        const check = checks[index]!;
        return check.status === "fulfilled" && check.value;
      })
      .map((url) => ({ url, found: false }));
    own(serving);
    const ownURLs = new Set(serving.map(({ url }) => url));
    // When a start node serves the chain itself, failing to find others
    // costs only the fallbacks.
    const nodes = await this.#declared(
      chainPath,
      this.startURLs.filter((_, index) => checks[index]!.status === "fulfilled"),
    ).then(
      (found) => [...serving, ...found.filter(({ url }) => !ownURLs.has(url))],
      (error: unknown) => {
        if (serving.length > 0) return serving;
        throw error;
      },
    );
    // Empty, but a start node did not answer: that may be the node serving it.
    if (nodes.length === 0 && failure !== undefined) throw failure.reason;
    return nodes;
  }

  /**
   * The declared hosts of `chainPath`, walked down from the nearest ancestor a
   * start node serves: the next of `starts` (those that just answered) in
   * turn, then the others when one fails. Empty only when no start node
   * failed: one answered that the chain has no hosts, or every one that it
   * serves no ancestor. Otherwise a failure is thrown.
   */
  async #declared(chainPath: string[], starts: readonly string[]): Promise<ChainNode[]> {
    const turn = this.#turn(JSON.stringify(chainPath), "walk");
    let failure: { reason: unknown } | undefined;
    for (let step = 0; step < starts.length; step += 1) {
      const start = starts[(turn + step) % starts.length]!;
      try {
        let at = chainPath.slice(0, -1);
        while (at.length > 0 && !(await this.#serves(start, at))) at = at.slice(0, -1);
        if (at.length === 0) continue;
        const resolver = new EndpointResolver(new NodeClient(start, at, { fetch: this.#fetch }), {
          ...this.#resolver,
          fetch: this.#fetch,
        });
        const hosts = await resolver.resolve(chainPath);
        // An empty answer after another start node failed does not show the
        // chain is offline: that node's directory may hold its hosts.
        if (hosts.length > 0 || failure === undefined) {
          return hosts.map(({ url }) => ({ url, found: true }));
        }
      } catch (error) {
        failure ??= { reason: error };
      }
    }
    if (failure !== undefined) throw failure.reason;
    return [];
  }
}
