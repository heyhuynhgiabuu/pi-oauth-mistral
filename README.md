# pi-oauth-mistral

Pi extension: Mistral subscription sign-in through browser OAuth for Pi's built-in `mistral` provider.

This is a maintained fork of [5omeOtherGuy/pi-mistral-subscription](https://github.com/5omeOtherGuy/pi-mistral-subscription), pinned to Pi **1.5.0**.

## Why this fork exists

The upstream package is tested against Pi 1.4.0 and its shipped code has not changed since 2026-10-31, two days before Pi 1.5.0 was released. It does work on 1.5.0 (see [Verification](#verification)), but the owner wanted a copy they control, without waiting on upstream for a 1.5.0 baseline.

Fork base: [`v0.2.0-2-g8fb0d5c`](https://github.com/5omeOtherGuy/pi-mistral-subscription/commit/8fb0d5c) (`v0.2.0` plus two docs/lockfile commits).

## What differs from upstream

Small by design — the upstream logic was already correct.

- **Pi 1.5.0 baseline.** `peerDependencies` and dev dependencies are `1.5.0` instead of `>=0.99.0` / `1.4.0`.
- **Package rename.** `@heyhuynhgiabuu/pi-oauth-mistral`, version `1.0.0`. The extension path and provider ids are unchanged, so `/login` and `/model` behave exactly as before.
- **Stale comments corrected.** Upstream claimed Pi's catalog may lack `mistral-large-4`, `zai-glm-5-3` and `zai-glm-5-3-flash` until an online catalog arrives. Verified in 1.5.0: all three ship in the built-in catalog, and the `mistral` provider has no `fetchModels` hook, so no online catalog fetch happens for it.
- **One test fixture replaced.** Upstream asserted on `pixtral-large-latest`, which no longer exists in the 1.5.0 catalog. The assertion now uses `labs-leanstral-1-5-1`, a model that is present and still hidden by the overlay.

## What upstream got right, and this fork keeps

The overlay is smaller than it looks. Verified against the 1.5.0 catalog:

| Overlay entry                                                           | Still needed on 1.5.0?                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Hide `labs-leanstral-1-5-1`, `mistral-large-4-0-8`                      | **Yes** — both remain in the catalog                                                |
| Hide the other 6 entries                                                | No — already absent from the 1.5.0 catalog (kept for older hosts on the peer range) |
| `glm-5-2` / `zai-glm-5-2` / `deepseek-v4-1-flash-1017` reasoning levels | No — 1.5.0 already declares identical maps                                          |
| `deepseek-v4-1-flash-1017` image input                                  | **Yes** — 1.5.0 declares `["text"]`                                                 |
| **`mistral-large-4` output cap at 32,768**                              | **Yes, and this is the important one**                                              |

That last row is the real reason to run any version of this package. Pi 1.5.0 still declares a 262,144 output limit for `mistral-large-4`. Upstream reports one empty tool call burning 32,768 tokens, which would let a runaway turn cost eight times as much. Removing the package restores the 262k ceiling.

## Install

Requires Pi 1.5.0 or newer and Node.js 22.19.0 or newer.

```sh
pi install git:github.com/heyhuynhgiabuu/pi-oauth-mistral
```

Then `/login` → **Sign in with an account** → **Mistral**, and pick a model with `/model` or `--model`:

```sh
pi --model mistral/zai-glm-5-3 --thinking max
```

The footer shows `(sub)` while the sign-in is active.

## Billing: two separate pools, not one

Upstream's README says the plan "includes a monthly usage budget shared across Studio, the API and Vibe Code". **That is wrong**, at least on an Education plan. The Mistral Admin Panel shows two independent allowances:

| Allowance                | Covers                                        | Plan example |
| ------------------------ | --------------------------------------------- | ------------ |
| Included API usage       | Studio / API keys                             | $15 / month  |
| Included Vibe Code usage | Vibe Code, including this extension's sign-in | $150 / month |

Measured on an Education plan (Pro with student discount): a request through this extension's OAuth sign-in moved the **Vibe Code** allowance, not the API one. That is the whole economic argument for using this instead of a plain Studio API key — a coding agent exhausts the API pool quickly, while the Vibe Code pool is 10x larger.

Both pay-as-you-go toggles were off, so exhausting an allowance stops usage rather than producing a bill. Check your own Admin Panel before relying on any figure here.

## Security notes

- **No runtime dependencies.** Every `@earendil-works/*` import is `import type`, erased at load. Only `node:util` and `node:crypto` are used. An install leaves `node_modules` empty.
- **No install scripts.** `package.json` declares no lifecycle scripts. This matters because `pi install` runs `npm install` **without** `--ignore-scripts`, and `pi update --extensions` does a `git reset --hard` plus reinstall.
- **Three hosts, all Mistral.** `console.mistral.ai` for the sign-in, `api.mistral.ai` for inference. PKCE is S256 with 64 random bytes; `code_verifier` goes only to `console.mistral.ai`. Both `sign_in_url` and `poll_url` are validated against their expected origins before use.
- **The flow mirrors Mistral's own CLI.** Verified against `mistralai/mistral-vibe` → `vibe/setup/auth/http_browser_sign_in_gateway.py`: same `/vibe/sign-in` path, same payload, same poll states, same `/exchange` call. It is an internal endpoint of the Vibe CLI, not a published API contract.

Treat that last point as the standing risk: the endpoint can change without notice, and Mistral's consumer terms exclude "Mistral AI Studio and access to any of our APIs". Using the subscription through Vibe Code usage is the reading that fits what the plan sells; that is an argument, not a guarantee.

## Verification

Run on Pi 1.5.0 with Node 26.13.0:

```sh
npm ci --ignore-scripts
npm run check   # lint, tests, typecheck, secret scan, pack check
```

Typecheck passes with zero errors. Two upstream tests asserted on models that no longer exist in the 1.5.0 catalog; one was replaced, the other only asserts a model the overlay hides.

No test contacts Mistral or uses real credentials. The OAuth tests inject a fake `fetch`; streaming tests use a loopback HTTP server.

## Migrating from upstream

The provider ids are unchanged, so a stored sign-in keeps working. To switch:

1. `pi remove` the upstream package (or remove it from `packages` in settings).
2. `pi install git:github.com/heyhuynhgiabuu/pi-oauth-mistral`.
3. No `/login` needed — the `mistral` credential in `auth.json` is reused.

Run `/logout` **before** removing the upstream package if you also intend to stop using this fork; without any extension, Pi cannot use a stored OAuth sign-in for `mistral` and leaves the provider unavailable.

## Licence

MIT. Original work Copyright (c) 2026 5omeOtherGuy; modifications Copyright (c) 2026 huynhgiabuu.
