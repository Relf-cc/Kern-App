/**
 * @Author Christian Relf
 * @Date 2026-10-14
 */

// Builds signed Windows installers and the updater manifest (latest.json),
// and optionally publishes them as the GitHub release for the current
// version.
//
//   node scripts/release.mjs --notes notes.md            build + manifest
//   node scripts/release.mjs --notes notes.md --publish  ...then publish
//   add --security for a security release: installs update to it without
//   asking (it marks the notes with <!-- kern:security -->)
//   add --linux release/linux to include the Linux bundles in the release
//
// Linux bundles can't be built here: they're made in the Ubuntu container
// under scripts/linux (so the glibc baseline stays low) and copied to a
// folder, which --linux then points at. A signed AppImage joins latest.json
// as the linux-x86_64 target; an unsigned one is attached as a download
// only.
//
// The updater signing key is read from TAURI_SIGNING_PRIVATE_KEY, or the file
// at KERN_UPDATER_KEY, or ~/.tauri/kern-updater.key. Keep that file backed
// up: installs only accept updates signed with it (the public half is in
// tauri.conf.json under plugins.updater.pubkey).
//
// Publishing needs the tag v<version> pushed to origin first, so the release
// can't be created against the wrong commit.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = "Relf-cc/Kern-App";
const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

// Windows runs commands through the shell (for npx), so paths and spaced
// values need quoting there.
const q = (s) => (process.platform === "win32" ? `"${s}"` : s);

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (r.status !== 0) fail(`${cmd} ${cmdArgs.join(" ")} exited with ${r.status}`);
  return r;
}

