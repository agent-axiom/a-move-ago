# Privacy notice

## Status and scope

A MOVE AGO is currently a pre-public-launch MVP. This notice describes the
data boundaries implemented by the Web, Telegram Mini App, Android adapter,
Cloudflare Worker, and D1 schema in this repository. Deployment operators must
replace placeholder configuration and complete the profile-deletion path
described below before representing the service as publicly launched.

## Guest sessions

Every client starts as a guest. The client stores a random opaque bearer token:

- Web and Telegram Mini App use browser local storage under
  `amoveago.session.v1`;
- Android uses persistent, app-sandboxed Capacitor Preferences. Preferences
  are not guaranteed to be encrypted or excluded from device backups; access
  to a compromised/unlocked device or its backup can expose the bearer token.

The token is not a profile and contains no identity claims. D1 stores only its
cryptographic hash with a server-side pepper, plus the session ID, channel,
kind, creation/expiry/revocation times, and last-seen time. Clearing browser or
app data removes the local token and can make guest progress inaccessible.
The application does not use an authentication cookie.

## Optional Telegram profile

Telegram linking occurs only after the player explicitly chooses to save
progress. Merely opening the Telegram Mini App, or the presence of
`initData`, does not create a profile.

After server-side verification, the profile can store:

- verified numeric Telegram user ID;
- display name;
- optional username and avatar URL;
- for OIDC, issuer, subject, and audience identifiers;
- internal ID and creation/update timestamps.

Raw Mini App `initData`, OIDC authorization codes, and OIDC tokens are used
to verify the login and are not stored as profile fields. Short-lived auth-flow
records contain a guest-session reference, hashed state, nonce, PKCE verifier,
expiry/claim times, and a hashed one-time handoff code.

The requested Telegram OIDC scopes are `openid profile` only. A MOVE AGO
does not request a phone number or the `telegram:bot_access` permission and
does not request permission for the bot to message the player.

## Progress and attempts

The service stores the case and puzzle identifiers, a client-generated attempt
UUID, the normalized reconstruction, whether it was correct, the response
needed for replay, hints used, and submission time. Hint events store the
attempt, hint level, returned hint payload, and timestamp. Streak and aggregate
statistics are derived from these records.

Guest attempts belong to the guest session. When the player explicitly links
Telegram, server-recorded guest attempts are attached to the verified profile so
progress can synchronize across clients.

## Logs and network processing

Application structured logs contain request ID, HTTP method, path, status, and
session kind. They must not contain session tokens, Telegram proof, OIDC
tokens, handoff codes, answer payloads, personal profile payloads, or private
puzzle solutions. Network metadata can be processed by Cloudflare to deliver
and rate-limit the Worker; the application derives a peppered HMAC key from a
coarse network prefix for guest-session rate limiting rather than storing the
raw IP in its D1 application tables.

## Retention

- The checked-in session lifetime is 7,776,000 seconds (90 days). It is
  configurable, and the scheduled cleanup removes expired sessions.
- A local token can remain on the device until the client replaces or clears
  it, but the Worker rejects it after server-side expiry or revocation.
- Guest attempts are removed when their expired guest session is cleaned up.
  Attempts linked to a Telegram profile otherwise remain part of that profile
  until the profile-deletion process removes them.
- Revoked sessions and associated unlinked guest attempts are eligible for
  cleanup after 30 days.
- Expired auth flows and handoffs are short-lived and are cleaned after a
  one-day grace period.
- Hint-event records older than 31,536,000 seconds (one year) are removed by
  the scheduled cleanup.

Cloudflare platform logs, GitHub delivery logs, and operator backups can have
separate retention configured by the deployment operator; those settings must
be disclosed by any public deployment.

## Player controls and deletion requirement

Logging out revokes the current app session and returns the client to a new
guest session. Clearing local storage removes the local guest token, but
neither action by itself deletes a linked Telegram profile.

A usable profile-deletion path that removes the Telegram profile and associated
personal data is a release requirement before public launch. The current
repository does not yet expose that path, so public launch is blocked until it
is implemented, tested, documented, and wired to the deployed service.

Security vulnerabilities involving personal data should be reported privately
as described in [SECURITY.md](SECURITY.md).
