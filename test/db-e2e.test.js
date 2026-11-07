/**
 * The app's own calls, end to end: js/api.js through the supabase-js the
 * site ships, over HTTP, through Caddy, to GoTrue, PostgREST and Storage.
 *
 * The policy tests beside this one ask the database directly. These catch
 * what they cannot: a difference between what the SQL allows and what the
 * client actually sends — an upsert that is really an update, a signed
 * URL with the wrong prefix, an RPC whose arguments are named differently.
 * One of each thing that matters, not a second copy of the policy tests.
 *
 * They need the stack in server/ up and migrated, and skip without
 * DATABASE_URL like the rest. People are made through GoTrue's admin API
 * with the development service key, and removed again at the end.
 */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { loadApp, aRecipe } = require("./helpers/load.js");
const { skip, stackConfig, vendoredSupabase, closePool } = require("./helpers/db.js");
const { agentToken } = require("../mcp/auth.js");

const e2e = (name, fn) => test(name, { skip }, fn);

// supabase-js rejects with plain objects rather than Errors, so the message
// is matched by hand.
const refusal = (pattern) => (error) => pattern.test(String(error && error.message));

const made = [];
let admin = null;
let supabase = null;
let cfg = null;

function setup() {
  if (admin) return;
  cfg = stackConfig();
  supabase = vendoredSupabase();
  admin = client(cfg.serviceKey);
}

function client(key) {
  return supabase.createClient(cfg.url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** A person, signed in, with the app's RecipeApi on their session. */
async function person(name) {
  setup();
  const email = `${randomUUID()}@example.test`;
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (error) throw error;
  made.push(data.user.id);
  const c = client(cfg.anonKey);
  const signedIn = await c.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  const api = new (loadApp("api.js").RecipeApi)(c);
  api.userId = data.user.id;
  const books = await api.listBooks();
  return { id: data.user.id, client: c, api, book: books.find((b) => b.isOwner).id };
}

after(async () => {
  if (admin) {
    for (const id of made) await admin.auth.admin.deleteUser(id);
  }
  await closePool();
});

e2e("J9.4 · a deletion travels as a tombstone, and a book's recipes reach only its members", async () => {
  const ann = await person("Ann");
  const sam = await person("Sam");
  const id = randomUUID();
  const now = new Date().toISOString();

  await ann.api.pushRecipes([{ id, book_id: ann.book, data: aRecipe({ name: "Soup" }), updated_at: now }]);
  let rows = await ann.api.fetchRecipes(ann.book);
  assert.deepEqual(rows.map((r) => [r.id, r.data.name, r.deleted_at]), [[id, "Soup", null]]);

  // Pushing again is the upsert every sync sends, and a tombstone is one of those.
  await ann.api.pushRecipes([{ id, book_id: ann.book, data: aRecipe({ name: "Soup" }), updated_at: now, deleted_at: now }]);
  rows = await ann.api.fetchRecipes(ann.book);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].deleted_at, "the tombstone came back down");

  // Somebody outside the book reads nothing and writes nothing into it.
  assert.deepEqual(await sam.api.fetchRecipes(ann.book), []);
  await assert.rejects(
    sam.api.pushRecipes([{ id: randomUUID(), book_id: ann.book, data: aRecipe(), updated_at: now }]),
    refusal(/row-level security/)
  );
});

e2e("J7.4 · a link is good for one person, and says what it grants before it is accepted", async () => {
  const ann = await person("Ann");
  const bob = await person("Bob");
  const cat = await person("Cat");

  const code = await ann.api.createInvite(ann.book, 1, "viewer");
  assert.deepEqual(await bob.api.previewInvite(code), {
    bookName: "Ann's recipes",
    ownerName: "Ann",
    alreadyMember: false,
    role: "viewer",
  });
  assert.deepEqual(await bob.api.redeemInvite(code), { id: ann.book, name: "Ann's recipes" });
  const joined = (await bob.api.listBooks()).find((b) => b.id === ann.book);
  assert.equal(joined.role, "viewer");

  await assert.rejects(cat.api.redeemInvite(code), refusal(/already been used/));
  assert.equal((await cat.api.listBooks()).some((b) => b.id === ann.book), false);
});

