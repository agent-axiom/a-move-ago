import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./check-production-play.mjs";

/** Bootstrap and ordinary content imports never exercise the privileged localized flow. */
export async function runLocalizedCli(
  args,
  env,
  { readFile: read = readFile, access: exists = access, log = console.log, errorLog = console.error, ...deps } = {},
) {
  try {
    if (args.length !== 0) throw new Error("UNEXPECTED_ARGUMENTS");
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const request = JSON.parse(await read(resolve(root, "ops/content-key-request.json"), "utf8"));
    let envelopePresent = true;
    try {
      await exists(resolve(root, "ops/content-envelope.json"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      envelopePresent = false;
    }
    if (request?.purpose !== "localization" || !envelopePresent) {
      log(JSON.stringify({ skipped: true, reason: "NO_LOCALIZATION_PUBLICATION" }));
      return 0;
    }
    return await runCli([], { ...env, CHECK_LOCALIZATIONS: "true" }, { ...deps, log, errorLog });
  } catch {
    errorLog(JSON.stringify({ ok: false, code: "LOCALIZED_PLAY_CHECK_FAILED" }));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runLocalizedCli(process.argv.slice(2), process.env);
}
