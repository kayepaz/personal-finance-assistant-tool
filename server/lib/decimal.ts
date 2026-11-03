/**
 * Minimal arbitrary-precision decimal arithmetic on strings, backed by BigInt.
 * Money and quantities are stored and exchanged as decimal strings; never use `number` for them.
 */

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const DEFAULT_DIV_PLACES = 18;

interface Dec {
  n: bigint; // unscaled value
  s: number; // scale (digits after the point)
}

export function isDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_RE.test(value);
}

function parse(value: string): Dec {
  if (!isDecimal(value)) throw new RangeError(`Not a decimal string: ${JSON.stringify(value)}`);
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const [int, frac = ""] = body.split(".");
  const n = BigInt(int + frac);
  return { n: negative ? -n : n, s: frac.length };
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const s = Math.max(a.s, b.s);
  return [a.n * 10n ** BigInt(s - a.s), b.n * 10n ** BigInt(s - b.s), s];
}

function format(d: Dec): string {
  const negative = d.n < 0n;
  let digits = (negative ? -d.n : d.n).toString();
  if (d.s > 0) {
    digits = digits.padStart(d.s + 1, "0");
    const int = digits.slice(0, digits.length - d.s) || "0";
    const frac = digits.slice(digits.length - d.s).replace(/0+$/, "");
    digits = frac ? `${int}.${frac}` : int;
  }
  return negative && digits !== "0" ? `-${digits}` : digits;
}

/** Divide two bigints rounding half away from zero. */
function divRound(num: bigint, den: bigint): bigint {
  const q = num / den;
  const r = num % den;
  if (r === 0n) return q;
  const twice = (r < 0n ? -r : r) * 2n;
  const absDen = den < 0n ? -den : den;
  if (twice >= absDen) return (num < 0n) !== (den < 0n) ? q - 1n : q + 1n;
  return q;
}

export function normalize(a: string): string {
  return format(parse(a));
}

export function add(a: string, b: string): string {
  const [x, y, s] = align(parse(a), parse(b));
  return format({ n: x + y, s });
}

export function sub(a: string, b: string): string {
  const [x, y, s] = align(parse(a), parse(b));
  return format({ n: x - y, s });
}

export function mul(a: string, b: string): string {
  const x = parse(a), y = parse(b);
  return format({ n: x.n * y.n, s: x.s + y.s });
}

export function div(a: string, b: string, places = DEFAULT_DIV_PLACES): string {
  const x = parse(a), y = parse(b);
  if (y.n === 0n) throw new RangeError("Division by zero");
  // a/b = (x.n / 10^x.s) / (y.n / 10^y.s); scale result to `places`.
  const num = x.n * 10n ** BigInt(places + y.s);
  const den = y.n * 10n ** BigInt(x.s);
  return format({ n: divRound(num, den), s: places });
}

export function round(a: string, places: number): string {
  const x = parse(a);
  if (x.s <= places) return format(x);
  return format({ n: divRound(x.n, 10n ** BigInt(x.s - places)), s: places });
}

export function cmp(a: string, b: string): -1 | 0 | 1 {
  const [x, y] = align(parse(a), parse(b));
  return x < y ? -1 : x > y ? 1 : 0;
}

export function sign(a: string): -1 | 0 | 1 {
  const n = parse(a).n;
  return n < 0n ? -1 : n > 0n ? 1 : 0;
}

export function sum(values: Iterable<string>): string {
  let total = "0";
  for (const v of values) total = add(total, v);
  return total;
}

/** Percent change from `base` to `value`, e.g. pctChange("100", "112.5") === "12.5". */
export function pctChange(base: string, value: string, places = 4): string {
  return round(div(mul(sub(value, base), "100"), base), places);
}
