/** Tiny DOM helpers. All text goes through textContent, so user data is never parsed as HTML. */

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "class") el.className = String(v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else {el.appendChild(
        typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c,
      );}
  }
}

export function mount(target: Element, ...children: Child[]) {
  target.replaceChildren();
  append(target, children);
}

/** Read a form into a plain object; empty strings are omitted. */
export function formData(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new FormData(form).entries()) {
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
  }
  return out;
}

export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h(
    "label",
    { class: "field" },
    h("span", { class: "field-label" }, label),
    input,
    hint ? h("small", null, hint) : null,
  );
}

export function input(name: string, attrs: Attrs = {}): HTMLInputElement {
  return h("input", { name, ...attrs });
}

export function select(
  name: string,
  options: [string, string][],
  attrs: Attrs = {},
  selected?: string,
): HTMLSelectElement {
  return h(
    "select",
    { name, ...attrs },
    options.map(([value, label]) => h("option", { value, selected: value === selected }, label)),
  );
}

export function textarea(name: string, attrs: Attrs = {}, value = ""): HTMLTextAreaElement {
  const t = h("textarea", { name, rows: 3, ...attrs });
  t.value = value;
  return t;
}

export function fmtDate(ms: number | null | undefined): string {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function fmtNum(value: string | null | undefined, maxFrac = 4): string {
  if (value === null || value === undefined || value === "") return "—";
  const [int, frac = ""] = value.replace("-", "").split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const f = frac.slice(0, maxFrac);
  return `${value.startsWith("-") ? "−" : ""}${grouped}${f ? `.${f}` : ""}`;
}

export function label(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}

/** Money with exactly two decimals, e.g. "1234.5" -> "1,234.50". */
export function fmtMoney(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const [int, frac = ""] = value.split(".");
  const f = (frac + "00").slice(0, 2);
  return fmtNum(`${int}.${f}`, 2);
}
