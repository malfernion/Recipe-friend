/**
 * What copy-data, copy-photos and verify share: reading secrets from the
 * environment, keeping them out of every message, connecting to the two
 * databases and the two Storage APIs, and the rules for what does not
 * move (agents, expired invites).
 *
 * The rules live here once so that verify expects exactly what copy-data
 * did, and a change to one is a change to both.
 */
"use strict";

const fs = require("node:fs");

// ---------------------------------------------------------------------
// Secrets: from the environment only, and never printed
// ---------------------------------------------------------------------

/** Every environment variable that may hold a secret. */
const SECRET_VARS = [
  "HOSTED_DB_URL",
  "HOSTED_SERVICE_KEY",
  "TARGET_DB_URL",
  "TARGET_SERVICE_KEY",
];

/**
 * Everything worth hiding: each secret variable's value, and the password
 * inside each connection string on its own (a driver may print a URL it has
 * taken apart). Collected once, longest first, so a password that is also
 * part of a URL is hidden either way.
 */
function secretValues() {
  const out = new Set();
  for (const name of SECRET_VARS) {
    const value = process.env[name];
    if (!value || value.length < 4) continue;
    out.add(value);
    try {
      const u = new URL(value);
      if (u.password) {
        out.add(u.password);
        out.add(decodeURIComponent(u.password));
      }
      if (u.username) out.add(`${u.username}:`);
    } catch {
      // not a URL; the whole value is already in the set
    }
  }
  return [...out].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}

/**
 * A message with every secret taken out: the known values, any
 * user:password in a postgres:// URL, and anything shaped like a JWT or a
 * Supabase secret key, whether or not it is one of ours.
 */
function redact(text) {
  let s = String(text);
  for (const secret of secretValues()) s = s.split(secret).join("[redacted]");
  s = s.replace(/(postgres(?:ql)?:\/\/)[^@\s/]*@/gi, "$1[redacted]@");
  s = s.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]");
  s = s.replace(/sb_secret_[A-Za-z0-9_-]+/g, "[redacted-key]");
  return s;
}

/** A required environment variable, or a clear exit naming it. */
function need(name) {
  const value = process.env[name];
  if (!value) {
    throw new Usage(`${name} is not set. See server/migrate-from-supabase/README.md.`);
  }
  return value;
}

class Usage extends Error {}

/** Where a connection string points, with no credentials: for the log. */
function describeDb(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return "(unparseable connection string)";
  }
}

/** Where an http(s) URL points, with no credentials: for the log. */
function describeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return "(unparseable URL)";
  }
}

/**
 * Run `main`, and turn anything it throws into a redacted message and an
 * exit code. A stack trace is printed only with MIGRATE_DEBUG=1, and is
 * redacted too.
 */
function run(main) {
  main().then(
    (code) => process.exit(code || 0),
    (error) => {
      if (error instanceof Usage) {
        console.error(`error: ${redact(error.message)}`);
        process.exit(2);
      }
      const parts = [error && error.message ? error.message : String(error)];
      if (error && error.detail) parts.push(`detail: ${error.detail}`);
      if (error && error.code) parts.push(`code: ${error.code}`);
      console.error(`error: ${redact(parts.join("\n  "))}`);
      if (process.env.MIGRATE_DEBUG === "1" && error && error.stack) console.error(redact(error.stack));
      process.exit(1);
    }
  );
}

// ---------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------

/**
 * A pg client that hands every value back as the text Postgres sent, and
 * takes text in. Nothing is turned into a JS Date or number on the way
 * through, so a timestamp keeps its microseconds and a jsonb its exact
 * value: what is read from one side is written to the other byte for byte.
 */
async function connect(url, { label, hosted = false } = {}) {
  const { Client } = require("pg");
  const config = { connectionString: url, types: { getTypeParser: () => (v) => v } };
  if (hosted) config.ssl = hostedSsl(url);
  // Strip sslmode from the string so the explicit ssl object above wins:
  // pg reads sslmode=require as verify-full, with a CA it does not have.
  if (hosted) config.connectionString = stripSslParams(url);
  const client = new Client(config);
  client.on("error", (e) => console.error(`${label || "db"}: ${redact(e.message)}`));
  try {
    await client.connect();
  } catch (e) {
    throw new Error(`could not connect to ${label || "database"} at ${describeDb(url)}: ${e.message}`);
  }
  // Text output of timestamps depends on the session's time zone. Both
  // sides in UTC means the same instant reads as the same string.
  await client.query("set timezone = 'UTC'");
  return client;
}

/**
 * TLS for the hosted pooler. Verified against Supabase's CA when
 * HOSTED_DB_CA_FILE names it (Dashboard → Database → SSL configuration →
 * Download certificate); against the system's CAs otherwise. Turning
 * verification off is possible, loudly, for the case where neither works.
 */
