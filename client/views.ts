/** Page views. Each view returns an element; `go()` navigates and re-renders. */
import { del, get, type J, patch, post, setToken } from "./api.ts";
import { changeBars, donut, type DonutSlice, foldSlices, lineChart } from "./charts.ts";
import { field, fmtDate, fmtMoney, fmtNum, formData, h, input, label, select, textarea } from "./dom.ts";

export interface Nav {
  go: (path: string) => void;
  refresh: () => void;
  toast: (msg: string, kind?: "error" | "ok") => void;
}

const ACCOUNT_KINDS: [string, string][] = [
  ["self_directed", "Self-directed trading"],
  ["managed", "Managed portfolio"],
  ["real_estate", "Real estate"],
  ["cash", "Cash"],
  ["credit_card", "Credit card"],
  ["line_of_credit", "Line of credit / mortgage"],
  ["other_asset", "Other asset"],
  ["other_liability", "Other liability"],
];
const INSTRUMENT_KINDS: [string, string][] = [
  ["equity", "Stock"],
  ["etf", "ETF"],
  ["fund", "Fund"],
  ["crypto", "Crypto"],
  ["metal", "Precious metal"],
  ["other", "Other"],
];

const link = (nav: Nav, path: string, ...children: (Node | string)[]) =>
  h("a", {
    href: path,
    onclick: (e: Event) => {
      e.preventDefault();
      nav.go(path);
    },
  }, ...children);

const badge = (status: string) => h("span", { class: `badge badge-${status}` }, label(status));

const todayStr = () => new Date().toLocaleDateString("en-CA");

/** Wrap a submit handler: collects the form, disables it while saving, shows errors. */
function onSubmit(nav: Nav, fn: (data: Record<string, string>, form: HTMLFormElement) => Promise<unknown>) {
  return async (e: Event) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const button = form.querySelector("button[type=submit]") as HTMLButtonElement | null;
    if (button) button.disabled = true;
    try {
      await fn(formData(form), form);
    } catch (err) {
      nav.toast((err as Error).message, "error");
    } finally {
      if (button) button.disabled = false;
    }
  };
}

function details(summary: string, ...content: (Node | string | null)[]) {
  return h("details", { class: "inline-form" }, h("summary", null, summary), ...content);
}

function empty(text: string) {
  return h("p", { class: "empty" }, text);
}

// ---------------------------------------------------------------- auth

export function setupView(nav: Nav, onDone: () => void): HTMLElement {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return h(
    "section",
    { class: "auth" },
    h("h1", null, "Welcome to PFAT"),
    h("p", null, "Set a passphrase to protect this server, and the currency your net worth is reported in."),
    h(
      "form",
      {
        onsubmit: onSubmit(nav, async (d) => {
          if (d.passphrase !== d.confirm) throw new Error("Passphrases don't match");
          const r = await post("/setup", {
            passphrase: d.passphrase,
            base_currency: d.base_currency,
            time_zone: d.time_zone,
            device_name: d.device_name ?? navigator.platform,
          });
          setToken(r.token);
          onDone();
        }),
      },
      field(
        "Passphrase",
        input("passphrase", {
          type: "password",
          required: true,
          minlength: 12,
          autocomplete: "new-password",
        }),
        "At least 12 characters. There is no recovery if you forget it.",
      ),
      field(
        "Confirm passphrase",
        input("confirm", { type: "password", required: true, autocomplete: "new-password" }),
      ),
      field(
        "Base currency",
        input("base_currency", { value: "CAD", required: true, maxlength: 3, pattern: "[A-Za-z]{3}" }),
        "Chosen once, at install.",
      ),
      field("Time zone", input("time_zone", { value: tz, required: true })),
      field("Name this device", input("device_name", { placeholder: "e.g. Laptop" })),
      h("button", { type: "submit", class: "primary" }, "Set up PFAT"),
    ),
  );
}

export function loginView(nav: Nav, onDone: () => void): HTMLElement {
  return h(
    "section",
    { class: "auth" },
    h("h1", null, "Sign in"),
    h(
      "form",
      {
        onsubmit: onSubmit(nav, async (d) => {
          const r = await post("/login", {
            passphrase: d.passphrase,
            device_name: d.device_name ?? navigator.platform,
          });
          setToken(r.token);
          onDone();
        }),
      },
      field(
        "Passphrase",
        input("passphrase", {
          type: "password",
          required: true,
          autocomplete: "current-password",
          autofocus: true,
        }),
      ),
      field("Name this device", input("device_name", { placeholder: "e.g. Phone" })),
      h("button", { type: "submit", class: "primary" }, "Sign in"),
    ),
  );
}

// ---------------------------------------------------------------- to-do

export async function todoView(nav: Nav): Promise<HTMLElement> {
  const items = await get<J[]>("/notifications");
  return h(
    "section",
    null,
    h(
      "header",
      { class: "page-head" },
      h("h1", null, "To do"),
      h(
        "p",
        { class: "sub" },
        items.length
          ? items.length === 1 ? "1 item needs a decision" : `${items.length} items need a decision`
          : "",
      ),
    ),
    items.length ? h("ul", { class: "cards" }, items.map((n) => todoCard(nav, n))) : empty(
      "Nothing needs your attention. Triggers, claim reviews and balance reminders will appear here.",
    ),
  );
}

function todoCard(nav: Nav, n: J): HTMLElement {
  const act = (body: J) => post(`/notifications/${n.id}/actions`, body).then(() => nav.refresh());
  const snooze = details(
    "Snooze",
    h(
      "form",
      { onsubmit: onSubmit(nav, (d) => act({ action: "snooze", until: d.until })) },
      field("Until", input("until", { type: "date", required: true, min: todayStr() })),
      h("button", { type: "submit" }, "Snooze"),
    ),
  );
  const dismiss = details(
    "Dismiss",
    h(
      "form",
      { onsubmit: onSubmit(nav, (d) => act({ action: "dismiss", note: d.note })) },
      field("Why are you dismissing this?", textarea("note", { required: true })),
      h("button", { type: "submit" }, "Dismiss"),
    ),
  );

  let actions: (Node | null)[] = [];
  let context: Node | null = null;
  if (n.kind === "trigger_fired" && n.firing) {
    const f = n.firing;
    context = h(
      "p",
      { class: "meta" },
      "Thesis: ",
      link(nav, `/theses/${f.thesis_id}`, f.thesis_title),
      " · Asset: ",
      link(nav, `/assets/${f.asset_id}`, f.asset_name),
    );
    actions = [
      h(
        "button",
        { onclick: () => nav.go(`/triggers/${f.trigger_id}`) },
        "Adjust trigger",
      ),
      h(
        "button",
        { onclick: () => nav.go(`/theses/${f.thesis_id}#trigger-${f.trigger_id}`) },
        "Change triggers on this thesis",
      ),
      details(
        "I sold",
        h(
          "p",
          { class: "hint" },
          "Record the sale on the asset page so the purchase is closed, then confirm here.",
        ),
        h(
          "form",
          { onsubmit: onSubmit(nav, (d) => act({ action: "sold", note: d.note })) },
          field("Note (optional)", textarea("note")),
          h("button", { type: "button", onclick: () => nav.go(`/assets/${f.asset_id}`) }, "Go to asset"),
          h("button", { type: "submit" }, "Mark sold"),
        ),
      ),
      snooze,
      dismiss,
    ];
  } else if (n.kind === "claim_review_due" && n.claim) {
    context = h(
      "p",
      { class: "meta" },
      n.claim.theses.length > 1 ? "Theses: " : "Thesis: ",
      n.claim.theses.flatMap((t: J, i: number) => [i ? ", " : "", link(nav, `/theses/${t.id}`, t.title)]),
      " · ",
      link(nav, `/claims/${n.claim.id}`, "Open claim"),
    );
    actions = [
      h(
        "form",
        {
          class: "row-form",
          onsubmit: onSubmit(nav, (d) => post(`/claims/${n.claim.id}/reviews`, d).then(() => nav.refresh())),
        },
        select("verdict", [["still_true", "Still true"], ["weakened", "Weakened"], [
          "no_longer_true",
          "No longer true",
        ]]),
        input("note", { placeholder: "What did you check?" }),
        h("button", { type: "submit", class: "primary" }, "Record review"),
      ),
      snooze,
      dismiss,
    ];
  } else if (n.kind === "balance_update_due") {
    actions = [
      h(
        "form",
        {
          class: "row-form",
          onsubmit: onSubmit(
            nav,
            (d) =>
              post(`/accounts/${n.ref_id}/snapshots`, { amount: d.amount, as_of: todayStr() }).then(() =>
                nav.refresh()
              ),
          ),
        },
        input("amount", {
          placeholder: "Current balance",
          required: true,
          pattern: "-?\\d+(\\.\\d+)?",
          inputmode: "decimal",
        }),
        h("button", { type: "submit", class: "primary" }, "Update balance"),
      ),
      h("button", { onclick: () => nav.go(`/accounts/${n.ref_id}`) }, "Open account"),
      snooze,
      dismiss,
    ];
  }

  return h(
    "li",
    { class: `card todo todo-${n.kind}` },
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "kind" }, label(n.kind)),
      h("time", null, fmtDate(n.created_at)),
    ),
    h("h3", null, n.title),
    n.body ? h("p", null, n.body) : null,
    context,
    h("div", { class: "actions" }, actions),
  );
}

