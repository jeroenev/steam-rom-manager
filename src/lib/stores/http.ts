// HTTP for the store clients: error kinds, secrets kept out of messages,
// paging that never mistakes a list cut short for the whole list. Ported
// from BoilR's boilr-stores http.rs.

import { STATUS_CODES } from "http";
import * as _ from "lodash";
import { StoreFetch, StoreRequestInit, StoreResponse } from "./host";

// A browser's user agent: several store web endpoints refuse unknown
// clients. Store modules set their own per request where a launcher's is
// expected.
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Every request ends after this long.
export const REQUEST_TIMEOUT_MS = 60 * 1000;

// The store refused the saved login: HTTP 401, an OAuth invalid_grant, a
// sign-in page where data was expected. Only this asks the user to sign in
// again; store modules check for it to renew a token once and try again.
export class LoginRejected extends Error {
  name = "LoginRejected";
}

// The store or the network is having trouble (no connection, a timeout,
// HTTP 408/425/429/5xx): the saved login is probably fine, later may work.
export class Transient extends Error {
  name = "Transient";
}

// A response with a status that isn't a success. 401 counts as a refused
// login and 408, 425, 429 and 5xx as transient. 403 is neither: stores send
// it for bot blocks and region locks as well as for dead tokens.
export class HttpStatus extends Error {
  name = "HttpStatus";
  constructor(
    readonly status: number,
    // Without its query (which can hold tokens).
    readonly url: string,
    // The start of the body, without secrets.
    readonly body: string,
  ) {
    super(httpStatusMessage(status, url, body));
  }
}

function httpStatusMessage(status: number, url: string, body: string) {
  const text = STATUS_CODES[status]
    ? `${status} ${STATUS_CODES[status]}`
    : String(status);
  return status === 401
    ? `The store rejected the saved login (${text} from ${url}). Sign in again. ${body}`
    : `${text} from ${url}: ${body}`;
}

export function loginRejected(message: string, cause?: unknown) {
  return new LoginRejected(message, cause === undefined ? {} : { cause });
}

export function transient(message: string, cause?: unknown) {
  return new Transient(message, cause === undefined ? {} : { cause });
}

// The message of any thrown value.
export function messageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// `err` with `context` in front, keeping it as the cause so its kind (a
// refused login, a transient failure) still shows.
export function wrapErr(err: unknown, context: string): Error {
  return new Error(`${context}: ${messageOf(err)}`, { cause: err });
}

// The error and its causes, outermost first.
export function errorChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = err;
  while (current !== undefined && current !== null && chain.length < 32) {
    chain.push(current);
    current = (current as any)?.cause;
  }
  return chain;
}

export function isLoginRejected(err: unknown): boolean {
  return errorChain(err).some(
    (cause) =>
      cause instanceof LoginRejected ||
      (cause instanceof HttpStatus && cause.status === 401),
  );
}

export function isTransient(err: unknown): boolean {
  return errorChain(err).some(
    (cause) =>
      cause instanceof Transient ||
      (cause instanceof HttpStatus && isTransientStatus(cause.status)),
  );
}

// Statuses that say "not now" rather than "no".
export function isTransientStatus(status: number): boolean {
  return [408, 425, 429].includes(status) || (status >= 500 && status < 600);
}

// The failed response behind `err`, when a status caused it.
export function httpStatusOf(err: unknown): HttpStatus | undefined {
  return errorChain(err).find((c) => c instanceof HttpStatus) as
    | HttpStatus
    | undefined;
}

export function statusOf(err: unknown): number | undefined {
  return httpStatusOf(err)?.status;
}

// The HttpStatus error for a response, with the start of its body.
export async function statusError(response: StoreResponse) {
  let body = "";
  try {
    body = await response.text();
  } catch {
    // (the status says enough)
  }
  return new HttpStatus(
    response.status,
    withoutQuery(response.url),
    snippet(body),
  );
}

// A request that got no answer, as an error without the URL's query.
// Connection problems and timeouts are transient.
export function requestFailed(err: unknown, url: string): Error {
  const parts: string[] = [];
  for (const cause of errorChain(err)) {
    const message = messageOf(cause);
    if (message && !parts.includes(message)) {
      parts.push(message);
    }
  }
  return transient(redact(`${parts.join(": ")} (${withoutQuery(url)})`));
}

// The fetch of one store, with a timeout per request, the refresh's
// deadline, a browser user agent, and errors of the right kind.
export class StoreHttp {
  constructor(
    private fetch: StoreFetch,
    private options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) {}

  // Fails on a status that isn't a success (HttpStatus).
  async send(url: string, init: StoreRequestInit = {}) {
    const response = await this.request(url, init);
    if (response.ok) {
      return response;
    }
    throw await statusError(response);
  }

  async sendJson<T = any>(url: string, init: StoreRequestInit = {}) {
    return readJson<T>(await this.send(url, init));
  }

  // Any answer, whatever its status.
  async request(url: string, init: StoreRequestInit = {}) {
    try {
      new URL(url);
    } catch {
      throw new Error(`Not a web address: ${withoutQuery(url)}`);
    }
    const signals = [
      AbortSignal.timeout(this.options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    ];
    for (const signal of [this.options.signal, init.signal]) {
      if (signal) {
        signals.push(signal);
      }
    }
    const headers = { ...(init.headers || {}) };
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "user-agent")) {
      headers["User-Agent"] = BROWSER_USER_AGENT;
    }
    try {
      return await this.fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      throw requestFailed(err, url);
    }
  }
}

