import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const resources = join(root, "apps/client/android/app/src/main/res");

function ensure(condition, code) {
  if (!condition) throw new Error(code);
}

export function brandPaths(svg) {
  const paths = [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((match) => match[1]);
  ensure(paths.length === 2, "BRAND_CANONICAL_PATHS_REQUIRED");
  return paths;
}

export function verifyLauncherReferences(manifest, table) {
  for (const [attribute, name] of [
    ["icon", "ic_launcher"],
    ["roundIcon", "ic_launcher_round"],
  ]) {
    const id = new RegExp(`resource (0x[0-9a-f]+) (?:[^:\\s]+:)?mipmap/${name}(?:\\s|$)`, "i").exec(
      table,
    )?.[1];
    ensure(
      id &&
        new RegExp(`android:${attribute}\\([^)]*\\)=(?:@|\\(type 0x01\\))${id}\\b`, "i").test(
          manifest,
        ),
      "BRAND_LAUNCHER_REFERENCE_MISMATCH",
    );
  }
}

export function verifyPackagedBranding(files, inspect, paths, table) {
  ensure(
    !files.some((file) => /\/ic_launcher(?:_foreground|_round)?\.(?:png|webp|jpe?g)$/.test(file)),
    "BRAND_OBSOLETE_RASTER_ICON",
  );
  const foregrounds = files.filter((file) =>
    /^res\/drawable[^/]*\/ic_launcher_foreground\.xml$/.test(file),
  );
  const monochromes = files.filter((file) =>
    /^res\/drawable[^/]*\/ic_launcher_monochrome\.xml$/.test(file),
  );
  const launchers = files.filter((file) =>
    /^res\/mipmap-anydpi(?:-v\d+)?\/ic_launcher(?:_round)?\.xml$/.test(file),
  );
  ensure(
    foregrounds.length > 0 && monochromes.length > 0 && launchers.length >= 6,
    "BRAND_ICON_VARIANTS_MISSING",
  );
  const checked = [...foregrounds, ...monochromes];
  for (const file of checked) {
    const xml = inspect(file);
    ensure(
      paths.every((path) => xml.includes(path)),
      "BRAND_PACKAGED_MARK_MISMATCH",
    );
  }
  let legacyCount = 0;
  for (const file of launchers) {
    const xml = inspect(file);
    if (xml.includes("adaptive-icon")) {
      for (const [element, name] of [
        ["background", "color/ic_launcher_background"],
        ["foreground", "drawable/ic_launcher_foreground"],
        ...(/-v33\//.test(file) ? [["monochrome", "drawable/ic_launcher_monochrome"]] : []),
      ]) {
        const id = new RegExp(`resource (0x[0-9a-f]+) (?:[^:\\s]+:)?${name}(?:\\s|$)`, "i").exec(
          table,
        )?.[1];
        const section = xml.split(`E: ${element}`)[1]?.split(/\bE:/)[0] ?? "";
        ensure(
          id &&
            new RegExp(`android:drawable\\([^)]*\\)=(?:@|\\(type 0x01\\))${id}\\b`, "i").test(
              section,
            ),
          "BRAND_ADAPTIVE_REFERENCE_MISMATCH",
        );
      }
      continue;
    }
    ensure(
      paths.every((path) => xml.includes(path)),
      "BRAND_PACKAGED_MARK_MISMATCH",
    );
    legacyCount++;
    checked.push(file);
  }
  ensure(legacyCount === 2, "BRAND_LEGACY_ICONS_MISSING");
  return { checkedVectors: checked, adaptiveVariants: launchers.length - legacyCount };
}

export async function verifySourceBranding() {
  const svg = await readFile(join(root, "assets/branding/app-icon.svg"), "utf8");
  const paths = brandPaths(svg);
  for (const file of [
    "drawable/ic_launcher_foreground.xml",
    "drawable/ic_launcher_monochrome.xml",
    "mipmap-anydpi/ic_launcher.xml",
    "mipmap-anydpi/ic_launcher_round.xml",
  ]) {
    const xml = await readFile(join(resources, file), "utf8");
    ensure(
      paths.every((path) => xml.includes(`android:pathData="${path}"`)),
      "BRAND_SOURCE_MARK_MISMATCH",
    );
  }
  return { svg, paths };
}

export async function main(args = process.argv.slice(2)) {
  const { svg, paths } = await verifySourceBranding();
  if (args.length === 1 && args[0] === "--source-only") {
    console.log(JSON.stringify({ ok: true, sourceBrandingVerified: true }));
    return;
  }
  ensure(
    args.length === 4 && args[0] === "--apk" && args[2] === "--output",
    "BRAND_CLI_ARGUMENTS_REQUIRED",
  );
  const apk = resolve(args[1]);
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  ensure(typeof sdk === "string" && sdk.length > 0, "BRAND_ANDROID_SDK_REQUIRED");
  const run = (file, argv) =>
    execFileSync(file, argv, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const files = run("unzip", ["-Z", "-1", apk]).trim().split("\n");
  const aapt = join(sdk, "build-tools/36.0.0/aapt2");
  const table = run(aapt, ["dump", "resources", apk]);
  verifyLauncherReferences(
    run(aapt, ["dump", "xmltree", apk, "--file", "AndroidManifest.xml"]),
    table,
  );
  const result = verifyPackagedBranding(
    files,
    (file) => run(aapt, ["dump", "xmltree", apk, "--file", file]),
    paths,
    table,
  );
  const output = resolve(args[3]);
  await mkdir(output, { recursive: true });
  const { default: sharp } = await import("sharp");
  const png = await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer();
  ensure(png.length <= 1024 * 1024, "BRAND_STORE_ICON_TOO_LARGE");
  await writeFile(join(output, "app-icon-512.png"), png);
  const report = {
    ok: true,
    ...result,
    apkSha256: createHash("sha256")
      .update(await readFile(apk))
      .digest("hex"),
    storeIconSha256: createHash("sha256").update(png).digest("hex"),
    storeIconSize: [512, 512],
  };
  await writeFile(
    join(output, "branding-verification.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
