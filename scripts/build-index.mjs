#!/usr/bin/env node
// Aggregate built artifacts in dist/ into a public/index.json catalog and
// copy archives + signatures into public/archives/<id>/<version>/.
//
// Usage:
//   node scripts/build-index.mjs                                  # writes to ./public/
//   node scripts/build-index.mjs --output <path>                  # alt output dir
//   node scripts/build-index.mjs --staging                        # validate only, don't write
//   node scripts/build-index.mjs --base-url <url>                 # override the URL prefix

import { readFile, readdir, mkdir, copyFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { resolve, join, relative } from "node:path";
import toml from "@iarna/toml";
import semver from "semver";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PLUGINS_DIR = join(REPO_ROOT, "plugins");
const DIST_DIR = join(REPO_ROOT, "dist");

const DEFAULT_BASE_URL = "https://mallard-marketplace.vnsf.xyz";
const SCHEMA_VERSION = 1;
const README_MAX_BYTES = 64 * 1024;
const README_TRUNCATION_MARKER = "\n\n…";

function parseArgs() {
  const args = new Map();
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith("--")) {
      const next = a[i + 1];
      if (next && !next.startsWith("--")) {
        args.set(a[i].slice(2), next);
        i += 1;
      } else {
        args.set(a[i].slice(2), true);
      }
    }
  }
  return args;
}