// ---------------------------------------------------------------- theses

export async function thesesView(nav: Nav): Promise<HTMLElement> {
  const theses = await get<J[]>("/theses");
  const groups = ["triggered", "active", "draft", "closed", "abandoned"];
  return h(
    "section",
    null,
    h("header", { class: "page-head" }, h("h1", null, "Theses")),
    details(
      "New thesis",
      h(
        "form",
        {
          onsubmit: onSubmit(nav, async (d) => {
            const t = await post("/theses", { title: d.title, summary: d.summary, status: d.status });
            nav.go(`/theses/${t.id}`);
          }),
        },
        field("Title", input("title", { required: true, placeholder: "e.g. Riding the AI capex wave" })),
        field("Summary", textarea("summary")),
        field("Start as", select("status", [["draft", "Draft"], ["active", "Active"]])),
        h("button", { type: "submit", class: "primary" }, "Create thesis"),
      ),
    ),
    theses.length === 0
      ? empty("No theses yet. A thesis records why you buy something and when you'd sell.")
      : null,
    groups.map((g) => {
      const list = theses.filter((t) => t.status === g);
      if (!list.length) return null;
      return h(
        "div",
        { class: "group" },
        h("h2", null, label(g)),
        h(
          "ul",
          { class: "list" },
          list.map((t) =>
            h(
              "li",
              null,
              link(nav, `/theses/${t.id}`, h("strong", null, t.title)),
              h(
                "span",
                { class: "meta" },
                `${t.link_count} holding${t.link_count === 1 ? "" : "s"} · ${t.claim_count} claim${
                  t.claim_count === 1 ? "" : "s"
                } · ${t.trigger_count} trigger${t.trigger_count === 1 ? "" : "s"}`,
              ),
            )
          ),
        ),
      );
    }),
  );
}

function triggerSummary(t: J): string {
  const p = t.params;
  if (t.type === "sell_on_date") return `Sell on ${p.date}`;
  if (t.type === "sell_after_days") {
    return `Sell ${p.days} days after ${p.from === "purchase" ? "purchase" : "trigger created"}`;
  }
  const base = p.baseline === "fixed" ? `fixed price ${p.fixed_price}` : label(p.baseline).toLowerCase();
  return `Alert when price ${p.direction === "up" ? "rises" : "falls"} ${p.percent}% from ${base}`;
}

function triggerParamFields(type: string, p: J = {}): HTMLElement {
  if (type === "sell_on_date") {
    return h(
      "div",
      null,
      field("Sell on", input("date", { type: "date", required: true, value: p.date ?? "" })),
    );
  }
  if (type === "sell_after_days") {
    return h(
      "div",
      null,
      field("Days", input("days", { type: "number", min: 1, required: true, value: p.days ?? "" })),
      field(
        "Counted from",
        select("from", [["purchase", "The purchase date"], ["trigger_created", "Today"]], {}, p.from),
      ),
    );
  }
  return h(
    "div",
    null,
    field("Direction", select("direction", [["down", "Falls by"], ["up", "Rises by"]], {}, p.direction)),
    field(
      "Percent",
      input("percent", {
        required: true,
        pattern: "\\d+(\\.\\d+)?",
        inputmode: "decimal",
        value: p.percent ?? "",
      }),
    ),
    field(
      "Measured from",
      select(
        "baseline",
        [["avg_cost", "Average cost"], ["purchase_price", "The linked purchase price"], [
          "fixed",
          "A fixed price",
        ]],
        {},
        p.baseline,
      ),
    ),
    field(
      "Fixed price (if chosen)",
      input("fixed_price", { pattern: "\\d+(\\.\\d+)?", inputmode: "decimal", value: p.fixed_price ?? "" }),
    ),
    h("p", { class: "hint" }, "Prices are daily closes, so alerts are checked once per day."),
  );
}

function paramsFrom(type: string, d: Record<string, string>): J {
  if (type === "sell_on_date") return { date: d.date };
  if (type === "sell_after_days") return { days: Number(d.days), from: d.from };
  return {
    direction: d.direction,
    percent: d.percent,
    baseline: d.baseline,
    ...(d.baseline === "fixed" ? { fixed_price: d.fixed_price } : {}),
  };
}

