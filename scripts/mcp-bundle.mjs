/**
 * @Author Christian Relf
 * @Date 2026-10-23
 */

// Prepares the two things an installed copy of Kern needs in order to be an
// MCP server for a client on this computer:
//
//   src-tauri/binaries/kern-mcp-<target triple>[.exe]   the bridge sidecar
//   src-tauri/binaries/kern.mcpb                       the extension bundle
//
// Tauri ships the first as `bundle.externalBin` (installed beside kern.exe
// as kern-mcp.exe) and the second as `bundle.resources`. `domain/mcp` looks
// for both beside the app and under binaries/, so a development run finds
// whatever is there and an installed copy finds the installed ones.
//
//   node scripts/mcp-bundle.mjs            build the bridge, then bundle it
//   node scripts/mcp-bundle.mjs --no-build use the binary already built
//
// It runs from `beforeBuildCommand`, so every `tauri build` has them. The
// .mcpb is Anthropic's extension format (a zip with a manifest at its root):
// dragging it onto Claude Desktop's Extensions page installs Kern there, with
// no settings file to edit. The zip is written here rather than with a
// library — it holds two small files, and the bridge itself has no
// dependencies either.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function output(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
  return r.status === 0 ? r.stdout : null;
}

// ------------------------------------------------------------ the bridge

const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const exe = process.platform === "win32" ? ".exe" : "";

const rustc = output("rustc", ["-vV"]);
const triple = rustc?.match(/^host:\s*(\S+)$/m)?.[1];
if (!triple) fail("Couldn't ask rustc for the host target triple - is Rust installed?");

if (!args.includes("--no-build")) {
  console.log("\n▸ Building the kern-mcp bridge…");
  const r = spawnSync("cargo", ["build", "--release", "-p", "kern-mcp"], {
    cwd: join(root, "src-tauri"),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) fail(`cargo build -p kern-mcp exited with ${r.status}`);
}

const built = join(root, "src-tauri/target/release", `kern-mcp${exe}`);
if (!existsSync(built)) fail(`No bridge at ${built}. Run without --no-build.`);

const binaries = join(root, "src-tauri/binaries");
mkdirSync(binaries, { recursive: true });
// Tauri looks for the sidecar under its own target triple and installs it
// beside the app with the triple removed.
const sidecar = join(binaries, `kern-mcp-${triple}${exe}`);
copyFileSync(built, sidecar);

// ------------------------------------------------------------ the zip

/** CRC-32, the one checksum a zip entry needs. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A zip of `{ name, data }` entries, deflated. Local header, then the central
 * directory, then the end record - the whole format, for files this size.
 */
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const body = deflateRawSync(data);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt32LE(0, 10); // a fixed stamp, so the same input gives the same file
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(0, 12);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE((0o100755 << 16) >>> 0, 38); // external attributes: executable
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

// ------------------------------------------------------------ the manifest

const platforms = { win32: ["win32"], darwin: ["darwin"], linux: ["linux"] };
const entry = `server/kern-mcp${exe}`;
const manifest = {
  manifest_version: "0.2",
  name: "kern",
  display_name: "Kern",
  version,
  description: "Your tasks, projects, boards, notes and whiteboards in Kern, on this computer.",
  long_description:
    "Connects to the copy of Kern running on this computer and works through its tools: reading what is there, "
    + "creating tasks and notes, setting up whole projects and drawing flowcharts onto whiteboards. Nothing is "
    + "reachable until the connection is switched on in Kern under Settings → API → Assistants, and Kern asks "
    + "before it approves this assistant by name.",
  author: { name: "Christian Relf" },
  license: "see LICENSE.md",
  // The bundle carries only the bridge. The protocol, the data and the rules
  // about what may be read or changed all live in the running app.
  server: {
    type: "binary",
    entry_point: entry,
    mcp_config: {
      command: `\${__dirname}/${entry}`,
      args: ["--name", "Claude Desktop"],
    },
  },
  compatibility: { platforms: platforms[process.platform] ?? [process.platform] },
};

const bundlePath = join(binaries, "kern.mcpb");
writeFileSync(
  bundlePath,
  zip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8") },
    { name: entry, data: readFileSync(built) },
  ]),
);

console.log(`\n✓ ${sidecar}`);
console.log(`✓ ${bundlePath} (Kern ${version}, ${triple})`);
