// Checks AMO for the signing status of the version currently in
// extension/manifest.json, and downloads the signed .xpi into dist/ once
// Mozilla has signed it.
//
//   node check-signing.mjs          -> check once
//   node check-signing.mjs --watch  -> poll every 60s until signed
//
// Why this exists: `web-ext sign` uploads AND waits, but it gives up after a
// short timeout. If it times out, the upload has still succeeded — the version
// exists on AMO and re-running `web-ext sign` on the same version number fails
// as a duplicate. This script picks up where it left off without re-uploading.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRED_PATH = path.join(HERE, "amo-credentials.json");
const MANIFEST_PATH = path.join(HERE, "extension", "manifest.json");
const DIST_DIR = path.join(HERE, "dist");

const WATCH = process.argv.includes("--watch");
const POLL_MS = 60_000;

if (!fs.existsSync(CRED_PATH)) {
  console.error(`Missing ${CRED_PATH}. See README.md.`);
  process.exit(1);
}

const { apiKey, apiSecret } = JSON.parse(fs.readFileSync(CRED_PATH, "utf8"));
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const ADDON_ID = manifest.browser_specific_settings.gecko.id;
const VERSION = manifest.version;

const b64url = (b) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(
    JSON.stringify({ iss: apiKey, jti: crypto.randomBytes(8).toString("hex"), iat: now, exp: now + 120 })
  );
  const s = b64url(crypto.createHmac("sha256", apiSecret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${s}`;
}

async function api(url) {
  const res = await fetch(url, { headers: { Authorization: `JWT ${jwt()}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function findVersion() {
  const list = await api(
    `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(ADDON_ID)}/versions/?filter=all_with_unlisted`
  );
  return (list.results || []).find((v) => v.version === VERSION) || null;
}

async function download(fileUrl, versionId) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const res = await fetch(fileUrl, { headers: { Authorization: `JWT ${jwt()}` }, redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // A signed add-on is a ZIP containing META-INF/mozilla.rsa. If that marker is
  // absent we downloaded the unsigned upload, which Firefox will refuse.
  const signed = buf.includes(Buffer.from("META-INF/mozilla.rsa"));
  const out = path.join(DIST_DIR, `claude-browser-connector-${VERSION}${signed ? "" : ".UNSIGNED"}.xpi`);
  fs.writeFileSync(out, buf);
  console.log(`\nDownloaded ${buf.length} bytes -> ${out}`);
  if (!signed) {
    console.log("WARNING: no signature marker found; this file is NOT signed and Firefox will reject it.");
    return false;
  }
  console.log("Signature verified (META-INF/mozilla.rsa present).");
  console.log("\nInstall it: Firefox -> about:addons -> gear icon -> Install Add-on From File...");
  return true;
}

async function checkOnce() {
  const v = await findVersion();
  if (!v) {
    console.log(`No version ${VERSION} found on AMO for ${ADDON_ID}.`);
    return false;
  }
  const f = v.file || (v.files || [])[0];
  const stamp = new Date().toLocaleTimeString();
  if (!f) {
    console.log(`[${stamp}] version ${VERSION} (id ${v.id}) exists but has no file record yet.`);
    return false;
  }
  console.log(
    `[${stamp}] version ${VERSION} | channel=${v.channel} | file status=${f.status} | mozilla_signed=${f.is_mozilla_signed_extension}`
  );
  if (f.status === "unreviewed") return false;
  if (f.is_mozilla_signed_extension || f.status === "public" || f.status === "approved") {
    return await download(f.url, v.id);
  }
  if (f.status === "disabled") {
    console.log("File was REJECTED/disabled by AMO. Check:", v.edit_url);
    process.exit(2);
  }
  return false;
}

if (!WATCH) {
  const done = await checkOnce();
  process.exit(done ? 0 : 3);
} else {
  console.log(`Polling AMO every ${POLL_MS / 1000}s for ${ADDON_ID} v${VERSION}. Ctrl+C to stop.\n`);
  for (;;) {
    let done = false;
    try {
      done = await checkOnce();
    } catch (e) {
      console.log(`[${new Date().toLocaleTimeString()}] check failed: ${e.message}`);
    }
    if (done) process.exit(0);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
