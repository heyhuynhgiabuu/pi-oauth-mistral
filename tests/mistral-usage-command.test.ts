import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import mistralSubscriptionExtension from "../extensions/mistral-subscription/index.ts";

const KEY = ["placeholder", "command", "key"].join("-");

type Notify = { message: string; level: string };

// Captures the /mistral-usage handler and stubs the two things it reaches for:
// the credential lookup and the global fetch the usage module falls back to.
function harness(apiKey: string | undefined) {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  mistralSubscriptionExtension({
    registerProvider: () => {},
    registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, definition.handler),
    on: () => {},
    getThinkingLevel: () => "high",
    setThinkingLevel: () => {},
    setModel: async () => true,
  } as unknown as ExtensionAPI);

  const handler = commands.get("mistral-usage");
  assert.ok(handler, "/mistral-usage is registered");

  return async (): Promise<Notify[]> => {
    const notifications: Notify[] = [];
    const ctx = {
      ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
      modelRegistry: { getApiKeyForProvider: async () => apiKey },
    };
    await handler("", ctx);
    return notifications;
  };
}

function stubFetch(handler: () => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => handler()) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("warns without calling the API when no Mistral credential is stored", async () => {
  const restore = stubFetch(async () => {
    throw new Error("the API must not be called without a credential");
  });
  try {
    const notifications = await harness(undefined)();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /No Mistral credential/);
  } finally {
    restore();
  }
});

test("reports the summary at info level when the lookup succeeds", async () => {
  const restore = stubFetch(async (): Promise<Response> =>
    Response.json({
      vibe_budget: { initial_budget: 150, usage_percentage: 0.85, payg_enabled: false },
      api_budget: { initial_budget: 15, usage_percentage: 0.5, payg_enabled: false },
    }),
  );
  try {
    const notifications = await harness(KEY)();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "info");
    assert.match(notifications[0]?.message ?? "", /Vibe Code: \$1\.28 of \$150\.00/);
  } finally {
    restore();
  }
});

// A usage lookup is decoration: it must never take the session down with it.
test("turns a failed lookup into a warning instead of throwing", async () => {
  const restore = stubFetch(async () => new Response("", { status: 500 }));
  try {
    const notifications = await harness(KEY)();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.level, "warning");
    assert.match(notifications[0]?.message ?? "", /HTTP 500/);
  } finally {
    restore();
  }
});
