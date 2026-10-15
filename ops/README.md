# Private daily content operations

Plaintext production puzzles, solutions, and authoring files stay outside this
repository. The application receives only the current public puzzle; private
solutions remain in D1.

The **Private daily content** workflow runs publication only from `main`, in the
protected `production` environment, using the existing Cloudflare bindings. Pull
requests run synthetic tests without production credentials. No administrative
HTTP endpoint is added to the game.

1. Choose a new unique `keyId` in `content-key-request.json`, with no
   `content-envelope.json` present. The workflow generates a 3072-bit RSA key in
   the protected runner and stores its temporary private key in an isolated D1
   operations table. Logs contain only its public key, SHA-256 fingerprint, and
   48-hour expiry. Reruns reuse the same pending key.
2. Outside this repository, validate the original corpus and encrypt
   `{ "cases": [...] }` with `encryptContentEnvelope` from
   `tools/src/private-content.ts`, using the logged public key and key ID. Verify
   its fingerprint. The envelope uses a fresh AES-256-GCM key and nonce, with
   RSA-OAEP-SHA256 key wrapping and an authenticated version/key ID.
3. Commit only the returned opaque envelope to `content-envelope.json`. The
   workflow decrypts in memory, validates every puzzle, checks remote conflicts
   for the entire corpus, then uses the existing immutable content importer.
   Default launch transfers accept 8–31 cases and require today plus the next
   seven UTC dates. Logs contain counts, dates, and an envelope digest, never
   puzzle text.
4. After successful publication the workflow erases the private key from the
   active operations record and retains a completion receipt. The same envelope
   is safe to rerun. A partial import retains its key; retry the identical
   envelope before expiry. Never replace a bound envelope with new ciphertext.

Historical backfills require an explicit archive request, for example:

```json
{
  "keyId": "archive-2026-09-10-2026-10-14-v1",
  "purpose": "archive",
  "from": "2026-09-10",
  "through": "2026-10-14"
}
```

Both boundaries are inclusive. The range must contain 1–60 consecutive UTC dates
and end before today. The decrypted corpus must include exactly that range,
without missing or extra dates. Archive transfers require a fresh key ID of the
form `archive-FROM-THROUGH-vN`, where `N` is a positive integer without leading
zeroes. This binds purpose and range to the authenticated envelope key ID;
changing either requires a new key. Default launch requests cannot use the
reserved `archive-` and `localize-` prefixes. Identical archive retries and completed receipts
remain safe across midnight and key expiry, respectively.

Translations use a fresh explicit localization request:

```json
{
  "keyId": "localize-2026-09-10-2026-11-13-ru-zh-v1",
  "purpose": "localization",
  "from": "2026-09-10",
  "through": "2026-11-13",
  "locales": ["ru", "zh"]
}
```

The authenticated key ID binds both inclusive dates and the exact ordered
language pair. Localization ranges contain 1–90 consecutive dates. Unlike an
archive backfill, a localization transfer can include future dates whose original
English cases are already published in D1; the public API still enforces its
usual release date. The encrypted payload follows `LocalizationBundleSchema`
from the API contract: version 1, one entry per source case, its immutable source
digest, and complete Russian and Chinese translations. Keep that plaintext
outside the repository.

Before claiming an envelope or writing any localization, the importer reconstructs
every original case in memory from D1 and verifies its canonical SHA-256 against
the original import digest. Case dates, puzzle IDs and versions, hint and solution
counts, and contradiction keys must match the full approved source. The complete
range and both languages are mandatory. Every existing localization is checked
before the first publication write: identical rows are safe to retry, while a
conflicting row rejects the complete transfer. Originals are never rewritten.

Localized public text and private hints, solution explanations, and contradictions
are stored separately in the localization tables installed by migration 0003.
Apply that migration before publishing a localization envelope. D1 requests are
bounded to 100 statements, including preflight and post-import checks. Partial
imports retain their bound key and accept only the identical ciphertext; successful
completion verifies all rows, erases the active private key, and records only
counts, dates, target languages, and the envelope digest.

Only encrypted transfer envelopes are permitted in this directory. This narrow
operational allowance does not permit plaintext production content, private keys,
credentials, or personal data anywhere in the public repository. D1 backups follow
the database retention policy; clearing the active key is not backup erasure.
