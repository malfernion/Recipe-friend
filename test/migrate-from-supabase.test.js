/**
 * Workstream E · moving off hosted Supabase: copy-data, copy-photos and
 * verify (server/migrate-from-supabase/), run for real between two of the
 * server/ dev stacks — one standing in for the hosted project, one for the
 * lab.
 *
 * The "hosted" stack is seeded the way production got its rows: people
 * signing in (the new-user trigger makes their book), a shared book with an
 * editor and a viewer, an agent placed in it, invites live and expired, a
 * plan, photos. Then the three scripts run as Dave would run them, and the
 * target is asked what arrived.
 *
 * Needs two stacks and these, and skips without them:
 *
 *   MIGRATE_TEST_SOURCE_DB   postgres URL of the stack playing hosted
 *   MIGRATE_TEST_TARGET_DB   postgres URL of the stack playing the lab
 *   MIGRATE_TEST_SOURCE_URL  that stack's Caddy, e.g. http://127.0.0.1:18181
 *   MIGRATE_TEST_TARGET_URL  this one's
 *
 * Both stacks use the development keys in server/.env(.example). EVERY ROW
 * AND PHOTO IN BOTH IS DELETED at the start: point these only at throwaway
 * stacks. See server/migrate-from-supabase/README.md, "Testing".
 */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { stackConfig } = require("./helpers/db.js");

const SRC_DB = process.env.MIGRATE_TEST_SOURCE_DB || "";
const DST_DB = process.env.MIGRATE_TEST_TARGET_DB || "";
const SRC_URL = process.env.MIGRATE_TEST_SOURCE_URL || "";
const DST_URL = process.env.MIGRATE_TEST_TARGET_URL || "";
const skip =
  SRC_DB && DST_DB && SRC_URL && DST_URL ? false : "MIGRATE_TEST_{SOURCE,TARGET}_{DB,URL} are not set, so there are no two stacks to migrate between";

const DIR = path.join(__dirname, "..", "server", "migrate-from-supabase");
const BUCKET = "recipe-photos";
const t = (name, fn) => test(name, { skip }, fn);

let pools = null;
function db() {
  if (!pools) {
    const { Pool } = require("pg");
    // Timestamps and jsonb as text, so "unchanged" means byte for byte.
    const types = { getTypeParser: () => (v) => v };
    pools = { src: new Pool({ connectionString: SRC_DB, max: 2, types }), dst: new Pool({ connectionString: DST_DB, max: 2, types }) };
  }
  return pools;
}
after(async () => {
  if (pools) await Promise.all([pools.src.end(), pools.dst.end()]);
});

const key = () => stackConfig().serviceKey;
const auth = () => ({ apikey: key(), authorization: `Bearer ${key()}` });

function scriptEnv(over = {}) {
  return {
    PATH: process.env.PATH,
    HOSTED_DB_URL: SRC_DB,
    HOSTED_URL: SRC_URL,
    HOSTED_SERVICE_KEY: key(),
    TARGET_DB_URL: DST_DB,
    TARGET_URL: DST_URL,
    TARGET_SERVICE_KEY: key(),
    ...over,
  };
}

/** Run one of the scripts as Dave would: its own process, env only. */
function script(name, args = [], env = {}) {
  const r = spawnSync(process.execPath, [path.join(DIR, name), ...args], { env: scriptEnv(env), encoding: "utf8", timeout: 120000 });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}

// ---------------------------------------------------------------------
// Storage, through each stack's Caddy
// ---------------------------------------------------------------------

async function listPhotos(base) {
  const out = [];
  async function walk(prefix) {
    const res = await fetch(`${base}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    for (const e of await res.json()) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id === null) await walk(p);
      else out.push({ path: p, size: e.metadata.size, mimetype: e.metadata.mimetype });
    }
  }
  await walk("");
  return out;
}

async function clearPhotos(base) {
  const all = await listPhotos(base);
  if (!all.length) return;
  const res = await fetch(`${base}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ prefixes: all.map((o) => o.path) }),
  });
  assert.equal(res.status, 200, await res.clone().text());
}

async function upload(base, name, bytes, type) {
  const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${name}`, {
    method: "POST",
    headers: { ...auth(), "content-type": type },
    body: bytes,
  });
  assert.equal(res.status, 200, await res.clone().text());
}

async function download(base, name) {
  const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${name}`, { headers: auth() });
  assert.equal(res.status, 200);
  return { bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") };
}

