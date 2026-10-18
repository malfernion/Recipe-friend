#!/usr/bin/env node
/**
 * Copies Recipe Friend's rows from the hosted Supabase project into the
 * self-hosted database (Workstream E). Data only: the target already has
 * the schema, from server/migrate.sh.
 *
 *   node server/migrate-from-supabase/copy-data.js
 *   node server/migrate-from-supabase/copy-data.js --wipe-target --yes-delete-everything-on-target
 *
 * Reads HOSTED_DB_URL in a read-only transaction and writes TARGET_DB_URL
 * in one transaction: all of it lands, or none of it does. See README.md
 * beside this file for what moves and what does not, and why.
 */
"use strict";

const lib = require("./lib.js");

const WIPE = "--wipe-target";
const WIPE_CONFIRM = "--yes-delete-everything-on-target";

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== WIPE && a !== WIPE_CONFIRM);
  if (unknown.length) throw new lib.Usage(`unknown argument ${unknown[0]}. Usage: copy-data.js [${WIPE} ${WIPE_CONFIRM}]`);
  const wipe = args.includes(WIPE);
  if (wipe && !args.includes(WIPE_CONFIRM)) {
    throw new lib.Usage(
      `${WIPE} TRUNCATES auth.users and every app table on the target, cascading to sessions and identities.\n` +
        `  It is for re-running a rehearsal. If that is what you mean, add ${WIPE_CONFIRM}.`
    );
  }
  if (args.includes(WIPE_CONFIRM) && !wipe) throw new lib.Usage(`${WIPE_CONFIRM} only means something with ${WIPE}.`);

  const src = await lib.connectSource();
  const dst = await lib.connectTarget();
  try {
    return await copy(src, dst, wipe);
  } finally {
    await src.query("rollback").catch(() => {});
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
}

