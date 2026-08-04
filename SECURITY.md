# Security policy

## Supported version

Security fixes are made against the current `main` branch.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Other branches, forks, and old snapshots | No |

## Report a vulnerability privately

Use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** tab.
2. Open **Advisories**.
3. Choose **Report a vulnerability** and create a private draft advisory.

Do not open a public issue, discussion, or pull request. Include the affected
commit or endpoint, impact, required conditions, and minimal reproduction
steps. Use synthetic data, redact tokens and personal information, and do not
include production puzzle solutions beyond what is necessary to identify the
affected boundary.

Maintainers will coordinate disclosure with the reporter. The target is
disclosure within 90 days of the private report, or earlier after a fix is
available. Complex remediation or an actively exploited issue may require a
different coordinated date; do not publish before that date without first
attempting private coordination.

## System and trust boundaries

The public Web, Telegram, and Android clients are untrusted callers of the
Cloudflare Worker. The Worker verifies authentication and evaluates attempts;
D1 stores session state, progress, Telegram profile fields, and private puzzle
solutions. Telegram Mini App proof and Telegram OIDC cross an external identity
provider boundary. The content import CLI is a privileged path from private
source material to D1.

The following are security invariants:

- A client receives only the public daily projection before a correct attempt.
  Accepted solutions, previous positions, private constraints, and the
  production corpus must not be embedded in client artifacts.
- App sessions use random opaque bearer tokens. D1 stores only token hashes
  made with a server-side pepper; tokens and peppers must not be logged.
- Android Capacitor Preferences is app-sandboxed persistent storage, not
  guaranteed encrypted or hardware-backed storage. Device or backup compromise
  can expose a bearer token until its server-side expiry or revocation.
- A Telegram identity is trusted only after server-side Mini App proof or OIDC
  verification. Host objects and client claims are not identity proof.
- OIDC state and handoff codes are guest-bound, short-lived, one-time values.
- Raw Telegram proof, OIDC tokens, handoff codes, secrets, personal payloads,
  and private puzzle solutions must not enter logs or public build artifacts.
- Mutation authorization depends on the active session and server-side actor
  checks. CORS, origin checks, and rate limits are defense-in-depth, not
  substitutes for authorization.
- D1 access remains parameterized and cross-session progress, attempts, hints,
  and profile data remain isolated.

## Sensitive data

Treat at least the following as sensitive even when short-lived:

- guest and Telegram app session tokens;
- raw Telegram Mini App proof, including `initData`;
- Telegram OIDC authorization codes, ID/access/refresh tokens, client secret,
  state, nonce, and PKCE verifier;
- auth handoff codes;
- session pepper, bot token, Cloudflare credentials, and Android signing
  material;
- private puzzle solutions, accepted retractions, previous FEN values, private
  constraints, unpublished hints, and the production puzzle corpus;
- Telegram identifiers and optional profile fields, attempts, and progress.

Hashes of tokens or one-time codes are still security-sensitive and should not
be exposed.

## Reportable security issues

Private reports are appropriate for realistic issues such as:

- authentication or account-linking bypass;
- replay, fixation, theft, or cross-channel exchange of a session or handoff;
- cross-session or cross-profile access to progress, attempts, or hints;
- exposure of credentials, personal data, private puzzle content, or accepted
  solutions before the intended reveal;
- injection, origin/redirect bypass, signature or OIDC verification flaws;
- a build, log, error response, or import path that crosses the boundaries
  above;
- a dependency flaw that is exploitable in the supported `main` branch.

Public sample solutions in `content/samples/**`, synthetic test fixtures,
expected guest-progress loss after local storage is cleared, and findings that
apply only to modified forks or unsupported snapshots are not vulnerabilities
in the supported service. General hardening suggestions without a concrete
security impact may be filed as ordinary issues only when doing so would not
reveal a weakness that needs coordinated remediation.

There is currently no bug-bounty promise. Please avoid privacy invasion,
service disruption, destructive testing, accessing another person's data, or
testing against production content.
