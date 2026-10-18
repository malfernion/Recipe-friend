#!/usr/bin/env node
/**
 * Compares the hosted project with the self-hosted one after copy-data and
 * copy-photos (Workstream E, E2/E5). Exits 0 only if everything that was
 * meant to move is there, unchanged, and nothing else is.
 *
 *   node server/migrate-from-supabase/verify.js
 *   node server/migrate-from-supabase/verify.js --skip-photos
 *
 * Read-only on both sides. Run it straight after the copy: anything done on
 * the new site in between (a sign-in, an edit) is a difference, honestly
 * reported.
 */
"use strict";

const lib = require("./lib.js");

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--skip-photos");
  if (unknown.length) throw new lib.Usage(`unknown argument ${unknown[0]}. Usage: verify.js [--skip-photos]`);
  const problems = [];
  const fail = (msg) => problems.push(msg);

  await verifyDatabase(fail);
  await verifyGoTrue(fail);
  if (args.includes("--skip-photos")) console.log("\nphotos: skipped (--skip-photos)");
  else await verifyPhotos(fail);

  if (problems.length) {
    console.error(`\nFAIL — ${problems.length} difference(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log("\nOK — the target matches the hosted project, less the documented exclusions.");
  return 0;
}

// ---------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------

/**
 * Which columns each table is compared on. Public tables: every column.
 * auth.users: who the account is, not GoTrue's bookkeeping, which a
 * sign-in changes. auth.identities: the Google account → user mapping.
 */
const COMPARE = {
  "auth.users": ["id", "email", "is_anonymous", "created_at"],
  "auth.identities": ["provider", "provider_id", "user_id"],
  "public.recipes": ["id", "book_id", "data", "updated_at", "deleted_at"],
};

let skippedIds = [];

async function verifyDatabase(fail) {
  const src = await lib.connectSource();
  const dst = await lib.connect(lib.need("TARGET_DB_URL"), { label: "target" });
  await dst.query("set default_transaction_read_only = on");
  try {
    await lib.assertDifferent(src, dst);
    const skipped = await lib.skippedUsers(src);
    skippedIds = skipped.map((s) => s.id);
    console.log(`hosted ${lib.describeDb(process.env.HOSTED_DB_URL)} → target ${lib.describeDb(process.env.TARGET_DB_URL)}`);
    console.log(`excluded: ${skipped.length} agent/anonymous account(s), agent memberships, expired invites\n`);
    console.log(`${"table".padEnd(22)} ${"hosted".padStart(7)} ${"expect".padStart(7)} ${"target".padStart(7)}`);

    const sel = lib.selections();
    for (const table of Object.keys(sel)) {
      const [schema, name] = table.split(".");
      const srcCols = await lib.writableColumns(src, schema, name);
      const dstCols = await lib.writableColumns(dst, schema, name);
      const wanted = COMPARE[table] || srcCols;
      const cols = wanted.filter((c) => srcCols.includes(c) && dstCols.includes(c));
      const key = sel[table].key;
      const rowsOf = async (db, where, params) => {
        const sql = `select ${key.map((k) => `${lib.q(k)}::text`).join(" || '/' || ")} as k,
                            md5(row(${cols.map(lib.q).join(", ")})::text) as h
                       from ${table} where ${where}`;
        return new Map((await db.query(sql, params)).rows.map((r) => [r.k, r.h]));
      };
      const all = Number((await src.query(`select count(*) as n from ${table}`)).rows[0].n);
      const expected = await rowsOf(src, sel[table].where, [skippedIds]);
      const actual = await rowsOf(dst, "true", []);
      console.log(`${table.padEnd(22)} ${String(all).padStart(7)} ${String(expected.size).padStart(7)} ${String(actual.size).padStart(7)}`);

      const missing = [...expected.keys()].filter((k) => !actual.has(k));
      const changed = [...expected.keys()].filter((k) => actual.has(k) && actual.get(k) !== expected.get(k));
      let extra = [...actual.keys()].filter((k) => !expected.has(k));
      if (table === "public.invites" && extra.length) {
        // An invite that was live at copy time and has expired since is
        // fine: it is on hosted too, and equally dead on both.
        const expiredSince = new Map(
          (await src.query("select code as k from public.invites where expires_at <= now() and code = any($1)", [extra])).rows.map((r) => [r.k, true])
        );
        extra = extra.filter((k) => !expiredSince.has(k));
      }
      const show = (list) => list.slice(0, 10).join(", ") + (list.length > 10 ? `, … (${list.length - 10} more)` : "");
      if (missing.length) fail(`${table}: ${missing.length} row(s) missing on target: ${show(missing)}`);
      if (extra.length) fail(`${table}: ${extra.length} row(s) on target that should not be there: ${show(extra)}`);
      if (changed.length) fail(`${table}: ${changed.length} row(s) differ (columns ${cols.join(", ")}): ${show(changed)}`);
    }

    // The checksum the plan asks for, over every recipe, as one number each side.
    const sum = `select md5(coalesce(string_agg(row(id, book_id, data, updated_at, deleted_at)::text, '|' order by id), '')) as s, count(*) as n from public.recipes`;
    const a = (await src.query(sum)).rows[0];
    const b = (await dst.query(sum)).rows[0];
    console.log(`\nrecipes checksum: hosted ${a.s} (${a.n}), target ${b.s} (${b.n})`);
    if (a.s !== b.s) fail(`recipes checksum differs: hosted ${a.s}, target ${b.s}`);

    // Nothing an agent left behind.
    const agentRows = Number((await dst.query("select count(*) as n from public.book_members where role = 'agent'")).rows[0].n);
    if (agentRows) fail(`target has ${agentRows} agent membership(s); agents are meant to be re-issued, not copied`);
    const agentAccounts = Number((await dst.query("select count(*) as n from public.agent_accounts")).rows[0].n);
    if (agentAccounts) fail(`target public.agent_accounts has ${agentAccounts} row(s); it should be empty after the copy`);
    const leaked = (await dst.query("select id from auth.users where id = any($1::uuid[])", [skippedIds])).rows;
    if (leaked.length) fail(`agent/anonymous account(s) present on target: ${leaked.map((r) => r.id).join(", ")}`);

    // Every person can sign in with the Google account they used before.
    const people = (await src.query("select id from auth.users where not (id = any($1::uuid[])) order by id", [skippedIds])).rows.map((r) => r.id);
    const googleOf = async (db) => {
      const m = new Map();
      for (const r of (await db.query("select user_id, provider_id from auth.identities where provider = 'google'")).rows) {
        if (!m.has(r.user_id)) m.set(r.user_id, new Set());
        m.get(r.user_id).add(r.provider_id);
      }
      return m;
    };
    const srcGoogle = await googleOf(src);
    const dstGoogle = await googleOf(dst);
    let ok = 0;
    for (const id of people) {
      const want = [...(srcGoogle.get(id) || [])].sort();
      const have = [...(dstGoogle.get(id) || [])].sort();
      if (!have.length) {
        fail(`user ${id} has no google identity on target${want.length ? "" : " (none on hosted either — this account cannot sign in on the new site)"}`);
      } else if (want.join() !== have.join()) {
        fail(`user ${id}: google provider_id differs (hosted ${want.join(",") || "none"}, target ${have.join(",")})`);
      } else ok++;
    }
    console.log(`google identities: ${ok} of ${people.length} account(s) map to the same Google account`);
  } finally {
    await src.query("rollback").catch(() => {});
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
}

/**
 * GoTrue itself can load every imported user. A row Postgres accepts can
 * still be one GoTrue cannot read (a NULL where it expects a string), and
 * that shows up as a failed sign-in, not as an error here — so ask it.
 * Needs TARGET_URL and TARGET_SERVICE_KEY; skipped, with a note, without.
 */
async function verifyGoTrue(fail) {
  if (!process.env.TARGET_URL || !process.env.TARGET_SERVICE_KEY) {
    console.log("\ngotrue: skipped (TARGET_URL / TARGET_SERVICE_KEY not set)");
    return;
  }
  const base = `${process.env.TARGET_URL.replace(/\/$/, "")}/auth/v1`;
  const key = process.env.TARGET_SERVICE_KEY;
  const dst = await lib.connect(lib.need("TARGET_DB_URL"), { label: "target" });
  let ids;
  try {
    ids = (await dst.query("select id from auth.users order by id")).rows.map((r) => r.id);
  } finally {
    await dst.end().catch(() => {});
  }
  let ok = 0;
  for (const id of ids) {
    const res = await fetch(`${base}/admin/users/${id}`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
    if (!res.ok) {
      fail(`gotrue cannot load user ${id}: HTTP ${res.status} ${await lib.safeText(res)}`);
      continue;
    }
    const user = await res.json();
    if (user.id !== id) fail(`gotrue returned ${user.id} for user ${id}`);
    else ok++;
  }
  console.log(`\ngotrue: loaded ${ok} of ${ids.length} user(s) through ${lib.describeUrl(base)}/admin/users`);
}

// ---------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------

async function verifyPhotos(fail) {
  const hosted = lib.hostedStorage();
  const target = lib.targetStorage();
  const a = await lib.listBucket(hosted.base, hosted.key);
  const b = await lib.listBucket(target.base, target.key);
  const bytes = (list) => list.reduce((n, o) => n + o.size, 0);
  console.log(`\nphotos: hosted ${a.length} object(s), ${bytes(a)} bytes; target ${b.length} object(s), ${bytes(b)} bytes`);
  const bm = new Map(b.map((o) => [o.path, o]));
  const am = new Map(a.map((o) => [o.path, o]));
  const missing = a.filter((o) => !bm.has(o.path)).map((o) => o.path);
  const extra = b.filter((o) => !am.has(o.path)).map((o) => o.path);
  const differ = a.filter((o) => bm.has(o.path) && (bm.get(o.path).size !== o.size || (o.mimetype && bm.get(o.path).mimetype !== o.mimetype)));
  const show = (list) => list.slice(0, 10).join(", ") + (list.length > 10 ? `, … (${list.length - 10} more)` : "");
  if (a.length !== b.length) fail(`photo count differs: hosted ${a.length}, target ${b.length}`);
  if (bytes(a) !== bytes(b)) fail(`photo bytes differ: hosted ${bytes(a)}, target ${bytes(b)}`);
  if (missing.length) fail(`${missing.length} photo(s) missing on target: ${show(missing)}`);
  if (extra.length) fail(`${extra.length} photo(s) on target not on hosted: ${show(extra)}`);
  if (differ.length) {
    fail(`${differ.length} photo(s) differ in size or type: ${show(differ.map((o) => `${o.path} (${o.size} ${o.mimetype} → ${bm.get(o.path).size} ${bm.get(o.path).mimetype})`))}`);
  }
}

lib.run(main);
