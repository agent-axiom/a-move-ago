# A MOVE AGO Android and Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Упаковать общий клиент в Android через Capacitor 8, настроить проверяемые App Links и довести публичный monorepo до воспроизводимых CI, GitHub Pages, Worker и Android delivery paths.

**Architecture:** Android использует тот же React UI, но отдельный Vite artifact с корневым base. Native-возможности остаются за `PlatformAdapter`; production OAuth возвращается через verified HTTPS App Link, debug — через фиксированную custom scheme. GitHub Actions проверяет всё на Node 24, а Pages/API deploys не запускаются без явной deployment configuration.

**Tech Stack:** Capacitor 8.5, Android API 24+, Java 21, Gradle wrapper, GitHub Actions
(`checkout@7`, `setup-node@7`, `setup-java@5`, Pages `6/5/5`, artifact `7`, Android setup `4`),
GitHub Pages, Cloudflare Wrangler 4.118.

---

**Порядок:** план 5 из 5. Требует завершённые планы 1–4. Публикация репозитория выполняется только после полного локального gate; production Worker/Pages требуют Cloudflare configuration.

## Карта файлов

- `packages/platform/src/android.ts` — Android implementation `PlatformAdapter` через инъецируемый native bridge.
- `packages/platform/src/android-bridge.ts` — единственная точка импорта Capacitor plugins.
- `packages/platform/src/android.test.ts` — unit tests без Android runtime.
- `apps/client/capacitor.config.ts` — App ID, webDir и HTTPS WebView origin.
- `apps/client/android/` — сгенерированный Capacitor Android project.
- `apps/client/android/app/src/main/AndroidManifest.xml` — verified production App Link.
- `apps/client/android/app/src/debug/AndroidManifest.xml` — debug-only `amoveago-debug` scheme.
- `apps/api/src/routes/android-association.ts` — `assetlinks.json` и безопасная recovery page.
- `tools/src/render-wrangler-config.ts` — проверяемая подстановка remote D1 ID во временный config.
- `LICENSE`, `content/samples/LICENSE.md`, `NOTICE.md` — software/content/brand boundaries.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `PRIVACY.md` — эксплуатационная и community документация.
- `.github/workflows/ci.yml` — единый pull-request gate.
- `.github/workflows/pages.yml` — GitHub Pages deployment.
- `.github/workflows/api.yml` — manual Worker/D1 deployment.
- `.github/workflows/android.yml` — Java 21 debug APK/AAB build.

### Task 1: Реализовать Android adapter через тестируемый bridge

**Files:**
- Modify: `packages/platform/package.json`
- Create: `packages/platform/src/android.ts`
- Create: `packages/platform/src/android-bridge.ts`
- Create: `packages/platform/src/android-entry.ts`
- Test: `packages/platform/src/android.test.ts`
- Modify: `apps/client/src/main.tsx`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing adapter tests**

Создать `packages/platform/src/android.test.ts` с fake bridge, который записывает вызовы. Проверить точные инварианты:

```ts
it("persists only the app session token under the versioned Preferences key", async () => {
  const bridge = fakeAndroidBridge();
  const adapter = createAndroidAdapter(bridge, {
    apiOrigin: "https://api.example.test",
    allowDebugScheme: false,
  });

  await adapter.tokenStore.write("session-token");
  expect(bridge.preferences.set).toHaveBeenCalledWith({
    key: "amoveago.session.v1",
    value: "session-token",
  });
  await expect(adapter.tokenStore.read()).resolves.toBe("session-token");
  await adapter.tokenStore.clear();
  expect(bridge.preferences.remove).toHaveBeenCalledWith({ key: "amoveago.session.v1" });
});

it("opens OIDC only in the system browser", async () => {
  const bridge = fakeAndroidBridge();
  await createAndroidAdapter(bridge, {
    apiOrigin: "https://api.example.test",
    allowDebugScheme: false,
  }).openAuthorization("https://oauth.telegram.org/auth");
  expect(bridge.browser.open).toHaveBeenCalledWith({
    url: "https://oauth.telegram.org/auth",
    presentationStyle: "popover",
  });
});

it("forwards only an exact production handoff or explicit provider denial", async () => {
  const bridge = fakeAndroidBridge();
  const adapter = createAndroidAdapter(bridge, {
    apiOrigin: "https://api.example.test",
    allowDebugScheme: false,
  });
  const seen: string[] = [];
  const unsubscribe = await adapter.authReturn.subscribe((url) => seen.push(url));
  const handoff = "a".repeat(43);

  bridge.emitUrl(`https://api.example.test/auth/android?handoff=${handoff}`);
  bridge.emitUrl("https://api.example.test/auth/android?authError=access_denied");
  bridge.emitUrl(`https://evil.test/auth/android?handoff=${handoff}`);
  bridge.emitUrl(`https://api.example.test/other?handoff=${handoff}`);
  bridge.emitUrl(`https://api.example.test/auth/android?handoff=${handoff}&next=evil`);
  bridge.emitUrl("https://api.example.test/auth/android?authError=server_error");
  bridge.emitUrl("https://api.example.test/auth/android?authError=access_denied&next=evil");
  bridge.emitUrl("https://api.example.test/auth/android?authError=access_denied#fragment");
  bridge.emitUrl(`amoveago-debug://auth?handoff=${handoff}`);
  bridge.emitUrl("javascript:alert(1)");

  expect(seen).toEqual([
    `https://api.example.test/auth/android?handoff=${handoff}`,
    "https://api.example.test/auth/android?authError=access_denied",
  ]);
  expect(bridge.browser.close).toHaveBeenCalledTimes(2);
  unsubscribe();
});