e2e("J2.8 · a device photo is uploaded to private storage and read back through a signed URL", async () => {
  const ann = await person("Ann");
  const sam = await person("Sam");
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from("not really a jpeg")]);

  const path = await ann.api.uploadPhoto(ann.book, randomUUID(), new Blob([bytes], { type: "image/jpeg" }));
  assert.ok(path.startsWith(`${ann.book}/`));

  const url = await ann.api.signedPhotoUrl(path, 60);
  assert.ok(url.startsWith(`${cfg.url}/storage/v1/object/sign/`), url);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);

  // Private: no URL without signing, and nobody outside the book can sign one.
  const unsigned = await fetch(`${cfg.url}/storage/v1/object/public/recipe-photos/${path}`);
  assert.notEqual(unsigned.status, 200);
  await assert.rejects(sam.api.signedPhotoUrl(path, 60));
});

e2e("J16.3 · an agent may add a recipe, and may not edit one or see the photos", async () => {
  const ann = await person("Ann");
  const soup = randomUUID();
  await ann.api.pushRecipes([{ id: soup, book_id: ann.book, data: aRecipe({ name: "Soup" }), updated_at: new Date().toISOString() }]);
  const path = await ann.api.uploadPhoto(ann.book, soup, new Blob([Buffer.from([0xff, 0xd8])], { type: "image/jpeg" }));

  // Made the way the Sharing list makes one: one create_agent call, which
  // hands back the key once.
  const agent = await ann.api.createAgent(ann.book, "Kitchen helper");
  assert.match(agent.key, /^rfk_/);
  const members = await ann.api.listMembers(ann.book);
  assert.deepEqual(
    members.filter((m) => m.role === "agent").map((m) => m.name),
    ["Kitchen helper"]
  );
  assert.deepEqual(
    (await ann.api.listAgents(ann.book)).map((a) => [a.name, a.keyPrefix]),
    [["Kitchen helper", agent.key.slice(0, 12)]]
  );
  // GoTrue can still read every user, the agent's principal included: a
  // NULL where it expects a string would 500 the whole list.
  const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 50 });
  if (listed.error) throw listed.error;
  const one = await admin.auth.admin.getUserById(agent.userId);
  if (one.error) throw one.error;
  assert.equal(one.data.user.is_anonymous, true);

  // The agent, holding the token the hosted MCP server would mint for it.
  const token = agentToken({ agentId: agent.userId, bookId: ann.book }, cfg.jwtSecret);
  const c = supabase.createClient(cfg.url, cfg.anonKey, { accessToken: async () => token });
  const api = new (loadApp("api.js").RecipeApi)(c);
  api.userId = agent.userId;

  assert.equal((await api.fetchRecipes(ann.book)).length, 1);
  const bread = randomUUID();
  assert.equal(await api.insertRecipe(ann.book, bread, aRecipe({ name: "Bread" })), bread);
  assert.equal(await api.patchRecipe(soup, { data: aRecipe({ name: "Mine now" }) }), 0, "an edit changed a row");
  assert.equal((await ann.api.readRecipeData(soup)).data.name, "Soup");
  await assert.rejects(api.signedPhotoUrl(path, 60));
});

