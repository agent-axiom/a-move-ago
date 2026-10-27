# RuStore delivery

The [RuStore release workflow](../../.github/workflows/rustore.yml) builds a signed
APK for `com.agentaxiom.amoveago`. A push of an `android-v*` tag submits an update
for moderation with automatic publication after approval. Manual runs default to
`build-only`; choose `publish` explicitly to submit from `main`.

The workflow checks the exact release commit against successful `CI` and
`Android` push runs, tests and lints the native release, and verifies the APK's
identity, signature, version, App Link and packaged web configuration. Release
commits must belong to `main`. Concurrent releases are serialized.

Every signed artifact also includes `app-icon-512.png` for the Console listing
and `branding-verification.json`. The release checks the compiled legacy, round,
adaptive and themed launcher artwork against `assets/branding/app-icon.svg` and
rejects obsolete raster icons. For a rejected first release, replace its APK in
Console with the new signed APK and use the included PNG as the listing icon.

## One-time setup

1. Create the application in RuStore Console with package name
   `com.agentaxiom.amoveago`. RuStore's update API requires an **active version**;
   prepare the first listing and release in Console, including its screenshots,
   description and privacy policy.
2. Choose a permanent Android signing key. Reuse the existing key if this package
   has already been distributed. Keep a secure backup: every APK update must use
   the same signing identity. Do not generate a new production key on each CI run.
3. In [GitHub environment settings](https://github.com/agent-axiom/a-move-ago/settings/environments),
   create an environment named `rustore`. Configure these environment secrets:

   | Secret | Value |
   | --- | --- |
   | `ANDROID_KEYSTORE_BASE64` | Base64-encoded JKS or PKCS12 keystore |
   | `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
   | `ANDROID_KEY_ALIAS` | Signing key alias |
   | `ANDROID_KEY_PASSWORD` | Signing key password |
   | `RUSTORE_KEY_ID` | RuStore Console API key ID |
   | `RUSTORE_PRIVATE_KEY_BASE64` | RuStore API RSA private key, Base64 DER PKCS8 |

   Only the four Android secrets are needed for `build-only`. The two RuStore
   secrets are required when submitting an update.

   The RuStore API key and Android signing key are separate credentials. Store
   them in GitHub Secrets, never in release notes, source control or chat. The
   workflow restores the keystore into a private temporary file and removes it
   on completion. The production signing key is never an uploaded artifact.
4. Set repository variable `API_ORIGIN` to the bare production HTTPS API origin,
   currently `https://a-move-ago-api.if-ab6.workers.dev`. Do not override it with a
   different value in the `rustore` environment. The verification job runs before
   entering that environment, so the repository variable is required.
5. Once this configuration is on `main` and its `CI` and `Android` runs are green,
   run **RuStore release** on `main`, version `1.0.0`, mode `build-only`.
   Download the verified signed APK and `android-release-metadata.json` from the
   workflow artifact. Artifacts are retained for 14 days.
6. Add the APK's SHA-256 signing-certificate fingerprint to the existing API
   deployment variable `ANDROID_SHA256_CERT_FINGERPRINTS` (uppercase, colon
   separated; multiple certificates are comma separated), then deploy the API.
   Its `/.well-known/assetlinks.json` must associate that certificate with
   `com.agentaxiom.amoveago`. This enables the Android authentication App Link.
   Every automated publication verifies the live association before contacting
   RuStore. The build-only mode allows the initial APK to be generated before
   this association exists.
7. Upload that APK in RuStore Console and complete the first publication. After
   it becomes active, CI can submit subsequent updates automatically.

Environment deployment restrictions, if enabled, must allow `main` and
`android-v*` tags. Restrict who can write release tags using the repository's
normal release controls.

## Release an update

Use a canonical `major.minor.patch` version without prerelease suffixes or leading
zeros. Minor and patch components range from 0 to 999; major ranges from 0 to
2099. Version `0.0.0` is invalid. The Android version code is deterministic:

```text
versionCode = major × 1,000,000 + minor × 1,000 + patch
1.0.0 → 1000000
1.0.1 → 1000001
1.1.0 → 1001000
```

The code must be greater than all existing RuStore versions, including drafts
and testing versions. If an existing application used another numbering scheme,
choose a version whose generated code exceeds it before the first automated
update.

1. Add player-facing release notes to `ops/rustore/notes/<version>.txt` (at most
   5,000 characters) and merge the change into `main`.
2. Wait for both `CI` and `Android` push workflows on that exact commit to succeed.
3. Create and push a release tag pointing to that commit:

   ```sh
   git switch main
   git pull --ff-only
   git tag android-v1.0.1
   git push origin android-v1.0.1
   ```

Alternatively, manually run **RuStore release** from `main` with the version and
`publish` mode. A manual `build-only` run only produces the signed APK and safe
verification metadata; it does not call the RuStore publication API.

A successful submission means RuStore accepted the version for processing or
moderation. It does not mean the app is already available in the store. RuStore
publishes it automatically after approval; follow its status in Console.

## Recovery and limitations

- If the exact commit's checks are still running or have failed, the release
  stops before loading signing or RuStore secrets. Rerun after successful checks.
- Before creating a version, the uploader checks all version pages, confirms an
  active production release, and refuses to proceed while a draft, moderation
  submission or version awaiting publication exists. RuStore creates a draft by
  replacing an existing draft, so this check protects Console work. Avoid editing
  or creating a Console draft during an automated release.
- A previously submitted matching version returns an already-submitted result
  instead of uploading it again. A conflicting or lower version code is rejected.
- Mutating API calls are not retried automatically. If creation, upload or
  submission has an ambiguous outcome, inspect Console first. A partially created
  draft is retained for recovery; CI does not delete it. Complete or remove it
  intentionally in Console before submitting another release.
- The workflow's live App Link check requires the production API to be available
  with a matching certificate. Building an APK does not prove real-device login
  or RuStore moderation success.
- Pull requests test signed release packaging with a temporary synthetic key.
  That key and APK are discarded and cannot be used for production updates.

## API references

- [Authorization and signature](https://www.rustore.ru/help/work-with-rustore-api/api-authorization-token)
- [Create a draft version](https://www.rustore.ru/help/work-with-rustore-api/api-upload-publication-app/create-draft-version)
- [Upload an APK](https://www.rustore.ru/help/work-with-rustore-api/api-upload-publication-app/apk-file-upload/file-upload-apk)
- [Submit for moderation](https://www.rustore.ru/help/work-with-rustore-api/api-upload-publication-app/send-draft-app-for-moderation)
- [Version statuses](https://www.rustore.ru/help/work-with-rustore-api/api-upload-publication-app/get-version-status)