async function copy(src, dst, wipe) {
  // --- 1. Who is who --------------------------------------------------
  await lib.assertDifferent(src, dst);
  const sv = await lib.serverVersion(src);
  const tv = await lib.serverVersion(dst);
  console.log(`hosted: Postgres ${sv.text} at ${lib.describeDb(process.env.HOSTED_DB_URL)} (read-only)`);
  console.log(`target: Postgres ${tv.text} at ${lib.describeDb(process.env.TARGET_DB_URL)}`);
  if (sv.major !== tv.major) {
    console.log(`note: major versions differ (${sv.major} → ${tv.major}). Rows are copied as SQL values, so this is fine; noted for the record.`);
  }

  // --- 2. Is the target ready, and empty? -------------------------------
  if (!(await lib.tableExists(dst, "recipe_friend.schema_migrations"))) {
    throw new Error("target has no recipe_friend.schema_migrations: run the migrate service (server/migrate.sh) on it first.");
  }
  const applied = (await dst.query("select version from recipe_friend.schema_migrations order by version")).rows.map((r) => r.version);
  if (!applied.some((v) => v.startsWith("009_"))) {
    throw new Error(`target schema is not migrated to 009 (has: ${applied.join(", ") || "nothing"}). Deploy the stack so migrate runs, then try again.`);
  }
  console.log(`target schema: ${applied.length} migrations applied, latest ${applied[applied.length - 1]}`);

  const occupied = [];
  for (const t of lib.TARGET_TABLES) {
    const n = Number((await dst.query(`select count(*) as n from ${t}`)).rows[0].n);
    if (n > 0) occupied.push(`${t}: ${n}`);
  }
  if (occupied.length && !wipe) {
    throw new Error(
      `target is not empty — refusing to copy on top of existing data:\n    ${occupied.join("\n    ")}\n` +
        `  For a repeat rehearsal, run again with --wipe-target --yes-delete-everything-on-target.`
    );
  }

  // --- 3. What the hosted side has, and what stays behind ---------------
  for (const t of ["auth.users", "auth.identities", ...lib.PUBLIC_TABLES.map((x) => `public.${x}`)]) {
    if (!(await lib.tableExists(src, t))) throw new Error(`hosted database has no ${t}. Is HOSTED_DB_URL the Recipe Friend project?`);
  }
  const skipped = await lib.skippedUsers(src);
  const skippedIds = skipped.map((s) => s.id);
  console.log(`\nleft behind: ${skipped.length} agent/anonymous account(s) — agents are re-issued after cutover (E7)`);
  for (const s of skipped) console.log(`  ${s.id}  (${s.reasons.join(", ")})`);

  // A book owned by a skipped account would take its recipes with it. The
  // schema has not allowed that since 008, so if it happens, stop and look.
  const orphanBooks = (await src.query("select id, owner from public.books where owner = any($1::uuid[])", [skippedIds])).rows;
  if (orphanBooks.length) {
    throw new Error(
      `${orphanBooks.length} book(s) are owned by an agent/anonymous account, and copying would drop them and their recipes:\n    ` +
        orphanBooks.map((b) => `book ${b.id} owned by ${b.owner}`).join("\n    ") +
        `\n  Nothing was written. Move those books to a person on the hosted site first.`
    );
  }

  const sel = lib.selections();
  const notes = [];
  const count = async (sql, params = []) => Number((await src.query(sql, params)).rows[0].n);
  notes.push(["auth.identities", "non-Google or agent identities", await count(`select count(*) as n from auth.identities where not (${sel["auth.identities"].where})`, [skippedIds])]);
  notes.push(["public.profiles", "agent profiles", await count(`select count(*) as n from public.profiles where not (${sel["public.profiles"].where})`, [skippedIds])]);
  notes.push(["public.book_members", "agent memberships", await count(`select count(*) as n from public.book_members where not (${sel["public.book_members"].where})`, [skippedIds])]);
  notes.push(["public.invites", "expired invites", await count("select count(*) as n from public.invites where expires_at <= now()")]);
  notes.push([
    "public.invites",
    "live invites made by an agent account",
    await count("select count(*) as n from public.invites where expires_at > now() and created_by = any($1::uuid[])", [skippedIds]),
  ]);
  if (await lib.tableExists(src, "public.agent_accounts")) {
    notes.push(["public.agent_accounts", "agent records (stays empty)", await count("select count(*) as n from public.agent_accounts")]);
  }

  // --- 4. Columns: what both sides have ---------------------------------
  const plan = [];
  for (const table of ["auth.users", "auth.identities", ...lib.PUBLIC_TABLES.map((t) => `public.${t}`)]) {
    const [schema, name] = table.split(".");
    const srcCols = await lib.writableColumns(src, schema, name);
    const dstCols = await lib.writableColumns(dst, schema, name);
    let cols;
    if (table === "auth.users") cols = lib.USER_COLUMNS;
    else if (table === "auth.identities") cols = lib.IDENTITY_COLUMNS;
    else cols = srcCols;
    const both = cols.filter((c) => srcCols.includes(c) && dstCols.includes(c));
    const dropped = cols.filter((c) => !both.includes(c));
    if (dropped.length) console.log(`note: ${table}: not on both sides, so not copied: ${dropped.join(", ")}`);
    const missingInTarget = srcCols.filter((c) => !dstCols.includes(c));
    if (table.startsWith("public.") && missingInTarget.length) {
      throw new Error(`${table} has columns on the hosted side that the target lacks: ${missingInTarget.join(", ")}. Is the target's schema older than hosted?`);
    }
    for (const k of sel[table].key) {
      if (!both.includes(k)) throw new Error(`${table}: key column ${k} is not on both sides; cannot copy.`);
    }
    const constants = table === "auth.users" ? lib.USER_EMPTY_STRING_COLUMNS.filter((c) => dstCols.includes(c) && !both.includes(c)) : [];
    plan.push({ table, cols: both, constants });
  }

  // --- 5. Read --------------------------------------------------------
  for (const p of plan) {
    const cols = p.cols.map(lib.q).join(", ");
    p.rows = (await src.query({ text: `select ${cols} from ${p.table} where ${sel[p.table].where} order by ${sel[p.table].key.map(lib.q).join(", ")}`, values: [skippedIds], rowMode: "array" })).rows;
  }

  // --- 6. Write, in one transaction, with triggers off -------------------
  //
  // replica: the new-user trigger would give every imported person a
  // second book, live_plans_touched would overwrite updated_at, and the
  // quota triggers would count rows as they land. Foreign keys are
  // triggers too, so they are off as well — checked by hand in step 7
  // before anything is committed.
  await dst.query("begin");
  try {
    await dst.query("set local session_replication_role = replica");
    if (wipe) {
      console.log(`\nwiping target: truncate ${lib.TARGET_TABLES.join(", ")} cascade`);
      await dst.query(`truncate ${lib.TARGET_TABLES.join(", ")} cascade`);
    }
    for (const p of plan) await insertRows(dst, p);

    // --- 7. Every foreign key, checked before commit --------------------
    const orphans = await dst.query(`
      select 'auth.identities.user_id' as ref, count(*) as n from auth.identities i where not exists (select 1 from auth.users u where u.id = i.user_id)
      union all select 'profiles.user_id', count(*) from public.profiles x where not exists (select 1 from auth.users u where u.id = x.user_id)
      union all select 'books.owner', count(*) from public.books x where not exists (select 1 from auth.users u where u.id = x.owner)
      union all select 'book_members.user_id', count(*) from public.book_members x where not exists (select 1 from auth.users u where u.id = x.user_id)
      union all select 'book_members.book_id', count(*) from public.book_members x where not exists (select 1 from public.books b where b.id = x.book_id)
      union all select 'recipes.book_id', count(*) from public.recipes x where not exists (select 1 from public.books b where b.id = x.book_id)
      union all select 'invites.book_id', count(*) from public.invites x where not exists (select 1 from public.books b where b.id = x.book_id)
      union all select 'invites.created_by', count(*) from public.invites x where not exists (select 1 from auth.users u where u.id = x.created_by)
      union all select 'live_plans.book_id', count(*) from public.live_plans x where not exists (select 1 from public.books b where b.id = x.book_id)
      union all select 'plans.book_id', count(*) from public.plans x where not exists (select 1 from public.books b where b.id = x.book_id)`);
    const broken = orphans.rows.filter((r) => Number(r.n) > 0);
    if (broken.length) {
      throw new Error(`foreign keys would break; rolled back, nothing written:\n    ${broken.map((r) => `${r.ref}: ${r.n} row(s) point at nothing`).join("\n    ")}`);
    }

    // Each book's owner is in its member list, as the app assumes.
    const ownerless = Number((await dst.query(
      "select count(*) as n from public.books b where not exists (select 1 from public.book_members m where m.book_id = b.id and m.user_id = b.owner and m.role = 'owner')"
    )).rows[0].n);
    if (ownerless) console.log(`warning: ${ownerless} book(s) have no 'owner' membership row for their owner (copied as they are on hosted).`);

    await dst.query("set local session_replication_role = origin");
    await dst.query("commit");
  } catch (e) {
    await dst.query("rollback").catch(() => {});
    throw e;
  }

  // --- 8. Report -----------------------------------------------------
  console.log("\ncopied:");
  for (const p of plan) console.log(`  ${p.table.padEnd(20)} ${String(p.rows.length).padStart(6)}`);
  console.log(`  ${"public.agent_accounts".padEnd(20)} ${"0".padStart(6)}  (by design: agents are re-issued)`);
  console.log("\nleft behind on purpose:");
  for (const [table, what, n] of notes) console.log(`  ${table.padEnd(20)} ${String(n).padStart(6)}  ${what}`);
  console.log("\nnot copied at all: sessions, refresh tokens, passwords, MFA, one-time tokens — everyone signs in once on the new site.");
  console.log("next: copy-photos.js, then verify.js.");
  return 0;
}

/** Multi-row inserts, as text values cast by Postgres to each column's type. */
async function insertRows(db, { table, cols, constants, rows }) {
  if (!rows.length) return;
  const names = [...cols, ...constants].map(lib.q).join(", ");
  const perRow = cols.length;
  const batch = Math.max(1, Math.floor(30000 / perRow));
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const values = [];
    const tuples = chunk.map((row, r) => {
      const ph = row.map((v, c) => {
        values.push(v);
        return `$${r * perRow + c + 1}`;
      });
      return `(${[...ph, ...constants.map(() => "''")].join(", ")})`;
    });
    await db.query(`insert into ${table} (${names}) values ${tuples.join(", ")}`, values);
  }
}

lib.run(main);