export async function thesisView(nav: Nav, id: string): Promise<HTMLElement> {
  const [t, history, assets, claimLibrary, triggerLibrary] = await Promise.all([
    get(`/theses/${id}`),
    get<J[]>(`/theses/${id}/history`),
    get<J[]>("/assets"),
    get<J[]>("/claims?status=active"),
    get<J[]>("/triggers?status=active"),
  ]);
  const update = (body: J) => patch(`/theses/${id}`, body).then(() => nav.refresh());
  const open = t.status !== "closed" && t.status !== "abandoned";

  // --- lifecycle
  const lifecycle = h(
    "div",
    { class: "actions" },
    t.status === "draft"
      ? h("button", {
        class: "primary",
        onclick: () => update({ status: "active" }).catch((e) => nav.toast(e.message, "error")),
      }, "Activate")
      : null,
    open
      ? details(
        "Close thesis",
        h("p", { class: "hint" }, "Looking back: did the thesis play out?"),
        h(
          "form",
          {
            onsubmit: onSubmit(
              nav,
              (d) => update({ status: "closed", outcome: d.outcome, retrospective: d.retrospective }),
            ),
          },
          field(
            "Outcome",
            select("outcome", [["played_out", "Played out"], ["partly", "Partly"], ["wrong", "Wrong"], [
              "unclear",
              "Unclear",
            ]]),
          ),
          field("Retrospective", textarea("retrospective", { required: true, rows: 5 })),
          h("button", { type: "submit", class: "primary" }, "Close thesis"),
        ),
      )
      : h("button", {
        onclick: () =>
          update({ status: "active", note: "Re-opened" }).catch((e) => nav.toast(e.message, "error")),
      }, "Re-open"),
    open
      ? details(
        "Abandon",
        h(
          "form",
          {
            onsubmit: onSubmit(
              nav,
              (d) => update({ status: "abandoned", retrospective: d.retrospective, note: d.retrospective }),
            ),
          },
          field("Why?", textarea("retrospective", { required: true })),
          h("button", { type: "submit" }, "Abandon thesis"),
        ),
      )
      : null,
  );

  // --- links
  const assetPicker = select("asset_id", [
    ["", "Choose an asset…"],
    ...assets.map((a): [string, string] => [a.id, `${a.name} — ${a.account_name}`]),
  ], { required: true });
  const buyPicker = select("buy_trade_id", [["", "—"]]);
  const buyField = field("Which purchase?", buyPicker, "Each purchase can serve one or more theses.");
  buyField.hidden = true;
  assetPicker.addEventListener("change", async () => {
    const a = assets.find((x) => x.id === assetPicker.value);
    buyField.hidden = !a || a.tracking !== "trades";
    if (a?.tracking === "trades") {
      const buys = await get<J[]>(`/assets/${a.id}/open-buys`);
      buyPicker.replaceChildren(
        ...buys.map((b) =>
          h(
            "option",
            { value: b.id },
            `${b.trade_date}: ${fmtNum(b.open_quantity)} open @ ${fmtNum(b.price)}`,
          )
        ),
      );
      if (!buys.length) {
        buyPicker.replaceChildren(h("option", { value: "" }, "No open purchases — record a buy first"));
      }
    }
  });
  const links = h(
    "div",
    { class: "panel" },
    h("h2", null, "Holdings"),
    t.links.length
      ? h(
        "ul",
        { class: "list" },
        t.links.map((l: J) =>
          h(
            "li",
            null,
            link(nav, `/assets/${l.asset_id}`, h("strong", null, l.asset_name)),
            h(
              "span",
              { class: "meta" },
              `${l.account_name}${
                l.buy_date
                  ? ` · bought ${l.buy_date}: ${fmtNum(l.buy_quantity)} @ ${fmtNum(l.buy_price)}`
                  : ""
              }`,
            ),
            details(
              "Unlink",
              h(
                "form",
                {
                  onsubmit: onSubmit(
                    nav,
                    (d) => post(`/links/${l.id}/unlink`, { reason: d.reason }).then(() => nav.refresh()),
                  ),
                },
                field("Reason", input("reason", { required: true })),
                h("button", { type: "submit" }, "Unlink"),
              ),
            ),
          )
        ),
      )
      : empty("Not linked to any holdings yet."),
    open
      ? details(
        "Link a holding",
        h(
          "form",
          { onsubmit: onSubmit(nav, (d) => post(`/theses/${id}/links`, d).then(() => nav.refresh())) },
          field("Asset", assetPicker),
          buyField,
          h("button", { type: "submit", class: "primary" }, "Link"),
        ),
      )
      : null,
  );

  // --- claims & triggers (shared library; edits happen on their own pages and apply everywhere)
  const usedBy = (n: number) => (n > 1 ? ` · shared by ${n} theses` : "");
  const attachPicker = (
    kind: "claims" | "triggers",
    library: J[],
    attachedIds: Set<string>,
    describe: (x: J) => string,
  ) => {
    const choices = library.filter((x) => !attachedIds.has(x.id));
    const picker = select("pick", [
      [
        "",
        choices.length
          ? "Choose an existing one…"
          : library.length
          ? "All already added"
          : "Nothing to reuse yet",
      ],
      ...choices.map((x): [string, string] => [x.id, describe(x)]),
      ["__new", "+ Add new…"],
    ]);
    return h(
      "form",
      {
        class: "row-form",
        onsubmit: onSubmit(nav, async (d) => {
          if (!d.pick) throw new Error("Choose one, or pick “Add new…”");
          if (d.pick === "__new") return nav.go(`/${kind}/new?thesis=${id}`);
          await post(
            `/theses/${id}/${kind}`,
            kind === "claims" ? { claim_id: d.pick } : { trigger_id: d.pick },
          );
          nav.refresh();
        }),
      },
      picker,
      h("button", { type: "submit", class: "primary" }, "Add"),
    );
  };
  const detachForm = (path: string) =>
    details(
      "Remove from thesis",
      h(
        "form",
        { onsubmit: onSubmit(nav, (d) => post(path, { reason: d.reason }).then(() => nav.refresh())) },
        field("Why?", input("reason", { required: true })),
        h("button", { type: "submit" }, "Remove"),
      ),
    );

  const claims = h(
    "div",
    { class: "panel" },
    h("h2", null, "Claims"),
    h(
      "p",
      { class: "hint" },
      "Statements you re-check on a schedule. One review covers every thesis using the claim.",
    ),
    t.claims.length
      ? h(
        "ul",
        { class: "list" },
        t.claims.map((c: J) =>
          h(
            "li",
            { class: c.status === "retired" ? "retired" : "" },
            link(nav, `/claims/${c.id}`, h("strong", null, c.statement)),
            h(
              "span",
              { class: "meta" },
              c.status === "retired"
                ? "Retired"
                : `Review every ${c.review_every_days} days · next ${c.next_review_on}${
                  usedBy(c.thesis_count)
                }`,
            ),
            open
              ? h("div", { class: "actions" }, detachForm(`/thesis-claims/${c.attachment_id}/detach`))
              : null,
          )
        ),
      )
      : empty("No claims yet."),
    open
      ? attachPicker("claims", claimLibrary, new Set(t.claims.map((c: J) => c.id)), (c) => c.statement)
      : null,
  );

  const triggers = h(
    "div",
    { class: "panel" },
    h("h2", null, "Triggers"),
    h("p", { class: "hint" }, "Each trigger is checked for every linked holding."),
    t.triggers.length
      ? h(
        "ul",
        { class: "list" },
        t.triggers.map((g: J) =>
          h(
            "li",
            { id: `trigger-${g.id}`, class: g.status === "retired" ? "retired" : "" },
            link(nav, `/triggers/${g.id}`, h("strong", null, g.label || triggerSummary(g))),
            h(
              "span",
              { class: "meta" },
              `${g.label ? triggerSummary(g) : ""}${g.status === "retired" ? " · Retired" : ""}${
                usedBy(g.thesis_count)
              }`,
            ),
            open
              ? h("div", { class: "actions" }, detachForm(`/thesis-triggers/${g.attachment_id}/detach`))
              : null,
          )
        ),
      )
      : empty("No triggers yet."),
    open
      ? attachPicker(
        "triggers",
        triggerLibrary,
        new Set(t.triggers.map((g: J) => g.id)),
        (g) => (g.label ? `${g.label} — ${triggerSummary(g)}` : triggerSummary(g)),
      )
      : null,
  );

  // --- reasoning
  const reasoning = h(
    "div",
    { class: "panel" },
    h("h2", null, "Reasoning"),
    h(
      "form",
      {
        onsubmit: onSubmit(nav, (d, f) =>
          post(`/theses/${id}/reasoning`, d).then(() => {
            f.reset();
            nav.refresh();
          })),
      },
      textarea("body", {
        required: true,
        placeholder: "Notes to yourself about why you put this thesis together",
      }),
      h("button", { type: "submit" }, "Add note"),
    ),
    h(
      "ul",
      { class: "notes" },
      t.reasoning.map((r: J) => h("li", null, h("time", null, fmtDate(r.created_at)), h("p", null, r.body))),
    ),
  );

  // --- history
  const historyPanel = details(
    `History (${history.length} change${history.length === 1 ? "" : "s"})`,
    h(
      "ol",
      { class: "history" },
      history.map((r) =>
        h(
          "li",
          null,
          h("time", null, new Date(r.created_at).toLocaleString()),
          ` ${label(r.entity_type)} ${r.action}`,
          r.note ? h("em", null, ` — ${r.note}`) : null,
        )
      ),
    ),
  );

  return h(
    "section",
    null,
    h("p", { class: "crumbs" }, link(nav, "/theses", "Theses")),
    h(
      "header",
      { class: "page-head" },
      h("h1", null, t.title, " ", badge(t.status)),
      t.summary ? h("p", { class: "sub" }, t.summary) : null,
    ),
    t.status === "closed"
      ? h(
        "div",
        { class: "panel retro" },
        h("h2", null, `Outcome: ${label(t.outcome ?? "unclear")}`),
        h("p", null, t.retrospective),
      )
      : null,
    lifecycle,
    details(
      "Edit title & summary",
      h(
        "form",
        {
          onsubmit: onSubmit(nav, (d) => update({ title: d.title, summary: d.summary ?? "", note: d.note })),
        },
        field("Title", input("title", { required: true, value: t.title })),
        field("Summary", textarea("summary", {}, t.summary)),
        field("Why the change?", input("note")),
        h("button", { type: "submit" }, "Save"),
      ),
    ),
    h("div", { class: "grid" }, links, triggers, claims, reasoning),
    historyPanel,
  );
}