// ---------------------------------------------------------------------
// The "hosted" project, seeded as production was: by people using it
// ---------------------------------------------------------------------

const APP_TABLES = "public.profiles, public.books, public.book_members, public.recipes, public.invites, public.live_plans, public.plans, public.agent_accounts";

async function wipe(pool) {
  await pool.query(`truncate ${APP_TABLES}, auth.users cascade`);
}

/** A person signing in with Google: GoTrue's users row and identity row. The trigger does the rest. */
async function person(pool, name) {
  const id = randomUUID();
  const sub = String(100000000000000000000n + BigInt(Math.floor(Math.random() * 1e12)));
  const email = `${name.toLowerCase()}-${id.slice(0, 8)}@example.test`;
  await pool.query(
    `insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data,
                             is_anonymous, created_at, updated_at, last_sign_in_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, now(), $3,
             '{"provider":"google","providers":["google"]}', false, now() - interval '200 days', now(), now())`,
    [id, email, JSON.stringify({ name, full_name: name, sub })]
  );
  await pool.query(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     values ($1, $2, $3, 'google', now(), now(), now())`,
    [sub, id, JSON.stringify({ sub, email, name, email_verified: true })]
  );
  const book = (await pool.query("select id from public.books where owner = $1", [id])).rows[0].id;
  return { id, sub, email, book };
}

/** An agent: an anonymous account, placed in `book` as add_agent places one. */
async function agent(pool, book) {
  const id = randomUUID();
  await pool.query(
    `insert into auth.users (id, instance_id, aud, role, raw_user_meta_data, raw_app_meta_data, is_anonymous, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{"name":"Kitchen helper"}', '{}', true, now(), now())`,
    [id]
  );
  await pool.query("insert into public.agent_accounts (user_id) values ($1)", [id]);
  await pool.query("insert into public.book_members (book_id, user_id, role) values ($1, $2, 'agent')", [book, id]);
  return id;
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5000, 7), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1234, 3)]);

const seed = {};

t("setup: two throwaway stacks, emptied, and the hosted one seeded with a household", async () => {
  const { src, dst } = db();
  for (const p of [src, dst]) {
    const applied = (await p.query("select count(*) as n from recipe_friend.schema_migrations where version like '009_%'")).rows[0].n;
    assert.equal(applied, "1", "both stacks must be migrated through 009 (server/migrate.sh)");
    await wipe(p);
  }
  await clearPhotos(SRC_URL);
  await clearPhotos(DST_URL);

  const ann = await person(src, "Ann");
  const ben = await person(src, "Ben");
  const cat = await person(src, "Cat");
  await src.query("insert into public.book_members (book_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ann.book, ben.id, cat.id]);
  await src.query("update public.profiles set unit_prefs = '{\"system\":\"metric\"}' where user_id = $1", [ann.id]);
  const helper = await agent(src, ann.book);
  // An anonymous sign-in that never got placed, as a failed add_agent leaves.
  const stray = randomUUID();
  await src.query(
    `insert into auth.users (id, instance_id, aud, role, raw_user_meta_data, raw_app_meta_data, is_anonymous, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '{}', '{}', true, now(), now())`,
    [stray]
  );

  const soup = randomUUID();
  const gone = randomUUID();
  const toast = randomUUID();
  await src.query(
    `insert into public.recipes (id, book_id, data, updated_at, deleted_at, created_at) values
       ($1, $4, $5, '2026-01-02 03:04:05.123456+00', null, '2025-12-01 10:00:00.654321+00'),
       ($2, $4, '{"name":"Old stew"}', '2026-02-03 04:05:06.000001+00', '2026-02-03 04:05:06.000001+00', '2025-11-01 00:00:00+00'),
       ($3, $6, '{"name":"Toast","notes":"ünïcødé ✓"}', now(), null, now())`,
    [soup, gone, toast, ann.book, JSON.stringify({ name: "Soup", photo: `${ann.book}/${soup}.jpg`, ingredients: [{ qty: 1.5, unit: "l" }] }), ben.book]
  );
  const live = randomUUID();
  const expired = randomUUID();
  await src.query(
    `insert into public.invites (code, book_id, created_by, role, expires_at) values
       ($1, $3, $4, 'viewer', now() + interval '2 days'),
       ($2, $3, $4, 'editor', now() - interval '1 day')`,
    [live, expired, ann.book, ann.id]
  );
  await src.query("insert into public.live_plans (book_id, data) values ($1, $2)", [ann.book, JSON.stringify({ id: randomUUID(), meals: [{ recipe: soup }] })]);
  const planId = randomUUID();
  await src.query("insert into public.plans (id, book_id, data, completed_at) values ($1, $2, $3, now() - interval '7 days')", [
    planId,
    ann.book,
    JSON.stringify({ id: planId, meals: [] }),
  ]);

  await upload(SRC_URL, `${ann.book}/${soup}.jpg`, JPEG, "image/jpeg");
  await upload(SRC_URL, `${ben.book}/${toast}.png`, PNG, "image/png");

  Object.assign(seed, { ann, ben, cat, helper, stray, soup, gone, toast, live, expired });
  const books = (await src.query("select count(*) as n from public.books")).rows[0].n;
  assert.equal(books, "3", "one book each for the three people, none for the agent");
});

t("copy-data refuses when both URLs reach the same database, even with --wipe-target", () => {
  const r = script("copy-data.js", ["--wipe-target", "--yes-delete-everything-on-target"], { TARGET_DB_URL: SRC_DB });
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /reach the same database/);
});

