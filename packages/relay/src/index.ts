import type { TransactionPayload } from "@adalin/lattice-core";

export interface SubmitResult {
  readonly transactionCID: string;
  readonly mempoolCount?: number;
  readonly mempoolBytes?: number;
}

export interface TransactionSubmitter {
  submit(payload: TransactionPayload, signal?: AbortSignal): Promise<SubmitResult>;
}

export interface HTTPSubmitterOptions {
  readonly fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly timeoutMilliseconds?: number;
  readonly maximumResponseBytes?: number;
  /**
   * `Authorization` header, for a node's operator (loopback) port, which
   * requires the node's cookie; see `nodeCookieAuthorization`.
   */
  readonly authorization?: string;
}

/**
 * The node's named refusals for `POST /transactions` (lattice-node's pool,
 * runtime, and API error case names). Relay policy such as
 * `belowMinRelayFee` is one node's choice, never consensus. A 429 with no
 * body is a rate limit; a 429 named `full` is the node's pool.
 */
export const SUBMISSION_REFUSALS = [
  "belowMinRelayFee",
  "feeTooLow",
  // Nodes before the funded-only pool; newer ones say feeTooLow.
  "conflictingNonce",
  "nonceAhead",
  "unavailable",
  "insufficientFunds",
  "invalidState",
  "tooLarge",
  "full",
  "unresolved",
  "contextChanged",
  "unknownChain",
  "shuttingDown",
  "requestTooLarge",
] as const;

export type SubmissionRefusal = (typeof SUBMISSION_REFUSALS)[number];

function namedRefusal(refusal: string | undefined): SubmissionRefusal | undefined {
  return SUBMISSION_REFUSALS.find((name) => name === refusal);
}

export class SubmissionError extends Error {
  readonly status: number;
  /** The node's refusal text, verbatim. */
  readonly refusal?: string;
  /** Set when `refusal` is one of {@link SUBMISSION_REFUSALS}. */
  readonly reason?: SubmissionRefusal;

  constructor(status: number, refusal?: string) {
    super(refusal ?? `submission failed with HTTP ${status}`);
    this.name = "SubmissionError";
    this.status = status;
    if (refusal !== undefined) this.refusal = refusal;
    const reason = namedRefusal(refusal);
    if (reason !== undefined) this.reason = reason;
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.[0-9]{1,3}){3}$/.test(host);
}

function submissionURL(input: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.hash) {
    throw new Error("submission URL must not contain credentials or a fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("submission URL must use HTTPS, except for loopback HTTP");
  }
  return url.toString();
}

function canonicalCount(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function errorMessage(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const error = (value as Record<string, unknown>).error;
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

async function boundedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximumBytes) {
    throw new SubmissionError(response.status, "response too large");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new SubmissionError(response.status, "response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Explicit transaction submission to an application-selected third-party
 * relay or private node. The read-only NodeClient never owns this capability.
 */
export class HTTPTransactionSubmitter implements TransactionSubmitter {
  readonly endpoint: string;
  readonly #fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly #timeoutMilliseconds: number;
  readonly #maximumResponseBytes: number;
  readonly #authorization: string | undefined;

  constructor(endpoint: string, options: HTTPSubmitterOptions = {}) {
    this.endpoint = submissionURL(endpoint);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 8_000;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 1024 * 1024;
    this.#authorization = options.authorization;
  }

  async submit(payload: TransactionPayload, signal?: AbortSignal): Promise<SubmitResult> {
    const timeout = AbortSignal.timeout(this.#timeoutMilliseconds);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const response = await this.#fetch(this.endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(this.#authorization === undefined ? {} : { Authorization: this.#authorization }),
      },
      body: JSON.stringify(payload),
      // A redirect would re-send the payload (and any Authorization) where
      // the answering host points; node routes never redirect.
      redirect: "error",
      signal: combined,
    });
    const text = await boundedText(response, this.#maximumResponseBytes);
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      // A refusal without a JSON body (404 with public submit off, 413) is
      // still a refusal: keep its status rather than blaming the encoding.
      throw new SubmissionError(response.status, response.ok ? "invalid JSON response" : undefined);
    }
    if (!response.ok) throw new SubmissionError(response.status, errorMessage(decoded));
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new SubmissionError(response.status, "invalid submission response");
    }
    const body = decoded as Record<string, unknown>;
    if (typeof body.transactionCID !== "string") {
      throw new SubmissionError(response.status, "submission response omitted transactionCID");
    }
    const mempoolCount = canonicalCount(body.mempoolCount, "mempoolCount");
    const mempoolBytes = canonicalCount(body.mempoolBytes, "mempoolBytes");
    return {
      transactionCID: body.transactionCID,
      ...(mempoolCount === undefined ? {} : { mempoolCount }),
      ...(mempoolBytes === undefined ? {} : { mempoolBytes }),
    };
  }
}
