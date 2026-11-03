/** Small input validators for request bodies. Each throws a 400 HttpError with the field name. */
import { badRequest } from "./http.ts";
import { isDecimal, sign } from "./decimal.ts";
import { isIsoDate } from "./dates.ts";

type Obj = Record<string, unknown>;

interface Opt {
  optional?: boolean;
}

function missing(body: Obj, key: string, opt?: Opt): boolean {
  const v = body[key];
  if (v === undefined || v === null) {
    if (opt?.optional) return true;
    throw badRequest(`'${key}' is required`);
  }
  return false;
}

export function str(
  body: Obj,
  key: string,
  opt: Opt & { max?: number; min?: number } = {},
): string | undefined {
  if (missing(body, key, opt)) return undefined;
  const v = body[key];
  if (typeof v !== "string") throw badRequest(`'${key}' must be a string`);
  const t = v.trim();
  if (t.length < (opt.min ?? (opt.optional ? 0 : 1))) throw badRequest(`'${key}' is too short`);
  if (t.length > (opt.max ?? 10_000)) throw badRequest(`'${key}' is too long`);
  return t;
}

export function reqStr(body: Obj, key: string, opt: { max?: number; min?: number } = {}): string {
  return str(body, key, opt)!;
}

export function int(
  body: Obj,
  key: string,
  opt: Opt & { min?: number; max?: number } = {},
): number | undefined {
  if (missing(body, key, opt)) return undefined;
  const v = body[key];
  if (typeof v !== "number" || !Number.isInteger(v)) throw badRequest(`'${key}' must be an integer`);
  if (opt.min !== undefined && v < opt.min) throw badRequest(`'${key}' must be ≥ ${opt.min}`);
  if (opt.max !== undefined && v > opt.max) throw badRequest(`'${key}' must be ≤ ${opt.max}`);
  return v;
}

export function dec(body: Obj, key: string, opt: Opt & { positive?: boolean; nonNegative?: boolean } = {}):
  | string
  | undefined {
  if (missing(body, key, opt)) return undefined;
  const v = body[key];
  if (!isDecimal(v)) throw badRequest(`'${key}' must be a decimal string like "12.34"`);
  if (opt.positive && sign(v) <= 0) throw badRequest(`'${key}' must be greater than 0`);
  if (opt.nonNegative && sign(v) < 0) throw badRequest(`'${key}' must not be negative`);
  return v;
}

export function date(body: Obj, key: string, opt: Opt = {}): string | undefined {
  if (missing(body, key, opt)) return undefined;
  const v = body[key];
  if (!isIsoDate(v)) throw badRequest(`'${key}' must be a date YYYY-MM-DD`);
  return v;
}

export function oneOf<T extends string>(
  body: Obj,
  key: string,
  values: readonly T[],
  opt: Opt = {},
): T | undefined {
  if (missing(body, key, opt)) return undefined;
  const v = body[key];
  if (typeof v !== "string" || !values.includes(v as T)) {
    throw badRequest(`'${key}' must be one of: ${values.join(", ")}`);
  }
  return v as T;
}

export function bool(body: Obj, key: string, opt: Opt = {}): boolean | undefined {
  if (missing(body, key, opt)) return undefined;
  const v = body[key];
  if (typeof v !== "boolean") throw badRequest(`'${key}' must be true or false`);
  return v;
}

export function strArray(body: Obj, key: string, opt: Opt & { max?: number } = {}): string[] | undefined {
  if (missing(body, key, opt)) return undefined;
  const v = body[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim().length > 0 && x.length <= 50)) {
    throw badRequest(`'${key}' must be an array of short strings`);
  }
  if (v.length > (opt.max ?? 20)) throw badRequest(`'${key}' has too many items`);
  return [...new Set(v.map((x: string) => x.trim()))];
}

export function currency(body: Obj, key: string, opt: Opt = {}): string | undefined {
  const v = str(body, key, opt);
  if (v === undefined) return undefined;
  if (!/^[A-Za-z]{3}$/.test(v)) throw badRequest(`'${key}' must be a 3-letter currency code`);
  return v.toUpperCase();
}

export function has(body: Obj, key: string): boolean {
  return Object.hasOwn(body, key);
}
