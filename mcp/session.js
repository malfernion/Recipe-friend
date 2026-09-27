/**
 * mcp/session.js — turning the pasted credential into a signed-in client.
 *
 * The credential carries a refresh token belonging to an anonymous user
 * (J16.1), and exchanging it is the whole of signing in: the access token
 * that comes back is what `auth.uid()` reads, and every policy migration
 * 008 wrote governs the agent from there without a second authorisation
 * path being invented.
 *
 * **Only the pasted token is ever exchanged.** A refresh token is good
 * once. Supabase hands back a new one every time, and after that it
 * accepts the old one again for only two reasons: within a few seconds
 * of being used, or when it is the *parent* of the token now current —
 * in which case it answers with the current one rather than a new one.
 * Turning off reuse detection does not widen that; it only stops a
 * refusal ending the whole session.
 *
 * So the pasted string (P0) stays good exactly as long as nothing
 * exchanges the token it was swapped for (P1). The first exchange here
 * makes P1; every exchange after it presents P0 again, gets P1 back
 * unchanged, and a fresh access token with it. Nothing ever presents P1,
 * so the chain never grows past one link, and a restart, a second copy
 * or a start a week later from the configuration file all find P0 still
 * the parent. This used to hand the session to the library with
 * `autoRefreshToken` on, which after an hour exchanged P1 for P2, and
 * from then on the pasted string was two links behind and every restart
 * was told the credential had been revoked (J16.9).
 *
 * **Nothing is written to disk.** That arrangement is what lets this
 * hold no state: the string is the whole of it, so a server the host may
 * spawn once per session, restart, or run twice needs nothing else.
 *
 * **The data client holds no refresh token at all.** It is built with the
 * library's `accessToken` option and asks `fresh()` for an access token
 * on every request, so there is no session inside it for the library to
 * refresh on its own. Each exchange uses a client of its own, built with
 * auto-refresh off and dropped straight after.
 *
 * **The exchange happens on the first tool call, not at startup.** A host
 * that spawns servers speculatively should not spend a token-endpoint
 * request per spawn, and a failure at boot happens where nobody is
 * looking; a failure on the first call is something the model can read
 * and repeat to the person.
 */
"use strict";

const { isAuthRetryableFetchError } = require("@supabase/supabase-js");

/**
 * Was that the world being unreachable, rather than the credential being
 * finished?
 *
 * `refreshSession` does not throw when the network fails — it *returns*
 * an `AuthRetryableFetchError` carrying `status: 0`, where a token the
 * server actually refused comes back as a 400. Six reviews walked past
 * this because the test that named it stubbed a throw the real library
 * cannot produce, so the branch that told the two apart was dead code
 * and every outage said the credential was dead.
 *
 * The library's own predicate first; the shape behind it after, because
 * a stubbed client has no reason to import the library's error classes.
 */
const REFUSED = new Set([400, 401, 403]);

function unreachable(error) {
  if (!error) return false;
  if (typeof isAuthRetryableFetchError === "function" && isAuthRetryableFetchError(error)) return true;
  // Asked the other way round on purpose: only a status the auth server
  // itself used to refuse this token means the credential is finished.
  // Everything else is the world — a 429 from a rate limiter (two agents
  // behind one address, or a host that spawns a server per session), a
  // 5xx, a fetch that never arrived and carries status 0, or a reply
  // from a captive portal or proxy that carries no status at all.
  //
  // The default belongs on this side because the two answers are not
  // equally costly: waiting is free and wrong once, while removing an
  // agent is entire and one-way (J16.7) and cannot be taken back.
  return !REFUSED.has(Number(error.status));
}

/** One sentence for "wait", against DEAD's sentence for "start again". */
function cannotReach(url, why) {
  return `Could not reach ${url}${why ? `: ${why}` : ""}. That is the project or the network, not the credential — try again in a moment.`;
}

class SessionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionError";
  }
}

