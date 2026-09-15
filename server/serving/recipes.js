/**
 * Recipe registry (plan P1) — registered recipe FOLDERS that live on nodes.
 *
 * A recipe is an opaque, self-orchestrating folder (typically a git clone,
 * e.g. MiaAI-Lab GLM-5.3-Flash-EXL3-2x-DGX-Sparks): start.sh dispatcher with
 * start|stop|restart|status|logs verbs, `.env` parameters, multinode logic
 * internal to the recipe. The dashboard NEVER edits recipe content — it
 * registers the folder, probes it read-only once per refresh (one exec), and
 * runs its verbs via recipe-run jobs / direct exec.
 *
 * Storage: config/serve-recipes.json — records keyed by recipe id; identity is
 * unique on (sparkId, canonical path). Re-registering an existing folder
 * returns the existing record (D-folder / arch-review finding 2).
 *
 * Probe output is marker-delimited (pure builder + pure parser, both
 * testable). SECRET VALUES NEVER LEAVE THE NODE: .env text is parsed in the
 * probe (stdout is sent back to the dashboard!), so the parser allow-lists
 * public keys and records only PRESENCE for credential keys — names ending
 * in KEY, TOKEN, SECRET, or PASSWORD (e.g. VLLM_API_KEY, HF_TOKEN, GHCR_TOKEN).
 *
 * Meta keys parsed (public): PORT, MODEL, MODEL_FALLBACK, DFLASH_MODEL,
 * SERVED_MODEL_NAME, HEAD_IP, WORKER_IP, WORKER_USER, NNODES, TP,
 * READY_TIMEOUT, MAX_MODEL_LEN, GPU_MEM_UTIL, IMAGE.
 * Container names come from `${VAR:-default}` scraping of the entry scripts
 * (the .env files do NOT define them — ops-review finding 2).
 *
 * `class`: "repo" when the main entry dispatches a `status)` verb; "script"
 * otherwise (advisory — lifecycle here always uses verbs; class only labels
 * the UI). Node kind "nas" must not host recipes (route-level guard).
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { shellQuote } from "../util/shellQuote.js";
import { atomicWrite } from "../util/atomicWrite.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

/** Recipe ids: same charset as serving script ids (path-safe, no leading dot/dash). */
const RECIPE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function validRecipeId(id) {
  return typeof id === "string" && RECIPE_ID_RE.test(id);
}

/** Absolute, traversal-tolerant (it IS an absolute node path), injection-guarded. */
export function validRecipePath(p) {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= 4096 &&
    !p.includes("\0") &&
    p.startsWith("/")
  );
}

/** Canonical identity key for the (sparkId, path) uniqueness constraint. */
export function recipeKey(sparkId, p) {
  // Collapse //, strip trailing /, drop /./ segments — NOT full realpath (the
  // probe resolves symlinks server-side is overkill; this covers UI re-entry).
  const norm = path.posix.normalize(p).replace(/\/+$/, "") || "/";
  return `${sparkId}\u0000${norm}`;
}

export function makeRecipeId(sparkId, p) {
  const base = path.posix
    .basename(p)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 40);
  const hash = crypto.createHash("sha1").update(recipeKey(sparkId, p)).digest("hex").slice(0, 8);
  return `${base || "recipe"}-${hash}`;
}

// ─── Probe (pure builders / parsers) ───────────────────────

const PROBE_LIMIT = 24_000; // bytes of .env text we read (bounded)

/**
 * Build the ONE-exec probe command for a recipe folder (pure).
 * `entryRel` defaults to start.sh; variant container-scrape covers the known
 * entry shapes (start.sh, start-NAME.sh, tpN/start.sh).
 */
export function buildRecipeProbeCommand(absPath) {
  const q = shellQuote(absPath);
  return [
    `cd ${q} || { echo "__P_NOPATH__"; exit 0; }`,
    "echo __P_FILES__",
    "find . -maxdepth 2 -type f -name '*.sh' -printf '%p %s\\n' 2>/dev/null | sort | head -40",
    "echo __P_GIT__",
    "git rev-parse HEAD 2>/dev/null || true",
    "echo __P_DIRTY__",
    "git status --porcelain -- Dockerfile overlay 2>/dev/null | head -20",
    "echo __P_DISPATCH__",
    "grep -oE '^ *(start|stop|status|logs|restart|download)\\)' start.sh 2>/dev/null | tr -d ' )' | sort -u | head",
    "echo __P_ENV__",
    `head -c ${PROBE_LIMIT} .env 2>/dev/null || true`,
    "echo __P_EXAMPLE__",
    `head -c ${PROBE_LIMIT} .env.example 2>/dev/null || true`,
    "echo __P_CONTAINERS__",
    "grep -HE 'CONTAINER[A-Z0-9_]*=' start.sh start-*.sh tp*/start*.sh 2>/dev/null | head -48",
    "echo __P_END__",
  ].join("\n");
}

