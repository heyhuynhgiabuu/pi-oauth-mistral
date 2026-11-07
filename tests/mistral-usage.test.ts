import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type FetchLike,
  describeUsage,
  fetchMistralUsage,
  formatAmount,
  remaining,
  spent,
} from "../src/mistral-usage.ts";

const KEY = ["placeholder", "usage", "key"].join("-");

// Shape measured against the live API on 2026-11-06, including the top-level
// copy of the API budget that the response carries but the spec does not list.
const BUDGET = {
  vibe_budget: {
    usage_percentage: 0.828815696,
    initial_budget: 150,
    currency: "USD",
    reset_at: "2026-12-01T00:00:00Z",
    payg_enabled: false,
  },
  api_budget: {
    usage_percentage: 0.5006672266666666,
    initial_budget: 15,
    currency: "USD",
    reset_at: "2026-12-01T00:00:00Z",
    payg_enabled: false,
  },
  usage_percentage: 0.5006672266666666,
  initial_budget: 15,
  currency: "USD",
  reset_at: "2026-12-01T00:00:00Z",
};

const SUBSCRIPTION = { plan_name: "EDU", payg_enabled: false, vibe_payg_enabled: false, enterprise: false };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeFetch(
  options: { budget?: unknown; subscription?: unknown; budgetStatus?: number; requests?: string[] } = {},
): FetchLike {
  return async (url, init) => {
    options.requests?.push(url);
    // Name the header explicitly: reading whichever key happens to come first
    // would pass even if the key were sent as something other than Authorization.
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${KEY}`);
    if (url.endsWith("/v1/billing/budget")) {
      return jsonResponse(options.budget ?? BUDGET, options.budgetStatus ?? 200);
    }
    if (url.endsWith("/v1/billing/subscription")) {
      return jsonResponse(options.subscription ?? SUBSCRIPTION);
    }
    throw new Error(`unexpected url ${url}`);
  };
}

describe("Mistral usage", () => {
  it("reads both allowances and the plan name", async () => {
    const usage = await fetchMistralUsage(KEY, { fetch: fakeFetch() });
    assert.equal(usage.planName, "EDU");
    assert.equal(usage.vibe.initialBudget, 150);
    assert.equal(usage.api.initialBudget, 15);
    assert.equal(usage.vibe.paygEnabled, false);
  });

  // Regression: the response repeats the API budget at the top level. Reading
  // that for the Vibe figure reports "$150" as if it were "$15".
  it("does not confuse the top-level budget copy with the Vibe allowance", async () => {
    const usage = await fetchMistralUsage(KEY, { fetch: fakeFetch() });
    assert.equal(usage.vibe.initialBudget, 150);
  });

  it("keeps the numbers when the plan lookup fails", async () => {
    const fetch: FetchLike = async (url, init) =>
      url.endsWith("/v1/billing/subscription") ? jsonResponse({ detail: "nope" }, 403) : fakeFetch()(url, init);
    const usage = await fetchMistralUsage(KEY, { fetch });
    assert.equal(usage.planName, undefined);
    assert.equal(usage.vibe.initialBudget, 150);
  });

  it("reports the HTTP status when the budget read fails", async () => {
    await assert.rejects(
      fetchMistralUsage(KEY, { fetch: fakeFetch({ budgetStatus: 401 }) }),
      /HTTP 401 on \/v1\/billing\/budget/,
    );
  });

  it("rejects a response without the nested budgets", async () => {
    await assert.rejects(
      fetchMistralUsage(KEY, { fetch: fakeFetch({ budget: { usage_percentage: 1 } }) }),
      /had no Vibe budget/,
    );
  });

  it("converts the percentage into spent and remaining amounts", async () => {
    const usage = await fetchMistralUsage(KEY, { fetch: fakeFetch() });
    assert.ok(Math.abs(spent(usage.api) - 0.0751) < 0.001);
    assert.ok(Math.abs(remaining(usage.api) - 14.9249) < 0.001);
  });

  it("never reports a negative remainder", () => {
    assert.equal(remaining({ initialBudget: 10, usagePercentage: 140, paygEnabled: false }), 0);
  });

  it("formats an amount in the budget currency, falling back on a malformed code", () => {
    assert.equal(formatAmount({ initialBudget: 15, usagePercentage: 0, paygEnabled: false }, 14.92), "$14.92");
    // Intl throws for a code that is not well-formed, which must not hide the number.
    assert.equal(
      formatAmount({ initialBudget: 15, usagePercentage: 0, currency: "EURO", paygEnabled: false }, 1.5),
      "1.50 EURO",
    );
  });

  it("checks both URLs and sends the key as a bearer token", async () => {
    const requests: string[] = [];
    await fetchMistralUsage(KEY, { fetch: fakeFetch({ requests }) });
    assert.deepEqual(requests.sort(), [
      "https://api.mistral.ai/v1/billing/budget",
      "https://api.mistral.ai/v1/billing/subscription",
    ]);
  });

  it("reports a reachable-API failure instead of a bare fetch error", async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await assert.rejects(fetchMistralUsage(KEY, { fetch }), /could not reach https:\/\/api\.mistral\.ai/);
  });

  it("points at /login when the key is rejected", async () => {
    await assert.rejects(fetchMistralUsage(KEY, { fetch: fakeFetch({ budgetStatus: 401 }) }), /Run \/login/);
  });

  it("rejects a body that is not JSON", async () => {
    const fetch: FetchLike = async () => new Response("<html>nope</html>", { status: 200 });
    await assert.rejects(fetchMistralUsage(KEY, { fetch }), /response was malformed/);
  });

  it("rejects a response without the API budget", async () => {
    const budget = { vibe_budget: (BUDGET as Record<string, unknown>).vibe_budget };
    await assert.rejects(fetchMistralUsage(KEY, { fetch: fakeFetch({ budget }) }), /had no API budget/);
  });

  it("keeps the reported calendar day when reset_at carries an offset", async () => {
    const budget = {
      vibe_budget: {
        initial_budget: 150,
        usage_percentage: 1,
        reset_at: "2026-12-01T00:00:00+02:00",
        payg_enabled: false,
      },
      api_budget: {
        initial_budget: 15,
        usage_percentage: 1,
        reset_at: "2026-12-01T00:00:00+02:00",
        payg_enabled: false,
      },
    };
    const text = describeUsage(await fetchMistralUsage(KEY, { fetch: fakeFetch({ budget }) }));
    assert.match(text, /resets 2026-12-01/);
    assert.doesNotMatch(text, /2026-11-30/);
  });

  it("mentions pay-as-you-go when it is on", async () => {
    const budget = {
      vibe_budget: { initial_budget: 150, usage_percentage: 0, payg_enabled: true },
      api_budget: { initial_budget: 15, usage_percentage: 0, payg_enabled: false },
    };
    const text = describeUsage(await fetchMistralUsage(KEY, { fetch: fakeFetch({ budget }) }));
    assert.match(text, /Pay-as-you-go is on\./);
  });

  it("omits the reset day when reset_at is absent", async () => {
    const budget = {
      vibe_budget: { initial_budget: 150, usage_percentage: 0, payg_enabled: false },
      api_budget: { initial_budget: 15, usage_percentage: 0, payg_enabled: false },
    };
    const text = describeUsage(await fetchMistralUsage(KEY, { fetch: fakeFetch({ budget }) }));
    assert.doesNotMatch(text, /resets/);
  });

  it("describes both allowances with the reset day", async () => {
    const text = describeUsage(await fetchMistralUsage(KEY, { fetch: fakeFetch() }));
    assert.match(text, /Mistral EDU plan/);
    assert.match(text, /Vibe Code: \$1\.24 of \$150\.00/);
    assert.match(text, /API: \$0\.08 of \$15\.00/);
    assert.match(text, /resets 2026-12-01/);
    assert.doesNotMatch(text, /Pay-as-you-go/);
  });
});