// ---------------------------------------------------------------- accounts

export async function accountsView(nav: Nav): Promise<HTMLElement> {
  const [accounts, settings] = await Promise.all([get<J[]>("/accounts"), get("/settings")]);
  return h(
    "section",
    null,
    h("header", { class: "page-head" }, h("h1", null, "Accounts")),
    details(
      "New account",
      h(
        "form",
        {
          onsubmit: onSubmit(nav, async (d) => {
            const a = await post("/accounts", {
              name: d.name,
              kind: d.kind,
              currency: d.currency,
              tags: d.tags ? d.tags.split(",").map((s) => s.trim()).filter(Boolean) : [],
              notes: d.notes,
              update_every_days: d.update_every_days ? Number(d.update_every_days) : undefined,
            });
            nav.go(`/accounts/${a.id}`);
          }),
        },
        field("Name", input("name", { required: true, placeholder: "e.g. Questrade TFSA" })),
        field("Type", select("kind", ACCOUNT_KINDS)),
        field("Currency", input("currency", { value: settings.base_currency, maxlength: 3, required: true })),
        field("Tags", input("tags", { placeholder: "TFSA, RRSP, non-registered…" }), "Comma separated."),
        field(
          "Remind me to update the balance every (days)",
          input("update_every_days", { type: "number", min: 1 }),
        ),
        field("Jurisdiction / tax notes", textarea("notes"), "Noted only — PFAT never calculates taxes."),
        h("button", { type: "submit", class: "primary" }, "Create account"),
      ),
    ),
    accounts.length
      ? h(
        "ul",
        { class: "list" },
        accounts.map((a) =>
          h(
            "li",
            null,
            link(nav, `/accounts/${a.id}`, h("strong", null, a.name)),
            h(
              "span",
              { class: "meta" },
              `${ACCOUNT_KINDS.find(([k]) => k === a.kind)?.[1]} · ${a.currency}${
                a.tags.length ? ` · ${a.tags.join(", ")}` : ""
              }`,
            ),
          )
        ),
      )
      : empty("No accounts yet."),
  );
}

export async function accountView(nav: Nav, id: string): Promise<HTMLElement> {
  const [a, instruments] = await Promise.all([get(`/accounts/${id}`), get<J[]>("/instruments")]);
  const tradeable = a.kind === "self_directed";
  const lastValue = a.snapshots.find((s: J) => s.kind === "value");
  const lastCash = a.snapshots.find((s: J) => s.kind === "cash");

  const instrumentPicker = select("instrument_id", [
    ["", tradeable ? "Choose…" : "None (e.g. a house)"],
    ...instruments.map((
      i,
    ): [string, string] => [
      i.id,
      `${i.symbol}${i.exchange ? ` (${i.exchange})` : ""} — ${i.name || label(i.kind)}`,
    ]),
    ["__new", "+ New instrument…"],
  ]);
  const newInstrument = h(
    "fieldset",
    { hidden: true },
    h("legend", null, "New instrument"),
    field("Symbol", input("symbol", { placeholder: "AAPL" })),
    field("Exchange", input("exchange", { placeholder: "optional, e.g. TSX" })),
    field("Name", input("inst_name")),
    field("Type", select("inst_kind", INSTRUMENT_KINDS)),
    field("Currency", input("inst_currency", { value: a.currency, maxlength: 3 })),
    field("Provider symbol", input("provider_symbol", { placeholder: "defaults to symbol, e.g. SHOP.TO" })),
  );
  instrumentPicker.addEventListener(
    "change",
    () => (newInstrument.hidden = instrumentPicker.value !== "__new"),
  );

  return h(
    "section",
    null,
    h("p", { class: "crumbs" }, link(nav, "/accounts", "Accounts")),
    h(
      "header",
      { class: "page-head" },
      h("h1", null, a.name),
      h(
        "p",
        { class: "sub" },
        `${ACCOUNT_KINDS.find(([k]) => k === a.kind)?.[1]} · ${a.currency}${
          a.tags.length ? ` · ${a.tags.join(", ")}` : ""
        }`,
      ),
    ),
    a.notes ? h("div", { class: "panel" }, h("h2", null, "Notes"), h("p", null, a.notes)) : null,
    h(
      "div",
      { class: "grid" },
      h(
        "div",
        { class: "panel" },
        h("h2", null, a.is_liability ? "Balance owed" : tradeable ? "Cash" : "Value"),
        h("p", { class: "big" }, fmtNum((tradeable ? lastCash : lastValue)?.amount, 2), " ", a.currency),
        h(
          "p",
          { class: "meta" },
          (tradeable ? lastCash : lastValue)
            ? `as of ${(tradeable ? lastCash : lastValue).as_of}`
            : "Not recorded yet",
        ),
        h(
          "form",
          {
            class: "row-form",
            onsubmit: onSubmit(
              nav,
              (d) =>
                post(`/accounts/${id}/snapshots`, { ...d, kind: tradeable ? "cash" : "value" }).then(() =>
                  nav.refresh()
                ),
            ),
          },
          input("amount", {
            placeholder: "Amount",
            required: true,
            pattern: "-?\\d+(\\.\\d+)?",
            inputmode: "decimal",
          }),
          input("as_of", { type: "date", value: todayStr() }),
          h("button", { type: "submit" }, "Record"),
        ),
        a.update_every_days
          ? h("p", { class: "hint" }, `You'll be reminded every ${a.update_every_days} days.`)
          : null,
      ),
      h(
        "div",
        { class: "panel" },
        h("h2", null, "Assets"),
        a.assets.length
          ? h(
            "ul",
            { class: "list" },
            a.assets.map((x: J) =>
              h(
                "li",
                null,
                link(nav, `/assets/${x.id}`, h("strong", null, x.name)),
                h(
                  "span",
                  { class: "meta" },
                  x.tracking === "trades"
                    ? `${fmtNum(x.quantity)} held · avg cost ${fmtNum(x.average_cost)}`
                    : "Value-tracked",
                ),
              )
            ),
          )
          : empty("No assets yet."),
        details(
          "Add asset",
          h(
            "form",
            {
              onsubmit: onSubmit(nav, async (d) => {
                let instrumentId = d.instrument_id;
                if (instrumentId === "__new") {
                  const inst = await post("/instruments", {
                    symbol: d.symbol,
                    exchange: d.exchange,
                    name: d.inst_name,
                    kind: d.inst_kind,
                    currency: d.inst_currency,
                    provider_symbol: d.provider_symbol,
                  });
                  instrumentId = inst.id;
                }
                const asset = await post("/assets", {
                  account_id: id,
                  instrument_id: instrumentId,
                  name: d.name,
                });
                nav.go(`/assets/${asset.id}`);
              }),
            },
            field("Instrument", instrumentPicker),
            newInstrument,
            field(
              "Name",
              input("name", { placeholder: tradeable ? "defaults to the symbol" : "e.g. Main St house" }),
            ),
            h("button", { type: "submit", class: "primary" }, "Add asset"),
          ),
        ),
      ),
    ),
    details(
      "Account settings",
      h(
        "form",
        {
          onsubmit: onSubmit(nav, (d) =>
            patch(`/accounts/${id}`, {
              name: d.name,
              tags: d.tags ? d.tags.split(",").map((s) => s.trim()).filter(Boolean) : [],
              notes: d.notes ?? "",
              update_every_days: d.update_every_days ? Number(d.update_every_days) : null,
            }).then(() => nav.refresh())),
        },
        field("Name", input("name", { value: a.name, required: true })),
        field("Tags", input("tags", { value: a.tags.join(", ") })),
        field(
          "Update reminder (days)",
          input("update_every_days", { type: "number", min: 1, value: a.update_every_days ?? "" }),
        ),
        field("Notes", textarea("notes", {}, a.notes)),
        h("button", { type: "submit" }, "Save"),
      ),
    ),
  );
}