/** What to say when the credential is no longer worth anything. */
const DEAD =
  "That credential no longer works. A credential ends by being revoked (J16.9), " +
  "so this is what removing the agent looks like from out here: open the Books " +
  "dialog in Recipe Friend, remove the agent, add another, and paste the new one.";

/**
 * How long before an access token runs out this fetches the next one: a
 * quarter of its life, and never less than a minute. Well ahead of the
 * library's own margin, and wide enough that a sync started just before
 * it does not run past the end of the token it started with.
 *
 * Counted from `expires_in` on this machine's clock rather than from the
 * server's `expires_at`, so a clock that is out by a quarter of an hour
 * does not renew on every question.
 */
function renewAt(session, now) {
  const lifetime = Number(session.expires_in) > 0 ? Number(session.expires_in) * 1000 : 3600 * 1000;
  return now + lifetime - Math.max(60 * 1000, lifetime / 4);
}

class Session {
  /**
   * `createClient` and `now` are seams rather than hard imports so that
   * the tests can watch what this asks for, and move the clock, without a
   * network. Nothing else passes them.
   */
  constructor(credential, { createClient, now } = {}) {
    this.credential = credential;
    this.createClient = createClient || require("@supabase/supabase-js").createClient;
    this.now = now || Date.now;
    this.token = null;
    this.renewing = null;
    this.opened = null;
  }

  /**
   * The signed-in client, built once and shared, with an access token
   * that has time left on it.
   *
   * Called before every sync (`Book.syncOnce`), which is where a token
   * that has run down is renewed and where a credential that has stopped
   * working is reported, in the same words as the first call.
   */
  async open() {
    await this.fresh();
    if (!this.opened) {
      const { url, key } = this.credential;
      const client = this.createClient(url, key, { accessToken: () => this.fresh() });
      this.opened = { client, userId: this.token.userId };
    }
    return this.opened;
  }

  /**
   * An access token with time left on it, exchanging the pasted token for
   * one if not. Memoised on the promise so that two tools called together
   * — or two requests inside one sync — exchange once between them.
   */
  async fresh() {
    if (this.token && this.now() < this.token.renewAt) return this.token.value;
    if (!this.renewing) {
      // A failed exchange is not kept: the credential may be fine and the
      // network may not have been.
      this.renewing = this.exchange().finally(() => {
        this.renewing = null;
      });
    }
    this.token = await this.renewing;
    return this.token.value;
  }

  async exchange() {
    const { url, key, refreshToken } = this.credential;
    // A client for this one exchange, dropped after it. Nothing is
    // persisted, no url is read, and it never refreshes on its own: the
    // token it is handed back is P1, and presenting P1 is the one thing
    // that would put the pasted string out of date.
    const client = this.createClient(url, key, {
      auth: {
        persistSession: false,
        detectSessionInUrl: false,
        autoRefreshToken: false,
      },
    });

    let data, error;
    try {
      ({ data, error } = await client.auth.refreshSession({ refresh_token: refreshToken }));
    } catch (err) {
      // Kept for a client that throws rather than returns. The real one
      // does not, which was the whole of this bug: see `unreachable`.
      throw new SessionError(cannotReach(url, err && err.message));
    }
    // Which kind of failure, asked of the answer rather than of whether
    // there was one. Saying "revoked" about a flaky connection sends
    // somebody to delete a working agent, and removing one is entire
    // and one-way (J16.7) — the wrong answer here is the irreversible
    // one, and this is the most network-exposed moment the server has.
    if (unreachable(error)) throw new SessionError(cannotReach(url, error.message));
    if (error || !data || !data.session || !data.session.access_token || !data.user) {
      throw new SessionError(DEAD);
    }

    // Only the access token is kept. The refresh token that came back
    // with it is deliberately dropped with the client: see the top of
    // this file.
    return {
      value: data.session.access_token,
      renewAt: renewAt(data.session, this.now()),
      userId: data.user.id,
    };
  }
}

module.exports = { Session, SessionError, DEAD };
