import { getJSON } from "./http.js";
import {
  type ChildDirectoriesPage,
  type Fetch,
  NodeClient,
  normalizeNodeURL,
} from "./node-client.js";
import { optionalString, record, stringArray } from "./wire.js";

/**
 * Operator-declared read endpoints of child chains.
 *
 * This module is deliberately separate from `NodeClient`: a declared URL is a
 * third party's claim relayed by the node, not something the node vouches
 * for. A child is found through the hosts that announce it, never through
 * what its parent commits: the resolver accepts a declared host when it
 * serves the chain at that path on the root's network, and even then the
 * result is labeled {@link OPERATOR_DECLARED}. Submit capability is reported as data only; a
 * caller that wants to send a transaction must construct a
 * `TransactionSubmitter` itself.
 */
export const OPERATOR_DECLARED = "operator-declared, not independently verified" as const;

/** The raw `GET /api/chain/endpoints?chainPath=P/D` answer. */
export interface DeclaredEndpoints {
  readonly chainPath: readonly string[];
  /**
   * The newest child block the parent's recent blocks commit, or absent.
   * Information only: it can be a block the child chain did not keep, or one
   * nobody serves, so no host is required to serve it.
   */
  readonly committedBlock?: string;
  readonly endpoints: readonly string[];
  readonly submitEndpoints: readonly string[];
}

export function parseDeclaredEndpoints(value: unknown): DeclaredEndpoints {
  const body = record(value, "endpoints");
  const committedBlock =
    body.committedBlock === null
      ? undefined
      : optionalString(body.committedBlock, "endpoints.committedBlock");
  return {
    chainPath: stringArray(body.chainPath, "endpoints.chainPath"),
    ...(committedBlock === undefined ? {} : { committedBlock }),
    endpoints: stringArray(body.endpoints, "endpoints.endpoints"),
    // A node predating the field omits it; that reads as empty.
    submitEndpoints:
      body.submitEndpoints === undefined
        ? []
        : stringArray(body.submitEndpoints, "endpoints.submitEndpoints"),
  };
}

/** A declared host that serves the chain at its path, on the root's network. */
export interface ResolvedEndpoint {
  readonly url: string;
  readonly chainPath: readonly string[];
  /** The host's declared `POST /transactions` support; unverified data only. */
  readonly declaresSubmit: boolean;
  readonly trust: typeof OPERATOR_DECLARED;
}

export interface EndpointResolverOptions {
  readonly fetch?: Fetch;
  /** Per request. */
  readonly timeoutMilliseconds?: number;
  readonly maximumResponseBytes?: number;
  /** Declared URLs probed per child, across all parent sources. */
  readonly maximumCandidates?: number;
  /** Verified hosts of one level asked about the next level. */
  readonly maximumSources?: number;
  /** Requests one `resolve` may make in total. */
  readonly maximumRequests?: number;
  /**
   * Resolves a declared host name to its addresses (e.g. Node's
   * `dns.promises.lookup` with `all: true`). When given, a declared name is
   * dialed only if every address is public. Without it only literal hosts
   * are judged; DNS rebinding between this lookup and the fetch's own is
   * outside what a portable fetch-based client can prevent.
   */
  readonly lookup?: (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>;
}

function ipv4(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^[0-9]{1,3}$/.test(part))) return undefined;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function publicIPv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 || // multicast, reserved, broadcast
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF, documentation
    (a === 192 && b === 88 && c === 99) || // 6to4 relay
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** The eight 16-bit groups of a canonical IPv6 literal (WHATWG-serialized). */
function ipv6Groups(host: string): number[] | undefined {
  const halves = host.split("::");
  if (halves.length > 2) return undefined;
  const parse = (half: string | undefined): number[] | undefined => {
    if (half === undefined || half === "") return [];
    const groups = half.split(":");
    return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))
      ? groups.map((group) => parseInt(group, 16))
      : undefined;
  };
  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  if (head === undefined || tail === undefined) return undefined;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return undefined;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

