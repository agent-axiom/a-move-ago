# A MOVE AGO

A MOVE AGO is a daily retro-chess game. The player sees the board after an
unknown move and reconstructs the immediately preceding position. This
repository contains the TypeScript MVP, public sample puzzles, and delivery
plans; it does not contain the production puzzle corpus.

## Product loop

1. Start with an opaque guest session.
2. Load the daily case and inspect the position after the unknown move.
3. Move the last piece back and, when needed, restore a captured piece or a
   special move.
4. Submit the reconstruction to the Worker. The client never receives accepted
   solutions before a correct attempt.
5. Use ordered hints, review the reveal, and update the streak.
6. Optionally save and synchronize progress through Telegram.

Open **Archive** to browse published cases by month and see your completion
progress. Historical cases have a shareable `?case=YYYY-MM-DD` URL; **Back to
today** returns to the current UTC daily case. Future cases remain hidden.

Telegram authentication is optional. Merely opening the app in Telegram does
not create a profile.

## Architecture

The approved
[MVP architecture and system diagram](docs/superpowers/specs/2026-08-03-a-move-ago-mvp-design.md)
defines the trust and deployment boundaries.

- `apps/client`: one React/Vite UI for GitHub Pages, Telegram Mini Apps, and
  Capacitor web assets.
- `apps/api`: a Hono Cloudflare Worker backed by D1.
- `packages/game-core`: deterministic retro-chess domain logic.
- `packages/api-contract`: Zod schemas and the typed HTTP client.
- `packages/platform`: Web, Telegram, and Android host adapters.
- `tools`: content validation and draft-first D1 import tooling.
- `content/samples`: public, non-production examples only.

## Prerequisites

- Node.js 24.x (`package.json` requires `>=24 <25`)
- npm 11 or newer

Wrangler, Vite, Vitest, Biome, and Playwright are installed as workspace
dependencies. A native Android build additionally requires Java 21 and the
Android SDK.

## Install

From the repository root:

```sh
npm ci
```

## Run the Worker and local D1

Non-secret development defaults and the local D1 binding live in
`apps/api/wrangler.jsonc`. Put local secrets in
`apps/api/.dev.vars`, which is ignored by Git:

```dotenv
SESSION_PEPPER=replace-with-a-long-random-local-value
TELEGRAM_BOT_TOKEN=replace-with-a-local-test-value
TELEGRAM_OIDC_CLIENT_SECRET=replace-with-a-local-test-value
```

Never commit real Telegram or Cloudflare credentials. Seed today's local daily
case from the public example, then start the Worker:

```sh
npm run dev:seed
npm run dev -w @a-move-ago/api
```

Wrangler serves the Worker on `http://localhost:8787` by default. The health
check is `GET /v1/healthz`.

`dev:seed` applies local migrations and publishes a clearly marked
**Development sample** for today's UTC date. It uses only local D1, accepts no
arguments, and preserves existing local data. Run it again on a new day. It
does not create or import production puzzles.

## Run the client

In another terminal:

```sh
VITE_API_BASE_URL=http://localhost:8787 npm run dev -w @a-move-ago/client
```

Use the `http://localhost:5173` URL emitted by Vite so it matches the
development origin allowlist.

## Local checks

Run the repository checks independently so the failing boundary is visible:

```sh
npm run check
npm run typecheck
npm test
npm run content:validate
npm run build -w @a-move-ago/api
```

The full pull-request gate, including both client artifacts and Playwright, is
listed in [CONTRIBUTING.md](CONTRIBUTING.md).

CI also seeds local D1 and runs a real Worker/browser game through a correct
retraction, the solution reveal, statistics and a reload. These checks complement
the mocked API tests for network failures and Telegram host behavior.

## Pages and Android web builds

```sh
VITE_API_BASE_URL=https://api.test npm run build:pages -w @a-move-ago/client
VITE_API_BASE_URL=https://api.test VITE_ANDROID_ALLOW_DEBUG_SCHEME=true npm run build:android:web -w @a-move-ago/client
npm run verify:artifacts -w @a-move-ago/client
```

The outputs are `apps/client/dist/pages` and
`apps/client/dist/android`. The latter is a Capacitor-ready web asset, not a
signed APK or app bundle. The debug-scheme flag is only for a debug artifact
and must not be enabled in a release build.

To copy the Android web artifact and registered native plugins into the
checked-in Capacitor project, then run the native Java 21 gate:

```sh
npm run cap:sync:android -w @a-move-ago/client
npm run android:test -w @a-move-ago/client
```

The native gate runs unit tests, lint, debug APK/AAB compilation, and verifies
that the debug callback scheme is absent from the release manifest. Set the
Gradle property `A_MOVE_AGO_APP_LINK_HOST` to the API hostname for a deployable
App Link; an unset property deliberately uses a non-production `.invalid`
host.

