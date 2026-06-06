import { createClient, configure } from "tdl";
import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { EMBEDDED_API_ID, EMBEDDED_API_HASH, VERSION } from "../build-config";

let configured = false;

/** Root for all tg-houston state (session db, downloaded files, bundled dylib). */
export function tgHoustonHome(): string {
  return process.env.TG_HOUSTON_HOME || join(homedir(), ".tg-houston");
}

function resolveTdjson(): string {
  if (process.env.TG_TDJSON) return process.env.TG_TDJSON;
  // The release tarball ships bin/tg and lib/libtdjson.dylib as siblings, so
  // resolve relative to the compiled binary first — works from any install
  // location and independently of where session data (TG_HOUSTON_HOME) lives.
  const besideBinary = join(process.execPath, "..", "..", "lib", "libtdjson.dylib");
  if (existsSync(besideBinary)) return besideBinary;
  const installed = join(tgHoustonHome(), "lib", "libtdjson.dylib");
  if (existsSync(installed)) return installed;
  // Dev fallback: running from the repo with node_modules present.
  try {
    const { getTdjson } = require("prebuilt-tdlib");
    return getTdjson();
  } catch {
    throw new Error(
      `libtdjson.dylib not found — expected at ${besideBinary}. Reinstall tg-houston (re-extract the release tarball).`,
    );
  }
}

export function createTelegramClient() {
  if (!configured) {
    configure({ tdjson: resolveTdjson(), verbosityLevel: 0 });
    configured = true;
  }

  const apiId = process.env.TELEGRAM_API_ID || EMBEDDED_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH || EMBEDDED_API_HASH;
  if (!apiId || !apiHash) {
    console.error(
      "No Telegram API credentials. This build has none embedded — set TELEGRAM_API_ID and TELEGRAM_API_HASH (from https://my.telegram.org/apps).",
    );
    process.exit(1);
  }

  const dataPath = join(tgHoustonHome(), "data", "tdlib");
  return createClient({
    apiId: parseInt(apiId, 10),
    apiHash,
    databaseDirectory: join(dataPath, "db"),
    filesDirectory: join(dataPath, "files"),
    tdlibParameters: {
      device_model: "tg-houston",
      application_version: VERSION,
      system_language_code: "en",
    },
  });
}