function embedded(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function publicIPv6(host: string): boolean {
  const g = ipv6Groups(host);
  if (g === undefined) return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  // IPv4-mapped (::ffff:a.b.c.d) is judged as the IPv4 address it names.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return publicIPv4(embedded(g6, g7));
  }
  // NAT64 well-known prefix (64:ff9b::/96) reaches the embedded IPv4.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return publicIPv4(embedded(g6, g7));
  }
  // 6to4 (2002::/16) reaches the IPv4 in bits 16...47.
  if (g0 === 0x2002) return publicIPv4(embedded(g1, g2));
  // Otherwise only global unicast (2000::/3), minus special-purpose blocks:
  // Teredo and benchmarking (2001:0::/23 covers 2001::/32 and 2001:2::/48),
  // documentation (2001:db8::/32).
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && (g1 < 0x200 || g1 === 0xdb8)) return false;
  return true;
}

/** Whether an IP address literal (v4 dotted or v6, unbracketed) is public. */
export function isPublicAddress(address: string): boolean {
  const host = address.toLowerCase();
  const octets = ipv4(host);
  return octets !== undefined ? publicIPv4(octets) : publicIPv6(host);
}

/**
 * A third party's declared read URL, or undefined when it must not be dialed:
 * HTTPS only, a public host only (no loopback, private, link-local, special-
 * purpose, or single-label names), no credentials, query, or fragment. This
 * judges the URL's literal host; a name's DNS answers are checked only when
 * the resolver is given a `lookup`.
 */
