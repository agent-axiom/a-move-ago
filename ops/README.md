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
   workflow decrypts in memory, checks the entire corpus and at least eight UTC
   daily dates beginning today, then uses the existing immutable content importer.
   Logs contain counts, dates, and an envelope digest, never puzzle text.
4. After successful publication the workflow erases the private key from the
   active operations record and retains a completion receipt. The same envelope
   is safe to rerun. A partial import retains its key; retry the identical
   envelope before expiry. Never replace a bound envelope with new ciphertext.

Only encrypted transfer envelopes are permitted in this directory. This narrow
operational allowance does not permit plaintext production content, private keys,
credentials, or personal data anywhere in the public repository. D1 backups follow
the database retention policy; clearing the active key is not backup erasure.