t("copy-data refuses a wipe without the second, explicit flag, and writes nothing", () => {
  const r = script("copy-data.js", ["--wipe-target"]);
  assert.equal(r.code, 2, r.all);
  assert.match(r.err, /--yes-delete-everything-on-target/);
});

t("copy-data copies the household into an empty, migrated target", () => {
  const r = script("copy-data.js");
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /hosted: Postgres 17\./);
  assert.match(r.out, /target: Postgres 17\./);
  assert.match(r.out, /left behind: 2 agent\/anonymous account/);
  assert.match(r.out, /public\.invites\s+1\s+expired invites/);
});

t("people keep their user ids, and each Google account still maps to the same user", async () => {
  const { dst } = db();
  for (const p of [seed.ann, seed.ben, seed.cat]) {
    const u = (await dst.query("select email, is_anonymous from auth.users where id = $1", [p.id])).rows[0];
    assert.ok(u, `user ${p.id} is on the target`);
    assert.equal(u.email, p.email);
    assert.equal(u.is_anonymous, "f");
    const ids = (await dst.query("select provider_id from auth.identities where user_id = $1 and provider = 'google'", [p.id])).rows;
    assert.deepEqual(ids.map((r) => r.provider_id), [p.sub]);
  }
  // GoTrue's string columns are '' rather than NULL, which it cannot read.
  const nulls = (await dst.query("select count(*) as n from auth.users where confirmation_token is null or recovery_token is null")).rows[0].n;
  assert.equal(nulls, "0");
});

t("agents are not migrated: no account, no profile, no membership, agent_accounts empty", async () => {
  const { dst } = db();
  for (const id of [seed.helper, seed.stray]) {
    assert.equal((await dst.query("select count(*) as n from auth.users where id = $1", [id])).rows[0].n, "0");
    assert.equal((await dst.query("select count(*) as n from public.profiles where user_id = $1", [id])).rows[0].n, "0");
    assert.equal((await dst.query("select count(*) as n from public.book_members where user_id = $1", [id])).rows[0].n, "0");
  }
  assert.equal((await dst.query("select count(*) as n from public.agent_accounts")).rows[0].n, "0");
  const roles = (await dst.query("select role from public.book_members where book_id = $1 order by role", [seed.ann.book])).rows.map((r) => r.role);
  assert.deepEqual(roles, ["editor", "owner", "viewer"]);
});

t("the new-user trigger did not run on the import: the same three books, no extras", async () => {
  const { src, dst } = db();
  const books = async (p) => (await p.query("select id, name, owner, created_at from public.books order by id")).rows;
  assert.deepEqual(await books(dst), await books(src));
  assert.equal((await dst.query("select count(*) as n from public.profiles")).rows[0].n, "3");
});

t("recipes, tombstones, plans and timestamps arrive exactly; expired invites stay behind", async () => {
  const { src, dst } = db();
  const recipes = async (p) => (await p.query("select id, book_id, data, updated_at, deleted_at, created_at from public.recipes order by id")).rows;
  assert.deepEqual(await recipes(dst), await recipes(src));
  // live_plans_touched would have stamped the copy's own time.
  const lp = async (p) => (await p.query("select book_id, data, updated_at, created_at from public.live_plans")).rows;
  assert.deepEqual(await lp(dst), await lp(src));
  const plans = async (p) => (await p.query("select * from public.plans order by id")).rows;
  assert.deepEqual(await plans(dst), await plans(src));
  const codes = (await dst.query("select code from public.invites")).rows.map((r) => r.code);
  assert.deepEqual(codes, [seed.live]);
  const prefs = (await dst.query("select unit_prefs from public.profiles where user_id = $1", [seed.ann.id])).rows[0].unit_prefs;
  assert.equal(prefs, '{"system": "metric"}');
});

