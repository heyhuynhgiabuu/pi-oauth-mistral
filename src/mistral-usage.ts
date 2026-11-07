import { isRecord } from "./type-guards.ts";

// Measured against the live API on 2026-11-06: the OAuth sign-in key is accepted
// as a bearer token here, while /v1/admin/* rejects it and needs an admin key.
export const BILLING_BASE_URL = "https://api.mistral.ai";

const BUDGET_PATH = "/v1/billing/budget";
const SUBSCRIPTION_PATH = "/v1/billing/subscription";
const REQUEST_TIMEOUT_MS = 10_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type MistralUsageDependencies = {
  fetch?: FetchLike;
};

/** One allowance as the API reports it: a percentage of a budget. */
export type Budget = {
  initialBudget: number;
  /** Percent of the allowance consumed, 0-100. */
  usagePercentage: number;
  currency?: string;
  resetAt?: string;
  paygEnabled: boolean;
};

export type Subscription = {
  planName?: string;
  vibePaygEnabled: boolean;
};

export type MistralUsage = {
  planName?: string;
  vibe: Budget;
  api: Budget;
};

const USAGE_MESSAGE = "Could not read Mistral usage";

function numberField(record: Record<string, unknown>, field: string, message: string): number {
  const value = record[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${message} had no valid ${field}`);
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolField(record: Record<string, unknown>, field: string): boolean {
  return record[field] === true;
}

function parseBudget(value: unknown, label: string): Budget {
  if (!isRecord(value)) throw new Error(`${USAGE_MESSAGE}: response had no ${label} budget`);
  const message = `Mistral usage: ${label} budget`;
  return {
    initialBudget: numberField(value, "initial_budget", message),
    usagePercentage: numberField(value, "usage_percentage", message),
    currency: optionalString(value, "currency"),
    resetAt: optionalString(value, "reset_at"),
    paygEnabled: boolField(value, "payg_enabled"),
  };
}

async function getJson(fetch: FetchLike, path: string, apiKey: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${BILLING_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // A bare "fetch failed" tells the user nothing actionable.
    throw new Error(`${USAGE_MESSAGE}: could not reach ${BILLING_BASE_URL}`, { cause: error });
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? " Run /login to sign in again." : "";
    throw new Error(`${USAGE_MESSAGE} (HTTP ${response.status} on ${path}).${hint}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${USAGE_MESSAGE} response was malformed`, { cause: error });
  }
}

/** Amount consumed so far this period, in the budget's currency. */
export function spent(budget: Budget): number {
  return (budget.initialBudget * budget.usagePercentage) / 100;
}

/** Amount left this period; never negative. */
export function remaining(budget: Budget): number {
  return Math.max(0, budget.initialBudget - spent(budget));
}
export function formatAmount(budget: Budget, amount: number): string {
  const currency = budget.currency ?? "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    // An unexpected currency code must not hide the number.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * Reads both allowances. The budget endpoint also returns a top-level copy of
 * the API allowance, which silently reports the wrong budget if used for the
 * Vibe allowance, so only the nested objects are read here.
 */
export async function fetchMistralUsage(apiKey: string, dependencies: MistralUsageDependencies = {}) {
  const fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const [budgetPayload, subscriptionPayload] = await Promise.all([
    getJson(fetch, BUDGET_PATH, apiKey),
    // A plan name is decoration: without it the numbers are still correct.
    getJson(fetch, SUBSCRIPTION_PATH, apiKey).catch(() => undefined),
  ]);

  if (!isRecord(budgetPayload)) throw new Error(`${USAGE_MESSAGE} response was malformed`);
  const subscription = isRecord(subscriptionPayload) ? parseSubscription(subscriptionPayload) : undefined;

  return {
    planName: subscription?.planName,
    vibe: parseBudget(budgetPayload.vibe_budget, "Vibe"),
    api: parseBudget(budgetPayload.api_budget, "API"),
  } satisfies MistralUsage;
}

function parseSubscription(payload: Record<string, unknown>): Subscription {
  return {
    planName: optionalString(payload, "plan_name"),
    vibePaygEnabled: boolField(payload, "vibe_payg_enabled"),
  };
}

function resetDay(budget: Budget): string {
  if (!budget.resetAt) return "";
  // Keep the calendar day the API reported: converting to UTC can shift it.
  const day = /^\d{4}-\d{2}-\d{2}/.exec(budget.resetAt)?.[0];
  if (day) return `, resets ${day}`;
  const date = new Date(budget.resetAt);
  return Number.isNaN(date.getTime()) ? "" : `, resets ${date.toISOString().slice(0, 10)}`;
}

export function describeUsage(usage: MistralUsage): string {
  const line = (label: string, budget: Budget) =>
    `${label} ${formatAmount(budget, spent(budget))} of ${formatAmount(budget, budget.initialBudget)}` +
    ` (${budget.usagePercentage.toFixed(1)}% used)${resetDay(budget)}`;

  const plan = usage.planName ? `Mistral ${usage.planName} plan. ` : "";
  const payg = usage.vibe.paygEnabled || usage.api.paygEnabled ? " Pay-as-you-go is on." : "";
  return `${plan}${line("Vibe Code:", usage.vibe)}. ${line("API:", usage.api)}.${payg}`;
}