it("allows the exact custom scheme only in an explicitly enabled debug build", async () => {
  const handoff = "b".repeat(43);
  const url = `amoveago-debug://auth?handoff=${handoff}`;
  const bridge = fakeAndroidBridge({ initialUrl: url });
  const adapter = createAndroidAdapter(bridge, {
    apiOrigin: "https://api.example.test",
    allowDebugScheme: true,
  });
  await expect(adapter.authReturn.initialUrl()).resolves.toBe(url);
  expect(bridge.browser.close).toHaveBeenCalledOnce();

  const releaseBridge = fakeAndroidBridge({ initialUrl: url });
  await expect(createAndroidAdapter(releaseBridge, {
    apiOrigin: "https://api.example.test",
    allowDebugScheme: false,
  }).authReturn.initialUrl()).resolves.toBeNull();
});

it("forwards exact cold-start denials and keeps the debug target build-gated", async () => {
  const productionUrl = "https://api.example.test/auth/android?authError=access_denied";
  const productionBridge = fakeAndroidBridge({ initialUrl: productionUrl });
  const productionAdapter = createAndroidAdapter(productionBridge, {
    apiOrigin: "https://api.example.test",
    allowDebugScheme: false,
  });
  await expect(productionAdapter.authReturn.initialUrl()).resolves.toBe(productionUrl);
  expect(productionBridge.browser.close).toHaveBeenCalledOnce();

  const debugUrl = "amoveago-debug://auth?authError=access_denied";
  const bridge = fakeAndroidBridge({ initialUrl: debugUrl });
  const adapter = createAndroidAdapter(bridge, {
    apiOrigin: "https://api.example.test",
    allowDebugScheme: true,
  });
  await expect(adapter.authReturn.initialUrl()).resolves.toBe(debugUrl);
  expect(bridge.browser.close).toHaveBeenCalledOnce();

  const releaseBridge = fakeAndroidBridge({ initialUrl: debugUrl });
  await expect(createAndroidAdapter(releaseBridge, {
    apiOrigin: "https://api.example.test",
    allowDebugScheme: false,
  }).authReturn.initialUrl()).resolves.toBeNull();
});

