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
const table =
  "resource 0x7f080000 drawable/ic_launcher_foreground\nresource 0x7f080001 drawable/ic_launcher_monochrome\nresource 0x7f050000 color/ic_launcher_background\n";
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

test("the installed application's normal and round icons resolve to the verified resources", () => {
  const manifest = "android:icon(0x1010002)=@0x7f0e0000\nandroid:roundIcon(0x101052c)=@0x7f0e0001";
  const table =
    "resource 0x7f0e0000 mipmap/ic_launcher\nresource 0x7f0e0001 com.agentaxiom.amoveago:mipmap/ic_launcher_round\n";
  verifyLauncherReferences(manifest, table);
  assert.throws(
    () => verifyLauncherReferences(manifest.replace("@0x7f0e0000", "@0x7f0e0002"), table),
    /BRAND_LAUNCHER_REFERENCE_MISMATCH/,
  );
});

test("the listing mark matches legacy, round, adaptive and themed Android sources", async () => {
  const result = await verifySourceBranding();
  assert.equal(result.paths.length, 2);
  assert.deepEqual(
    brandPaths('<svg><path fill="white" d="M1 2L3 4Z"/><path d="M5 6L7 8Z"/></svg>'),
    paths,
  );
});

test("compiled APK vectors must contain the same mark in all drawable variants", () => {
  const report = verifyPackagedBranding(files, inspect, paths, table);
  assert.equal(report.checkedVectors.length, 4);
  assert.equal(report.adaptiveVariants, 4);
  for (const replaced of [files[0], files[1], files[2], files[3]]) {
    assert.throws(
      () =>
        verifyPackagedBranding(
          files,
          (file) => (file === replaced ? "Capacitor default" : inspect(file)),
          paths,
        ),
      /BRAND_PACKAGED_MARK_MISMATCH/,
    );
  }
});

test("old density raster icons and missing legacy/adaptive/themed variants fail closed", () => {
  assert.throws(
    () => verifyPackagedBranding([...files, "res/mipmap-hdpi-v4/ic_launcher.png"], inspect, paths),
    /BRAND_OBSOLETE_RASTER_ICON/,
  );
  assert.throws(
    () => verifyPackagedBranding(files.slice(1), inspect, paths),
    /BRAND_ICON_VARIANTS_MISSING/,
  );
  assert.throws(
    () => verifyPackagedBranding(files, () => "adaptive-icon", paths),
    /BRAND_PACKAGED_MARK_MISMATCH/,
  );
  assert.throws(() => brandPaths("<svg/>"), /BRAND_CANONICAL_PATHS_REQUIRED/);
});

test("adaptive icons cannot point to an unverified foreground or monochrome", () => {
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
