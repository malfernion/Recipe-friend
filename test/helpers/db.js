/**
 * The database, for the tests that run against it (test/db-*.test.js).
 *
 * Those tests need the stack in server/ up and migrated, and DATABASE_URL
 * pointing at its Postgres. Without DATABASE_URL they skip, so
 * `node --test test/*.test.js` still passes on a machine with no Docker.
 *
 * Every policy test runs inside one transaction that is rolled back at the
 * end, so each starts from the database as the migrations left it and
 * leaves nothing behind. Seeding happens as `postgres`, the role the
 * migrations ran as; acting happens as `authenticated` with the claims a
 * GoTrue token would carry, which is exactly what PostgREST does with a
 * request: `set local role` and `request.jwt.claims`.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DATABASE_URL = process.env.DATABASE_URL || "";
const skip = DATABASE_URL ? false : "DATABASE_URL is not set, so there is no database to test against";

let pool = null;
function getPool() {
  if (!pool) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  }
  return pool;
}

/** Close the pool once a file's tests are done, so node can exit. */
async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

/**
 * Run `fn(db)` inside a transaction that is always rolled back. `db` is
 * the Session below.
 */
async function inTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    return await fn(new Session(client));
  } finally {
    try {
      await client.query("rollback");
    } finally {
      client.release();
    }
  }
}

class Session {
  constructor(client) {
    this.client = client;
    this.savepoints = 0;
  }

  /** A plain query, as whoever is acting at the moment. */
  async q(sql, params = []) {
    return this.client.query(sql, params);
  }

  /** First row, or undefined. */
  async one(sql, params = []) {
    return (await this.q(sql, params)).rows[0];
  }

  /** Go back to being `postgres`: seeding, and reading what really happened. */
  async asAdmin() {
    await this.q("reset role");
    await this.q("select set_config('request.jwt.claims', '', true)");
  }

  /**
   * Act as a signed-in user, the way PostgREST does with their token.
   * `user` is what person() or agent() returned. An anonymous account's
   * token carries is_anonymous: true at the top level, and a Google one
   * carries false, so both are said here.
   */
  async as(user) {
    await this.asAdmin();
    const claims = {
      sub: user.id,
      role: "authenticated",
      aud: "authenticated",
      is_anonymous: Boolean(user.anonymous),
    };
    await this.q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await this.q("set local role authenticated");
  }

  /** Act as nobody: the publishable key with no session. */
  async asAnon() {
    await this.asAdmin();
    await this.q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    await this.q("set local role anon");
  }