it("implements layout, haptics, external links and the non-Telegram proof contract", async () => {
  const bridge = fakeAndroidBridge({ height: 720 });
  const adapter = createAndroidAdapter(bridge, {
    apiOrigin: "https://api.example.test",
    allowDebugScheme: false,
  });
  const values = new Map<string, string>();
  const target = {
    style: {
      setProperty: (name: string, value: string) => values.set(name, value),
      getPropertyValue: (name: string) => values.get(name) ?? "",
    },
  } as unknown as HTMLElement;
  const removeLayout = adapter.installLayoutVars(target);
  expect(target.style.getPropertyValue("--host-stable-height")).toBe("720px");
  expect(target.style.getPropertyValue("--host-safe-top"))
    .toBe("env(safe-area-inset-top, 0px)");
  await adapter.ready();
  await adapter.haptic("selection");
  await adapter.haptic("success");
  await adapter.openExternal("https://example.test/help");
  await expect(adapter.requestTelegramProof({ reason: "save-progress", userInitiatedAt: 1 }))
    .resolves.toBeNull();
  expect(bridge.haptics.selectionChanged).toHaveBeenCalledOnce();
  expect(bridge.haptics.notification).toHaveBeenCalledWith("success");
  expect(bridge.browser.open).toHaveBeenCalledWith({
    url: "https://example.test/help",
    presentationStyle: "popover",
  });
  removeLayout();
  expect(bridge.layout.removeResizeListener).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/platform -- src/android.test.ts`

Expected: FAIL because `createAndroidAdapter` and the bridge do not exist.

- [ ] **Step 3: Install exact Capacitor runtime dependencies**

Add to `packages/platform/package.json`:

```json
"dependencies": {
  "@capacitor/app": "8.1.1",
  "@capacitor/browser": "8.0.4",
  "@capacitor/core": "8.5.0",
  "@capacitor/haptics": "8.0.2",
  "@capacitor/preferences": "8.0.1"
}
```

Retain the workspace dependencies created in plan 4 and run `npm install` to update the lockfile.

- [ ] **Step 4: Implement the injectable bridge and adapter**

`packages/platform/src/android-bridge.ts` imports `App`, `Browser`, `Capacitor`, `Haptics`,
`NotificationType` and `Preferences`, then exports this exact narrow object (including a resize port
backed by `window.innerHeight`/`window.addEventListener`):

```ts
export const capacitorAndroidBridge: AndroidBridge = {
  preferences: Preferences,
  browser: Browser,
  app: App,
  haptics: {
    selectionChanged: () => Haptics.selectionChanged(),
    notification: (kind) => Haptics.notification({
      type: kind === "success" ? NotificationType.Success : NotificationType.Error,
    }),
  },
  layout: {
    height: () => window.innerHeight,
    addResizeListener: (listener) => window.addEventListener("resize", listener),
    removeResizeListener: (listener) => window.removeEventListener("resize", listener),
  },
  initialUrl: () => App.getLaunchUrl().then((result) => result?.url ?? null),
  isNative: () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android",
};
```

`packages/platform/src/android.ts` exports `AndroidBridge`, `AndroidAdapterConfig` and
`createAndroidAdapter(bridge, config)`. `config.apiOrigin` must parse as a bare HTTPS origin;
`config.allowDebugScheme` is the explicit build-time debug capability. The adapter must:

- set `kind: "android"`, `channel: "android"` and `authMode: "oidc-android"`;
- use only the key `amoveago.session.v1` for the app token;
- use `Browser.open()` for authorization/external URLs and `Browser.close()` after a valid auth return;
- accept a production return only when its origin is exactly `config.apiOrigin`, its pathname is
  exactly `/auth/android`, it has no credentials or fragment, and its query is **exactly one of**:
  a sole `handoff` matching `^[A-Za-z0-9_-]{43}$`, or the sole pair
  `authError=access_denied`;
- accept the same two exact query alternatives on `amoveago-debug://auth` only when
  `config.allowDebugScheme === true`; a release adapter rejects that scheme even if an external
  component somehow forwards it;
- call `Browser.close()` and forward the unchanged URL for either accepted alternative, so both
  subscription and cold-start `initialUrl()` notify the plan-4 `SessionProvider` of a successful
  handoff or a user denial;
- expose filtered `App.getLaunchUrl()` as `authReturn.initialUrl()`;
- subscribe with `App.addListener("appUrlOpen", ({ url }) => acceptAuthReturn(url))` and return a
  remover that calls the native listener handle's `remove()`;
- subscribe to `App.addListener("backButton", () => backHandler())` and remove the prior listener
  whenever the UI replaces its back handler;
- implement `ready()` as an idempotent resolved promise and `requestTelegramProof()` as `null`;
- set `--host-stable-height` from the resize port and both safe/content-safe edge variables to
  `env(safe-area-inset-<edge>, 0px)`, returning exact resize-listener cleanup;
- map selection/success/error through the narrow Haptics bridge and use the same system-browser path
  for `openExternal()` and `openAuthorization()`.

Add the package subpath export `"./android": "./src/android-entry.ts"` without re-exporting it from
root `src/index.ts`. `android-entry.ts` imports the native bridge and exports
`createCapacitorAndroidAdapter(config: AndroidAdapterConfig): Promise<PlatformAdapter | null>`,
returning `null` unless `bridge.isNative()` is true.

Modify `apps/client/src/main.tsx` to pass the plan-4 loader seam only for the Android Vite mode:

```tsx
const loadAndroid = import.meta.env.MODE === "android"
  ? async () => {
      const { createCapacitorAndroidAdapter } = await import("@a-move-ago/platform/android");
      return createCapacitorAndroidAdapter({
        apiOrigin: import.meta.env.VITE_API_BASE_URL,
        allowDebugScheme: import.meta.env.VITE_ANDROID_ALLOW_DEBUG_SCHEME === "true",
      });
    }
  : undefined;

const runtime = await createBrowserRuntime(window, loadAndroid);
```

This is the only client import of the Android subpath. The root platform entry remains
Capacitor-free, and the compile-time false Pages branch must be removed from the Pages artifact.

- [ ] **Step 5: Run GREEN and prove web imports stay safe**

Run: `npm test -w @a-move-ago/platform -- src/android.test.ts`

Expected: PASS for Preferences, Browser, URL filtering and listener cleanup.

The Android debug build commands in this plan set `VITE_ANDROID_ALLOW_DEBUG_SCHEME=true`; Pages and
future release builds leave it absent/false. No runtime heuristic may widen the allowlist.

Run: `VITE_API_BASE_URL=https://api.invalid npm run build:pages -w @a-move-ago/client`

Expected: exit `0`; `rg -n 'Capacitor|@capacitor' apps/client/dist/pages` has no matches, and opening
the built Pages entry in Playwright produces no `Capacitor is not defined` error.

- [ ] **Step 6: Commit**

```bash
git add packages/platform apps/client/src/main.tsx package-lock.json
git commit -m "feat: add Android platform adapter"
```

### Task 2: Сгенерировать и зафиксировать Capacitor Android project

**Files:**
- Modify: `apps/client/package.json`
- Create: `apps/client/capacitor.config.ts`
- Create: `apps/client/android/` via Capacitor CLI
- Modify: `apps/client/android/app/build.gradle`
- Modify: `apps/client/android/app/src/main/AndroidManifest.xml`
- Create: `apps/client/android/app/src/debug/AndroidManifest.xml`
- Modify: `apps/client/android/app/src/main/res/values/strings.xml`
- Modify: `package-lock.json`

- [ ] **Step 1: Add the Capacitor CLI and deterministic scripts**

Add to `apps/client/package.json`:

```json
"scripts": {
  "cap:add:android": "cap add android",
  "cap:sync:android": "cap sync android",
  "android:test": "./android/gradlew -p android testDebugUnitTest lintDebug assembleDebug bundleDebug verifyAuthManifests"
},
"devDependencies": {
  "@capacitor/android": "8.5.0",
  "@capacitor/cli": "8.5.0"
}
```

Merge these entries with the plan-4 manifest and run `npm install`.

- [ ] **Step 2: Create the exact Capacitor config**

`apps/client/capacitor.config.ts`:

```ts
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.agentaxiom.amoveago",
  appName: "A MOVE AGO",
  webDir: "dist/android",
  server: {
    androidScheme: "https",
    hostname: "localhost",
  },
};

export default config;
```

- [ ] **Step 3: Generate native sources once**

Run: `VITE_API_BASE_URL=https://api.invalid VITE_ANDROID_ALLOW_DEBUG_SCHEME=true npm run build:android:web -w @a-move-ago/client`

Expected: `apps/client/dist/android/index.html` exists and its script/style URLs start at `/`, not `/a-move-ago/`.

Run from `apps/client`: `npm run cap:add:android`

Expected: Capacitor creates `apps/client/android`, package
`com.agentaxiom.amoveago`, Gradle wrapper and app module.

Run: `rg -n 'minSdkVersion = 24|compileSdkVersion = 36|targetSdkVersion = 36' apps/client/android/variables.gradle`

Expected: all three pinned Capacitor 8.5 Android baselines are present. Treat template drift as a
review point instead of silently changing the supported-device or target-SDK contract.

Run from repository root: `npm run cap:sync:android -w @a-move-ago/client`

Expected: `dist/android` is copied to the native assets directory and all four Capacitor plugins are registered.

- [ ] **Step 4: Configure release App Link without a hard-coded deployment host**

Inside `apps/client/android/app/build.gradle`, add to `defaultConfig`:

```groovy
manifestPlaceholders = [
    appLinkHost: project.findProperty("A_MOVE_AGO_APP_LINK_HOST") ?: "app-link-not-configured.invalid"
]
```

Add inside the generated `MainActivity` in
`apps/client/android/app/src/main/AndroidManifest.xml`:

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data
        android:scheme="https"
        android:host="${appLinkHost}"
        android:pathPrefix="/auth/android" />
</intent-filter>
```

Create `apps/client/android/app/src/debug/AndroidManifest.xml` as the complete merge-only debug
manifest:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application>
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="amoveago-debug" android:host="auth" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

Set `app_name`, `title_activity_main` and `package_name` in `strings.xml` to
`A MOVE AGO`, `A MOVE AGO` and `com.agentaxiom.amoveago` respectively.

Finally, append a Gradle verification task after the Android plugin has created the variant tasks.
It inspects the actual manifest-task outputs instead of assuming an AGP intermediate directory:

```groovy
afterEvaluate {
    def mergedManifestText = { String taskName ->
        def files = tasks.named(taskName).get().outputs.files.asFileTree.matching {
            include "**/AndroidManifest.xml"
        }.files
        if (files.empty) {
            throw new GradleException("No merged manifest emitted by ${taskName}")
        }
        files.collect { it.getText("UTF-8") }.join("\n")
    }

    tasks.register("verifyAuthManifests") {
        dependsOn "processDebugMainManifest", "processReleaseMainManifest"
        doLast {
            def debugManifest = mergedManifestText("processDebugMainManifest")
            def releaseManifest = mergedManifestText("processReleaseMainManifest")
            if (!debugManifest.contains('android:scheme="amoveago-debug"')) {
                throw new GradleException("Debug auth scheme is missing")
            }
            if (releaseManifest.contains('amoveago-debug')) {
                throw new GradleException("Debug auth scheme leaked into release manifest")
            }
            if (!releaseManifest.contains('android:pathPrefix="/auth/android"')) {
                throw new GradleException("Release App Link is missing")
            }
        }
    }
}
```

- [ ] **Step 5: Verify merged manifests and native build**

If Java 21 and Android SDK are available locally:

Run: `npm run android:test -w @a-move-ago/client`

Expected: `testDebugUnitTest`, `lintDebug`, `assembleDebug`, `bundleDebug`,
`processReleaseMainManifest` and `verifyAuthManifests` PASS; merged debug manifest contains both
filters, while the merged release manifest contains the exact App Link and no `amoveago-debug`
scheme.

If they are unavailable locally, run `npm run cap:sync:android -w @a-move-ago/client` and defer only the Gradle command to Task 8 CI. Record this environment limitation; do not claim native compilation locally.

- [ ] **Step 6: Commit**

```bash
git add apps/client/capacitor.config.ts apps/client/package.json apps/client/android package-lock.json
git commit -m "feat: scaffold Capacitor Android app"
```

### Task 3: Отдать Android association и безопасный callback fallback из Worker

**Files:**
- Modify: `apps/api/src/env.ts`
- Create: `apps/api/src/routes/android-association.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/wrangler.jsonc`
- Modify: `apps/api/vitest.config.ts`
- Test: `apps/api/test/android-association.test.ts`

- [ ] **Step 1: Write failing association tests**

Override `ANDROID_PACKAGE_NAME` and `ANDROID_SHA256_CERT_FINGERPRINTS` in the test pool bindings,
then make `apps/api/test/android-association.test.ts` import `SELF` from `cloudflare:test` and assert:

```ts
const association = await SELF.fetch("https://api.test/.well-known/assetlinks.json");
expect(association.status).toBe(200);
expect(await association.json()).toEqual([
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "com.agentaxiom.amoveago",
      sha256_cert_fingerprints: [
        "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
      ],
    },
  },
]);
expect(association.headers.get("content-type")).toContain("application/json");

