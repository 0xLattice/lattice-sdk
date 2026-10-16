import { EndpointResolver, type EndpointResolverOptions } from "./endpoints.js";
import { NodeError } from "./http.js";
import { type Fetch, NodeClient, normalizeNodeURL } from "./node-client.js";

/** A 404 says the start node has nothing for this step: the chain's absence, not its failure. */
function notFoundIsOffline(error: unknown): void {
  if (!(error instanceof NodeError && error.status === 404)) throw error;
}

/** No node serves the chain, as far as the start node's directory says. */
export class ChainOfflineError extends Error {
  readonly chainPath: readonly string[];
  constructor(chainPath: readonly string[]) {
    super(`No node serves ${chainPath.join("/")}`);
    this.name = "ChainOfflineError";
    this.chainPath = [...chainPath];
  }
}

/** Where to read a chain. */
export interface ChainNode {
  readonly url: string;
  /** True for a node found through the directory, not the start node. */
  readonly found: boolean;
}

export interface ChainNodeFinderOptions {
  readonly fetch?: Fetch;
  /** How long a found node is kept, and a failed one tried last. */
  readonly ttlMilliseconds?: number;
  /** Per `/api/chain/info` check. */
  readonly timeoutMilliseconds?: number;
  /** For the directory walk. */
  readonly resolver?: Omit<EndpointResolverOptions, "fetch">;
  readonly now?: () => number;
}

/**
 * Which node to read a chain from: the start node (the one the reader chose)
 * when it serves the chain; else one found through the chain's hosts'
 * rendezvous ({@link EndpointResolver}), walked down from the nearest
 * ancestor the start node serves. A found node serves the chain at that path
 * on the start node's network and is read at its own tip; what a parent
 * commits never decides. A chain is offline only when no node is found.
 *
 * The start node failing (not answering, or any answer but 404) is its
 * failure, not the chain's: it is thrown as is. A search is shared by
 * concurrent callers; a found node is kept for `ttlMilliseconds`, then
 * searched again to follow the hosts as they come and go. {@link forget} a
 * node that failed: it is dropped, and tried after the others until the ttl
 * passes. Forgetting the start node for a chain it serves sends the next
 * searches to the chain's declared hosts until the ttl passes, back to the
 * start node only when none is found.
 */
export class ChainNodeFinder {
  readonly startURL: string;
  readonly #fetch: Fetch;
  readonly #ttl: number;
  readonly #timeout: number;
  readonly #resolver: Omit<EndpointResolverOptions, "fetch">;
  readonly #now: () => number;
  readonly #searches = new Map<string, { search: Promise<ChainNode>; until: number }>();
  readonly #failed = new Map<string, number>();

  constructor(startURL: string, options: ChainNodeFinderOptions = {}) {
    this.startURL = normalizeNodeURL(startURL);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#ttl = options.ttlMilliseconds ?? 30_000;
    this.#timeout = options.timeoutMilliseconds ?? 15_000;
    this.#resolver = options.resolver ?? {};
    this.#now = options.now ?? Date.now;
  }

  /** Whether `url` answers for `chainPath`: false on 404, throws on any other failure. */
  async serves(url: string, chainPath: readonly string[], signal?: AbortSignal): Promise<boolean> {
    const client = new NodeClient(url, chainPath, {
      fetch: this.#fetch,
      timeoutMilliseconds: this.#timeout,
    });
    try {
      const info = await client.chainInfo(signal);
      return info.chain.join("/") === chainPath.join("/");
    } catch (error) {
      if (error instanceof NodeError && error.status === 404) return false;
      throw error;
    }
  }

  nodeFor(chainPath: readonly string[]): Promise<ChainNode> {
    const key = chainPath.join("/");
    const kept = this.#searches.get(key);
    if (kept !== undefined && this.#now() < kept.until) return kept.search;
    const entry = { until: Infinity } as { search: Promise<ChainNode>; until: number };
    entry.search = this.#search([...chainPath], key, entry);
    this.#searches.set(key, entry);
    entry.search.catch(() => {
      if (this.#searches.get(key) === entry) this.#searches.delete(key);
    });
    return entry.search;
  }

  /** `node` failed reading `chainPath`: search again on the next read. */
  async forget(chainPath: readonly string[], node: ChainNode): Promise<void> {
    const key = chainPath.join("/");
    const kept = this.#searches.get(key);
    if (kept === undefined) return;
    const current = await kept.search.catch(() => undefined);
    if (current?.url !== node.url || current.found !== node.found) return;
    if (this.#searches.get(key) !== kept) return;
    this.#searches.delete(key);
    this.#failed.set(`${key} ${node.url}`, this.#now() + this.#ttl);
  }

  async #search(chainPath: string[], key: string, entry: { until: number }): Promise<ChainNode> {
    const start = this.startURL;
    const fresh = (url: string) => !(this.#now() < (this.#failed.get(`${key} ${url}`) ?? 0));
    const startServes = await this.serves(start, chainPath);
    const itself = { url: start, found: false };
    if (startServes && fresh(start)) return itself;
    let at = chainPath.slice(0, -1);
    while (at.length > 0 && !(await this.serves(start, at))) at = at.slice(0, -1);
    if (at.length === 0) {
      if (startServes) return itself;
      throw new ChainOfflineError(chainPath);
    }
    const resolver = new EndpointResolver(new NodeClient(start, at, { fetch: this.#fetch }), {
      ...this.#resolver,
      fetch: this.#fetch,
    });
    const hosts = (await resolver.resolve(chainPath).catch(() => []))
      .map(({ url }) => url)
      .filter((url) => url !== start);
    const url = hosts.find(fresh) ?? hosts[0];
    if (url === undefined && startServes) return itself;
    if (url === undefined) {
      // Nothing found. If the start node's own part of the walk failed (its
      // network, or its directory for the first level), that is its failure,
      // thrown as is; a directory that names no host (404) is the chain's.
      await Promise.all([
        new NodeClient(start, at, {
          fetch: this.#fetch,
          timeoutMilliseconds: this.#timeout,
        })
          .nexusGenesis()
          .catch(notFoundIsOffline),
        resolver.declared(start, chainPath.slice(0, at.length + 1)).catch(notFoundIsOffline),
      ]);
      throw new ChainOfflineError(chainPath);
    }
    entry.until = this.#now() + this.#ttl;
    return { url, found: true };
  }
}
