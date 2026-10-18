/**
 * mcp/auth.js — from an agent key to a token PostgREST will believe.
 *
 * An agent reaches the hosted server with `Authorization: Bearer rfk_…`
 * (J16.6). That key means nothing to PostgREST. This file turns it into
 * something that does, in two steps, and holds the only secret the
 * service has:
 *
 *   1. **Resolve.** Ask the database who the key belongs to, through
 *      `resolve_agent_key` (migration 010). The call is made as
 *      `recipe_friend_mcp`, a role that can do that one thing and nothing
 *      else, with a token signed here that lasts a minute.
 *   2. **Mint.** Sign a token for the agent the database named — `sub` its
 *      id, role `authenticated`, five minutes — and use it for the
 *      request. From there every policy from 008 and 009 decides, exactly
 *      as it does for a person.
 *
 * The JWT secret can sign a token for anybody, so the service's use of it
 * is kept as narrow as the code can make it: `agentToken` takes an answer
 * from `resolve` and nothing else, always says `authenticated`, and never
 * lasts long.
 *
 * A connected app (migration 011) arrives instead with an access token
 * GoTrue issued it through OAuth. GoTrue's custom access token hook has
 * already made that token name the app's agent rather than the person who
 * connected it, with a role nothing else accepts; `appClaims` checks it
 * properly — signature, expiry, issuer, audience, role, client — and
 * `resolveApp` asks the database whether that agent is still bound to that
 * app and still in its book. From there it is minted for like a key.
 *
 * Nothing here logs or returns a key. The cache is keyed on its SHA-256.
 */
"use strict";

const crypto = require("node:crypto");

/** How long a token minted for an agent lasts. */
const AGENT_TOKEN_SECONDS = 5 * 60;
/** How long the token the service resolves keys with lasts. */
const SERVICE_TOKEN_SECONDS = 60;
/** The longest a resolved key may be believed without asking again. */
const MAX_CACHE_SECONDS = 60;

/** What GoTrue's hook (migration 011) puts in a connected app's token. */
const APP_AUDIENCE = "recipe-friend-mcp";
const APP_ROLE = "recipe_friend_app";
/** Clock skew allowed on a token's iat; its exp is never stretched. */
const SKEW_SECONDS = 60;

const KEY = /^rfk_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

/** An HS256 JWT. Small enough to write rather than depend on. */
function signJwt(claims, secret) {
  if (!secret) throw new Error("no JWT secret");
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** Read a JWT's claims without checking it — for the tests. */
function readJwt(token) {
  return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
}

/** The bearer key from an Authorization header, or null. */
function bearer(header) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(header || ""));
  return m ? m[1] : null;
}

/**
 * The claims of an HS256 JWT signed with `secret`, or null. Nothing else
 * is accepted: not another algorithm, not `none`, not a token whose
 * signature does not match to the byte.
 */
function verifyJwt(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !secret) return null;
  let head, claims;
  try {
    head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!head || head.alg !== "HS256" || !claims || typeof claims !== "object") return null;
  const want = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  return claims;
}

/**
 * `{agentId, clientId}` from a connected app's access token, or null.
 * Everything that makes it one is checked, and a person's own session —
 * role `authenticated`, audience `authenticated`, no client — fails
 * several of them, so it can never be taken for an app (J17.15).
 */
function appClaims(token, { jwtSecret, issuer, now = Date.now() } = {}) {
  if (!issuer) return null;
  const c = verifyJwt(token, jwtSecret);
  if (!c) return null;
  const t = Math.floor(now / 1000);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (typeof c.exp !== "number" || c.exp <= t) return null;
  if (typeof c.iat === "number" && c.iat > t + SKEW_SECONDS) return null;
  if (c.iss !== issuer) return null;
  if (!aud.includes(APP_AUDIENCE)) return null;
  if (c.role !== APP_ROLE) return null;
  if (!UUID.test(String(c.sub)) || !UUID.test(String(c.client_id))) return null;
  return { agentId: c.sub, clientId: c.client_id };
}

/** Is this shaped like a key at all? Saves a database trip for junk. */
function looksLikeKey(key) {
  return typeof key === "string" && KEY.test(key);
}

class ResolveError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResolveError";
  }
}