function hostedSsl() {
  if (process.env.HOSTED_DB_SSL_NO_VERIFY === "1") {
    console.error("warning: HOSTED_DB_SSL_NO_VERIFY=1 — the hosted server's certificate is NOT checked.");
    return { rejectUnauthorized: false };
  }
  const file = process.env.HOSTED_DB_CA_FILE;
  if (file) return { rejectUnauthorized: true, ca: fs.readFileSync(file, "utf8") };
  return { rejectUnauthorized: true };
}

function stripSslParams(url) {
  try {
    const u = new URL(url);
    for (const p of ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl"]) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return url;
  }
}

/** The hosted side, opened for reading only, on one consistent snapshot. */
async function connectSource() {
  const url = need("HOSTED_DB_URL");
  const db = await connect(url, { label: "hosted", hosted: !isLocal(url) });
  await db.query("set default_transaction_read_only = on");
  await db.query("begin isolation level repeatable read read only");
  return db;
}

async function connectTarget() {
  return connect(need("TARGET_DB_URL"), { label: "target" });
}

function isLocal(url) {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || !host.includes(".");
  } catch {
    return false;
  }
}

async function serverVersion(db) {
  const { rows } = await db.query("select current_setting('server_version') as v, current_setting('server_version_num') as n");
  return { text: rows[0].v, major: Math.floor(Number(rows[0].n) / 10000) };
}

/**
 * Refuse to go on if both URLs reach the same database — a mix-up that
 * would make --wipe-target truncate the source. Same server start time to
 * the microsecond and same database oid is the same database.
 */
async function assertDifferent(src, dst) {
  const who = "select pg_postmaster_start_time()::text || '/' || (select oid from pg_database where datname = current_database())::text as w";
  const a = (await src.query(who)).rows[0].w;
  const b = (await dst.query(who)).rows[0].w;
  if (a === b) throw new Error("HOSTED_DB_URL and TARGET_DB_URL reach the same database. Nothing was done.");
}

/** The columns of a table that can be written: not generated, not missing. */
async function writableColumns(db, schema, table) {
  const { rows } = await db.query(
    `select column_name from information_schema.columns
      where table_schema = $1 and table_name = $2
        and is_generated = 'NEVER' and coalesce(identity_generation, '') <> 'ALWAYS'
      order by ordinal_position`,
    [schema, table]
  );
  return rows.map((r) => r.column_name);
}

async function tableExists(db, qualified) {
  const { rows } = await db.query("select to_regclass($1) is not null as ok", [qualified]);
  return rows[0].ok === "t" || rows[0].ok === true;
}

const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

// ---------------------------------------------------------------------
// What moves, and what does not
// ---------------------------------------------------------------------

/** The app's tables, in an order where every foreign key points backwards. */
const PUBLIC_TABLES = ["profiles", "books", "book_members", "recipes", "invites", "live_plans", "plans"];

/** Every table copy-data writes, and so every one that must start empty. */
const TARGET_TABLES = ["auth.users", "auth.identities", ...PUBLIC_TABLES.map((t) => `public.${t}`), "public.agent_accounts"];

/**
 * The auth.users columns the plan names (E, "What moves"), plus
 * instance_id, which every row GoTrue writes carries. Copied where both
 * sides have them; anything else in auth.users — passwords, tokens,
 * last sign-in — is left behind.
 */
const USER_COLUMNS = [
  "id",
  "instance_id",
  "aud",
  "role",
  "email",
  "email_confirmed_at",
  "raw_app_meta_data",
  "raw_user_meta_data",
  "is_anonymous",
  "created_at",
  "updated_at",
];

/**
 * auth.users token columns that are nullable with no default, which GoTrue
 * reads into plain strings: a NULL there makes GoTrue fail to load the user
 * ("converting NULL to string is unsupported"). Written as '' — never
 * copied, they are one-time tokens for the old project.
 */
const USER_EMPTY_STRING_COLUMNS = [
  "confirmation_token",
  "recovery_token",
  "email_change_token_new",
  "email_change",
  "email_change_token_current",
  "phone_change",
  "phone_change_token",
  "reauthentication_token",
];

/** auth.identities: what maps a Google account to its user. */
const IDENTITY_COLUMNS = [
  "id",
  "provider_id",
  "user_id",
  "identity_data",
  "provider",
  "last_sign_in_at",
  "created_at",
  "updated_at",
];

/**
 * The users who do not move, with why. An agent is an anonymous account,
 * or one placed as an agent (role 'agent', or agent_accounts once the
 * hosted project has migration 009) — the second catches an agent whose
 * account stopped being anonymous. Agents are re-issued after cutover
 * (E7) because their credentials carry the old URL.
 */