/** Split probe stdout into marker → lines maps (pure). */
export function parseProbeOutput(out) {
  const text = String(out ?? "");
  if (text.includes("__P_NOPATH__")) return { noPath: true };
  const sections = {};
  let cur = null;
  for (const line of text.split("\n")) {
    const m = line.match(/(^| )__P_([A-Z]+)__/);
    if (m && line.trim().startsWith("__P_")) {
      cur = m[2].toLowerCase();
      sections[cur] = [];
      // Same-line content after the marker (defensive): keep it.
      const rest = line.replace(/__P_[A-Z]+__/, "").trim();
      if (rest && cur !== "end") sections[cur].push(rest);
      continue;
    }
    if (cur && cur !== "end") sections[cur].push(line);
  }
  return { sections };
}

/** Keys whose VALUES must never be stored or sent to the client. */
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD)$/i;
/** Public meta keys we surface (all others in .env are ignored). */
const PUBLIC_KEYS = new Set([
  "PORT",
  "MODEL",
  "MODEL_FALLBACK",
  "DFLASH_MODEL",
  "SERVED_MODEL_NAME",
  "HEAD_IP",
  "WORKER_IP",
  "WORKER_USER",
  "NNODES",
  "TP",
  "READY_TIMEOUT",
  "MAX_MODEL_LEN",
  "GPU_MEM_UTIL",
  "IMAGE",
]);

/**
 * Parse `KEY=VALUE` env text (shell-ish, bounded). Comment/blank lines skipped;
 * first/last-wins per source ordering as in .env sourcing (last assignment
 * wins). Values with quotes un-wrapped. Secret keys → presence booleans only
 * (`secrets: { KEY: true }`), values dropped.
 */
export function parseEnvText(text, { allowSecrets = false } = {}) {
  const vars = {};
  const secrets = {};
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    // Strip matching surrounding quotes.
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    // Inline trailing comment only for unquoted values with ' #'.
    if (!val.startsWith("#") && val.includes(" #")) val = val.split(" #")[0].trim();
    if (SECRET_KEY_RE.test(key)) {
      if (allowSecrets) secrets[key] = val;
      else if (val !== "") secrets[key] = true;
      continue;
    }
    if (PUBLIC_KEYS.has(key)) vars[key] = val;
  }
  return { vars, secrets };
}

/**
 * Scrape `${CONTAINER_*:="name"}` defaults from grep -H'd lines (pure).
 * Input shape: `start.sh:CONTAINER_HEAD="${CONTAINER_HEAD:-glm53-exl3-head}"`.
 * Returns per-entry maps so variant sets never merge (start-tp4.sh names are
 * NOT start.sh names): `{ "start.sh": { CONTAINER_HEAD: "…", … }, … }`.
 * Falls back to plain assignments (`CONTAINER_NAME='vllm-fn-tp1'`).
 */