// ---------------------------------------------------------------- assets

export async function assetView(nav: Nav, id: string): Promise<HTMLElement> {
  const a = await get(`/assets/${id}`);
  const trades = a.tracking === "trades";
  const openBuys = trades ? await get<J[]>(`/assets/${id}/open-buys`) : [];
  const price = a.latest_price;

  const sellForm = h(
    "form",
    {
      onsubmit: onSubmit(nav, async (d) => {
        const allocations = openBuys
          .map((b) => ({ buy_trade_id: b.id, quantity: d[`alloc_${b.id}`] }))
          .filter((x) => x.quantity && Number(x.quantity) > 0);
        const total = allocations.reduce((s, x) => s + Number(x.quantity), 0);
        const r = await post(`/assets/${id}/sells`, {
          trade_date: d.trade_date,
          price: d.price,
          fees: d.fees,
          notes: d.notes,
          allocations,
          quantity: allocations.length === 1 ? allocations[0].quantity : String(total),
        });
        if (r.fully_sold_theses.length) {
          nav.toast(
            `Fully sold: ${r.fully_sold_theses.map((t: J) => t.title).join(", ")}. Consider closing ${
              r.fully_sold_theses.length > 1 ? "these theses" : "this thesis"
            } with a retrospective.`,
            "ok",
          );
          nav.go(`/theses/${r.fully_sold_theses[0].id}`);
        } else nav.refresh();
      }),
    },
    field("Date", input("trade_date", { type: "date", required: true, value: todayStr() })),
    field(
      "Price per unit",
      input("price", { required: true, pattern: "\\d+(\\.\\d+)?", inputmode: "decimal" }),
    ),
    h(
      "fieldset",
      null,
      h("legend", null, "Which purchases does this sale close?"),
      openBuys.length
        ? openBuys.map((b) =>
          field(
            `${b.trade_date} @ ${fmtNum(b.price)} (${fmtNum(b.open_quantity)} open)`,
            input(`alloc_${b.id}`, { placeholder: "0", pattern: "\\d+(\\.\\d+)?", inputmode: "decimal" }),
          )
        )
        : empty("No open purchases."),
    ),
    field("Fees (noted only)", input("fees", { pattern: "\\d+(\\.\\d+)?", inputmode: "decimal" })),
    field("Notes", input("notes")),
    h("button", { type: "submit", class: "primary" }, "Record sale"),
  );

  return h(
    "section",
    null,
    h("p", { class: "crumbs" }, link(nav, `/accounts/${a.account_id}`, a.account_name)),
    h(
      "header",
      { class: "page-head" },
      h("h1", null, a.name),
      h(
        "p",
        { class: "sub" },
        a.symbol
          ? `${a.symbol}${a.exchange ? ` · ${a.exchange}` : ""} · ${a.instrument_currency}`
          : "Value-tracked",
      ),
    ),
    h(
      "div",
      { class: "grid" },
      trades
        ? h(
          "div",
          { class: "panel" },
          h("h2", null, "Position"),
          h("p", { class: "big" }, fmtNum(a.quantity)),
          h("p", { class: "meta" }, `Average cost ${fmtNum(a.average_cost)} ${a.instrument_currency}`),
          h(
            "p",
            { class: "meta" },
            price
              ? `Last close ${fmtNum(price.close)} on ${price.price_date}`
              : "No price yet — add a market-data key in Settings.",
          ),
        )
        : null,
      h(
        "div",
        { class: "panel" },
        h("h2", null, "Theses"),
        a.links.length
          ? h(
            "ul",
            { class: "list" },
            a.links.map((l: J) =>
              h(
                "li",
                null,
                link(nav, `/theses/${l.thesis_id}`, h("strong", null, l.thesis_title)),
                " ",
                badge(l.thesis_status),
              )
            ),
          )
          : empty(
            "Not part of any thesis yet. Every purchase should have a reason — link it from a thesis page.",
          ),
      ),
    ),
    trades
      ? h(
        "div",
        { class: "panel" },
        h("h2", null, "Trades"),
        h(
          "div",
          { class: "actions" },
          details(
            "Record a buy",
            h(
              "form",
              { onsubmit: onSubmit(nav, (d) => post(`/assets/${id}/buys`, d).then(() => nav.refresh())) },
              field("Date", input("trade_date", { type: "date", required: true, value: todayStr() })),
              field(
                "Quantity",
                input("quantity", { required: true, pattern: "\\d+(\\.\\d+)?", inputmode: "decimal" }),
              ),
              field(
                "Price per unit",
                input("price", { required: true, pattern: "\\d+(\\.\\d+)?", inputmode: "decimal" }),
              ),
              field("Fees (noted only)", input("fees", { pattern: "\\d+(\\.\\d+)?", inputmode: "decimal" })),
              field("Notes", input("notes")),
              h("button", { type: "submit", class: "primary" }, "Record buy"),
            ),
          ),
          openBuys.length ? details("Record a sale", sellForm) : null,
        ),
        a.trades.length
          ? h(
            "table",
            null,
            h(
              "thead",
              null,
              h("tr", null, ["Date", "Side", "Qty", "Price", "Open", ""].map((c) => h("th", null, c))),
            ),
            h(
              "tbody",
              null,
              a.trades.map((t: J) =>
                h(
                  "tr",
                  null,
                  h("td", null, t.trade_date),
                  h("td", null, label(t.side)),
                  h("td", { class: "num" }, fmtNum(t.quantity)),
                  h("td", { class: "num" }, fmtNum(t.price)),
                  h("td", { class: "num" }, t.side === "buy" ? fmtNum(t.open_quantity) : ""),
                  h(
                    "td",
                    null,
                    h("button", {
                      class: "link danger",
                      onclick: async () => {
                        if (!confirm("Delete this trade?")) return;
                        try {
                          await del(`/trades/${t.id}`);
                          nav.refresh();
                        } catch (e) {
                          nav.toast((e as Error).message, "error");
                        }
                      },
                    }, "Delete"),
                  ),
                )
              ),
            ),
          )
          : empty("No trades yet."),
      )
      : null,
  );
}

