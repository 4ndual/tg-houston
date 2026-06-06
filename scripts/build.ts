// Build the standalone tg binary with embedded API credentials and assemble
// the release payload (binary + libtdjson.dylib + SHA256SUMS) under dist/.
//
// Usage:
//   TG_BUILD_API_ID=... TG_BUILD_API_HASH=... bun run build
//
// Credentials come ONLY from env at build time (CI repo secrets locally or in
// Actions); they are never committed.

import { $ } from "bun";
import { join } from "path";
import { mkdirSync, copyFileSync, existsSync } from "fs";

const apiId = process.env.TG_BUILD_API_ID;
const apiHash = process.env.TG_BUILD_API_HASH;
if (!apiId || !apiHash) {
  console.error("Missing TG_BUILD_API_ID / TG_BUILD_API_HASH (get them at https://my.telegram.org/apps)");
  process.exit(1);
}

const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
const version: string = process.env.TG_BUILD_VERSION || pkg.version;

const root = join(import.meta.dir, "..");
const payload = join(root, "dist", "tg-houston");
mkdirSync(join(payload, "bin"), { recursive: true });
mkdirSync(join(payload, "lib"), { recursive: true });

await $`bun build ${join(root, "src/cli.ts")} --compile --outfile ${join(payload, "bin/tg")} \
  --define __TG_API_ID__=${JSON.stringify(apiId)} \
  --define __TG_API_HASH__=${JSON.stringify(apiHash)} \
  --define __TG_VERSION__=${JSON.stringify(version)}`;

const { getTdjson } = await import("prebuilt-tdlib");
const dylib = getTdjson();
if (!existsSync(dylib)) {
  console.error(`prebuilt-tdlib dylib not found at ${dylib}`);
  process.exit(1);
}
copyFileSync(dylib, join(payload, "lib", "libtdjson.dylib"));

// Fixed (unversioned) asset name so the GitHub `releases/latest/download/` URL
// is stable; the version is embedded in the binary (`tg --version`).
const tarballName = "tg-houston-darwin-arm64.tar.gz";
const tarball = join(root, "dist", tarballName);
await $`tar -czf ${tarball} -C ${join(root, "dist")} tg-houston`;
const sums = await $`cd ${join(root, "dist")} && shasum -a 256 ${tarballName}`.text();
await Bun.write(join(root, "dist", "SHA256SUMS"), sums);
console.log(sums.trim());

console.log(`\nbuilt: ${tarball}`);
console.log(`binary: ${join(payload, "bin/tg")} (version ${version})`);
