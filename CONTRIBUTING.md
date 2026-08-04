# Contributing

Thank you for helping improve A MOVE AGO. Keep each change focused: one
coherent purpose, the smallest practical diff, relevant tests, and a commit
message that explains the intent. Do not mix formatting, dependency updates,
content, and behavior unless the change genuinely requires them together.

## Set up

Use Node.js 24.x and npm 11 or newer, then install the locked dependency graph:

```sh
npm ci
```

Do not hand-edit generated dependency state or commit build output.

## Complete local gate

Run the same boundaries expected by the pull-request gate:

```sh
npm run check
npm run typecheck
npm test
npm run content:validate
npm run build -w @a-move-ago/api
VITE_API_BASE_URL=https://api.test npm run build:pages -w @a-move-ago/client
VITE_API_BASE_URL=https://api.test VITE_ANDROID_ALLOW_DEBUG_SCHEME=true npm run build:android:web -w @a-move-ago/client
npm run verify:artifacts -w @a-move-ago/client
npx playwright install --with-deps chromium
npm run e2e -w @a-move-ago/client
git diff --check
```

Use narrower package tests while developing, but do not substitute them for
the complete gate before requesting review. If Java 21 or the Android SDK is
required by a checked-in native Android task, report any local environment
limitation and rely on the designated Android CI gate; do not claim a native
build that was not run.

## Code contributions

Code contributions are accepted under AGPL-3.0, the same license as the
repository source. By contributing, you confirm that you have the right to
license the contribution on those terms.

- Preserve the guest-first, optional-Telegram product boundary.
- Keep platform APIs behind `packages/platform`.
- Keep private solutions and evaluation on the server.
- Add or update tests for behavior changes.
- Avoid new dependencies unless their license, maintenance, and security
  tradeoffs are justified.

## Content contributions

Public content contributions belong only in `content/samples/**` and are
licensed under that directory's CC BY 4.0 notice. Every puzzle must retain
non-empty `provenance` and `license` fields and pass
`npm run content:validate`.

Do not submit a puzzle copied from a game collection, book, database, website,
or another author unless its license permits redistribution and the
provenance/license record is explicit. Production puzzles and the private
production corpus are not accepted in this public repository.

## Never commit

- production puzzles or other private puzzle sources;
- Telegram bot tokens, OIDC secrets, session peppers, Cloudflare tokens, or
  populated `.dev.vars`/`.env` files;
- Android keystores, signing material, APKs, or app bundles;
- personal data, real Telegram proof, session tokens, OIDC tokens, or handoff
  codes;
- `node_modules`, `dist`, coverage, Playwright reports, or other generated
  artifacts.

Before committing, inspect both tracked and untracked files. Sanitized test
fixtures must be synthetic and must not reuse production credentials or
personal data.

## Security reports and brand use

Do not disclose suspected vulnerabilities in a public issue or pull request.
Follow the private process in [SECURITY.md](SECURITY.md).

The code license does not grant permission to use the A MOVE AGO name, logo,
or visual identity. See [NOTICE.md](NOTICE.md).
