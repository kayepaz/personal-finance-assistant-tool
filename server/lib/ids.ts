/** UUID v7 (RFC 9562): 48-bit unix ms timestamp + random bits. Monotonic within a process. */

let lastMs = -1;
let seq = 0;

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Keep ids strictly increasing when several are minted in the same millisecond.
  if (now <= lastMs) {
    now = lastMs;
    seq = (seq + 1) & 0xfff;
    if (seq === 0) now = ++lastMs;
  } else {
    seq = bytes[6] & 0x07; // small random start leaves room to increment
  }
  lastMs = now;

  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
