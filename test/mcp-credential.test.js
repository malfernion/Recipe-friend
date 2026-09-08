/**
 * mcp/credential.js — the other half of J16.6.
 *
 * `js/api.js` packs the string the Books dialog shows once; this reads
 * it back. The two live in one repository so that the pair can be tested
 * together rather than trusted to agree, which is the first thing that
 * would rot if the server lived somewhere else.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/load.js");
const { decode, CredentialError } = require("../mcp/credential.js");

const BOOK = "11111111-1111-4111-8111-111111111111";
const COORDS = { url: "https://dveyxesgwohokenoomsf.supabase.co", key: "sb_publishable_J6rDrCnnu0" };
// Shaped like the real thing: long, mixed case, and carrying the
// characters that plain base64 would turn into "+" and "/".
const TOKEN = "ffvz3s7g4l2m-_ABC123xyz~QWERTY.abcdefghijklmnop_-";

/** The dialog's own path to a credential, with the network stubbed out. */
async function mintCredential(win, { token = TOKEN, book = BOOK } = {}) {
  const api = new win.RecipeApi({
    rpc: async () => ({ error: null }),
  });
  api.userId = "owner-1";
  const scratch = () => ({
    auth: {
      signInAnonymously: async () => ({
        data: { session: { refresh_token: token, user: { id: "agent-1" } } },
        error: null,
      }),
    },
  });
  const made = await api.createAgent(book, "Meal planner", scratch, COORDS, "captcha");
  return made.credential;
}

test("J16.6 · what the dialog packs is what the server reads", async () => {
  const win = loadApp("api.js");
  const credential = await mintCredential(win);

  assert.ok(credential.startsWith("rfa1."), "the prefix says which shape it is");
  assert.deepEqual(decode(credential), {
    url: COORDS.url,
    key: COORDS.key,
    book: BOOK,
    refreshToken: TOKEN,
  });
});

test("a credential survives being pasted with whitespace around it", async () => {
  const win = loadApp("api.js");
  const credential = await mintCredential(win);

  assert.deepEqual(decode(`\n  ${credential}  \n`), decode(credential));
});

test("nothing at all says where to get one", () => {
  for (const nothing of ["", "   ", null, undefined]) {
    assert.throws(() => decode(nothing), (err) => {
      assert.ok(err instanceof CredentialError);
      assert.match(err.message, /RECIPE_FRIEND_CREDENTIAL/);
      assert.match(err.message, /Books dialog/);
      return true;
    });
  }
});

test("something that is not a credential is told so by its prefix", () => {
  assert.throws(() => decode("sb_publishable_J6rDrCnnu0"), /should begin "rfa1\."/);
});

test("a credential that lost its end says what probably happened", async () => {
  const win = loadApp("api.js");
  const credential = await mintCredential(win);

  // A copy that stopped short: the base64 still decodes, into nonsense.
  assert.throws(() => decode(credential.slice(0, credential.length - 20)), /damaged/);
});

test("a credential missing a field names the field", () => {
  const packed = (parts) => "rfa1." + Buffer.from(JSON.stringify(parts)).toString("base64url");
  const whole = { url: COORDS.url, key: COORDS.key, book: BOOK, refresh_token: TOKEN };

  assert.throws(() => decode(packed({ ...whole, refresh_token: "" })), /missing the token/);
  assert.throws(() => decode(packed({ ...whole, book: "" })), /missing the book id/);
  assert.throws(() => decode(packed({ ...whole, url: "", key: "" })),
    /missing the project url, the publishable key/);
  assert.throws(() => decode(packed({ ...whole, book: "not-an-id" })), /not an id/);
  assert.throws(() => decode(packed({ ...whole, url: "http://example.com" })), /not an https address/);
});

test("no failure ever quotes the token, because stderr is somewhere a host may log", () => {
  const packed = (parts) => "rfa1." + Buffer.from(JSON.stringify(parts)).toString("base64url");
  const broken = [
    "",
    "not-a-credential",
    "rfa1.@@@@",
    packed({ url: "http://x.co", key: "k", book: BOOK, refresh_token: TOKEN }),
    packed({ url: COORDS.url, key: "k", book: "nope", refresh_token: TOKEN }),
  ];

  for (const one of broken) {
    try {
      decode(one);
      assert.fail(`expected ${one.slice(0, 20)} to be refused`);
    } catch (err) {
      assert.ok(!err.message.includes(TOKEN), err.message);
      assert.ok(!err.stack.includes(TOKEN));
    }
  }
});
