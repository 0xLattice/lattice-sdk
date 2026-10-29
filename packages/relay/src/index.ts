import type { TransactionPayload } from "@adalin/lattice-core";
import { boundedText, errorMessage, writeURL } from "./http.js";

export * from "./sponsor.js";

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

function canonicalCount(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
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
    this.endpoint = writeURL(endpoint, "submission");
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
    if (text === undefined) throw new SubmissionError(response.status, "response too large");
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
