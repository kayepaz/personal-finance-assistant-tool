/**
 * Communication log: wraps fetch so every outbound call is recorded with its exact URL, headers and bodies
 * (request and response). API keys and tokens are masked before anything is stored.
 */
import type { DB, Row } from "../db/db.ts";
import { uuidv7 } from "../lib/ids.ts";

/** Callers name the purpose of a call with this header; it is removed before the request is sent. */
export const PURPOSE_HEADER = "x-pfat-purpose";

const MAX_BODY = 64 * 1024;
const KEEP_ROWS = 2000;
const SECRET_PARAMS = new Set(["apikey", "token", "api_key", "key"]);
const SECRET_HEADERS = new Set(["authorization", "x-pfat-signature", "cookie"]);
const MASK = "••••";

export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_PARAMS.has(k.toLowerCase())) u.searchParams.set(k, MASK);
    }
    return decodeURI(u.toString());
  } catch {
    return raw;
  }
}

function headerObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => (out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? MASK : value));
  return out;
}

function clip(text: string): string {
  return text.length > MAX_BODY
    ? `${text.slice(0, MAX_BODY)}\n… (truncated, ${text.length} characters)`
    : text;
}

function bodyText(body: BodyInit | null | undefined): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return clip(body);
  if (body instanceof URLSearchParams) return clip(body.toString());
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return `(${body.byteLength} bytes of binary data)`;
  }
  return "(stream)";
}

function purposeFor(url: URL, given: string | null): string {
  if (given) return given;
  if (url.hostname.endsWith("alphavantage.co")) return "Alpha Vantage";
  if (url.hostname.endsWith("finnhub.io")) return "Finnhub";
  if (url.hostname.endsWith("bankofcanada.ca")) return "Exchange rates · Bank of Canada";
  return "Outbound request";
}

/** A fetch that records each call in cache.db's network_log. `cache` is a getter because restore swaps it. */
export function loggedFetch(cache: () => DB, base: typeof fetch = fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const headers = new Headers(req.headers);
    const purpose = purposeFor(new URL(req.url), headers.get(PURPOSE_HEADER));
    headers.delete(PURPOSE_HEADER);
    const requestBody = bodyText(init?.body);
    const started = Date.now();
    const id = uuidv7(started);
    let response: Response | undefined;
    let error = "";
    try {
      response = await base(req.url, { ...init, method: req.method, headers });
      return response;
    } catch (err) {
      error = (err as Error).message;
      throw err;
    } finally {
      let responseBody = "";
      if (response) {
        try {
          responseBody = clip(await response.clone().text());
        } catch {
          responseBody = "(response body could not be read)";
        }
      }
      try {
        const db = cache();
        db.prepare(
          `INSERT INTO network_log(id, started_at, duration_ms, purpose, method, url, request_headers, request_body,
             status, response_headers, response_body, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          started,
          Date.now() - started,
          purpose,
          req.method,
          maskUrl(req.url),
          JSON.stringify(headerObject(headers)),
          requestBody,
          response?.status ?? null,
          JSON.stringify(response ? headerObject(response.headers) : {}),
          responseBody,
          error,
        );
        db.prepare(
          `DELETE FROM network_log WHERE started_at < (SELECT started_at FROM network_log
             ORDER BY started_at DESC LIMIT 1 OFFSET ?)`,
        ).run(KEEP_ROWS - 1);
      } catch (e) {
        console.error("[netlog] could not record call:", e);
      }
    }
  }) as typeof fetch;
}

export function listNetworkLog(cache: DB, before?: number, limit = 50): Row[] {
  return cache.prepare(
    `SELECT * FROM network_log ${
      before ? "WHERE started_at < ?" : ""
    } ORDER BY started_at DESC, id DESC LIMIT ?`,
  ).all(...(before ? [before, limit] : [limit])).map((r) => ({
    ...r,
    request_headers: JSON.parse(r.request_headers as string),
    response_headers: JSON.parse(r.response_headers as string),
  }));
}

export function clearNetworkLog(cache: DB): void {
  cache.exec("DELETE FROM network_log");
}
