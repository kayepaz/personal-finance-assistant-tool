/** A tiny router and JSON helpers. No dependencies. */

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const notFound = (what = "Not found") => new HttpError(404, what);
export const conflict = (msg: string) => new HttpError(409, msg);

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export interface Ctx<S = unknown> {
  req: Request;
  url: URL;
  params: Record<string, string>;
  state: S;
  body: () => Promise<Record<string, unknown>>;
}

type Handler<S> = (ctx: Ctx<S>) => Response | Promise<Response> | unknown | Promise<unknown>;

interface Route<S> {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler<S>;
}

export class Router<S> {
  #routes: Route<S>[] = [];

  on(method: string, path: string, handler: Handler<S>): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" + path.replace(/:([a-zA-Z_]+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) + "/?$",
    );
    this.#routes.push({ method, pattern, keys, handler });
    return this;
  }
  get(p: string, h: Handler<S>) {
    return this.on("GET", p, h);
  }
  post(p: string, h: Handler<S>) {
    return this.on("POST", p, h);
  }
  patch(p: string, h: Handler<S>) {
    return this.on("PATCH", p, h);
  }
  delete(p: string, h: Handler<S>) {
    return this.on("DELETE", p, h);
  }

  match(method: string, pathname: string): { handler: Handler<S>; params: Record<string, string> } | null {
    let pathMatched = false;
    for (const r of this.#routes) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    if (pathMatched) throw new HttpError(405, "Method not allowed");
    return null;
  }

  async handle(req: Request, url: URL, state: S): Promise<Response | null> {
    const found = this.match(req.method, url.pathname);
    if (!found) return null;
    let cached: Record<string, unknown> | undefined;
    const ctx: Ctx<S> = {
      req,
      url,
      params: found.params,
      state,
      body: async () => {
        if (cached) return cached;
        const text = await req.text();
        if (!text) return (cached = {});
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw badRequest("Body is not valid JSON");
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw badRequest("Body must be a JSON object");
        }
        return (cached = parsed as Record<string, unknown>);
      },
    };
    const result = await found.handler(ctx);
    if (result instanceof Response) return result;
    if (result === undefined) return new Response(null, { status: 204 });
    return json(result);
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.message, details: err.details }, err.status);
  }
  console.error(err);
  return json({ error: "Internal server error" }, 500);
}