// ---------------------------------------------------------------- settings

export async function settingsView(nav: Nav, onSignOut: () => void): Promise<HTMLElement> {
  const [s, sessions] = await Promise.all([get("/settings"), get<J[]>("/sessions")]);
  return h(
    "section",
    null,
    h(
      "header",
      { class: "page-head" },
      h("h1", null, "Settings"),
      h("p", { class: "sub" }, `Base currency ${s.base_currency} · ${s.time_zone}`),
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", null, "Market data"),
      h(
        "p",
        { class: "hint" },
        "Prices and exchange rates come only from sources you've turned on below. Only ticker symbols and currency codes are sent.",
      ),
      s.providers.map((p: J) =>
        h(
          "div",
          { class: "provider" },
          h(
            "h3",
            null,
            p.name,
            " ",
            p.consented && p.has_key
              ? h("span", { class: "badge badge-active" }, "On")
              : h("span", { class: "badge" }, "Off"),
          ),
          h("p", { class: "meta" }, `Used for: ${p.uses}${p.needs_key ? "" : " · no API key needed"}`),
          h("p", { class: "consent" }, p.consent_text),
          h(
            "p",
            { class: "meta" },
            `${p.calls_today} of ${p.daily_limit} calls today${p.exhausted_today ? " · limit reached" : ""}`,
          ),
          !p.needs_key ? null : h(
            "form",
            {
              class: "row-form",
              onsubmit: onSubmit(
                nav,
                (d) => post(`/providers/${p.id}`, { api_key: d.api_key ?? "" }).then(() => nav.refresh()),
              ),
            },
            input("api_key", {
              type: "password",
              placeholder: p.has_key ? "Key saved — enter to replace" : "API key",
              autocomplete: "off",
            }),
            h("button", { type: "submit" }, "Save key"),
          ),
          h(
            "label",
            { class: "check" },
            h("input", {
              type: "checkbox",
              checked: p.consented,
              onchange: (e: Event) =>
                post(`/providers/${p.id}`, { consent: (e.target as HTMLInputElement).checked }).then(() =>
                  nav.refresh()
                ),
            }),
            " I agree to send the data described above to ",
            p.name,
          ),
        )
      ),
      s.deferred.length
        ? h(
          "p",
          { class: "hint" },
          `Waiting for tomorrow's quota: ${s.deferred.map((x: J) => x.key).join(", ")}`,
        )
        : null,
      h("button", {
        onclick: async () => {
          try {
            const r = await post("/jobs/run");
            nav.toast(
              `Checked: ${r.prices.updated.length} prices updated, ${r.triggers_fired} triggers fired, ${r.claim_reviews} reviews due.`,
              "ok",
            );
            nav.refresh();
          } catch (e) {
            nav.toast((e as Error).message, "error");
          }
        },
      }, "Run checks now"),
      s.last_jobs
        ? h("p", { class: "meta" }, `Last run ${new Date(s.last_jobs.ran_at).toLocaleString()}`)
        : null,
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", null, "Signed-in devices"),
      h(
        "ul",
        { class: "list" },
        sessions.map((x) =>
          h(
            "li",
            null,
            h("strong", null, x.device_name),
            x.current ? " (this device)" : "",
            h("span", { class: "meta" }, `Last seen ${new Date(x.last_seen_at).toLocaleString()}`),
            x.current ? null : h("button", {
              class: "link danger",
              onclick: () => del(`/sessions/${x.id}`).then(() => nav.refresh()),
            }, "Sign out device"),
          )
        ),
      ),
      h("button", {
        onclick: async () => {
          await post("/logout").catch(() => {});
          setToken(null);
          onSignOut();
        },
      }, "Sign out"),
    ),
  );
}

// ---------------------------------------------------------------- claims library

const VERDICT_OPTIONS: [string, string][] = [
  ["still_true", "Still true"],
  ["weakened", "Weakened"],
  ["no_longer_true", "No longer true"],
];

function usedByPanel(nav: Nav, theses: J[], what: string): HTMLElement {
  return h(
    "div",
    { class: "panel" },
    h("h2", null, `Used by ${theses.length} ${theses.length === 1 ? "thesis" : "theses"}`),
    theses.length
      ? h(
        "ul",
        { class: "list" },
        theses.map((t) =>
          h("li", null, link(nav, `/theses/${t.id}`, h("strong", null, t.title)), " ", badge(t.status))
        ),
      )
      : empty(`This ${what} isn't attached to any thesis. Add it from a thesis page.`),
  );
}

function historyList(history: J[]): HTMLElement {
  return details(
    `History (${history.length} change${history.length === 1 ? "" : "s"})`,
    h(
      "ol",
      { class: "history" },
      history.map((r) =>
        h(
          "li",
          null,
          h("time", null, new Date(r.created_at).toLocaleString()),
          ` ${label(r.action)}`,
          r.note ? h("em", null, ` — ${r.note}`) : null,
        )
      ),
    ),
  );
}

function sharedWarning(count: number): HTMLElement | null {
  return count > 1 ? h("p", { class: "warn" }, `Changes apply to all ${count} theses that use this.`) : null;
}

export async function claimsView(nav: Nav): Promise<HTMLElement> {
  const claims = await get<J[]>("/claims");
  return h(
    "section",
    null,
    h(
      "header",
      { class: "page-head" },
      h("h1", null, "Claims"),
      h("p", { class: "sub" }, "Reusable statements you re-check on a schedule. Attach them to any thesis."),
    ),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", onclick: () => nav.go("/claims/new") }, "New claim"),
    ),
    claims.length
      ? h(
        "ul",
        { class: "list" },
        claims.map((c) =>
          h(
            "li",
            { class: c.status === "retired" ? "retired" : "" },
            link(nav, `/claims/${c.id}`, h("strong", null, c.statement)),
            h(
              "span",
              { class: "meta" },
              [
                c.status === "retired" ? "Retired" : `Next review ${c.next_review_on}`,
                `${c.thesis_count} ${c.thesis_count === 1 ? "thesis" : "theses"}`,
                c.last_verdict ? `last verdict: ${label(c.last_verdict).toLowerCase()}` : "",
              ].filter(Boolean).join(" · "),
            ),
          )
        ),
      )
      : empty("No claims yet."),
  );
}

async function backTo(thesisId: string | null): Promise<J | null> {
  return thesisId ? await get(`/theses/${thesisId}`).catch(() => null) : null;
}

export async function claimNewView(nav: Nav, thesisId: string | null): Promise<HTMLElement> {
  const thesis = await backTo(thesisId);
  return h(
    "section",
    null,
    h(
      "p",
      { class: "crumbs" },
      thesis ? link(nav, `/theses/${thesis.id}`, thesis.title) : link(nav, "/claims", "Claims"),
    ),
    h(
      "header",
      { class: "page-head" },
      h("h1", null, "New claim"),
      thesis ? h("p", { class: "sub" }, `Will be added to “${thesis.title}”.`) : null,
    ),
    h(
      "form",
      {
        class: "panel",
        onsubmit: onSubmit(nav, async (d) => {
          const c = await post("/claims", {
            statement: d.statement,
            review_every_days: Number(d.review_every_days),
            thesis_id: thesis?.id,
          });
          nav.go(thesis ? `/theses/${thesis.id}` : `/claims/${c.id}`);
        }),
      },
      field(
        "Statement",
        textarea("statement", { required: true, placeholder: "e.g. The company has a strong product" }),
      ),
      field(
        "Review every (days)",
        input("review_every_days", { type: "number", min: 1, value: 90, required: true }),
      ),
      h("button", { type: "submit", class: "primary" }, thesis ? "Create and add to thesis" : "Create claim"),
    ),
  );
}