  /**
   * Run a statement that is expected to be refused, and hand back the
   * error — or null if it went through. A savepoint keeps the refusal from
   * aborting the rest of the test's transaction.
   */
  async attempt(sql, params = []) {
    const name = `attempt_${++this.savepoints}`;
    await this.q(`savepoint ${name}`);
    try {
      const result = await this.q(sql, params);
      await this.q(`release savepoint ${name}`);
      return { error: null, rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
      await this.q(`rollback to savepoint ${name}`);
      return { error, rows: [], rowCount: 0 };
    }
  }

  // --- seeding, as postgres -------------------------------------------

  /**
   * A person: an auth.users row as GoTrue writes one for a Google
   * sign-in. The new-user trigger does the rest, as it does in production.
   */
  async person(name = "Ann") {
    await this.asAdmin();
    const id = randomUUID();
    await this.q(
      `insert into auth.users
         (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data,
          is_anonymous, created_at, updated_at)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
               $2, $3, '{"provider":"google","providers":["google"]}', false, now(), now())`,
      [id, `${id}@example.test`, JSON.stringify({ name })]
    );
    const book = await this.one("select id from public.books where owner = $1", [id]);
    return { id, name, book: book && book.id, anonymous: false };
  }

  /**
   * An anonymous GoTrue user, placed in no book: what anonymous sign-in
   * made, back when agents were made that way. Kept for the guards that
   * still have to refuse one.
   */
  async anonymous(name = "Kitchen helper") {
    await this.asAdmin();
    const id = randomUUID();
    await this.q(
      `insert into auth.users
         (id, instance_id, aud, role, raw_user_meta_data, raw_app_meta_data,
          is_anonymous, created_at, updated_at)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
               $2, '{}', true, now(), now())`,
      [id, JSON.stringify({ name })]
    );
    return { id, name, anonymous: true };
  }

  /**
   * An agent in `book`, made the way the app makes one: its owner calls
   * create_agent (migration 010). Comes back with its key, which is the
   * only time the key exists in plain text.
   */
  async agentIn(book, name = "Kitchen helper") {
    await this.asAdmin();
    const { owner } = await this.one("select owner from public.books where id = $1", [book]);
    await this.as({ id: owner, anonymous: false });
    const { made } = await this.one("select public.create_agent($1, $2) as made", [book, name]);
    await this.asAdmin();
    return { id: made.agent_id, name, key: made.key, keyPrefix: made.key_prefix, anonymous: true };
  }

  /** Act as the hosted MCP server does when it resolves a key. */
  async asMcp() {
    await this.asAdmin();
    await this.q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "recipe_friend_mcp" })]);
    await this.q("set local role recipe_friend_mcp");
  }

  /** Put `user` in `book` with `role`, as a redeemed invite would. */
  async member(book, user, role) {
    await this.asAdmin();
    await this.q("insert into public.book_members (book_id, user_id, role) values ($1, $2, $3)", [
      book,
      user.id,
      role,
    ]);
  }

  /** A recipe in `book`, with a fresh id. */
  async recipe(book, data = { name: "Soup" }) {
    await this.asAdmin();
    const id = randomUUID();
    await this.q("insert into public.recipes (id, book_id, data) values ($1, $2, $3)", [id, book, data]);
    return id;
  }

  /** An invite to `book`, minted by `owner`. `over` sets any column. */
  async invite(book, owner, over = {}) {
    await this.asAdmin();
    const row = { code: randomUUID(), book_id: book, created_by: owner.id, ...over };
    const cols = Object.keys(row);
    await this.q(
      `insert into public.invites (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      cols.map((c) => row[c])
    );
    return row.code;
  }

  /** The live plan for `book`, written as postgres. */
  async livePlan(book, data = { id: randomUUID(), meals: [] }) {
    await this.asAdmin();
    await this.q("insert into public.live_plans (book_id, data) values ($1, $2)", [book, data]);
  }
}

// ---------------------------------------------------------------------
// The HTTP side, for the end-to-end tests
// ---------------------------------------------------------------------

/**
 * The stack's address and keys. The keys come from server/.env if it
 * exists and server/.env.example if not — the development values, which
 * are the only ones a test should ever hold.
 */
function stackConfig() {
  const dir = path.join(__dirname, "..", "..", "server");
  const file = fs.existsSync(path.join(dir, ".env")) ? ".env" : ".env.example";
  const env = {};
  for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return {
    url: process.env.STACK_URL || `http://127.0.0.1:${env.HTTP_PORT || 8080}`,
    // The address the stack believes it has (PUBLIC_URL): GoTrue's issuer
    // and the MCP server's resource are built from it, and an OAuth client
    // checks they match the URL it was given.
    publicUrl: process.env.STACK_PUBLIC_URL || env.PUBLIC_URL || "http://localhost:8080",
    anonKey: env.ANON_KEY,
    serviceKey: env.SERVICE_ROLE_KEY,
    // Only for the tests that act as the hosted MCP server would.
    jwtSecret: env.JWT_SECRET,
    // How long the mcp service believes a resolved key (server/compose.yaml).
    mcpCacheSeconds: env.MCP_KEY_CACHE_SECONDS,
  };
}

/** The supabase-js the site ships, loaded the way index.html loads it. */
function vendoredSupabase() {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "js", "vendor", "supabase.js"), "utf8");
  return new Function(`${src}\n;return supabase;`)();
}

module.exports = { skip, inTransaction, closePool, getPool, stackConfig, vendoredSupabase, randomUUID };