// The body of a response.
export async function readText(response: StoreResponse) {
  try {
    return await response.text();
  } catch (err) {
    throw requestFailed(err, response.url);
  }
}

// The JSON body of a response.
export async function readJson<T = any>(response: StoreResponse): Promise<T> {
  const text = await readText(response);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Unexpected response from ${withoutQuery(response.url)}: ${messageOf(err)}. Body starts with: ${snippet(text)}`,
    );
  }
}

// The URL without query, fragment and user info: what's safe to show.
export function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.split(/[?#]/)[0];
  }
}

// How much of a body is looked at for a snippet: enough to redact around
// the part shown.
const SNIPPET_SOURCE_CHARS = 2000;

// The start of a response body for an error message, without secrets.
export function snippet(text: string): string {
  const start = Array.from(text).slice(0, SNIPPET_SOURCE_CHARS).join("");
  return Array.from(redact(start)).slice(0, 300).join("");
}

// Fetches a list page by page. `fetchPage` gets a cursor and returns that
// page's items and the next cursor, or null after the last page.
//
// A cursor that comes back a second time, or more than `maxPages` pages, is
// an error and not the end of the list: a list cut short must never be
// saved as the whole library, as the games it lacks would leave Steam.
export async function paginate<C, T>(
  what: string,
  first: C,
  maxPages: number,
  fetchPage: (cursor: C) => Promise<[T[], C | null | undefined]>,
): Promise<T[]> {
  const items: T[] = [];
  const seen: C[] = [first];
  let cursor = first;
  for (let page = 0; page < maxPages; page++) {
    const [pageItems, next] = await fetchPage(cursor);
    items.push(...pageItems);
    if (next === null || next === undefined) {
      return items;
    }
    if (seen.some((s) => _.isEqual(s, next))) {
      throw new Error(
        `${what} sent the same page twice, so the list is incomplete and was not saved`,
      );
    }
    seen.push(next);
    cursor = next;
  }
  throw new Error(
    `${what} kept sending more pages after ${maxPages}, so the list is incomplete and was not saved`,
  );
}

// Takes out what may be a secret from text that ends up in errors and logs:
// the query and fragment of every URL (tokens, client secrets, Humble order
// keys), and the values of JSON fields whose names suggest a credential.
export function redact(text: string): string {
  return redactJsonSecrets(redactUrls(text));
}

function redactUrls(text: string): string {
  let out = "";
  let rest = text;
  for (;;) {
    const starts = ["https://", "http://"]
      .map((scheme) => rest.indexOf(scheme))
      .filter((i) => i >= 0);
    if (!starts.length) {
      break;
    }
    const start = Math.min(...starts);
    out += rest.slice(0, start);
    const fromUrl = rest.slice(start);
    const endMatch = fromUrl.search(/[\s"'<>)\]}\\]/);
    const end = endMatch < 0 ? fromUrl.length : endMatch;
    const url = fromUrl.slice(0, end);
    const kept = url.search(/[?#]/);
    out += kept < 0 ? url : url.slice(0, kept);
    rest = fromUrl.slice(end);
  }
  return out + rest;
}

const SECRET_FIELD_PARTS = [
  "token",
  "secret",
  "password",
  "cookie",
  "code",
  "key",
  "session",
  "auth",
  "ticket",
  "sid",
];

function isSecretField(name: string) {
  const lower = name.toLowerCase();
  return (
    !lower.startsWith("error") &&
    SECRET_FIELD_PARTS.some((part) => lower.includes(part))
  );
}

// Replaces the string values of secret-looking JSON fields with "…". Works
// on cut-off or otherwise broken JSON too.
function redactJsonSecrets(text: string): string {
  const chars = Array.from(text);
  let out = "";
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c !== '"') {
      out += c;
      i += 1;
      continue;
    }
    const nameEnd = stringEnd(chars, i);
    const name = chars.slice(i + 1, Math.max(nameEnd - 1, i + 1)).join("");
    out += chars.slice(i, nameEnd).join("");
    i = nameEnd;
    const colon = skipWhitespace(chars, i);
    if (chars[colon] !== ":" || !isSecretField(name)) {
      continue;
    }
    const value = skipWhitespace(chars, colon + 1);
    if (chars[value] !== '"') {
      continue;
    }
    out += chars.slice(i, value).join("");
    out += '"…"';
    i = stringEnd(chars, value);
  }
  return out;
}

// The index after the closing quote of the string that opens at `open`.
function stringEnd(chars: string[], open: number) {
  let i = open + 1;
  while (i < chars.length) {
    if (chars[i] === "\\") {
      i += 2;
    } else if (chars[i] === '"') {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return chars.length;
}

function skipWhitespace(chars: string[], i: number) {
  while (i < chars.length && /\s/.test(chars[i])) {
    i += 1;
  }
  return i;
}

// A query parameter of a URL.
export function queryParam(url: string, name: string): string | undefined {
  try {
    return new URL(url).searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

// Whether a cookie for `cookieDomain` goes to `host` (".example.com" and
// "example.com" match example.com and every subdomain).
export function domainMatches(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.replace(/^\.+/, "").toLowerCase();
  const lowerHost = host.toLowerCase();
  return lowerHost === domain || lowerHost.endsWith(`.${domain}`);
}

// A game's title as stores write it, without trademark signs and with
// single spaces (Playnite's RemoveTrademarks): one game, one title, whichever
// store lists it.
export function cleanTitle(title: string): string {
  return title
    .replace(/[™®©]/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join(" ");
}
