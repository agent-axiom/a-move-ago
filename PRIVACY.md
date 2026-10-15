# Privacy notice

## Status and scope

A MOVE AGO is currently a pre-public-launch MVP. This notice describes the
data boundaries implemented by the Web, Telegram Mini App, Android adapter,
Cloudflare Worker, and D1 schema in this repository. Deployment operators must
replace placeholder configuration, configure and disclose actual platform-log
and backup retention, and pass the production release gate before representing
the service as publicly launched.

## Guest sessions

Every client starts as a guest. The client stores a random opaque bearer token:

- Web and Telegram Mini App use browser local storage under
  `amoveago.session.v1`;
- Android uses persistent, app-sandboxed Capacitor Preferences. Preferences
  are not guaranteed to be encrypted or excluded from device backups; access
  to a compromised/unlocked device or its backup can expose the bearer token.

If the browser blocks local storage, Web and Telegram Mini App keep the token
only in memory for the current app instance. Closing or reloading that instance
can make unsaved guest progress inaccessible. A linked Telegram profile can be
reconnected through an explicit **Save progress with Telegram** action.

The token is not a profile and contains no identity claims. D1 stores only its
cryptographic hash with a server-side pepper, plus the session ID, channel,
kind, creation/expiry/revocation times, and last-seen time. Clearing browser or
app data removes the local token and can make guest progress inaccessible.
The application does not use an authentication cookie.

After a linked Telegram profile is deleted, the current opaque token is not
replaced. Its online D1 session becomes an active unlinked guest session and
retains the session ID, token hash, `kind = guest`, channel, creation time,
expiry time, revocation field, and last-seen time. Its `player_id` and
`rotated_from_session_id` are null.

Previously revoked pseudonymous guest predecessor sessions can remain until
scheduled cleanup. They retain their own session ID, token hash, `kind =
guest`, channel, creation time, expiry time, revocation time, and last-seen
time. A predecessor can retain `rotated_from_session_id` pointing only to an
earlier pseudonymous guest session. These rows have no `player_id`, Telegram
identity, or attempts belonging to the deleted profile.

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

Profile deletion removes every attempt linked to the deleted player, including
attempts first created as guest progress and later attached to that profile.
Related hint events and derived statistics disappear with those attempts.
Attempts accumulated independently by an unlinked guest after deletion remain
guest data and can be attached only by a later explicit Telegram sign-in.

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

Profile deletion removes the active online D1 records immediately. It does not
promise immediate physical erasure from Cloudflare platform logs, GitHub
delivery logs, or operator backups, which can have separate retention set by
the deployment operator. A public operator must configure and disclose those
periods and must ensure that restoring a backup does not reintroduce deleted
profile rows into the active service.

## Player controls and profile deletion

Logging out revokes the current app session and returns the client to a new
guest session. Clearing local storage removes the local guest token, but
neither action by itself deletes a linked Telegram profile.

A linked player can open **Progress**, choose **Delete Telegram profile**,
review the permanent warning, and choose **Delete permanently**. The
authenticated `DELETE /v1/me` immediately and irreversibly removes from active
online D1 the Telegram profile fields, every other Telegram session linked to
that player, player-linked attempts, their hint events, linked auth flows, and
derived statistics. The current token survives only as an empty unlinked guest
session. The operation does not delete the Telegram account, Telegram-hosted
content, chess content, or content-import history.

The client reports success only after a guest-only Worker response. A network
or contract failure remains unconfirmed and can be retried with the same token
while that session remains active; it is never presented as successful
deletion. An `INVALID_SESSION` response instead requires an app
reload/bootstrap before the player explicitly signs in with Telegram to verify
the profile. A later explicit **Save progress with Telegram** creates a new
profile and never restores deleted profile data.

An OIDC flow started before deletion but not yet linked to the profile, or a
Mini App login already running from another guest session, can still finish
after deletion and create a new profile. This is a new account-creation event:
deleted profile data is not restored, although independently accumulated
progress from that separate guest session can be linked.

Security vulnerabilities involving personal data should be reported privately
as described in [SECURITY.md](SECURITY.md).
