// End-to-end checks of the main screens. Tests share one server and run in order.
import { expect, test } from "playwright/test";

const PASS = "correct horse battery staple";
let page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => {
    throw e;
  });
});

test.afterAll(async () => {
  await page.close();
});

const open = (summary) => page.locator("summary", { hasText: summary }).first().click();
// Menu links; "To do" may carry a count badge ("To do 1").
const nav = (name) => page.locator("nav.top").getByRole("link", { name: new RegExp(`^${name}( \\d+)?$`) });

test("first run: set a passphrase and land on To do", async () => {
  await page.goto("/");
  await page.fill("input[name=passphrase]", PASS);
  await page.fill("input[name=confirm]", PASS);
  await page.fill("input[name=device_name]", "e2e");
  await page.click("button[type=submit]");
  await expect(page.getByRole("heading", { name: "To do" })).toBeVisible();
  await expect(page.getByText("Nothing needs your attention")).toBeVisible();
});

test("simple accounts: negative balances are liabilities", async () => {
  for (const [name, amount] of [["Savings", "25000"], ["Visa", "-1830.45"]]) {
    await nav("Accounts").click();
    await open("New account");
    await page.fill("input[name=name]", name);
    await page.selectOption("select[name=kind]", "cash");
    await page.click("button:has-text('Create account')");
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await page.fill("input[name=amount]", amount);
    await page.click("button:has-text('Record')");
    await expect(page.locator(".big")).toContainText(amount.startsWith("-") ? "−1,830.45" : "25,000");
  }
  await nav("Reports").click();
  const sheet = page.locator(".panel", { has: page.getByRole("heading", { name: "Balance sheet" }) });
  await expect(sheet.locator("tbody").nth(1)).toContainText("Visa");
  await expect(sheet.locator("tfoot")).toContainText("23,169.55");
});

test("investing: a thesis with a shared trigger fires and can be adjusted", async () => {
  // A self-directed account holding gold coins priced by hand.
  await nav("Accounts").click();
  await open("New account");
  await page.fill("input[name=name]", "Brokerage");
  await page.click("button:has-text('Create account')");
  await open("Add asset");
  await page.selectOption("select[name=instrument_id]", "__new");
  await expect(page.locator(".provider-hint")).toContainText("from Alpha Vantage or Finnhub");
  // Check symbol fills in the name (the server's provider call is stubbed here; no keys in tests).
  await page.route("**/api/instruments/check", (r) =>
    r.fulfill({
      json: {
        ok: true,
        provider_symbol: "AAPL",
        provider: "Finnhub",
        price: "270.10",
        date: "2026-11-06",
        name: "Apple Inc",
        tried: [],
      },
    }));
  await page.fill("input[name=inst_symbol]", "aapl");
  await page.click("button:has-text('Check symbol')");
  await expect(page.locator(".check-result")).toContainText("✓ AAPL");
  await expect(page.locator("input[name=inst_name]")).toHaveValue("Apple Inc");
  await page.unroute("**/api/instruments/check");
  await page.fill("input[name=inst_name]", "");
  await page.selectOption("select[name=inst_market]", "OTHER");
  await expect(page.locator(".provider-hint")).toContainText("record them yourself");
  await page.fill("input[name=inst_symbol]", "maple");
  await page.selectOption("select[name=inst_kind]", "metal");
  await page.click("button:has-text('Add asset')");
  await expect(page.getByRole("heading", { name: "MAPLE" })).toBeVisible();
  await open("Record a buy");
  const buy = page.locator("form", { has: page.locator("button:has-text('Record buy')") });
  await buy.locator("input[name=trade_date]").fill("2026-05-01");
  await buy.locator("input[name=quantity]").fill("3");
  await buy.locator("input[name=price]").fill("3000");
  await buy.locator("button:has-text('Record buy')").click();
  await expect(page.locator("td", { hasText: "2026-05-01" })).toBeVisible();

  // Thesis, linked to the purchase, with a new trigger made from the picker's "Add new…".
  await nav("Theses").click();
  await open("New thesis");
  await page.fill("input[name=title]", "Gold as a hedge");
  await page.selectOption("select[name=status]", "active");
  await page.click("button:has-text('Create thesis')");
  await open("Link a holding");
  const assetPicker = page.locator("select[name=asset_id]");
  await assetPicker.selectOption({ index: 1 });
  await expect(page.locator("select[name=buy_trade_id] option")).toContainText(["2026-05-01"]);
  await page.click("button:has-text('Link')");
  const holdings = page.locator(".panel", { has: page.getByRole("heading", { name: "Holdings" }) });
  await expect(holdings.locator(".list")).toContainText("MAPLE");
  const triggers = page.locator(".panel", { has: page.getByRole("heading", { name: "Triggers" }) });
  await triggers.locator("select[name=pick]").selectOption("__new");
  await triggers.locator("button:has-text('Add')").click();
  await expect(page.getByRole("heading", { name: "New trigger" })).toBeVisible();
  await page.fill("input[name=percent]", "10");
  await page.fill("input[name=label]", "10% stop");
  await page.click("button:has-text('Create and add to thesis')");
  await expect(triggers.getByText("10% stop")).toBeVisible();

  // A manual price 15% below cost, then a check run: the stop fires on the To do page.
  await triggers.getByText("10% stop").click(); // trigger page
  await page.goBack();
  await holdings.getByRole("link", { name: "MAPLE" }).click();
  await page.fill("input[name=close]", "2550");
  await page.click(".panel:has(h2:text('Record a price')) button:has-text('Record')");
  await expect(page.getByText("Last price (entered by you)")).toBeVisible();
  await nav("Settings").click();
  await page.click("button:has-text('Run checks now')");
  await expect(page.locator(".toast")).toContainText("1 triggers fired");
  await nav("To do").click();
  const card = page.locator(".card", { hasText: "10% stop" });
  await expect(card).toContainText("fallen 15%");

  // Adjusting the shared trigger resolves the alert and records why.
  await card.getByRole("button", { name: "Adjust trigger" }).click();
  await page.fill("input[name=percent]", "20");
  await page.fill("input[name=note]", "Gold is volatile");
  await page.click("button:has-text('Save')");
  await nav("To do").click();
  await expect(page.getByText("Nothing needs your attention")).toBeVisible();
  await nav("Triggers").click();
  await page.getByText("10% stop").click();
  await open("History (2 changes)");
  await expect(page.getByText("Gold is volatile")).toBeVisible();
});

