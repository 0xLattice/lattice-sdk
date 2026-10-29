function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.[0-9]{1,3}){3}$/.test(host);
}

/** `input` as a URL, refused unless HTTPS or loopback HTTP, without credentials. */
export function writeURL(input: string, what: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.hash) {
    throw new Error(`${what} URL must not contain credentials or a fragment`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error(`${what} URL must use HTTPS, except for loopback HTTP`);
  }
  return url.toString();
}

/** The message in a node-style `{error}` or `{error: {message}}` body. */
export function errorMessage(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const error = (value as Record<string, unknown>).error;
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

/** The response's UTF-8 text, or undefined when it is over `maximumBytes`. */
export async function boundedText(
  response: Response,
  maximumBytes: number,
): Promise<string | undefined> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximumBytes) return undefined;
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
      return undefined;
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