const fallback = await SELF.fetch("https://api.test/auth/android?handoff=secret-code");
const html = await fallback.text();
expect(html).not.toContain("secret-code");
expect(fallback.headers.get("referrer-policy")).toBe("no-referrer");
expect(fallback.headers.get("content-security-policy")).toContain("default-src 'none'");
```

Also assert invalid or empty fingerprint configuration fails with `503 CONFIGURATION_ERROR`, never an empty association.

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/api -- test/android-association.test.ts`

Expected: FAIL with 404 routes.

- [ ] **Step 3: Add typed configuration and route**

Add to `Env` and `wrangler.jsonc` vars:

```ts
ANDROID_PACKAGE_NAME: string;
ANDROID_SHA256_CERT_FINGERPRINTS: string;
```

```jsonc
"ANDROID_PACKAGE_NAME": "com.agentaxiom.amoveago",
"ANDROID_SHA256_CERT_FINGERPRINTS": ""
```

An empty fingerprint is an intentional fail-closed deployment sentinel. Before enabling Android
App Links, production config must contain one or more comma-separated uppercase SHA-256
fingerprints matching `/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/`.

`android-association.ts` parses, deduplicates and sorts fingerprints, returns the exact Digital
Asset Links object above and sets `cache-control: public, max-age=300`.

`GET /auth/android` returns static HTML containing only “Return to A MOVE AGO on your Android
device.” It must not serialize query parameters, execute script, load images or reference third-party
origins. Set:

```text
content-security-policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'
referrer-policy: no-referrer
cache-control: no-store
x-content-type-options: nosniff
```

Mount both routes before authenticated `/v1/*` middleware.

Add these deterministic test bindings inside `apps/api/vitest.config.ts`:

```ts
ANDROID_PACKAGE_NAME: "com.agentaxiom.amoveago",
ANDROID_SHA256_CERT_FINGERPRINTS:
  "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
```

- [ ] **Step 4: Run GREEN**

Run: `npm test -w @a-move-ago/api -- test/android-association.test.ts`