function commitTimestamp() {
  try {
    return execSync("git log -1 --format=%aI", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return new Date().toISOString();
  }
}

/** Return the ISO-8601 timestamp of the commit that first added `relPath` to
 *  the repo, or `null` if the file isn't tracked. Used for `published_at` —
 *  the publish workflow rebuilds every submission on every push, so the
 *  receipt's `built_at` resets each run; the git add-commit is the stable
 *  "when did this version become available" anchor. `--diff-filter=A` keeps
 *  only addition commits; `tail -1` picks the oldest (chronological order)
 *  so subsequent edits (e.g. marking a version withdrawn) don't move the
 *  date. Submissions are immutable in practice, so there's typically one
 *  matching commit. */
function firstAddCommitTimestamp(relPath) {
  try {
    const out = execFileSync(
      "git",
      ["log", "--diff-filter=A", "--format=%aI", "--", relPath],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!out) return null;
    const lines = out.split("\n").filter(Boolean);
    return lines[lines.length - 1] || null;
  } catch {
    return null;
  }
}

async function readSubmission(id, version) {
  const submissionPath = join(PLUGINS_DIR, id, `${version}.toml`);
  if (!existsSync(submissionPath)) return null;
  return toml.parse(await readFile(submissionPath, "utf8"));
}

/** Extract the top-level README.md from a `.mallardx` archive, truncating at
 *  64 KB with a "\n\n…" marker. Returns `null` when the archive has no README.
 *  The truncation is on a byte boundary; if it splits a UTF-8 codepoint
 *  Node's decoder substitutes U+FFFD — that's a visible degradation but won't
 *  crash the client. The host-side `read_plugin_readme` walks back to a char
 *  boundary; we don't try to match that algorithm exactly. */
function extractReadme(archivePath) {
  try {
    const out = execFileSync("unzip", ["-p", archivePath, "README.md"], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
    if (out.length === 0) return null;
    if (out.length <= README_MAX_BYTES) return out.toString("utf8");
    return out.slice(0, README_MAX_BYTES).toString("utf8") + README_TRUNCATION_MARKER;
  } catch {
    return null;
  }
}

function permissionsSummary(manifest) {
  // Mirror Mallard's CatalogVersion::permissions_summary shape (Plan #16 spec §1).
  const p = manifest.permissions ?? {};
  return {
    sends: Boolean(p.sends ?? false),
    gmcp_access: Array.isArray(p.gmcp_access) ? p.gmcp_access : [],
    notifications: Boolean(p.notifications ?? false),
    keychain: Boolean(p.keychain ?? false),
    network: Array.isArray(p.network) ? p.network : [],
    filesystem: Array.isArray(p.filesystem) ? p.filesystem : [],
    clipboard: typeof p.clipboard === "string" ? p.clipboard : "none",
    external_app: Array.isArray(p.external_app) ? p.external_app : [],
  };
}

function validateCatalog(catalog) {
  if (catalog.version !== SCHEMA_VERSION) {
    throw new Error(`catalog version ${catalog.version} != ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(catalog.plugins)) throw new Error(`catalog.plugins must be array`);
  for (const p of catalog.plugins) {
    if (!p.id || !p.name || !Array.isArray(p.versions) || p.versions.length === 0) {
      throw new Error(`plugin ${p.id || "<no id>"} missing required fields`);
    }
    // Defence-in-depth: the extractor truncates, but a bad future change
    // could let a giant README through. The client side caps at the same
    // size, so anything bigger is wasted bytes in index.json.
    if (typeof p.latest_readme === "string"
        && p.latest_readme.length > README_MAX_BYTES + README_TRUNCATION_MARKER.length) {
      throw new Error(`${p.id} latest_readme exceeds 64KB cap (${p.latest_readme.length} bytes)`);
    }
    for (const v of p.versions) {
      if (!semver.valid(v.version)) throw new Error(`bad version: ${v.version}`);
      if (!/^[0-9a-f]{64}$/.test(v.archive_sha256)) {
        throw new Error(`bad sha256 for ${p.id}@${v.version}: ${v.archive_sha256}`);
      }
      if (!v.archive_url || !v.signature_url) {
        throw new Error(`${p.id}@${v.version} missing archive/signature URL`);
      }
    }
  }
}

async function walkDistVersions() {
  if (!existsSync(DIST_DIR)) return [];
  const out = [];
  for (const id of await readdir(DIST_DIR)) {
    const idDir = join(DIST_DIR, id);
    if (!(await stat(idDir)).isDirectory()) continue;
    for (const version of await readdir(idDir)) {
      const versionDir = join(idDir, version);
      const receiptPath = join(versionDir, "build-receipt.json");
      if (!existsSync(receiptPath)) continue;
      out.push({ id, version, dir: versionDir });
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const baseUrl = (args.get("base-url") || DEFAULT_BASE_URL).replace(/\/$/, "");
  const outputDir = args.get("output") ? resolve(args.get("output")) : join(REPO_ROOT, "public");
  const staging = Boolean(args.get("staging"));

  const generated_at = commitTimestamp();

  const versions = await walkDistVersions();
  if (versions.length === 0) {
    console.error("build-index: no built versions in dist/. Run build-plugin first.");
    process.exit(1);
  }

  // Group by plugin id.
  const byId = new Map();
  for (const v of versions) {
    if (!byId.has(v.id)) byId.set(v.id, []);
    byId.get(v.id).push(v);
  }

  const catalogPlugins = [];

  for (const [id, vs] of byId.entries()) {
    // Sort versions newest-first by semver.
    vs.sort((a, b) => semver.rcompare(a.version, b.version));

    // Use the latest non-withdrawn version's manifest for per-plugin fields.
    let perPluginManifest = null;
    let perPluginSubmission = null;
    let perPluginArchivePath = null;
    const catalogVersions = [];

    for (const v of vs) {
      const submission = await readSubmission(id, v.version);
      if (!submission) {
        throw new Error(`missing submission file for ${id}@${v.version}`);
      }
      const receipt = JSON.parse(await readFile(join(v.dir, "build-receipt.json"), "utf8"));
      const manifestRaw = await readFile(join(v.dir, "plugin.toml"), "utf8");
      const manifest = toml.parse(manifestRaw);
      const archiveUrl = `${baseUrl}/archives/${id}/${v.version}/${receipt.artifact}`;
      const signatureUrl = `${archiveUrl}.minisig`;
      const manifestUrl = `${baseUrl}/archives/${id}/${v.version}/plugin.toml`;

      const withdrawn = Boolean(submission.withdrawn);
      const withdrawn_reason = withdrawn ? submission.withdrawn_reason || null : null;

      // published_at = when the submission file was first committed (i.e.
      // merged to main). Fall back to the receipt's `built_at` if the
      // submission isn't tracked yet (dirty local tree / pre-merge dry runs).
      const submissionRelPath = `plugins/${id}/${v.version}.toml`;
      const published_at = firstAddCommitTimestamp(submissionRelPath) || receipt.built_at;

      catalogVersions.push({
        version: v.version,
        published_at,
        archive_url: archiveUrl,
        archive_sha256: receipt.archive_sha256,
        signature_url: signatureUrl,
        manifest_url: manifestUrl,
        minimum_app_version: manifest.minimum_app_version || "0.0.0",
        permissions_summary: permissionsSummary(manifest),
        withdrawn,
        withdrawn_reason,
      });

      if (!perPluginManifest && !withdrawn) {
        perPluginManifest = manifest;
        perPluginSubmission = submission;
        perPluginArchivePath = join(v.dir, receipt.artifact);
      }
    }

    if (!perPluginManifest) {
      perPluginManifest = toml.parse(await readFile(join(vs[0].dir, "plugin.toml"), "utf8"));
      perPluginSubmission = await readSubmission(id, vs[0].version);
      const fallbackReceipt = JSON.parse(await readFile(join(vs[0].dir, "build-receipt.json"), "utf8"));
      perPluginArchivePath = join(vs[0].dir, fallbackReceipt.artifact);
    }

    catalogPlugins.push({
      id,
      name: perPluginManifest.name || id,
      description: perPluginManifest.description || "",
      language: perPluginManifest.language || "lua",
      homepage: perPluginSubmission.meta?.homepage || perPluginManifest.homepage || null,
      tags: perPluginSubmission.meta?.tags || [],
      worlds_match: perPluginManifest.worlds?.match || [],
      license: perPluginManifest.license || null,
      authors: perPluginManifest.authors || [],
      panels: Object.entries(perPluginManifest.panels || {})
        .map(([id, decl]) => ({ id, title: decl.title || id })),
      latest_readme: perPluginArchivePath ? extractReadme(perPluginArchivePath) : null,
      versions: catalogVersions,
    });
  }

  // Sort plugins alphabetically by id for stable output.
  catalogPlugins.sort((a, b) => a.id.localeCompare(b.id));

  const catalog = {
    version: SCHEMA_VERSION,
    generated_at,
    plugins: catalogPlugins,
  };

  validateCatalog(catalog);

  if (staging) {
    console.log("build-index --staging: catalog is valid.");
    console.log(JSON.stringify({ plugins: catalogPlugins.length, total_versions: catalogPlugins.reduce((n, p) => n + p.versions.length, 0) }, null, 2));
    return;
  }

  // Write public/index.json + copy archives + signatures + plugin.toml files.
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "index.json"), JSON.stringify(catalog, null, 2) + "\n");

  for (const v of versions) {
    const receipt = JSON.parse(await readFile(join(v.dir, "build-receipt.json"), "utf8"));
    const destDir = join(outputDir, "archives", v.id, v.version);
    await mkdir(destDir, { recursive: true });
    await copyFile(join(v.dir, receipt.artifact), join(destDir, receipt.artifact));
    const sigSrc = join(v.dir, `${receipt.artifact}.minisig`);
    if (existsSync(sigSrc)) {
      await copyFile(sigSrc, join(destDir, `${receipt.artifact}.minisig`));
    } else {
      console.warn(`build-index: no signature for ${v.id}@${v.version} — publish workflow signs; PR runs do not`);
    }
    await copyFile(join(v.dir, "plugin.toml"), join(destDir, "plugin.toml"));
  }

  console.log(`build-index: wrote ${relative(REPO_ROOT, outputDir)}/index.json`);
  console.log(`  plugins: ${catalogPlugins.length}`);
  console.log(`  total versions: ${catalogPlugins.reduce((n, p) => n + p.versions.length, 0)}`);
}

main().catch((e) => {
  console.error("build-index failed:", e.message);
  process.exit(1);
});