export function parseContainerLines(lines) {
  const byEntry = {};
  for (const raw of Array.isArray(lines) ? lines : String(lines ?? "").split("\n")) {
    const line = String(raw);
    const ci = line.indexOf(":");
    if (ci <= 0) continue;
    // Strip ./ prefix from the grep file name.
    const file = line.slice(0, ci).replace(/^\.\//, "");
    const body = line.slice(ci + 1);
    byEntry[file] ||= {};
    let m = body.match(/(CONTAINER[A-Z0-9_]*)="\$\{[A-Z0-9_]+:-([^}]+)\}"/);
    if (!m) m = body.match(/(CONTAINER[A-Z0-9_]*)=['"]?([A-Za-z0-9._-]+)['"]?/);
    if (m && !(m[1] in byEntry[file])) byEntry[file][m[1]] = m[2];
  }
  return byEntry;
}

/** Variant scan from the files section: { entry, variants[] }. */
export function parseVariantFiles(fileLines, dispatchOk) {
  const files = [];
  for (const line of fileLines || []) {
    const m = String(line).match(/^\.?\/?(.+\.sh)\s+(\d+)$/);
    if (m) files.push({ rel: m[1].replace(/^\.\//, ""), bytes: Number(m[2]) });
  }
  const entry = files.find((f) => f.rel === "start.sh") || null;
  const variants = files
    .filter(
      (f) =>
        f.rel !== "start.sh" &&
        (/(^|\/)start[^\/]*\.sh$/.test(f.rel) || /(^|\/)start\.sh$/.test(f.rel)) &&
        // top-level start*.sh or tp*/start.sh — not tests/ or scripts/
        (!f.rel.includes("/") || /^tp[0-9a-z]+\//i.test(f.rel))
    )
    .map((f) => ({
      rel: f.rel,
      // Label: start-tp4.sh → tp4, tp1/start.sh → tp1
      name: f.rel.replace(/^tp/, "tp").replace(/\.sh$/, "").replace(/^start-?/, "") || "default",
    }));
  return { entry: entry?.rel || null, variants, files };
}

/**
 * Build the recipe meta from probe stdout (pure; single funnel).
 * @param {string} out probe exec stdout
 * @returns {{ ok: boolean, error?: string, meta: object, versions: object,
 *             files: object, dispatch: object }}
 */
export function parseRecipeProbe(out) {
  const parsed = parseProbeOutput(out);
  if (parsed.noPath) return { ok: false, error: "folder not found on node", meta: {}, versions: {}, files: {}, dispatch: {} };
  const s = parsed.sections || {};
  const get = (k) => (s[k] || []).join("\n");

  const env = parseEnvText(get("env"));
  const example = parseEnvText(get("example"));
  // .env wins where present (sourced second by the recipes themselves).
  const vars = { ...example.vars, ...env.vars };
  const secrets = {
    ...Object.fromEntries(Object.keys(example.secrets).map((k) => [k, true])),
    ...Object.fromEntries(Object.keys(env.secrets).map((k) => [k, true])),
  };

  const containers = parseContainerLines(get("containers"));
  const verbs = (s.dispatch || []).map((v) => String(v).trim()).filter(Boolean);

  const dispatchOk = verbs.includes("status");
  const { entry, variants, files } = parseVariantFiles(s.files, dispatchOk);
  if (!entry && variants.length === 0) {
    return { ok: false, error: "no start.sh found in folder", meta: {}, versions: {}, files: {}, dispatch: {} };
  }

  const gitHead = get("git").trim().split("\n")[0] || null;
  const dirtyBuild = get("dirty").trim().length > 0;

  return {
    ok: true,
    meta: {
      port: Number.isInteger(+vars.PORT) && +vars.PORT >= 1 && +vars.PORT <= 65535 ? +vars.PORT : null,
      model: vars.MODEL || null,
      modelFallback: vars.MODEL_FALLBACK || null,
      dflashModel: vars.DFLASH_MODEL || null,
      servedName: vars.SERVED_MODEL_NAME || null,
      headIp: vars.HEAD_IP || null,
      workerIp: vars.WORKER_IP || null,
      workerUser: vars.WORKER_USER || null,
      nnodes: vars.NNODES
        ? Math.max(1, parseInt(vars.NNODES, 10) || 1)
        : vars.WORKER_IP
          ? 2
          : 1,
      tp: vars.TP ? parseInt(vars.TP, 10) || null : null,
      readyTimeoutS: vars.READY_TIMEOUT ? parseInt(vars.READY_TIMEOUT, 10) || null : null,
      maxModelLen: vars.MAX_MODEL_LEN ? parseInt(vars.MAX_MODEL_LEN, 10) || null : null,
      image: vars.IMAGE || null,
      containers: containers[entry || variants[0]?.rel] || {}, // default-entry set
      containersByEntry: containers, // per-entry: { "start.sh": {...}, "start-tp4.sh": {...} }
      secretPresence: secrets, // { VLLM_API_KEY: true } — booleans only
      entry: entry || variants[0]?.rel || null,
      variants,
      class: dispatchOk ? "repo" : "script",
      verbs,
    },
    versions: { gitHead, dirtyBuild, probedAt: Date.now() },
    files: files.map((f) => f.rel).slice(0, 40),
    dispatch: { verbs },
  };
}

/** Drift comparison between stored version and a fresh probe version (pure). */
export function versionDrift(startedWith, current) {
  if (!startedWith?.version || !current) return { drift: false, rebuild: false };
  const v0 = startedWith.version;
  const v1 = current;
  const headMoved = Boolean(v0.gitHead && v1.gitHead && v0.gitHead !== v1.gitHead);
  const becameDirty = Boolean(v1.dirtyBuild) && v0.dirtyBuild !== true;
  return { drift: headMoved || becameDirty, rebuild: headMoved || becameDirty };
}

// ─── Store ─────────────────────────────────────────────────

export class RecipeStore {
  /**
   * @param {{ filePath?: string, now?: () => number }} [opts]
   */
  constructor(opts = {}) {
    this._file =
      opts.filePath ||
      process.env.SPARKDASH_SERVE_RECIPES_PATH ||
      path.join(ROOT, "config", "serve-recipes.json");
    this._now = opts.now || Date.now;
    /** @type {Map<string, object>} */
    this.recipes = new Map();
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this._file)) return;
      const raw = JSON.parse(fs.readFileSync(this._file, "utf8"));
      for (const r of raw.recipes || []) {
        if (r?.id && r?.sparkId && r?.path) this.recipes.set(r.id, r);
      }
    } catch (err) {
      console.error("[serve-recipes] failed to load state:", err.message);
    }
  }

  _persist() {
    try {
      const recipes = [...this.recipes.values()].sort((a, b) => a.id.localeCompare(b.id));
      atomicWrite(this._file, JSON.stringify({ version: 1, recipes }, null, 2) + "\n", 0o644);
    } catch (err) {
      console.error("[serve-recipes] failed to persist state:", err.message);
    }
  }

  list() {
    return [...this.recipes.values()];
  }

  get(id) {
    return this.recipes.get(id) || null;
  }

  /** Identity lookup: existing record for (sparkId, canonical path) or null. */
  findByPath(sparkId, p) {
    const key = recipeKey(sparkId, p);
    for (const r of this.recipes.values()) {
      if (recipeKey(r.sparkId, r.path) === key) return r;
    }
    return null;
  }

  /**
   * Register (or return existing) a recipe folder record. Does NOT probe —
   * the route probes and calls updateMeta (store stays IO-of-disk only).
   */
  register({ sparkId, path: p, label, entry }) {
    const existing = this.findByPath(sparkId, p);
    if (existing) return { recipe: existing, created: false };
    let id = makeRecipeId(sparkId, p);
    if (this.recipes.has(id)) {
      // sha1 prefix collision (0.4/4B chance × tiny N — still, no silent merge):
      id = `${id}-${this.recipes.size}`;
    }
    const rec = {
      id,
      sparkId,
      path: path.posix.normalize(p).replace(/\/+$/, "") || "/",
      label: typeof label === "string" && label.trim() ? label.trim().slice(0, 80) : null,
      entry: entry || null, // probe fills when null
      meta: null,
      versions: null,
      files: [],
      orphaned: false,
      probeError: null,
      createdAt: this._now(),
      updatedAt: this._now(),
    };
    this.recipes.set(id, rec);
    this._persist();
    return { recipe: rec, created: true };
  }

  /** Merge a probe result (or probe error) into the record. */
  updateFromProbe(id, probe, { entry } = {}) {
    const r = this.recipes.get(id);
    if (!r) return null;
    if (probe?.ok) {
      r.meta = entry && probe.meta.variants?.some((v) => v.rel === entry)
        ? { ...probe.meta, entry }
        : probe.meta;
      r.versions = probe.versions;
      r.files = probe.files;
      r.probeError = null;
      if (entry) r.entry = entry;
      else if (!r.entry) r.entry = probe.meta.entry;
    } else if (probe && probe.error) {
      r.probeError = probe.error;
    }
    r.updatedAt = this._now();
    this._persist();
    return r;
  }

  remove(id) {
    if (!this.recipes.has(id)) return false;
    this.recipes.delete(id);
    this._persist();
    return true;
  }

  /** Mark/un-mark every recipe on a spark (registry "remove" → orphan). */
  setOrphanedBySpark(sparkId, orphaned) {
    let n = 0;
    for (const r of this.recipes.values()) {
      if (r.sparkId === sparkId && Boolean(r.orphaned) !== Boolean(orphaned)) {
        r.orphaned = Boolean(orphaned);
        r.updatedAt = this._now();
        n++;
      }
    }
    if (n) this._persist();
    return n;
  }

  /** Redacted public shape (secrets already presence-only in meta). */
  static toPublic(r) {
    return { ...r };
  }
}