async function skippedUsers(src) {
  const hasAgentAccounts = await tableExists(src, "public.agent_accounts");
  const { rows } = await src.query(`
    select id, array_agg(distinct reason order by reason) as reasons from (
      select id, 'anonymous' as reason from auth.users where is_anonymous is true
      union all
      select user_id, 'agent member' from public.book_members where role = 'agent'
      ${hasAgentAccounts ? "union all select user_id, 'agent_accounts' from public.agent_accounts" : ""}
    ) s group by id order by id`);
  return rows.map((r) => ({ id: r.id, reasons: parseTextArray(r.reasons) }));
}

/** '{a,b}' → ['a','b'], for the text array the raw parser hands back. */
function parseTextArray(text) {
  if (Array.isArray(text)) return text;
  return String(text)
    .replace(/^\{|\}$/g, "")
    .split(",")
    .filter(Boolean)
    .map((s) => s.replace(/^"|"$/g, ""));
}

/**
 * The rows that move, per table: SQL over the hosted side with the skipped
 * user ids as $1. verify asks the same questions to know what to expect.
 * `key` identifies a row for the diff. now() is the snapshot's moment, for
 * expired invites. Tables that keep every row still mention $1, so every
 * query takes the same one parameter.
 */
function selections() {
  return {
    "auth.users": { where: "not (id = any($1::uuid[]))", key: ["id"] },
    "auth.identities": { where: "provider = 'google' and not (user_id = any($1::uuid[]))", key: ["provider", "provider_id"] },
    "public.profiles": { where: "not (user_id = any($1::uuid[]))", key: ["user_id"] },
    "public.books": { where: "not (owner = any($1::uuid[]))", key: ["id"] },
    "public.book_members": { where: "role <> 'agent' and not (user_id = any($1::uuid[]))", key: ["book_id", "user_id"] },
    "public.recipes": { where: "$1::uuid[] is not null", key: ["id"] },
    "public.invites": { where: "expires_at > now() and not (created_by = any($1::uuid[]))", key: ["code"] },
    "public.live_plans": { where: "$1::uuid[] is not null", key: ["book_id"] },
    "public.plans": { where: "$1::uuid[] is not null", key: ["book_id", "id"] },
  };
}

// ---------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------

const BUCKET = "recipe-photos";

/**
 * Headers for a service-role call: the key in both headers, as supabase-js
 * sends it. A legacy key is a JWT, which the self-hosted stack (no gateway)
 * checks directly. A new `sb_secret_…` key is not a JWT; hosted Supabase's
 * gateway swaps it for one, but Storage still refuses a request with no
 * `authorization` header at all (HTTP 400, found on the first rehearsal).
 */
function storageHeaders(key) {
  return { apikey: key, authorization: `Bearer ${key}` };
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Every object in the bucket, recursing into folders: [{ path, size, mimetype, cacheControl }]. */
async function listBucket(storageBase, key) {
  const out = [];
  async function walk(prefix) {
    const limit = 1000;
    for (let offset = 0; ; offset += limit) {
      const res = await fetch(`${storageBase}/object/list/${BUCKET}`, {
        method: "POST",
        headers: { ...storageHeaders(key), "content-type": "application/json" },
        body: JSON.stringify({ prefix, limit, offset, sortBy: { column: "name", order: "asc" } }),
      });
      if (!res.ok) throw new Error(`listing ${describeUrl(storageBase)} ${BUCKET}/${prefix}: HTTP ${res.status} ${await safeText(res)}`);
      const entries = await res.json();
      for (const e of entries) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.id === null || e.id === undefined) {
          await walk(path);
        } else {
          const m = e.metadata || {};
          out.push({ path, size: Number(m.size ?? m.contentLength ?? 0), mimetype: m.mimetype || null, cacheControl: m.cacheControl || null });
        }
      }
      if (entries.length < limit) break;
    }
  }
  await walk("");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function safeText(res) {
  try {
    return redact((await res.text()).slice(0, 300));
  } catch {
    return "";
  }
}

/** The hosted project's Storage, and the target's (through Caddy). */
function hostedStorage() {
  return { base: `${need("HOSTED_URL").replace(/\/$/, "")}/storage/v1`, key: need("HOSTED_SERVICE_KEY") };
}
function targetStorage() {
  return { base: `${need("TARGET_URL").replace(/\/$/, "")}/storage/v1`, key: need("TARGET_SERVICE_KEY") };
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

module.exports = {
  redact,
  need,
  Usage,
  run,
  describeDb,
  describeUrl,
  connect,
  connectSource,
  connectTarget,
  serverVersion,
  assertDifferent,
  writableColumns,
  tableExists,
  q,
  PUBLIC_TABLES,
  TARGET_TABLES,
  USER_COLUMNS,
  USER_EMPTY_STRING_COLUMNS,
  IDENTITY_COLUMNS,
  skippedUsers,
  selections,
  BUCKET,
  storageHeaders,
  encodePath,
  listBucket,
  safeText,
  hostedStorage,
  targetStorage,
  formatBytes,
};