export async function claimView(nav: Nav, id: string): Promise<HTMLElement> {
  const c = await get(`/claims/${id}`);
  const active = c.status === "active";
  return h(
    "section",
    null,
    h("p", { class: "crumbs" }, link(nav, "/claims", "Claims")),
    h(
      "header",
      { class: "page-head" },
      h("h1", null, c.statement, " ", badge(active ? "active" : "retired")),
      h(
        "p",
        { class: "sub" },
        active ? `Review every ${c.review_every_days} days · next ${c.next_review_on}` : "Retired",
      ),
    ),
    h(
      "div",
      { class: "grid" },
      active
        ? h(
          "div",
          { class: "panel" },
          h("h2", null, "Review"),
          h(
            "form",
            { onsubmit: onSubmit(nav, (d) => post(`/claims/${id}/reviews`, d).then(() => nav.refresh())) },
            field("Verdict", select("verdict", VERDICT_OPTIONS)),
            field("Note", textarea("note", { placeholder: "What did you check?" })),
            h("button", { type: "submit", class: "primary" }, "Record review"),
          ),
          h(
            "ul",
            { class: "notes" },
            c.reviews.map((r: J) =>
              h(
                "li",
                null,
                h("time", null, fmtDate(r.reviewed_at)),
                h("p", null, h("strong", null, label(r.verdict)), r.note ? ` — ${r.note}` : ""),
              )
            ),
          ),
        )
        : null,
      usedByPanel(nav, c.theses, "claim"),
    ),
    active
      ? details(
        "Edit",
        h(
          "form",
          {
            onsubmit: onSubmit(nav, (d) =>
              patch(`/claims/${id}`, {
                statement: d.statement,
                review_every_days: Number(d.review_every_days),
                note: d.note,
              }).then(() => nav.refresh())),
          },
          sharedWarning(c.theses.length),
          field("Statement", textarea("statement", { required: true }, c.statement)),
          field(
            "Review every (days)",
            input("review_every_days", {
              type: "number",
              min: 1,
              required: true,
              value: c.review_every_days,
            }),
          ),
          field("Why the change?", input("note")),
          h("button", { type: "submit", class: "primary" }, "Save"),
        ),
      )
      : null,
    active
      ? details(
        "Retire",
        h(
          "form",
          {
            onsubmit: onSubmit(nav, (d) =>
              patch(`/claims/${id}`, { status: "retired", note: d.note }).then(() => nav.refresh())),
          },
          sharedWarning(c.theses.length),
          field("Why?", input("note", { required: true })),
          h("button", { type: "submit" }, "Retire claim"),
        ),
      )
      : null,
    historyList(c.history),
  );
}

// ---------------------------------------------------------------- triggers library

const TRIGGER_TYPE_OPTIONS: [string, string][] = [
  ["pct_change", "Price change %"],
  ["sell_on_date", "Sell on a date"],
  ["sell_after_days", "Sell after N days"],
];

export async function triggersView(nav: Nav): Promise<HTMLElement> {
  const triggers = await get<J[]>("/triggers");
  return h(
    "section",
    null,
    h(
      "header",
      { class: "page-head" },
      h("h1", null, "Triggers"),
      h(
        "p",
        { class: "sub" },
        "Reusable sell rules. Attach one to any number of theses; editing it changes it everywhere.",
      ),
    ),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", onclick: () => nav.go("/triggers/new") }, "New trigger"),
    ),
    triggers.length
      ? h(
        "ul",
        { class: "list" },
        triggers.map((g) =>
          h(
            "li",
            { class: g.status === "retired" ? "retired" : "" },
            link(nav, `/triggers/${g.id}`, h("strong", null, g.label || triggerSummary(g))),
            h(
              "span",
              { class: "meta" },
              [
                g.label ? triggerSummary(g) : "",
                g.status === "retired" ? "Retired" : "",
                `${g.thesis_count} ${g.thesis_count === 1 ? "thesis" : "theses"}`,
              ].filter(Boolean).join(" · "),
            ),
          )
        ),
      )
      : empty("No triggers yet."),
  );
}

export async function triggerNewView(nav: Nav, thesisId: string | null): Promise<HTMLElement> {
  const thesis = await backTo(thesisId);
  const typePicker = select("type", TRIGGER_TYPE_OPTIONS);
  const paramBox = h("div", null, triggerParamFields("pct_change"));
  typePicker.addEventListener("change", () => paramBox.replaceChildren(triggerParamFields(typePicker.value)));
  return h(
    "section",
    null,
    h(
      "p",
      { class: "crumbs" },
      thesis ? link(nav, `/theses/${thesis.id}`, thesis.title) : link(nav, "/triggers", "Triggers"),
    ),
    h(
      "header",
      { class: "page-head" },
      h("h1", null, "New trigger"),
      thesis ? h("p", { class: "sub" }, `Will be added to “${thesis.title}”.`) : null,
    ),
    h(
      "form",
      {
        class: "panel",
        onsubmit: onSubmit(nav, async (d) => {
          const g = await post("/triggers", {
            type: d.type,
            label: d.label,
            params: paramsFrom(d.type, d),
            thesis_id: thesis?.id,
          });
          nav.go(thesis ? `/theses/${thesis.id}` : `/triggers/${g.id}`);
        }),
      },
      field("Type", typePicker),
      paramBox,
      field(
        "Name",
        input("label", { placeholder: "e.g. Standard 10% stop" }),
        "A short name makes it easy to reuse.",
      ),
      h(
        "button",
        { type: "submit", class: "primary" },
        thesis ? "Create and add to thesis" : "Create trigger",
      ),
    ),
  );
}

export async function triggerView(nav: Nav, id: string): Promise<HTMLElement> {
  const g = await get(`/triggers/${id}`);
  const active = g.status === "active";
  return h(
    "section",
    null,
    h("p", { class: "crumbs" }, link(nav, "/triggers", "Triggers")),
    h(
      "header",
      { class: "page-head" },
      h("h1", null, g.label || triggerSummary(g), " ", badge(active ? "active" : "retired")),
      g.label ? h("p", { class: "sub" }, triggerSummary(g)) : null,
    ),
    h(
      "div",
      { class: "grid" },
      active
        ? h(
          "div",
          { class: "panel" },
          h("h2", null, "Adjust"),
          h(
            "form",
            {
              onsubmit: onSubmit(nav, (d) =>
                patch(`/triggers/${id}`, {
                  params: paramsFrom(g.type, d),
                  label: d.label ?? "",
                  note: d.note,
                }).then(() => {
                  nav.toast("Trigger updated; any open alerts for it were resolved.", "ok");
                  nav.refresh();
                })),
            },
            sharedWarning(g.theses.length),
            triggerParamFields(g.type, g.params),
            field("Name", input("label", { value: g.label })),
            field("Why the change?", input("note", { placeholder: "e.g. widening my stop to 20%" })),
            h("button", { type: "submit", class: "primary" }, "Save"),
          ),
          h(
            "p",
            { class: "hint" },
            "To change just one thesis, remove this trigger from it and add a different one.",
          ),
        )
        : null,
      usedByPanel(nav, g.theses, "trigger"),
    ),
    active
      ? details(
        "Retire",
        h(
          "form",
          {
            onsubmit: onSubmit(nav, (d) =>
              patch(`/triggers/${id}`, { status: "retired", note: d.note }).then(() => nav.refresh())),
          },
          sharedWarning(g.theses.length),
          field("Why?", input("note", { required: true })),
          h("button", { type: "submit" }, "Retire trigger"),
        ),
      )
      : null,
    historyList(g.history),
  );
}