export function declaredEndpointURL(input: string): string | undefined {
  let normalized: string;
  let url: URL;
  try {
    normalized = normalizeNodeURL(input);
    url = new URL(normalized);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[")) return publicIPv6(host.slice(1, -1)) ? normalized : undefined;
  const octets = ipv4(host);
  if (octets !== undefined) return publicIPv4(octets) ? normalized : undefined;
  const name = host.replace(/\.$/, "");
  if (!name.includes(".")) return undefined;
  if (/\.(?:localhost|local|internal|home\.arpa)$/.test(name)) return undefined;
  return normalized;
}

function childPath(parent: readonly string[], directory: string): string[] {
  if (directory.length === 0 || directory.includes("/")) {
    throw new TypeError("child directory must be one non-empty path component");
  }
  return [...parent, directory];
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

/** Requests one {@link EndpointResolver.resolve} may still make. */
class Budget {
  remaining: number;
  constructor(requests: number) {
    this.remaining = requests;
  }
  spend(): void {
    if (this.remaining <= 0) throw new RangeError("endpoint discovery request budget exhausted");
    this.remaining -= 1;
  }
}

/**
 * Walks operator-declared endpoints down from a caller-chosen root node, the
 * same rule at every level: a level's accepted hosts are asked for the next
 * level's declared URLs. The root is the only host dialed as given; every
 * other host is a declared URL that passed {@link declaredEndpointURL} (and
 * `lookup`, when given) and answered positively that it serves the chain at
 * that path (`/api/chain/info` names it and has a tip), with the root's Nexus
 * genesis (every network names its chains `Nexus/...`). What a parent commits
 * never decides acceptance. This is a consistency check, not proof.
 *
 * Accepted hosts keep the order they were declared in (by the sources in
 * order, then each answer's order), so no host comes first by claiming a
 * greater height.
 *
 * Every request is individually timed. `resolve` has a request budget, so it
 * ends within `maximumRequests` × `timeoutMilliseconds`; `walk` runs until
 * the caller stops it. Pass a signal for an overall deadline.
 */
export class EndpointResolver {
  readonly root: NodeClient;
  readonly #fetch: Fetch;
  readonly #lookup?: EndpointResolverOptions["lookup"];
  readonly #timeoutMilliseconds: number;
  readonly #maximumResponseBytes: number;
  readonly #maximumCandidates: number;
  readonly #maximumSources: number;
  readonly #maximumRequests: number;

  constructor(root: NodeClient, options: EndpointResolverOptions = {}) {
    this.root = root;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    if (options.lookup !== undefined) this.#lookup = options.lookup;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 4_000;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 64 * 1024;
    this.#maximumCandidates = options.maximumCandidates ?? 8;
    this.#maximumSources = options.maximumSources ?? 4;
    this.#maximumRequests = options.maximumRequests ?? 64;
  }

  #client(baseURL: string, chainPath: readonly string[], budget: Budget): NodeClient {
    return new NodeClient(baseURL, chainPath, {
      fetch: (input, init) => {
        budget.spend();
        return this.#fetch(input, init);
      },
      timeoutMilliseconds: this.#timeoutMilliseconds,
      maximumResponseBytes: this.#maximumResponseBytes,
    });
  }

  /** One node's raw, unverified declaration for `chainPath`. */
  async declared(
    sourceURL: string,
    chainPath: readonly string[],
    signal?: AbortSignal,
  ): Promise<DeclaredEndpoints> {
    return this.#declared(sourceURL, chainPath, new Budget(1), signal);
  }

  async #declared(
    sourceURL: string,
    chainPath: readonly string[],
    budget: Budget,
    signal?: AbortSignal,
  ): Promise<DeclaredEndpoints> {
    const url = new URL(`${normalizeNodeURL(sourceURL)}/api/chain/endpoints`);
    url.searchParams.set("chainPath", chainPath.join("/"));
    budget.spend();
    const declared = parseDeclaredEndpoints(
      await getJSON(url, {
        fetch: this.#fetch,
        timeoutMilliseconds: this.#timeoutMilliseconds,
        maximumResponseBytes: this.#maximumResponseBytes,
        signal,
      }),
    );
    if (!samePath(declared.chainPath, chainPath)) {
      throw new TypeError("endpoints answer names a different chainPath");
    }
    return declared;
  }

  /** Whether a declared host's name resolves only to public addresses. */
  async #resolvesPublic(url: string, signal?: AbortSignal): Promise<boolean> {
    if (this.#lookup === undefined) return true;
    const host = new URL(url).hostname;
    if (host.startsWith("[") || ipv4(host) !== undefined) return true;
    try {
      const timeout = AbortSignal.timeout(this.#timeoutMilliseconds);
      const bounded = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      bounded.throwIfAborted();
      const addresses = await Promise.race([
        this.#lookup(host, bounded),
        new Promise<never>((_, reject) => {
          bounded.addEventListener("abort", () => reject(bounded.reason), { once: true });
        }),
      ]);
      return addresses.length > 0 && addresses.every(isPublicAddress);
    } catch {
      return false;
    }
  }

  /** Whether `baseURL` serves `chainPath`, with a tip, on the network `nexusGenesis` names. */
  async #serves(
    baseURL: string,
    chainPath: readonly string[],
    nexusGenesis: string,
    budget: Budget,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      if (!(await this.#resolvesPublic(baseURL, signal))) return false;
      const client = this.#client(baseURL, chainPath, budget);
      const [info, genesis] = await Promise.all([
        client.chainInfo(signal),
        client.nexusGenesis(signal),
      ]);
      return (
        samePath(info.chain, chainPath) && info.height !== undefined && genesis === nexusGenesis
      );
    } catch {
      return false;
    }
  }

  /** Accepted endpoints of `parentSources`' child `chainPath`, in declared order. */
  async #level(
    parentSources: readonly string[],
    chainPath: readonly string[],
    nexusGenesis: string,
    budget: Budget,
    signal?: AbortSignal,
  ): Promise<ResolvedEndpoint[]> {
    const answers = await Promise.all(
      parentSources.slice(0, this.#maximumSources).map(async (source) => {
        try {
          return await this.#declared(source, chainPath, budget, signal);
        } catch {
          return undefined;
        }
      }),
    );
    const candidates = new Map<string, { url: string; declaresSubmit: boolean }>();
    for (const answer of answers) {
      if (answer === undefined) continue;
      const submit = new Set(answer.submitEndpoints.map(declaredEndpointURL));
      for (const declared of answer.endpoints) {
        const url = declaredEndpointURL(declared);
        if (url === undefined) continue;
        const seen = candidates.get(url);
        if (seen !== undefined) {
          seen.declaresSubmit ||= submit.has(url);
          continue;
        }
        if (candidates.size >= this.#maximumCandidates) continue;
        candidates.set(url, { url, declaresSubmit: submit.has(url) });
      }
    }
    const accepted = await Promise.all(
      [...candidates.values()].map(async ({ url, declaresSubmit }) =>
        (await this.#serves(url, chainPath, nexusGenesis, budget, signal))
          ? { url, chainPath: [...chainPath], declaresSubmit, trust: OPERATOR_DECLARED }
          : undefined,
      ),
    );
    return accepted.filter((entry) => entry !== undefined);
  }

  /** The root's Nexus genesis, which names the network every accepted host must be on. */
  async #network(budget: Budget, signal?: AbortSignal): Promise<string | undefined> {
    try {
      return await this.#client(this.root.baseURL, this.root.chainPath, budget).nexusGenesis(
        signal,
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Accepted declared endpoints for `chainPath`, which must extend the root's
   * chain path. Each level's accepted hosts are asked about the next level.
   */
  async resolve(chainPath: readonly string[], signal?: AbortSignal): Promise<ResolvedEndpoint[]> {
    const rootPath = this.root.chainPath;
    if (
      chainPath.length <= rootPath.length ||
      !samePath(chainPath.slice(0, rootPath.length), rootPath)
    ) {
      throw new RangeError("chainPath must name a descendant of the root's chain");
    }
    if (chainPath.some((part) => part.length === 0 || part.includes("/"))) {
      throw new RangeError("chainPath components must be non-empty and contain no '/'");
    }
    const budget = new Budget(this.#maximumRequests);
    const network = await this.#network(budget, signal);
    if (network === undefined) return [];
    let sources = [this.root.baseURL];
    let resolved: ResolvedEndpoint[] = [];
    for (let depth = rootPath.length + 1; depth <= chainPath.length; depth += 1) {
      resolved = await this.#level(sources, chainPath.slice(0, depth), network, budget, signal);
      if (resolved.length === 0) return [];
      sources = resolved.map((entry) => entry.url);
    }
    return resolved;
  }

  /**
   * Every chain below the root whose hosts answer, breadth first: a chain's
   * children are the directory names its accepted hosts list
   * (`/api/chain/children`, every page), and each is resolved like
   * {@link resolve}. Yields each accepted endpoint as it is found and runs
   * until the tree ends or the caller stops (break, or abort `signal`).
   * Every request is timed; the walk itself has no budget.
   */
  async *walk(signal?: AbortSignal): AsyncGenerator<ResolvedEndpoint, void, undefined> {
    signal?.throwIfAborted();
    const budget = new Budget(Infinity);
    const network = await this.#network(budget, signal);
    signal?.throwIfAborted();
    if (network === undefined) return;
    let frontier: { path: readonly string[]; sources: readonly string[] }[] = [
      { path: this.root.chainPath, sources: [this.root.baseURL] },
    ];
    while (frontier.length > 0) {
      const next: typeof frontier = [];
      for (const { path, sources } of frontier) {
        for await (const directory of this.#childDirectories(sources, path, budget, signal)) {
          const level = childPath(path, directory);
          const resolved = await this.#level(sources, level, network, budget, signal);
          signal?.throwIfAborted();
          yield* resolved;
          if (resolved.length > 0) next.push({ path: level, sources: resolved.map((e) => e.url) });
        }
      }
      frontier = next;
    }
  }

  /**
   * Every child directory the first answering source lists, page by page. A
   * source that fails mid-list hands over to the next, from the last name read.
   */
  async *#childDirectories(
    sources: readonly string[],
    chainPath: readonly string[],
    budget: Budget,
    signal?: AbortSignal,
  ): AsyncGenerator<string, void, undefined> {
    let after: string | undefined;
    for (const source of sources.slice(0, this.#maximumSources)) {
      const client = this.#client(source, chainPath, budget);
      let page: ChildDirectoriesPage;
      for (;;) {
        try {
          page = await client.childDirectories(after === undefined ? {} : { after }, signal);
        } catch {
          signal?.throwIfAborted();
          break;
        }
        for (const directory of page.directories) {
          after = directory;
          if (directory.length > 0 && !directory.includes("/")) yield directory;
        }
        if (page.next === undefined) return;
      }
    }
  }
}
