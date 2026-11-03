/** API client. The session token lives in localStorage on this device only. */

const TOKEN_KEY = "pfat.token";

// deno-lint-ignore no-explicit-any
export type J = Record<string, any>;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable (private mode); the session lasts until reload
  }
}

let onUnauthorized: () => void = () => {};
export function handleUnauthorized(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = J>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) {
      setToken(null);
      onUnauthorized();
    }
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const get = <T = J>(path: string) => api<T>("GET", path);
export const post = <T = J>(path: string, body: unknown = {}) => api<T>("POST", path, body);
export const patch = <T = J>(path: string, body: unknown) => api<T>("PATCH", path, body);
export const del = (path: string) => api("DELETE", path);