// ---------------------------------------------------------------- reports

const KIND_LABEL = new Map(ACCOUNT_KINDS);

export async function reportsView(nav: Nav): Promise<HTMLElement> {
  const r = await get("/reports");
  const bs = r.balance_sheet;
  const cur = bs.base_currency as string;
  const money = (v: string | null | undefined) => fmtMoney(v);
  const fmt = (n: number) => fmtMoney(n.toFixed(2));

  // --- balance sheet
  const row = (a: J) =>
    h(
      "tr",
      { class: a.stale || a.value_base === null ? "stale" : "" },
      h(
        "td",
        null,
        link(nav, `/accounts/${a.id}`, a.name),
        a.tags.length ? h("span", { class: "meta" }, a.tags.join(", ")) : null,
      ),
      h("td", null, KIND_LABEL.get(a.kind) ?? a.kind),
      h(
        "td",
        { class: "num" },
        a.currency !== cur && a.value_native !== null ? `${money(a.value_native)} ${a.currency}` : "",
      ),
      h("td", { class: "num" }, money(a.value_base)),
      h(
        "td",
        null,
        a.as_of ?? "",
        a.warnings.length
          ? h("span", { class: "flag", title: a.warnings.join("\n") }, a.stale ? " stale" : " check")
          : null,
      ),
    );
  const section = (title: string, rows: J[], total: string) =>
    h(
      "tbody",
      null,
      h("tr", { class: "section" }, h("th", { colspan: 5 }, title)),
      rows.length ? rows.map(row) : h("tr", null, h("td", { colspan: 5, class: "empty" }, "None")),
      h(
        "tr",
        { class: "subtotal" },
        h("td", { colspan: 3 }, `Total ${title.toLowerCase()}`),
        h("td", { class: "num" }, money(total)),
        h("td"),
      ),
    );
  const assets = bs.accounts.filter((a: J) => !a.is_liability);
  const liabilities = bs.accounts.filter((a: J) => a.is_liability);
  const sheet = h(
    "div",
    { class: "panel" },
    h("h2", null, "Balance sheet"),
    h(
      "table",
      { class: "sheet" },
      h(
        "thead",
        null,
        h("tr", null, ["Account", "Type", "Native", `Value (${cur})`, "As of"].map((c) => h("th", null, c))),
      ),
      section("Assets", assets, bs.totals.assets),
      section("Liabilities", liabilities, bs.totals.liabilities),
      h(
        "tfoot",
        null,
        h(
          "tr",
          null,
          h("td", { colspan: 3 }, "Net worth"),
          h("td", { class: "num" }, money(bs.totals.net_worth)),
          h("td"),
        ),
      ),
    ),
    bs.warnings.length
      ? h("ul", { class: "warnings" }, bs.warnings.map((w: string) => h("li", null, w)))
      : null,
    h(
      "p",
      { class: "hint" },
      "Self-directed accounts are valued at the latest price plus cash. Other accounts use their latest recorded balance. Approximate by design.",
    ),
  );

  // --- net worth over time
  const monthLabel = (m: string) =>
    new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  const months = r.net_worth as J[];
  const latest = months[months.length - 1];
  const trend = h(
    "div",
    { class: "panel" },
    h("h2", null, "Net worth"),
    h("p", { class: "big" }, money(latest.net_worth), " ", cur),
    latest.change !== null
      ? h(
        "p",
        { class: "meta" },
        `${Number(latest.change) >= 0 ? "+" : "−"}${
          money(latest.change.replace("-", ""))
        } ${cur} since last month`,
      )
      : null,
    months.length > 1
      ? [
        lineChart(
          months.map((m) => ({
            label: monthLabel(m.month),
            value: Number(m.net_worth),
            display: `${money(m.net_worth)} ${cur}`,
          })),
          "Net worth by month",
        ),
        h("h3", null, "Monthly change"),
        changeBars(
          months.slice(1).map((m) => ({
            label: monthLabel(m.month),
            value: Number(m.change),
            display: `${Number(m.change) >= 0 ? "+" : "−"}${money(m.change.replace("-", ""))} ${cur}`,
          })),
          "Monthly change in net worth",
        ),
        details(
          "Table",
          h(
            "table",
            null,
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                ["Month", "Assets", "Liabilities", "Net worth", "Change"].map((c) => h("th", null, c)),
              ),
            ),
            h(
              "tbody",
              null,
              [...months].reverse().map((m) =>
                h(
                  "tr",
                  null,
                  h("td", null, monthLabel(m.month), m.live ? " (so far)" : ""),
                  h("td", { class: "num" }, money(m.assets)),
                  h("td", { class: "num" }, money(m.liabilities)),
                  h("td", { class: "num" }, money(m.net_worth)),
                  h("td", { class: "num" }, m.change === null ? "" : money(m.change)),
                )
              ),
            ),
          ),
        ),
      ]
      : h(
        "p",
        { class: "hint" },
        "The trend builds up month by month: PFAT records your net worth each time it runs its checks.",
      ),
  );

  // --- allocation
  const slices = (list: J[], neutralId: (x: J) => boolean) =>
    list.map((x): DonutSlice => ({
      label: x.label,
      value: Number(x.value),
      display: money(x.value),
      pct: x.pct,
      neutral: neutralId(x),
    }));
  const totalAssets = Number(r.by_account.total);
  const byAccount = h(
    "div",
    { class: "panel" },
    h("h2", null, "Share of assets by account"),
    h("p", { class: "hint" }, `Values in ${cur}.`),
    r.by_account.slices.length
      ? donut(
        foldSlices(slices(r.by_account.slices, () => false), fmt, totalAssets),
        "total assets",
        compactMoney(totalAssets),
      )
      : empty("No account values yet."),
    liabilities.length
      ? h(
        "p",
        { class: "hint" },
        `Liabilities (${
          money(bs.totals.liabilities)
        } ${cur}) are subtracted from net worth and not shown in this chart.`,
      )
      : null,
  );
  const splits = r.by_thesis.splits as J[];
  const byThesis = h(
    "div",
    { class: "panel" },
    h("h2", null, "Share of assets by thesis"),
    h("p", { class: "hint" }, `Values in ${cur}.`),
    r.by_thesis.slices.length
      ? donut(
        foldSlices(slices(r.by_thesis.slices, (x) => x.id === null), fmt, totalAssets),
        "total assets",
        compactMoney(totalAssets),
      )
      : empty("No holdings are linked to a thesis yet."),
    splits.length
      ? h(
        "div",
        { class: "addendum" },
        h("h3", null, "Addendum: split holdings"),
        h(
          "p",
          { class: "hint" },
          "These holdings belong to more than one thesis, so their value was split evenly between them.",
        ),
        h(
          "ul",
          null,
          splits.map((x) =>
            h(
              "li",
              null,
              h("strong", null, x.holding),
              ` (${x.account}, ${x.detail}): ${money(x.value)} ${cur} split ${x.theses.length} ways — ${
                money(x.each)
              } each to `,
              x.theses.join(", "),
            )
          ),
        ),
      )
      : null,
  );

  return h(
    "section",
    null,
    h(
      "header",
      { class: "page-head" },
      h("h1", null, "Reports"),
      h("p", { class: "sub" }, `In ${cur} · as of ${bs.as_of}`),
    ),
    sheet,
    trend,
    h("div", { class: "grid" }, byAccount, byThesis),
  );
}

function compactMoney(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
