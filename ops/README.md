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
reserved `archive-`, `schedule-` and `localize-` prefixes. Identical archive retries and completed receipts
remain safe across midnight and key expiry, respectively.

Future additions require an explicit schedule request:

```json
{
  "keyId": "schedule-2026-11-14-2027-01-31-v1",
  "purpose": "schedule",
  "from": "2026-11-14",
  "through": "2027-01-31"
}
```

Both boundaries are inclusive. A schedule contains exactly 1–120 consecutive
dates; this example adds 79 days after the initial November 13 release horizon.
The key must have the form `schedule-FROM-THROUGH-vN`, with a positive version
number and no leading zeroes. The first date must be after the current UTC date
when creating the key and when first claiming the envelope. Before the first
claim, a read-only D1 preflight requires every intervening date from today to the
day before the schedule to have a published case with published, solvable puzzles.
A gap rejects the transfer before its envelope is bound or any content is written.

The entire exact date range, all puzzles and all remote conflicts are validated
before publication. Scheduled puzzles also pass the board-only predecessor audit:
exactly one materially feasible, locally legal previous move must exist and match
the accepted solution. Invisible FEN history and paid clues cannot establish this
uniqueness. Authors must separately retain a legal game lineage and review the
explanations, difficulty and variety; the audit does not prove historical reachability.
Cases are imported in chronological order regardless of their input order. The
immutable importer, private plaintext boundary and 48-hour pending key expiry
apply as before. A retry of already bound identical ciphertext may cross the
first scheduled midnight. Completed receipts remain usable after both the
schedule and key expire, without re-importing or revalidating future-date eligibility.

The protected workflow runs `tools/scripts/check-content-coverage.mjs` after a
schedule import. It verifies every date from today through the requested horizon,
including future cases intentionally hidden by the public API. It selects only
dates and counts, checks that all linked puzzles are published and have solutions,
and logs only aggregate coverage. After the matching localization import it also
requires Russian and Chinese rows for every case and puzzle in that horizon.
Bootstrap runs and elapsed schedules are explicitly skipped; neither is reported
as successful current coverage. The exported checker also accepts
`minimumFutureDays` for a release gate such as a 90-day reserve.

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