test("instruments: list usage and delete an unused one", async () => {
  await nav("Accounts").click();
  await page.click("text=Manage instruments");
  await expect(page.getByRole("heading", { name: "Instruments" })).toBeVisible();
  const maple = page.locator(".list.instruments > li", { hasText: "MAPLE" });
  await expect(maple).toContainText("Used by");
  await expect(maple.getByRole("button", { name: "Delete" })).toHaveCount(0);

  await open("New instrument");
  await page.selectOption("select[name=inst_market]", "OTHER");
  await page.fill("input[name=inst_symbol]", "OLDART");
  await page.click("button:has-text('Create instrument')");
  const old = page.locator(".list.instruments > li", { hasText: "OLDART" });
  await expect(old).toContainText("Not used by any asset");
  await old.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".list.instruments > li", { hasText: "OLDART" })).toHaveCount(0);
});

test("real estate: value is houses minus mortgages", async () => {
  await nav("Accounts").click();
  await open("New account");
  await page.fill("input[name=name]", "Home");
  await page.selectOption("select[name=kind]", "real_estate");
  await page.click("button:has-text('Create account')");
  for (
    const [category, name, value] of [["property", "12 Main St", "950000"], [
      "mortgage",
      "TD mortgage",
      "512000",
    ]]
  ) {
    await open("Add a house or mortgage");
    const form = page.locator("form", { has: page.locator("select[name=category]") });
    await form.locator("select[name=category]").selectOption(category);
    await form.locator("input[name=name]").fill(name);
    await form.locator("input[name=value]").fill(value);
    await form.locator("button:has-text('Add')").click();
    await expect(page.locator(".re-list")).toContainText(name);
  }
  await expect(page.locator(".panel", { has: page.getByRole("heading", { name: "Value" }) }).locator(".big"))
    .toContainText("438,000.00");
});

test("settings: storage, communication log, and sign out", async () => {
  await nav("Settings").click();
  await expect(page.locator(".panel", { has: page.getByRole("heading", { name: "Storage" }) })).toContainText(
    "Data —",
  );
  await expect(page.getByRole("heading", { name: "Communication log" })).toBeVisible();
  await page.locator("nav.top .signout").click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.fill("input[name=passphrase]", PASS);
  await page.click("button[type=submit]");
  await expect(page.getByRole("heading", { name: "To do" })).toBeVisible();
});