function output(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ------------------------------------------------------------ version

const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (pkg.version !== version || cargo !== version) fail(`Versions disagree: tauri.conf.json ${version}, package.json ${pkg.version}, Cargo.toml ${cargo}.`);
if (!conf.plugins?.updater?.pubkey) fail("tauri.conf.json has no plugins.updater.pubkey.");

const notesPath = option("--notes");
if (!notesPath) fail("Pass the release notes: --notes <file.md>");
if (!existsSync(notesPath)) fail(`No notes at ${notesPath}`);
const MARKER = "<!-- kern:security -->";
let notes = readFileSync(notesPath, "utf8").trim();
if (flag("--security") && !notes.toLowerCase().includes(MARKER)) notes = `${MARKER}\n${notes}`;
if (notes.toLowerCase().includes(MARKER)) console.log("\n! Security release: installs will update to it without asking.");

// ------------------------------------------------------------ signing key

let key = process.env.TAURI_SIGNING_PRIVATE_KEY;
if (!key) {
  const keyPath = process.env.KERN_UPDATER_KEY || join(homedir(), ".tauri", "kern-updater.key");
  if (!existsSync(keyPath)) fail(`No updater signing key: set TAURI_SIGNING_PRIVATE_KEY or KERN_UPDATER_KEY, or put it at ${keyPath}.`);
  key = readFileSync(keyPath, "utf8").trim();
}

// ------------------------------------------------------------ build

console.log(`\n▸ Building Kern ${version} with updater artifacts…\n`);
// Updater artifacts are only made for releases, so everyday builds don't
// need the key.
const work = mkdtempSync(join(tmpdir(), "kern-release-"));
const overrides = join(work, "release.conf.json");
writeFileSync(overrides, JSON.stringify({ bundle: { createUpdaterArtifacts: true } }));
// The notes as published (with the security marker, when there is one).
const publishedNotes = join(work, "notes.md");
writeFileSync(publishedNotes, notes + "\n");
run("npx", ["tauri", "build", "--config", q(overrides)], {
  env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" },
});

// ------------------------------------------------------------ manifest

const bundle = join(root, "src-tauri/target/release/bundle");
const artifacts = {
  nsis: join(bundle, "nsis", `Kern_${version}_x64-setup.exe`),
  msi: join(bundle, "msi", `Kern_${version}_x64_en-US.msi`),
};

// The MCP extension bundle (scripts/mcp-bundle.mjs, run by the build) is
// attached as a plain download: it installs Kern into Claude Desktop, and has
// nothing to do with the updater.
const mcpbSource = join(root, "src-tauri/binaries/kern.mcpb");
let mcpb = null;
if (existsSync(mcpbSource)) {
  mcpb = join(bundle, `Kern_${version}.mcpb`);
  copyFileSync(mcpbSource, mcpb);
  console.log(`\n✓ ${mcpb}`);
} else {
  console.log("\n! No kern.mcpb was built, so the Claude Desktop extension won't be attached.");
}

const platform = (file) => {
  if (!existsSync(file) || !existsSync(`${file}.sig`)) fail(`Missing ${file} or its .sig - was the build signed?`);
  const name = file.split(/[\\/]/).pop();
  return { signature: readFileSync(`${file}.sig`, "utf8").trim(), url: `https://github.com/${REPO}/releases/download/v${version}/${name}` };
};

// ------------------------------------------------------------ linux bundles

const base = (f) => f.split(/[\\/]/).pop();
const linuxDir = option("--linux");
let linuxFiles = [];
let linuxAppImage = null;
if (linuxDir) {
  if (!existsSync(linuxDir)) fail(`No Linux bundles at ${linuxDir} - build them first (see scripts/linux/build.sh).`);
  const names = readdirSync(linuxDir);
  const pick = (ext) => names.filter((n) => n.endsWith(ext)).map((n) => join(linuxDir, n));
  const found = { ".deb": pick(".deb"), ".rpm": pick(".rpm"), ".AppImage": pick(".AppImage") };
  for (const [ext, list] of Object.entries(found)) {
    if (!list.length) fail(`No ${ext} in ${linuxDir} - the container build didn't finish.`);
    if (list.length > 1) fail(`More than one ${ext} in ${linuxDir} (${list.map(base).join(", ")}). Empty it and rebuild.`);
  }
  linuxFiles = [found[".deb"][0], found[".rpm"][0], found[".AppImage"][0]];
  // Stale bundles from an earlier version would otherwise be published as
  // though they were this one.
  for (const f of linuxFiles) {
    if (!base(f).includes(version)) fail(`${base(f)} isn't version ${version}. Empty ${linuxDir} and rebuild.`);
  }
  linuxAppImage = found[".AppImage"][0];
  if (!existsSync(`${linuxAppImage}.sig`)) {
    console.log(`\n! ${base(linuxAppImage)} has no .sig, so Linux installs won't update themselves.`);
    console.log("  Rebuild with TAURI_SIGNING_PRIVATE_KEY set in the container to sign it.");
    linuxAppImage = null;
  }
  console.log(`\n✓ Linux bundles: ${linuxFiles.map(base).join(", ")}`);
}
// The oldest version without known security issues. Installs older than it
// must update (see check_for_update). It's carried forward from the release
// being replaced, so skipping a security release doesn't make it optional;
// a security release raises it to itself.
const cmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split("-")[0].split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
};
const res = await fetch(`https://github.com/${REPO}/releases/latest/download/latest.json`);
if (!res.ok && res.status !== 404) fail(`Couldn't read the published latest.json (${res.status}), so the minimum secure version can't be carried forward.`);
const previous = res.ok ? await res.json() : null;
let minSecure = previous?.kern?.minSecureVersion ?? null;
if (previous?.notes?.toLowerCase().includes(MARKER) && (!minSecure || cmp(previous.version, minSecure) > 0)) minSecure = previous.version;
if (notes.toLowerCase().includes(MARKER)) minSecure = version;
if (minSecure) console.log(`\nMinimum secure version: ${minSecure}${minSecure === version ? " (this release)" : " (carried forward)"}`);

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  ...(minSecure ? { kern: { minSecureVersion: minSecure } } : {}),
  platforms: {
    // The updater picks "<os>-<arch>-<installer>" first, matching how Kern
    // was installed, then falls back to "<os>-<arch>".
    "windows-x86_64": platform(artifacts.nsis),
    "windows-x86_64-nsis": platform(artifacts.nsis),
    "windows-x86_64-msi": platform(artifacts.msi),
    // Only the AppImage can update itself; .deb and .rpm are the package
    // manager's business, so they're downloads only.
    ...(linuxAppImage ? { "linux-x86_64": platform(linuxAppImage), "linux-x86_64-appimage": platform(linuxAppImage) } : {}),
  },
};
const manifestPath = join(bundle, "latest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`\n✓ Signed installers and ${manifestPath}`);

// ------------------------------------------------------------ publish

if (!flag("--publish")) {
  console.log(`\nNot published. To publish: push tag v${version}, then re-run with --publish.`);
  process.exit(0);
}
const tag = `v${version}`;
if (!output("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])) fail(`Tag ${tag} isn't on origin yet - push it first.`);
console.log(`\n▸ Publishing ${tag}…\n`);
run("gh", [
  "release", "create", tag,
  "--repo", REPO,
  "--title", q(`Kern ${version}`),
  "--notes-file", q(publishedNotes),
  ...[artifacts.nsis, artifacts.msi, ...(mcpb ? [mcpb] : []), ...linuxFiles, manifestPath].map(q),
]);
console.log(`\n✓ Released https://github.com/${REPO}/releases/tag/${tag}`);