e2e("J18.17, J18.23, J18.25 · two phones and an agent work on one book's lists through the server", async () => {
  const ann = await person("Ann");
  const device = (api, roles = {}) => {
    const win = loadApp("units.js", "scale.js", "storage.js", "plan.js", "planstore.js", "lists.js", "liststore.js", "sync.js");
    const lists = new win.RecipeListStore();
    const sync = new win.RecipeSync(new win.RecipeStore(), api, () => {}, new win.RecipePlanStore(), lists);
    sync.setBook(ann.book, roles);
    return { lists, sync, L: win.RecipeLists };
  };
  const apiFor = (c) => new (loadApp("api.js").RecipeApi)(c);
  const a = device(apiFor(ann.client));
  const b = device(apiFor(ann.client));

  // The first device to open the book moves the plan into Shopping; the
  // second finds it there.
  await a.sync.syncLists();
  await b.sync.syncLists();
  const shopping = a.L.shoppingListId(ann.book);
  assert.deepEqual(b.lists.lists.map((l) => [l.id, l.name]), [[shopping, "Shopping"]]);

  // J18.17 over the wire: Bolognese 4, one taken on each phone, is 2.
  const freezer = a.lists.create("Freezer", "stock");
  const bol = a.L.newId();
  a.lists.change(freezer.id, (l) => a.L.addItem(l, { text: "Bolognese", id: bol }));
  for (let i = 0; i < 3; i++) a.lists.change(freezer.id, (l) => a.L.bump(l, bol, +1, a.lists.deviceId));
  await a.sync.syncLists();
  await b.sync.syncLists();
  a.lists.change(freezer.id, (l) => a.L.bump(l, bol, -1, a.lists.deviceId));
  b.lists.change(freezer.id, (l) => b.L.bump(l, bol, -1, b.lists.deviceId));
  await a.sync.syncLists();
  await b.sync.syncLists();
  await a.sync.pullLists(freezer.id);
  for (const d of [a, b]) assert.equal(d.L.count(d.lists.get(freezer.id).items[0]), 2);

  // J18.23: two writes racing for one row both survive. Phone a merges
  // with a copy of the row that phone b has since written over.
  const stale = await ann.api.fetchLists(ann.book);
  const milk = b.L.newId();
  b.lists.change(shopping, (l) => b.L.addItem(l, { text: "milk", id: milk }));
  await b.sync.syncLists();
  a.lists.change(shopping, (l) => a.L.addItem(l, { text: "eggs" }));
  const fetch = a.sync.api.fetchLists.bind(a.sync.api);
  a.sync.api.fetchLists = async () => {
    a.sync.api.fetchLists = fetch;
    return stale;
  };
  await a.sync.syncLists();
  await b.sync.syncLists();
  const texts = (d) => d.L.liveItems(d.lists.get(shopping)).map((i) => i.text).sort();
  assert.deepEqual(texts(a), ["eggs", "milk"]);
  assert.deepEqual(texts(b), ["eggs", "milk"]);

  // J18.25: the agent adds and ticks; a rename or a new list stays on its
  // own device, because it pushes items and nothing else.
  const agent = await ann.api.createAgent(ann.book, "Kitchen helper");
  const token = agentToken({ agentId: agent.userId, bookId: ann.book }, cfg.jwtSecret);
  const bot = device(apiFor(supabase.createClient(cfg.url, cfg.anonKey, { accessToken: async () => token })), {
    addOnly: true,
  });
  await bot.sync.syncLists();
  bot.lists.change(shopping, (l) => bot.L.setTicked(bot.L.addItem(l, { text: "bread" }), milk, true));
  bot.lists.rename(shopping, "Bot's list");
  bot.lists.create("Bot's own", "checklist");
  await bot.sync.syncLists();
  await a.sync.syncLists();
  const seen = a.lists.get(shopping);
  assert.equal(seen.name, "Shopping");
  assert.deepEqual(texts(a), ["bread", "eggs", "milk"]);
  assert.equal(seen.items.find((i) => i.id === milk).ticked, true);
  assert.equal(a.lists.lists.length, 2, "the agent made no list");

  // J18.3: deleting travels, and the book is not seeded again after it.
  a.lists.remove(shopping);
  await a.sync.syncLists();
  await b.sync.syncLists();
  assert.deepEqual(b.lists.lists.map((l) => l.name), ["Freezer"]);
  const fresh = device(apiFor(ann.client));
  await fresh.sync.syncLists();
  assert.deepEqual(fresh.lists.lists.map((l) => l.name), ["Freezer"]);
});
