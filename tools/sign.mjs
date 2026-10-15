#!/usr/bin/env node
/*
 * Runs electron-builder with the local signing identity attached.
 *
 * electron-builder only signs when it is handed a certificate, and a
 * certificate with a private key cannot live in the repository -- so the
 * identity lives outside the checkout, under %USERPROFILE%\.infantgod, and this
 * wrapper is what connects the two.  That keeps `npm run dist` unchanged on a
 * machine that has an identity, and still works on one that does not (it warns
 * and builds unsigned rather than failing).
 *
 * Anything already in CSC_LINK / CSC_KEY_PASSWORD wins, which is how a real
 * certificate -- or a CI secret -- is used without touching this file.
 *
 *   node tools/sign.mjs --win --x64
 *   node tools/sign.mjs --win --x64 --dir
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

const IDENTITY_DIR = join(process.env.USERPROFILE || homedir(), ".infantgod");
const PFX = join(IDENTITY_DIR, "codesign.pfx");
const PASSWORD_FILE = join(IDENTITY_DIR, "codesign.pw");

const env = { ...process.env };

if (env.CSC_LINK) {
  console.log("sign: using the certificate from CSC_LINK");
} else if (existsSync(PFX) && existsSync(PASSWORD_FILE)) {
  env.CSC_LINK = PFX;
  env.CSC_KEY_PASSWORD = readFileSync(PASSWORD_FILE, "utf8").trim();
  console.log(`sign: using ${PFX}`);
} else {
  console.log("sign: no signing identity found; this build will be unsigned.");
  console.log("sign: run `npm run cert` to make a self-signed one.");
}

/*
 * Resolve electron-builder's own entry point instead of going through `npx`:
 * npx is a .cmd shim on Windows, and spawning one from Node without a shell is
 * the kind of thing that works until a path has a space in it.
 */
const CLI = join(REPO, "node_modules", "electron-builder", "out", "cli", "cli.js");
if (!existsSync(CLI)) {
  console.error(`sign: ${CLI} is missing -- run npm install first`);
  process.exit(1);
}

const child = spawn(process.execPath, [CLI, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: REPO,
  env,
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
