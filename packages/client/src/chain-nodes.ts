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
  /** True for a node found through the directory, not the start node. */
  readonly found: boolean;
}

export interface ChainNodesOptions {
  readonly fetch?: Fetch;
  /** How long a chain's list is kept before it is looked up again. */
  readonly ttlMilliseconds?: number;
  /** Per `/api/chain/info` check of the start node. */
  readonly timeoutMilliseconds?: number;
  /** For the directory walk. */
  readonly resolver?: Omit<EndpointResolverOptions, "fetch">;
  readonly now?: () => number;
}

/**
 * The nodes that serve a chain, in order: the start node (the one the reader
 * chose) when it serves the chain, then the hosts the chain's rendezvous
 * declares ({@link EndpointResolver}), walked down from the nearest ancestor
 * the start node serves. A found node serves the chain at that path on the
 * start node's network and is read at its own tip; what a parent commits
 * never decides.
 *
 * {@link read} tries the nodes in order until one answers. A chain is offline
 * ({@link ChainOfflineError}) only when the list is empty. The start node
 * failing while the list is made (unreachable, or any answer but 404) is
 * thrown as is: it is the reader's node, not the chain, that failed. A list
 * is shared by concurrent callers and kept for `ttlMilliseconds`.
 */
export class ChainNodes {
  readonly startURL: string;
  readonly #fetch: Fetch;
  readonly #ttl: number;
  readonly #timeout: number;
  readonly #resolver: Omit<EndpointResolverOptions, "fetch">;
  readonly #now: () => number;
  readonly #lists = new Map<string, { list: Promise<ChainNode[]>; until: number }>();

  constructor(startURL: string, options: ChainNodesOptions = {}) {
    this.startURL = normalizeNodeURL(startURL);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#ttl = options.ttlMilliseconds ?? 30_000;
    this.#timeout = options.timeoutMilliseconds ?? 15_000;
    this.#resolver = options.resolver ?? {};
    this.#now = options.now ?? Date.now;
  }

  /** The nodes serving `chainPath`, in the order {@link read} tries them. */
  list(chainPath: readonly string[]): Promise<ChainNode[]> {
    const key = chainPath.join("/");
    const kept = this.#lists.get(key);
    if (kept !== undefined && this.#now() < kept.until) return kept.list;
    const entry = { list: this.#list([...chainPath]), until: this.#now() + this.#ttl };
    this.#lists.set(key, entry);
    entry.list.catch(() => {
      if (this.#lists.get(key) === entry) this.#lists.delete(key);
    });
    return entry.list;
  }

  /** `read` on each node serving `chainPath`, in order, until one answers; else the last failure. */
  async read<T>(chainPath: readonly string[], read: (node: ChainNode) => Promise<T>): Promise<T> {
    const nodes = await this.list(chainPath);
    if (nodes.length === 0) throw new ChainOfflineError(chainPath);
    let failure: unknown;
    for (const node of nodes) {
      try {
        return await read(node);
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }

  /** Whether the start node answers for `chainPath`: false on 404, throws on any other failure. */
  async #serves(chainPath: readonly string[]): Promise<boolean> {
    const client = new NodeClient(this.startURL, chainPath, {
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

  async #list(chainPath: string[]): Promise<ChainNode[]> {
    const start = this.startURL;
    const own = (await this.#serves(chainPath)) ? [{ url: start, found: false }] : [];
    let at = chainPath.slice(0, -1);
    while (at.length > 0 && !(await this.#serves(at))) at = at.slice(0, -1);
    if (at.length === 0) return own;
    const resolver = new EndpointResolver(new NodeClient(start, at, { fetch: this.#fetch }), {
      ...this.#resolver,
      fetch: this.#fetch,
    });
    // When the start node serves the chain itself, its directory failing
    // costs only the fallbacks.
    const hosts = await resolver.resolve(chainPath).catch((error: unknown) => {
      if (own.length > 0) return [];
      throw error;
    });
    return [
      ...own,
      ...hosts.filter(({ url }) => url !== start).map(({ url }) => ({ url, found: true })),
    ];
  }
}
