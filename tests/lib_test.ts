import assert from "node:assert/strict";
import * as d from "../server/lib/decimal.ts";
import { UUID_RE, uuidv7 } from "../server/lib/ids.ts";
import { addDays, daysBetween, isIsoDate } from "../server/lib/dates.ts";

Deno.test("decimal arithmetic is exact", () => {
  assert.equal(d.add("0.1", "0.2"), "0.3");
  assert.equal(d.sub("1", "1.25"), "-0.25");
  assert.equal(d.mul("1.5", "-2.25"), "-3.375");
  assert.equal(d.div("1", "3", 4), "0.3333");
  assert.equal(d.div("2", "3", 4), "0.6667");
  assert.equal(d.div("-2", "3", 4), "-0.6667");
  assert.equal(d.round("2.345", 2), "2.35");
  assert.equal(d.normalize("010.500"), "10.5");
  assert.equal(d.cmp("1.10", "1.1"), 0);
  assert.equal(d.pctChange("100", "112.5"), "12.5");
  assert.equal(d.pctChange("200", "150"), "-25");
  assert.equal(d.sum(["1", "2.5", "-0.5"]), "3");
  assert.throws(() => d.add("1e3", "1"));
  assert.throws(() => d.div("1", "0"));
});

Deno.test("uuidv7 is valid and ordered", () => {
  const ids = Array.from({ length: 500 }, () => uuidv7());
  for (const id of ids) assert.match(id, UUID_RE);
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
});

Deno.test("dates", () => {
  assert.equal(addDays("2026-02-27", 2), "2026-03-01");
  assert.equal(daysBetween("2026-01-01", "2026-12-31"), 364);
  assert.ok(isIsoDate("2024-02-29"));
  assert.ok(!isIsoDate("2026-02-29"));
});
