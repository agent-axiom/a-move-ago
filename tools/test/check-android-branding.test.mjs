import assert from "node:assert/strict";
import test from "node:test";
import {
  brandPaths,
  verifyLauncherReferences,
  verifyPackagedBranding,
  verifySourceBranding,
} from "../scripts/check-android-branding.mjs";

const paths = ["M1 2L3 4Z", "M5 6L7 8Z"];
const vector = paths.join("\n");
const adaptive =
  "E: adaptive-icon\n E: background\n  A: android:drawable(0x1010199)=@0x7f050000\n E: foreground\n  A: android:drawable(0x1010199)=@0x7f080000\n E: monochrome\n  A: android:drawable(0x1010199)=@0x7f080001";
const files = [
  "res/drawable/ic_launcher_foreground.xml",
  "res/drawable/ic_launcher_monochrome.xml",
  ...["", "-v26", "-v33"].flatMap((version) => [
    `res/mipmap-anydpi${version}/ic_launcher.xml`,
    `res/mipmap-anydpi${version}/ic_launcher_round.xml`,
  ]),
];
const inspect = (file) => (/-v(?:26|33)\//.test(file) ? adaptive : vector);
function tableFor(map = (file) => file) {
  return [
    "resource 0x7f080000 drawable/ic_launcher_foreground",
    ` () (file) ${map(files[0])} type=XML`,
    "resource 0x7f080001 drawable/ic_launcher_monochrome",
    ` () (file) ${map(files[1])} type=XML`,
    "resource 0x7f050000 color/ic_launcher_background",
    ...["ic_launcher", "ic_launcher_round"].flatMap((name, index) => [
      `resource 0x7f0e000${index} mipmap/${name}`,
      ...["", "-v26", "-v33"].map(
        (version, i) =>
          ` (anydpi-v${[21, 26, 33][i]}) (file) ${map(`res/mipmap-anydpi${version}/${name}.xml`)} type=XML`,
      ),
    ]),
  ].join("\n");
}
const table = tableFor();

test("manifest icons resolve to the verified resources", () => {
  const manifest = "android:icon(0x1010002)=@0x7f0e0000\nandroid:roundIcon(0x101052c)=@0x7f0e0001";
  verifyLauncherReferences(manifest, table);
  assert.throws(
    () => verifyLauncherReferences(manifest.replace("@0x7f0e0000", "@0x7f0e0002"), table),
    /BRAND_LAUNCHER_REFERENCE_MISMATCH/,
  );
});

test("the listing mark matches all Android source vectors", async () => {
  assert.equal((await verifySourceBranding()).paths.length, 2);
  assert.deepEqual(brandPaths('<svg><path d="M1 2L3 4Z"/><path d="M5 6L7 8Z"/></svg>'), paths);
  assert.throws(() => brandPaths("<svg/>"), /BRAND_CANONICAL_PATHS_REQUIRED/);
});

test("compiled APK vectors must contain the same mark", () => {
  assert.equal(verifyPackagedBranding(files, inspect, paths, table).checkedVectors.length, 4);
  for (const replaced of files.slice(0, 4)) {
    assert.throws(
      () =>
        verifyPackagedBranding(
          files,
          (file) => (file === replaced ? "Capacitor default" : inspect(file)),
          paths,
          table,
        ),
      /BRAND_PACKAGED_MARK_MISMATCH/,
    );
  }
});

test("release optimization may deduplicate or shorten resource paths", () => {
  const deduplicate = (file) => (/-v(?:26|33)\//.test(file) ? file.replace("_round", "") : file);
  const unique = [...new Set(files.map(deduplicate))];
  assert.equal(
    verifyPackagedBranding(unique, inspect, paths, tableFor(deduplicate)).adaptiveVariants,
    2,
  );
  const names = new Map(unique.map((file, index) => [file, `res/a${index}.xml`]));
  const shorten = (file) => names.get(deduplicate(file));
  const reverse = new Map([...names].map(([a, b]) => [b, a]));
  assert.equal(
    verifyPackagedBranding(
      [...names.values()],
      (file) => inspect(reverse.get(file)),
      paths,
      tableFor(shorten),
    ).adaptiveVariants,
    2,
  );
});

test("obsolete rasters and missing packaged resources fail closed", () => {
  for (const extension of ["png", "webp"]) {
    assert.throws(
      () =>
        verifyPackagedBranding(
          [...files, `res/mipmap-hdpi-v4/ic_launcher.${extension}`],
          inspect,
          paths,
          table,
        ),
      /BRAND_OBSOLETE_RASTER_ICON/,
    );
  }
  assert.throws(
    () => verifyPackagedBranding(files.slice(1), inspect, paths, table),
    /BRAND_PACKAGED_RESOURCE_MISSING/,
  );
});

test("adaptive icons cannot reference a different background, foreground or monochrome", () => {
  for (const id of ["0x7f080000", "0x7f080001", "0x7f050000"]) {
    assert.throws(
      () =>
        verifyPackagedBranding(
          files,
          (file) => inspect(file).replaceAll(id, "0x7f080002"),
          paths,
          table,
        ),
      /BRAND_ADAPTIVE_REFERENCE_MISMATCH/,
    );
  }
});