Expected: association shape, validation, headers and handoff non-reflection PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/env.ts apps/api/src/routes/android-association.ts apps/api/src/app.ts apps/api/wrangler.jsonc apps/api/vitest.config.ts apps/api/test/android-association.test.ts
git commit -m "feat: publish verified Android app links"
```

### Task 4: Зафиксировать open-source, content и brand boundaries

**Files:**
- Create: `LICENSE`
- Create: `NOTICE.md`
- Create: `content/samples/LICENSE.md`
- Create: `README.md`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `PRIVACY.md`

- [ ] **Step 1: Add canonical licenses**

Run read-only: `gh api licenses/agpl-3.0 --jq .body`

Use `apply_patch` to save the returned canonical SPDX/GitHub AGPL-3.0 text verbatim as `LICENSE`.
Do not compose or abbreviate the license.

Create `content/samples/LICENSE.md` with:

```markdown
# Sample puzzle license

The files in this directory are licensed under Creative Commons Attribution 4.0
International (CC BY 4.0): https://creativecommons.org/licenses/by/4.0/

Attribution: “A MOVE AGO sample puzzles”, Agent Axiom contributors.

Each puzzle must also retain its `provenance` and `license` fields. This license does not
apply to the production puzzle corpus, which is not distributed in this repository.
```

- [ ] **Step 2: Add the exact boundary notice**

`NOTICE.md` must state all four rules:

1. source code is AGPL-3.0;
2. only `content/samples/**` is CC BY 4.0;
3. production puzzles are private and are not included;
4. “A MOVE AGO”, the logo and visual identity are not granted under the software license.

- [ ] **Step 3: Document operation and contribution**

`README.md` includes these executable sections: product loop, architecture diagram link to the
approved spec, prerequisites (Node 24/npm 11), `npm ci`, local checks, local Worker+D1 start,
client start, Pages/Android builds, guest-first Telegram auth, configuration table and links to all
five implementation plans.

`CONTRIBUTING.md` requires focused commits, the complete local gate, AGPL-3.0 for code and explicit
provenance/license for every content contribution. It forbids committing production puzzles,
Telegram/Cloudflare secrets, keystores and personal data.

`SECURITY.md` names private reporting through GitHub Security Advisories, supported branch `main`,
and a 90-day coordinated-disclosure target. It explicitly lists session tokens, Telegram proof,
OIDC tokens, handoff codes and private puzzle solutions as sensitive.

`PRIVACY.md` describes guest token storage, optional Telegram profile fields, progress/attempt data,
90-day session expiry, one-year hint-event cleanup, no phone/bot access and the pre-public-launch
requirement for a profile deletion path.

- [ ] **Step 4: Verify repository boundaries**

Run: `rg -n "acceptedSolutions|previousFen" apps/client packages/platform || true`

Expected: no production solution value or embedded content source; shared type/schema identifiers
may appear only where required for response validation after a correct attempt.

Run: `git ls-files | rg '(\.jks$|\.keystore$|\.apk$|\.aab$|\.dev\.vars$|\.env$)'`

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add LICENSE NOTICE.md content/samples/LICENSE.md README.md CONTRIBUTING.md SECURITY.md PRIVACY.md
git commit -m "docs: define project licensing and operations"
```

### Task 5: Создать единый pull-request CI gate

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run check
      - run: npm run typecheck
      - run: npm test
      - run: npm run content:validate
      - run: npm run build -w @a-move-ago/api
      - run: npm run build:pages -w @a-move-ago/client
        env:
          VITE_API_BASE_URL: https://api.test
      - run: npm run build:android:web -w @a-move-ago/client
        env:
          VITE_API_BASE_URL: https://api.test
          VITE_ANDROID_ALLOW_DEBUG_SCHEME: "true"
      - run: npm run verify:artifacts -w @a-move-ago/client
      - run: npx playwright install --with-deps chromium
      - run: npm run e2e -w @a-move-ago/client
```

Both artifact builds use the reserved `https://api.test` origin expected by plan 4's executable
artifact verifier and Playwright route mock. The Pages build exists before Playwright starts its
preview server; Chromium is installed explicitly, and the workflow contacts neither production nor
Telegram.

- [ ] **Step 2: Validate workflow and local equivalent**

Run separately: `npm ci`

Run separately: `npm run check`

Run separately: `npm run typecheck`

Run separately: `npm test`

Run separately: `npm run content:validate`

Run separately: `VITE_API_BASE_URL=https://api.test npm run build:pages -w @a-move-ago/client`

Run separately: `VITE_API_BASE_URL=https://api.test VITE_ANDROID_ALLOW_DEBUG_SCHEME=true npm run build:android:web -w @a-move-ago/client`

Run separately: `npm run verify:artifacts -w @a-move-ago/client`

Run separately: `npx playwright install --with-deps chromium`

Run separately: `npm run e2e -w @a-move-ago/client`

Expected: every command exits `0` with a clean `git diff --check`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: verify monorepo and client artifacts"
```

### Task 6: Публиковать Pages только с реальным API URL

**Files:**
- Create: `.github/workflows/pages.yml`

- [ ] **Step 1: Add the Pages workflow**

`.github/workflows/pages.yml`:

```yaml
name: Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    if: ${{ github.ref == 'refs/heads/main' && vars.API_ORIGIN != '' }}
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - uses: actions/configure-pages@v6
      - run: npm ci
      - run: npm run check
      - run: npm run typecheck
      - run: npm test
      - run: npm run content:validate
      - run: npm run build:pages -w @a-move-ago/client
        env:
          VITE_API_BASE_URL: ${{ vars.API_ORIGIN }}
      - uses: actions/upload-pages-artifact@v5
        with:
          path: apps/client/dist/pages
      - id: deployment
        uses: actions/deploy-pages@v5
```

- [ ] **Step 2: Verify both configuration branches**

Before setting `API_ORIGIN`, the workflow job must be `skipped`, not failed and not deployed with
`api.invalid`. After Worker deployment, set the exact HTTPS origin (without a trailing slash):

Resolve the exact HTTPS origin printed by successful `wrangler deploy`, export it as the
task-specific shell variable `A_MOVE_AGO_API_ORIGIN`, validate it with
`node -e 'new URL(process.env.A_MOVE_AGO_API_ORIGIN)'`, then run:

```bash
export A_MOVE_AGO_API_ORIGIN="https://replace-with-the-deployed-worker-origin.example"
node -e 'const url = new URL(process.env.A_MOVE_AGO_API_ORIGIN); if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) process.exit(1)'
gh variable set API_ORIGIN --repo agent-axiom/a-move-ago --body "$A_MOVE_AGO_API_ORIGIN"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pages.yml
git commit -m "ci: deploy client to GitHub Pages"
```

### Task 7: Добавить fail-closed manual Worker deploy

**Files:**
- Create: `tools/src/render-wrangler-config.ts`
- Test: `tools/src/render-wrangler-config.test.ts`
- Create: `tools/src/write-worker-secrets.ts`
- Test: `tools/src/write-worker-secrets.test.ts`
- Modify: `tools/package.json`
- Modify: `.gitignore`
- Create: `.github/workflows/api.yml`

- [ ] **Step 1: Write failing config-render tests**

Tests call `renderWranglerConfig(source, productionInput)` and assert:

- exactly one `00000000-0000-0000-0000-000000000000` sentinel is replaced;
- a non-UUID ID throws;
- `ENVIRONMENT` becomes `production`;
- `API_ORIGIN`, Telegram callback and Android return become one exact HTTPS Worker origin;
- numeric Telegram client ID replaces its development sentinel; a nonblank Android SHA-256
  fingerprint list is validated and substituted, while blank intentionally keeps the association
  endpoint fail-closed with `503` until a stable signing certificate exists;
- four distinct positive Rate Limiting namespace IDs replace `900000001` through `900000004`;
- zero or duplicate sentinels, `.invalid`, `amoveago-debug:`, duplicate/malformed namespace IDs and
  malformed production inputs throw;
- no token/account/auth secret is accepted by the function or returned text.

`write-worker-secrets.test.ts` passes an injected environment to `workerSecretsDocument()` and proves
that it accepts exactly `SESSION_PEPPER`, `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_OIDC_CLIENT_SECRET`, rejects a missing/blank value, never accepts Cloudflare credentials,
and writes JSON with mode `0o600` without logging values. This is also the first-deploy path: current
Wrangler cannot inherit required secrets from a Worker that does not exist yet.

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/tools -- src/render-wrangler-config.test.ts src/write-worker-secrets.test.ts`

Expected: FAIL because the renderer does not exist.

- [ ] **Step 3: Implement the renderer**

`render-wrangler-config.ts` exports the pure renderer and a CLI taking exactly
`--source <path> --target <path> --database-id <uuid> --api-origin <https-origin>
--telegram-client-id <digits> --rate-limit-namespace-ids <four-comma-separated-integers>` plus
optional `--android-fingerprints <comma-separated-list>`. It validates UUID with
`/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`, validates the API
URL as HTTPS with no credentials/path/query/fragment, validates every supplied nonblank fingerprint
with `/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/`, and requires each development sentinel exactly once.
It requires exactly four distinct positive safe integers for namespace IDs; these must be reserved
for this Worker in the target Cloudflare account.

The renderer performs these complete substitutions:

```text
database_id zero UUID                              → supplied D1 UUID
ENVIRONMENT development                            → production
TELEGRAM_OIDC_CLIENT_ID 123456789                  → supplied numeric client ID
API_ORIGIN https://a-move-ago-api.example.invalid  → supplied HTTPS origin
TELEGRAM_OIDC_CALLBACK_URL .invalid value          → ${API_ORIGIN}/v1/auth/telegram/oidc/callback
ANDROID_AUTH_RETURN_URL amoveago-debug://auth       → ${API_ORIGIN}/auth/android
ANDROID_SHA256_CERT_FINGERPRINTS empty string       → validated list, or remains empty/fail-closed
ratelimit IDs 900000001, ... 900000004              → four supplied account-unique IDs
```

It reparses the rendered JSONC through Wrangler's dry-run in the workflow, rejects any remaining
`.invalid`/debug/zero-UUID/rate-namespace sentinel, writes with mode `0o600`, and logs only the target path.

`write-worker-secrets.ts` accepts exactly `--target <path>`, reads only the three exact app-secret
environment variables named above, validates nonblank values (`SESSION_PEPPER` at least 32 bytes),
writes a Wrangler JSON secrets file with mode `0o600`, and logs only the target path. The file must be
created under runner temp, never under the checkout, and must never be uploaded as an artifact.

Add:

```json
"render:wrangler": "tsx src/render-wrangler-config.ts",
"write:worker-secrets": "tsx src/write-worker-secrets.ts"
```

Add `apps/api/wrangler.production.jsonc` to `.gitignore`. The generated config stays beside
`wrangler.jsonc`, so its relative `migrations_dir` continues to resolve to `apps/api/migrations`.

- [ ] **Step 4: Run GREEN**

Run: `npm test -w @a-move-ago/tools -- src/render-wrangler-config.test.ts src/write-worker-secrets.test.ts`

Expected: PASS for valid, malformed, missing and duplicate sentinel cases.

- [ ] **Step 5: Add the manual deployment workflow**

`.github/workflows/api.yml`:

```yaml
name: API

on:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: api-production
  cancel-in-progress: false

jobs:
  deploy:
    if: github.ref == 'refs/heads/main'
    environment: production
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - name: Validate deployment inputs
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          D1_DATABASE_ID: ${{ secrets.D1_DATABASE_ID }}
          SESSION_PEPPER: ${{ secrets.SESSION_PEPPER }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_OIDC_CLIENT_SECRET: ${{ secrets.TELEGRAM_OIDC_CLIENT_SECRET }}
          API_ORIGIN: ${{ vars.API_ORIGIN }}
          TELEGRAM_OIDC_CLIENT_ID: ${{ vars.TELEGRAM_OIDC_CLIENT_ID }}
          RATE_LIMIT_NAMESPACE_IDS: ${{ vars.RATE_LIMIT_NAMESPACE_IDS }}
        run: |
          test -n "$CLOUDFLARE_API_TOKEN"
          test -n "$CLOUDFLARE_ACCOUNT_ID"
          test -n "$D1_DATABASE_ID"
          test -n "$SESSION_PEPPER"
          test -n "$TELEGRAM_BOT_TOKEN"
          test -n "$TELEGRAM_OIDC_CLIENT_SECRET"
          test -n "$API_ORIGIN"
          test -n "$TELEGRAM_OIDC_CLIENT_ID"
          test -n "$RATE_LIMIT_NAMESPACE_IDS"
      - run: npm ci
      - run: npm run check
      - run: npm run typecheck
      - run: npm test -w @a-move-ago/api
      - run: npm run build -w @a-move-ago/api
      - name: Render remote config
        env:
          D1_DATABASE_ID: ${{ secrets.D1_DATABASE_ID }}
          API_ORIGIN: ${{ vars.API_ORIGIN }}
          TELEGRAM_OIDC_CLIENT_ID: ${{ vars.TELEGRAM_OIDC_CLIENT_ID }}
          ANDROID_SHA256_CERT_FINGERPRINTS: ${{ vars.ANDROID_SHA256_CERT_FINGERPRINTS }}
          RATE_LIMIT_NAMESPACE_IDS: ${{ vars.RATE_LIMIT_NAMESPACE_IDS }}
        run: >-
          npm run render:wrangler -w @a-move-ago/tools --
          --source ../apps/api/wrangler.jsonc
          --target ../apps/api/wrangler.production.jsonc
          --database-id "$D1_DATABASE_ID"
          --api-origin "$API_ORIGIN"
          --telegram-client-id "$TELEGRAM_OIDC_CLIENT_ID"
          --rate-limit-namespace-ids "$RATE_LIMIT_NAMESPACE_IDS"
          --android-fingerprints "$ANDROID_SHA256_CERT_FINGERPRINTS"
      - name: Materialize ephemeral Worker secrets
        env:
          SESSION_PEPPER: ${{ secrets.SESSION_PEPPER }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_OIDC_CLIENT_SECRET: ${{ secrets.TELEGRAM_OIDC_CLIENT_SECRET }}
        run: >-
          npm run write:worker-secrets -w @a-move-ago/tools --
          --target "$RUNNER_TEMP/worker-secrets.json"
      - name: Validate bundle with required secrets
        run: >-
          npx wrangler deploy --dry-run --config apps/api/wrangler.production.jsonc
          --secrets-file "$RUNNER_TEMP/worker-secrets.json"
      - name: Apply D1 migrations
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: >-
          npx wrangler d1 migrations apply a-move-ago --remote --config
          apps/api/wrangler.production.jsonc
      - name: Deploy Worker
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: >-
          npx wrangler deploy --config apps/api/wrangler.production.jsonc
          --secrets-file "$RUNNER_TEMP/worker-secrets.json"
      - name: Destroy ephemeral deployment files
        if: always()
        run: rm -f "$RUNNER_TEMP/worker-secrets.json" apps/api/wrangler.production.jsonc
```

Before the first dispatch, create D1 once, resolve the final Worker origin, and configure the three
Cloudflare deployment secrets, the three application secrets, and the four non-secret repository
variables used above. Keep `TELEGRAM_OIDC_CLIENT_ID` and the four account-unique rate-limit namespace
IDs in reviewed Worker vars and never pass a secret
as ordinary `--var`. `--secrets-file` supports the first deployment of a Worker that does not yet
exist and updates the same required secrets on later deployments; the ephemeral file stays in
`RUNNER_TEMP`, mode `0o600`, and is never printed or uploaded.
The workflow must fail before migrations when any required deployment input or app secret value is
missing. A blank signing-fingerprint variable is allowed only to keep `assetlinks.json` at the tested
`503 CONFIGURATION_ERROR`; configure a stable fingerprint before claiming production Android login.
No secret is scoped at job level: checkout, dependency lifecycle scripts, checks and tests receive
none of the Cloudflare or application credentials.

- [ ] **Step 6: Commit**

```bash
git add tools/src tools/package.json package-lock.json .gitignore .github/workflows/api.yml
git commit -m "ci: add manual Worker deployment"
```

### Task 8: Компилировать Android на Java 21 в CI

**Files:**
- Create: `.github/workflows/android.yml`

- [ ] **Step 1: Add Android workflow**

`.github/workflows/android.yml`:

```yaml
name: Android

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: android-${{ github.ref }}
  cancel-in-progress: true

jobs:
  debug:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      VITE_API_BASE_URL: ${{ vars.API_ORIGIN || 'https://api.invalid' }}
      VITE_ANDROID_ALLOW_DEBUG_SCHEME: "true"
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - uses: actions/setup-java@v5
        with:
          distribution: temurin
          java-version: 21
          cache: gradle
      - uses: android-actions/setup-android@v4
      - run: npm ci
      - name: Derive the one App Link host from the client API origin
        shell: bash
        run: |
          APP_LINK_HOST="$(node --input-type=module -e '
            const url = new URL(process.env.VITE_API_BASE_URL);
            if (url.protocol !== "https:" || url.username || url.password || url.hash || url.pathname !== "/" || url.search) {
              throw new Error("API_ORIGIN must be a bare HTTPS origin");
            }
            process.stdout.write(url.hostname);
          ')"
          test -n "$APP_LINK_HOST"
          echo "ORG_GRADLE_PROJECT_A_MOVE_AGO_APP_LINK_HOST=$APP_LINK_HOST" >> "$GITHUB_ENV"
      - run: npm run build:android:web -w @a-move-ago/client
      - run: npm run cap:sync:android -w @a-move-ago/client
      - run: npm run android:test -w @a-move-ago/client
      - uses: actions/upload-artifact@v7
        with:
          name: a-move-ago-android-debug
          if-no-files-found: error
          path: |
            apps/client/android/app/build/outputs/apk/debug/app-debug.apk
            apps/client/android/app/build/outputs/bundle/debug/app-debug.aab
```

- [ ] **Step 2: Verify the native gate on GitHub**

After push, run:

```bash
ANDROID_RUN_ID="$(gh run list --repo agent-axiom/a-move-ago --workflow android.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
test -n "$ANDROID_RUN_ID"
gh run watch "$ANDROID_RUN_ID" --repo agent-axiom/a-move-ago --exit-status
```

Expected: Java 21 setup, Capacitor sync, unit tests, lint, APK and AAB build all succeed. Download
the artifact and verify filenames only; do not publish to Google Play.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/android.yml
git commit -m "ci: build Android debug artifacts"
```

### Task 9: Выполнить final gate, создать публичный GitHub repo и включить Pages

**Files:**
- Verify: complete repository
- Remote create/push: `agent-axiom/a-move-ago`

- [ ] **Step 1: Run the complete local gate from a clean install**

Run separately: `npm ci`

Run separately: `npm run check`

Run separately: `npm run typecheck`

Run separately: `npm test`

Run separately: `npm run content:validate`

Run separately: `VITE_API_BASE_URL=https://api.test npm run build:pages -w @a-move-ago/client`

Run separately: `VITE_API_BASE_URL=https://api.test VITE_ANDROID_ALLOW_DEBUG_SCHEME=true npm run build:android:web -w @a-move-ago/client`

Run separately: `npm run verify:artifacts -w @a-move-ago/client`

Run separately: `npx playwright install --with-deps chromium`

Run separately: `npm run e2e -w @a-move-ago/client`

Run separately: `npm run build -w @a-move-ago/api`

Run separately: `git diff --check`

Expected: all commands exit `0`. `git status --short` shows no generated build artifacts or secrets.
If local Java/Android SDK exists, also run `npm run android:test -w @a-move-ago/client`; otherwise the
Android workflow is the required native compile gate.

- [ ] **Step 2: Audit public-repository contents**

Run: `git ls-files | sort`

Inspect every path under `content/`, `.github/`, `apps/client/public/` and all `.env.example` files.

Run: `rg -n --hidden -g '!package-lock.json' '(TELEGRAM_BOT_TOKEN=.+|TELEGRAM_OIDC_CLIENT_SECRET=.+|SESSION_PEPPER=.+|CLOUDFLARE_API_TOKEN=.+|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)' .`

Expected: no assigned secret or private key. Variable names in examples/docs are allowed only with
empty values or explanatory text. Confirm the only puzzle source is `content/samples/2026-08-03.json`.

- [ ] **Step 3: Create or attach the exact public remote**

First run read-only:

```bash
gh repo view agent-axiom/a-move-ago --json nameWithOwner,visibility,url
```

If it does not exist:

```bash
gh repo create agent-axiom/a-move-ago --public --source=. --remote=origin --description "Daily retro-chess: reconstruct what happened one move ago"
```

If it exists, verify `visibility` is `PUBLIC`, then add only the exact remote:

```bash
git remote add origin https://github.com/agent-axiom/a-move-ago.git
```

If `origin` already exists, require `git remote get-url origin` to equal the same URL; do not replace
an unrelated remote silently.

- [ ] **Step 4: Push main and enable workflow-based Pages**

```bash
git push -u origin main
gh api --method POST repos/agent-axiom/a-move-ago/pages -f build_type=workflow
```

If the Pages API reports that Pages already exists, verify its `build_type` is `workflow` with:

```bash
gh api repos/agent-axiom/a-move-ago/pages
```

- [ ] **Step 5: Observe all CI, then enable live Pages when the Worker exists**

Run: `gh run list --repo agent-axiom/a-move-ago --limit 10`

Wait for `CI` and `Android` to complete successfully. `Pages` is expected to skip until
`API_ORIGIN` is configured.

After a successful Worker deployment, confirm its bare HTTPS origin in the single `API_ORIGIN`
variable already used by the Worker preflight. Pages passes that value as `VITE_API_BASE_URL`, and
the Android workflow derives its manifest host from it; no
independent host setting may drift from the client API origin. Add the real release/debug signing
fingerprints to Worker configuration, then dispatch Pages and Android workflows:

```bash
gh workflow run pages.yml --repo agent-axiom/a-move-ago
gh workflow run android.yml --repo agent-axiom/a-move-ago
```

Expected live web URL: `https://agent-axiom.github.io/a-move-ago/`.

Production Telegram login remains fail-closed until BotFather callback/Mini App URLs and Worker
secrets are configured. Repository creation and CI do not authorize inventing those external values.

## Milestone exit

- Один source tree выпускает Pages/Telegram artifact с `/a-move-ago/` и Capacitor artifact с `/`.
- Android debug app compiles at API 24+ under Java 21 and receives only verified HTTPS or debug-only
  custom-scheme auth returns.
- Worker publishes valid `assetlinks.json` only with configured signing fingerprints.
- CI, Pages, API and Android workflows have minimal permissions and explicit deployment gates.
- Public repo contains AGPL code, CC BY samples, no production corpus, secrets, keystores or signed
  binaries.
- `main` is pushed to `agent-axiom/a-move-ago`; Pages becomes live only after the real API origin is
  configured.
