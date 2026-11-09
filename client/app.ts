/** PFAT client shell: routing, navigation, toasts. */
import { get, handleUnauthorized, post, setToken } from "./api.ts";
import { h, mount } from "./dom.ts";
import * as views from "./views.ts";

const root = document.getElementById("app")!;
let todoCount = 0;

const toastBox = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
document.body.appendChild(toastBox);

const nav: views.Nav = {
  go(path: string) {
    const [p, hash] = path.split("#");
    const changed = p !== location.pathname + location.search;
    if (changed) history.pushState(null, "", path);
    render().then(() => {
      if (hash) document.getElementById(hash)?.scrollIntoView({ block: "center" });
      else if (changed) scrollTo(0, 0);
    });
  },
  refresh() {
    render();
  },
  toast(msg: string, kind: "error" | "ok" = "ok") {
    const t = h("div", { class: `toast toast-${kind}` }, msg);
    toastBox.appendChild(t);
    setTimeout(() => t.remove(), kind === "error" ? 7000 : 4500);
  },
};

handleUnauthorized(() => render());
addEventListener("popstate", () => render());

const TABS: [string, string][] = [
  ["/", "To do"],
  ["/theses", "Theses"],
  ["/claims", "Claims"],
  ["/triggers", "Triggers"],
  ["/accounts", "Accounts"],
  ["/reports", "Reports"],
  ["/settings", "Settings"],
];

function shell(content: HTMLElement): HTMLElement {
  const here = location.pathname;
  const active = (
    p: string,
  ) => (p === "/" ? here === "/" : here.startsWith(p) ||
    (p === "/accounts" && (here.startsWith("/assets") || here.startsWith("/instruments"))));
  return h(
    "div",
    { class: "shell" },
    h(
      "nav",
      { class: "top" },
      h("a", { class: "brand", href: "/", onclick: (e: Event) => (e.preventDefault(), nav.go("/")) }, "PFAT"),
      TABS.map(([path, text]) =>
        h(
          "a",
          {
            href: path,
            class: active(path) ? "active" : "",
            onclick: (e: Event) => (e.preventDefault(), nav.go(path)),
          },
          text,
          path === "/" && todoCount ? h("span", { class: "count" }, String(todoCount)) : null,
        )
      ),
      h("button", {
        class: "signout",
        title: "Sign out of this device",
        onclick: async () => {
          await post("/logout").catch(() => {});
          setToken(null);
          nav.go("/");
        },
      }, "Sign out"),
    ),
    h("main", null, content),
  );
}

async function render(): Promise<void> {
  try {
    const status = await get("/status");
    if (!status.setup) return mount(root, views.setupView(nav, () => nav.go("/")));
    if (!status.authenticated) return mount(root, views.loginView(nav, () => nav.go("/")));

    const path = location.pathname;
    const thesisParam = new URLSearchParams(location.search).get("thesis");
    let m: RegExpMatchArray | null;
    let view: HTMLElement;
    if (path === "/") view = await views.todoView(nav);
    else if (path === "/theses") view = await views.thesesView(nav);
    else if ((m = path.match(/^\/theses\/([\w-]+)$/))) view = await views.thesisView(nav, m[1]);
    else if (path === "/claims") view = await views.claimsView(nav);
    else if (path === "/claims/new") view = await views.claimNewView(nav, thesisParam);
    else if ((m = path.match(/^\/claims\/([\w-]+)$/))) view = await views.claimView(nav, m[1]);
    else if (path === "/triggers") view = await views.triggersView(nav);
    else if (path === "/triggers/new") view = await views.triggerNewView(nav, thesisParam);
    else if ((m = path.match(/^\/triggers\/([\w-]+)$/))) view = await views.triggerView(nav, m[1]);
    else if (path === "/reports") view = await views.reportsView(nav);
    else if (path === "/accounts") view = await views.accountsView(nav);
    else if (path === "/instruments") view = await views.instrumentsView(nav);
    else if ((m = path.match(/^\/accounts\/([\w-]+)$/))) view = await views.accountView(nav, m[1]);
    else if ((m = path.match(/^\/assets\/([\w-]+)$/))) view = await views.assetView(nav, m[1]);
    else if (path === "/settings") view = await views.settingsView(nav, () => nav.go("/"));
    else view = h("section", null, h("h1", null, "Not found"));

    todoCount = (await get("/dashboard")).todo;
    const scroll = scrollY;
    mount(root, shell(view));
    scrollTo(0, scroll);
  } catch (err) {
    mount(
      root,
      h(
        "section",
        { class: "auth" },
        h("h1", null, "Something went wrong"),
        h("p", null, (err as Error).message),
        h("button", { onclick: () => render() }, "Try again"),
      ),
    );
  }
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
render();