t("triggers are back on after the copy: a new person on the target gets a book", async () => {
  const { dst } = db();
  const newcomer = await person(dst, "Dee");
  assert.ok(newcomer.book, "handle_new_user ran");
  await dst.query("delete from auth.users where id = $1", [newcomer.id]);
});

t("the hosted side was only read", async () => {
  const { src } = db();
  assert.equal((await src.query("select count(*) as n from auth.users")).rows[0].n, "5");
  assert.equal((await src.query("select count(*) as n from public.book_members where role = 'agent'")).rows[0].n, "1");
  assert.equal((await src.query("select count(*) as n from public.invites")).rows[0].n, "2");
});

t("copy-data refuses a target that is not empty", () => {
  const r = script("copy-data.js");
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /target is not empty/);
});

t("copy-photos copies every photo to the same path with the same type, then skips them on a re-run", async () => {
  const first = script("copy-photos.js");
  assert.equal(first.code, 0, first.all);
  assert.match(first.out, /uploaded 2 .*skipped 0/);

  const jpg = await download(DST_URL, `${seed.ann.book}/${seed.soup}.jpg`);
  assert.ok(jpg.bytes.equals(JPEG));
  assert.equal(jpg.type, "image/jpeg");
  const png = await download(DST_URL, `${seed.ben.book}/${seed.toast}.png`);
  assert.ok(png.bytes.equals(PNG));
  assert.equal(png.type, "image/png");

  const again = script("copy-photos.js");
  assert.equal(again.code, 0, again.all);
  assert.match(again.out, /uploaded 0 .*skipped 2/);
});

t("verify passes on a faithful copy, including GoTrue loading every imported user", () => {
  const r = script("verify.js");
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /google identities: 3 of 3/);
  assert.match(r.out, /gotrue: loaded 3 of 3/);
  assert.match(r.out, /photos: hosted 2 object\(s\), 6248 bytes; target 2 object\(s\), 6248 bytes/);
  assert.match(r.out, /^OK/m);
});

t("verify fails, naming the row, when a recipe differs or a photo or identity is missing", async () => {
  const { dst } = db();
  await dst.query("update public.recipes set data = data || '{\"name\":\"Soup!\"}' where id = $1", [seed.soup]);
  await dst.query("delete from auth.identities where user_id = $1", [seed.cat.id]);
  await clearPhotos(DST_URL);

  const r = script("verify.js");
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, new RegExp(`public\\.recipes: 1 row\\(s\\) differ.*${seed.soup}`));
  assert.match(r.err, /recipes checksum differs/);
  assert.match(r.err, new RegExp(`user ${seed.cat.id} has no google identity on target`));
  assert.match(r.err, /photo count differs: hosted 2, target 0/);
});

t("a rehearsal can be re-run: --wipe-target with the confirmation copies afresh, and verify passes again", () => {
  const r = script("copy-data.js", ["--wipe-target", "--yes-delete-everything-on-target"]);
  assert.equal(r.code, 0, r.all);
  assert.equal(script("copy-photos.js").code, 0);
  const v = script("verify.js");
  assert.equal(v.code, 0, v.all);
});

t("secrets stay out of the output: a failed connection names the host, never the password", () => {
  const password = `not-a-real-password-${randomUUID()}`;
  const u = new URL(DST_DB);
  u.password = password;
  const r = script("copy-data.js", [], { HOSTED_DB_URL: u.toString() });
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /could not connect to hosted/);
  assert.ok(!r.all.includes(password), r.all);

  const { redact } = require("../server/migrate-from-supabase/lib.js");
  assert.equal(redact("at postgres://postgres.abc:hunter22@aws-0.pooler.supabase.com:5432/postgres"), "at postgres://[redacted]@aws-0.pooler.supabase.com:5432/postgres");
  assert.equal(redact(`key ${key()}`), "key [redacted-jwt]");
  assert.equal(redact("key sb_secret_abcDEF123"), "key [redacted-key]");
});