## Guest-first Telegram authentication

Every Web, Telegram, and Android client begins as a guest. The server stores
only a hash of the opaque bearer token; the client stores the token locally.
Guest progress is stored server-side but remains bound to the opaque token
stored on that device. Clearing local app data can therefore make the progress
inaccessible.

A Telegram profile is created only after the player explicitly chooses to save
progress. Telegram Mini Apps then submit raw `initData` for server-side
verification. Web and Android use Telegram OpenID Connect with PKCE. Both
paths rotate the guest session and attach server-recorded guest attempts to the
verified Telegram profile. The requested OIDC scopes are only
`openid profile`; phone and bot-access scopes are not requested.

See [PRIVACY.md](PRIVACY.md) for stored fields and retention and
[SECURITY.md](SECURITY.md) for the security boundary and private reporting.

## Delete a Telegram profile

A player with a linked Telegram profile can open **Progress**, choose **Delete
Telegram profile**, review the permanent-deletion warning, and choose **Delete
permanently**. A confirmed deletion removes the A MOVE AGO Telegram profile,
saved attempts, hint history, and derived statistics on every device. It does
not delete the player's Telegram account and cannot be undone.

The authenticated API operation is `DELETE /v1/me`. It has no request body and
returns `{"kind":"guest","profile":null}` with `Cache-Control: no-store`.
After the Worker confirms deletion, the current app continues as an empty guest
with the same opaque session token; other sessions linked to the deleted
profile stop working. An unconfirmed response is never shown as success. An
interrupted transport response or invalid success payload can be
retried with the same token while that session remains active. A `401
INVALID_SESSION` is not deletion proof: reload the app to bootstrap an
available guest session, then explicitly choose **Save progress with Telegram**
to verify the profile.

A later explicit **Save progress with Telegram** creates a new profile. Deleted
profile progress is not restored, although progress accumulated independently
after deletion can be linked normally.

## Configuration

The checked-in values are development defaults or explicit deployment
sentinels. Replace deployment-specific IDs, origins, callbacks, and
fingerprints before a production deployment.

| Name | Scope | Secret | Purpose |
| --- | --- | --- | --- |
| `DB` | Worker | No | D1 binding configured in `apps/api/wrangler.jsonc`. |
| `ENVIRONMENT` | Worker | No | Runtime environment label. |
| `ALLOWED_ORIGINS` | Worker | No | Exact comma-separated browser-origin allowlist. |
| `SESSION_TTL_SECONDS` | Worker | No | Session lifetime; the checked-in baseline is 90 days. |
| `SESSION_PEPPER` | Worker | Yes | Server-side pepper for opaque-token hashes. |
| `TELEGRAM_BOT_TOKEN` | Worker | Yes | Verifies Telegram Mini App proof. |
| `TELEGRAM_OIDC_CLIENT_ID` | Worker | No | Telegram OIDC client identifier. |
| `TELEGRAM_OIDC_CLIENT_SECRET` | Worker | Yes | Telegram OIDC code exchange secret. |
| `TELEGRAM_OIDC_CALLBACK_URL` | Worker | No | Exact registered HTTPS OIDC callback. |
| `API_ORIGIN` | Worker | No | Canonical Worker origin used to validate auth URLs. |
| `WEB_AUTH_RETURN_URL` | Worker | No | Fixed Pages return URL after OIDC. |
| `ANDROID_AUTH_RETURN_URL` | Worker | No | Fixed Android auth-return URL. |
| `ANDROID_PACKAGE_NAME` | Worker | No | Package published in Digital Asset Links. |
| `ANDROID_SHA256_CERT_FINGERPRINTS` | Worker | No | Comma-separated release signing fingerprints; empty fails closed. |
| `TELEGRAM_INIT_DATA_MAX_AGE_SECONDS` | Worker | No | Maximum accepted Mini App proof age. |
| `TELEGRAM_INIT_DATA_FUTURE_SKEW_SECONDS` | Worker | No | Allowed proof clock skew. |
| `OIDC_FLOW_TTL_SECONDS` | Worker | No | OIDC state lifetime. |
| `HANDOFF_TTL_SECONDS` | Worker | No | One-time handoff-code lifetime. |
| `GUEST_RATE_LIMITER` | Worker | No | Guest-session rate-limit binding. |
| `ATTEMPT_RATE_LIMITER` | Worker | No | Attempt rate-limit binding. |
| `HINT_RATE_LIMITER` | Worker | No | Hint rate-limit binding. |
| `AUTH_RATE_LIMITER` | Worker | No | Telegram-auth rate-limit binding. |
| `VITE_API_BASE_URL` | Client | No | Required bare API origin baked into each client artifact. |
| `VITE_ANDROID_ALLOW_DEBUG_SCHEME` | Client | No | Enables the debug callback scheme only when exactly `true`. |
| `CLOUDFLARE_API_TOKEN` | Import CLI | Yes | Scoped token for `content:import --publish`. |
| `CLOUDFLARE_ACCOUNT_ID` | Import CLI | No | Cloudflare account containing the target D1 database. |
| `D1_DATABASE_ID` | Import CLI | No | Target D1 database for a production content import. |