class KeyResolver {
  /**
   * `restUrl` is PostgREST's base (…/rest/v1). `cacheSeconds` is clamped to
   * MAX_CACHE_SECONDS: it is the bound on how long a revoked key may still
   * be honoured. `fetch` and `now` are seams for the tests.
   */
  constructor({ restUrl, jwtSecret, cacheSeconds = 30, apikey, fetch: f, now } = {}) {
    if (!restUrl) throw new Error("no REST url");
    if (!jwtSecret) throw new Error("no JWT secret");
    this.restUrl = restUrl.replace(/\/+$/, "");
    this.jwtSecret = jwtSecret;
    this.apikey = apikey || null;
    this.cacheMs = Math.max(0, Math.min(Number(cacheSeconds) || 0, MAX_CACHE_SECONDS)) * 1000;
    this.fetch = f || globalThis.fetch;
    this.now = now || Date.now;
    this.cache = new Map();
  }

  serviceToken() {
    const iat = Math.floor(this.now() / 1000);
    return signJwt({ role: "recipe_friend_mcp", iat, exp: iat + SERVICE_TOKEN_SECONDS }, this.jwtSecret);
  }

  /**
   * `{agentId, bookId}` for a live key, null for anything else. Throws
   * ResolveError when the database could not be asked, which is not the
   * same as the key being wrong and must not be reported as that.
   */
  async resolve(key) {
    if (!looksLikeKey(key)) return null;
    const id = crypto.createHash("sha256").update(key).digest("hex");
    return this.lookup(id, "resolve_agent_key", { key });
  }

  /**
   * The same for a connected app: `{agentId, bookId}` while the agent named
   * by a checked token (see appClaims) is still bound to that app and in
   * its book, null once it has been removed. Cached the same way and for
   * the same time, which is the bound on how long a removed app's last
   * access token still works.
   */
  async resolveApp(app) {
    if (!app || !UUID.test(String(app.agentId)) || !UUID.test(String(app.clientId))) return null;
    return this.lookup(`app:${app.agentId}:${app.clientId}`, "resolve_agent_app", {
      agent: app.agentId,
      client: app.clientId,
    });
  }

  async lookup(id, fn, args) {
    const now = this.now();
    const hit = this.cache.get(id);
    if (hit && hit.until > now) return hit.value;
    this.cache.delete(id);

    let res;
    try {
      res = await this.fetch(`${this.restUrl}/rpc/${fn}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.serviceToken()}`,
          ...(this.apikey ? { apikey: this.apikey } : {}),
        },
        body: JSON.stringify(args),
      });
    } catch (err) {
      throw new ResolveError(`could not reach the database (${err && err.message})`);
    }
    if (!res.ok) throw new ResolveError(`the database answered ${res.status}`);
    const row = await res.json().catch(() => null);
    const value =
      row && UUID.test(String(row.agent_id)) && UUID.test(String(row.book_id))
        ? { agentId: row.agent_id, bookId: row.book_id }
        : null;

    // Only live keys are kept. A wrong key costs a trip each time, which is
    // the right way round: the cache exists to spare a working agent, not
    // to answer a guess faster.
    if (value && this.cacheMs > 0) {
      if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(id, { value, until: now + this.cacheMs });
    }
    return value;
  }
}

/**
 * The token an agent's requests carry. Only ever called with what
 * `resolve` returned, which is what keeps the secret's use narrow.
 */
function agentToken(resolved, jwtSecret, now = Date.now()) {
  if (!resolved || !UUID.test(String(resolved.agentId))) throw new Error("not a resolved agent");
  const iat = Math.floor(now / 1000);
  return signJwt(
    {
      sub: resolved.agentId,
      role: "authenticated",
      aud: "authenticated",
      // What GoTrue would have said of an anonymous user; the create-book
      // guard reads it alongside is_agent_user (008, 009).
      is_anonymous: true,
      iat,
      exp: iat + AGENT_TOKEN_SECONDS,
    },
    jwtSecret
  );
}

module.exports = {
  signJwt,
  readJwt,
  verifyJwt,
  appClaims,
  bearer,
  looksLikeKey,
  agentToken,
  KeyResolver,
  ResolveError,
  AGENT_TOKEN_SECONDS,
  MAX_CACHE_SECONDS,
  APP_AUDIENCE,
  APP_ROLE,
};
