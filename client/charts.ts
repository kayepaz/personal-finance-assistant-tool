/**
 * Small hand-rolled SVG charts (no dependencies). Colours come from CSS custom properties in styles.css
 * (validated categorical palette, light and dark). Identity is never colour-alone: every chart ships a
 * legend/table with labels and values.
 */
import { h } from "./dom.ts";

const NS = "http://www.w3.org/2000/svg";

function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: (Node | string)[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

const tip = (text: string) => s("title", {}, text);

export interface DonutSlice {
  label: string;
  value: number;
  display: string; // formatted value
  pct: string;
  neutral?: boolean; // e.g. "Not in any thesis" — drawn in gray, not a series colour
}

const MAX_SERIES = 7; // slot 8 is reserved for "Other"

/** Fold past seven series into "Other" so no hue is ever generated or cycled. */
export function foldSlices(slices: DonutSlice[], fmt: (n: number) => string, total: number): DonutSlice[] {
  const named = slices.filter((x) => !x.neutral);
  const neutral = slices.filter((x) => x.neutral);
  if (named.length <= MAX_SERIES + 1) return [...named, ...neutral];
  const keep = named.slice(0, MAX_SERIES);
  const rest = named.slice(MAX_SERIES);
  const other = rest.reduce((sum, x) => sum + x.value, 0);
  return [
    ...keep,
    {
      label: `Other (${rest.length})`,
      value: other,
      display: fmt(other),
      pct: total ? ((other / total) * 100).toFixed(1) : "0",
    },
    ...neutral,
  ];
}

/** Donut with a 2px surface gap between segments, centre total, and a legend table. */
export function donut(slices: DonutSlice[], centreLabel: string, centreValue: string): HTMLElement {
  const size = 220, r = 92, inner = 58, cx = size / 2, cy = size / 2;
  const total = slices.reduce((sum, x) => sum + Math.max(x.value, 0), 0);
  const svg = s("svg", {
    viewBox: `0 0 ${size} ${size}`,
    class: "donut",
    role: "img",
    "aria-label": centreLabel,
  });
  let angle = -Math.PI / 2;
  let slot = 0;
  slices.forEach((x) => {
    if (x.value <= 0 || total === 0) return;
    const cls = x.neutral ? "s-neutral" : `s${++slot}`;
    const sweep = (x.value / total) * Math.PI * 2;
    const a0 = angle, a1 = angle + sweep;
    angle = a1;
    let shape: SVGElement;
    if (sweep >= Math.PI * 2 - 1e-6) {
      shape = s("path", {
        d: `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} L ${cx - 0.01} ${
          cy - inner
        } A ${inner} ${inner} 0 1 0 ${cx} ${cy - inner} Z`,
      });
    } else {
      const large = sweep > Math.PI ? 1 : 0;
      const p = (rad: number, a: number) => `${cx + rad * Math.cos(a)} ${cy + rad * Math.sin(a)}`;
      shape = s("path", {
        d: `M ${p(r, a0)} A ${r} ${r} 0 ${large} 1 ${p(r, a1)} L ${
          p(inner, a1)
        } A ${inner} ${inner} 0 ${large} 0 ${p(inner, a0)} Z`,
      });
    }
    shape.setAttribute("class", `seg ${cls}`);
    shape.appendChild(tip(`${x.label}: ${x.display} (${x.pct}%)`));
    svg.appendChild(shape);
  });
  svg.appendChild(
    s("text", { x: cx, y: cy - 4, class: "donut-value", "text-anchor": "middle" }, centreValue),
  );
  svg.appendChild(
    s("text", { x: cx, y: cy + 16, class: "donut-label", "text-anchor": "middle" }, centreLabel),
  );

  slot = 0;
  const legend = h(
    "table",
    { class: "legend" },
    h(
      "tbody",
      null,
      slices.filter((x) => x.value > 0).map((x) =>
        h(
          "tr",
          null,
          h("td", null, h("span", { class: `swatch ${x.neutral ? "s-neutral" : `s${++slot}`}` })),
          h("td", null, x.label),
          h("td", { class: "num" }, x.display),
          h("td", { class: "num" }, `${x.pct}%`),
        )
      ),
    ),
  );
  return h("div", { class: "donut-wrap" }, svg, legend);
}

export interface Point {
  label: string; // x label, e.g. "Nov 2026"
  value: number;
  display: string;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? raw;
  const ticks: number[] = [];
  for (let t = Math.floor(min / step) * step; t <= max + step * 0.001; t += step) {
    ticks.push(Number(t.toFixed(10)));
  }
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

const compact = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);

interface Frame {
  svg: SVGSVGElement;
  x: (i: number) => number;
  y: (v: number) => number;
  band: number;
}

function frame(points: Point[], includeZero: boolean, title: string): Frame {
  const W = 760, H = 220, L = 52, R = 12, T = 10, B = 24;
  const vals = points.map((p) => p.value);
  const lo = Math.min(...vals, ...(includeZero ? [0] : []));
  const hi = Math.max(...vals, ...(includeZero ? [0] : []));
  const ticks = niceTicks(lo, hi);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const band = (W - L - R) / Math.max(points.length, 1);
  const x = (i: number) => L + band * (i + 0.5);
  const y = (v: number) => T + (H - T - B) * (1 - (v - y0) / (y1 - y0 || 1));
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": title });
  for (const t of ticks) {
    svg.appendChild(s("line", { x1: L, x2: W - R, y1: y(t), y2: y(t), class: t === 0 ? "axis" : "grid" }));
    svg.appendChild(s("text", { x: L - 8, y: y(t) + 4, class: "tick", "text-anchor": "end" }, compact(t)));
  }
  const every = Math.ceil(points.length / 8);
  points.forEach((p, i) => {
    if (i % every === 0 || i === points.length - 1) {
      svg.appendChild(s("text", { x: x(i), y: H - 8, class: "tick", "text-anchor": "middle" }, p.label));
    }
  });
  return { svg, x, y, band };
}

/** Net worth over time: a 2px line with markers; hover any month for its value. */
export function lineChart(points: Point[], title: string): SVGSVGElement {
  const { svg, x, y, band } = frame(points, false, title);
  if (points.length > 1) {
    svg.appendChild(s("polyline", {
      points: points.map((p, i) => `${x(i)},${y(p.value)}`).join(" "),
      class: "line s1-stroke",
    }));
  }
  points.forEach((p, i) => {
    const g = s("g", { class: "hit" });
    g.appendChild(s("rect", { x: x(i) - band / 2, y: 0, width: band, height: 220, class: "hit-area" }));
    g.appendChild(s("circle", { cx: x(i), cy: y(p.value), r: 4.5, class: "marker s1" }));
    g.appendChild(tip(`${p.label}: ${p.display}`));
    svg.appendChild(g);
  });
  return svg;
}

/** Signed monthly change: bars about a zero line, gains and losses in the diverging pair. */
export function changeBars(points: Point[], title: string): SVGSVGElement {
  const { svg, x, y, band } = frame(points, true, title);
  const w = Math.min(36, band * 0.6);
  points.forEach((p, i) => {
    const top = y(Math.max(p.value, 0)), bottom = y(Math.min(p.value, 0));
    const g = s("g", { class: "hit" });
    g.appendChild(s("rect", { x: x(i) - band / 2, y: 0, width: band, height: 220, class: "hit-area" }));
    g.appendChild(s("rect", {
      x: x(i) - w / 2,
      y: top,
      width: w,
      height: Math.max(bottom - top, 1),
      rx: 3,
      class: p.value >= 0 ? "bar gain" : "bar loss",
    }));
    g.appendChild(tip(`${p.label}: ${p.display}`));
    svg.appendChild(g);
  });
  return svg;
}