Cloudflare secrets belong in Wrangler/GitHub secret storage; local Worker
secrets belong in ignored `.dev.vars`. Client variables are public build
configuration and must never contain secrets.

## Production release gate

The August 23, 2026 release deployed the Worker and Pages and
passed CI and the Android debug build. That establishes a deployed MVP, not
completion of the public-launch checks below. The private production puzzle
corpus and current remote D1 content must be verified separately.

On October 15, 2026, the protected private-content workflow published 30 original
English daily cases covering October 15 through November 13. Renew this coverage
before it expires using the process in [ops/README.md](ops/README.md).

After deploying, check the real guest flow, browser CORS configuration and
today's published content:

```sh
npm run deployment:check -- --api-origin https://a-move-ago-api.if-ab6.workers.dev --web-origin https://agent-axiom.github.io
```

This dependency-free Node 24 check creates one empty guest session, reads its
identity and statistics, and loads today's daily case from D1. It does not
submit attempts, send Telegram proof, or print tokens or puzzle payloads. Each
request has a ten-second timeout and redirects are rejected. A successful
`/v1/healthz` alone does not establish that daily gameplay is available.

The API workflow deploys from `main` through an explicit manual run or a reviewed
change to `ops/api-release.json`. It uses the protected `production` environment
and runs this check after deployment. The **Deployment health**
workflow runs it daily at 00:31 UTC using the repository `API_ORIGIN` variable;
it can also be run manually. If the web deployment changes origin, update its
fixed origin in both workflows and `WEB_AUTH_RETURN_URL` in the config template.
Production config derives its browser origin from that return URL, retains
the Capacitor origin, and removes the Vite development origin.

The protected API workflow separately checks one synthetic guest solve, a replay
of the same attempt UUID, reloaded progress, and unchanged statistics. It reads
only today's first private solution from D1 in runner memory and prints no
answers or tokens. Pages delivery checks the published HTML against that build
and verifies its application bundle is available.

On relevant pull requests from this repository, the health workflow also
checks the currently deployed version. That check is advisory on pull
requests, so an existing content outage does not block a fix; the local
Worker/browser integration still verifies the proposed code independently.

Before launch, verify that the private D1 corpus has today's case and at least
the next seven UTC dates published, with validated solutions and recorded
provenance/licenses. The local development sample is not a production corpus.
The daily check detects missing current content; it does not inspect unpublished
future solutions or replace this operator check.

Before opening the public Pages version, the operator must verify all of these
against the deployed Worker and production D1:

- Cloudflare bindings, Telegram configuration, exact origins, callbacks, and
  current daily content are production-ready.
- A synthetic Telegram account has attempt and hint history from at least two
  linked sessions.
- The deployed UI completes both deletion steps and returns the current client
  to guest without changing its opaque token.
- Reloaded guest statistics contain none of the deleted profile history, daily
  gameplay still works, and the other linked session no longer reaches the old
  profile.
- Response and application logs for the deletion request ID contain no bearer
  token, Telegram fields, request body, SQL details, or deleted-row counts.
- Actual platform-log and backup retention is configured and disclosed, and a
  restore drill does not reintroduce deleted profile rows into active D1.
- GitHub Private Vulnerability Reporting and the private process documented in
  `SECURITY.md` are available.

## Implementation references

1. [Foundation and game core](docs/superpowers/plans/2026-08-03-a-move-ago-01-foundation-game-core.md)
2. [Gameplay API](docs/superpowers/plans/2026-08-03-a-move-ago-02-api-gameplay.md)
3. [Telegram authentication](docs/superpowers/plans/2026-08-03-a-move-ago-03-telegram-auth.md)
4. [Client](docs/superpowers/plans/2026-08-03-a-move-ago-04-client.md)
5. [Android and delivery](docs/superpowers/plans/2026-08-03-a-move-ago-05-android-delivery.md)

## Licensing and boundaries

Source code is AGPL-3.0. Only `content/samples/**` is CC BY 4.0.
Production puzzles are private and are not included. The A MOVE AGO name,
logo, and visual identity are outside the software and sample-content license
grants. See [NOTICE.md](NOTICE.md) for the exact boundary.
