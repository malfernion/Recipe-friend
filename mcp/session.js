/**
 * mcp/session.js — turning the pasted credential into a signed-in client.
 *
 * The credential carries a refresh token belonging to an anonymous user
 * (J16.1), and exchanging it is the whole of signing in: the access token
 * that comes back is what `auth.uid()` reads, and every policy migration
 * 008 wrote governs the agent from there without a second authorisation
 * path being invented.
 *
 * **Nothing is written to disk.** Supabase rotates refresh tokens, and
 * this project has switched off the check that treats the old one coming
 * back as a stolen one (J16.9, and the Boundaries entry that says what
 * that costs). That is what lets this hold no state: the pasted string
 * stays good, so the client keeps the rotating token in memory, drops it
 * with the process, and the next start begins from the same string. A
 * server the host may spawn once per session, restart, or run twice can
 * afford no other arrangement.
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

class Session {
  /**
   * `createClient` is a seam rather than a hard import so that the tests
   * can watch what this asks for without a network. Nothing else passes
   * it.
   */
  constructor(credential, { createClient } = {}) {
    this.credential = credential;
    this.createClient = createClient || require("@supabase/supabase-js").createClient;
    this.opening = null;
  }

  /**
   * The signed-in client, opened once and shared. Memoised on the promise
   * rather than the result so that two tools called together exchange the
   * credential once between them.
   */
  open() {
    if (!this.opening) {
      this.opening = this.exchange().catch((err) => {
        // A failed exchange is not cached: the credential may be fine and
        // the network may not have been.
        this.opening = null;
        throw err;
      });
    }
    return this.opening;
  }

  async exchange() {
    const { url, key, refreshToken } = this.credential;
    const client = this.createClient(url, key, {
      auth: {
        // No storage, nothing persisted, and no url to read a session out
        // of: this is a process, not a browser.
        persistSession: false,
        detectSessionInUrl: false,
        // The access token lasts about an hour and a planning conversation
        // can outlast it, so the client keeps it fresh in memory.
        autoRefreshToken: true,
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
    if (error || !data || !data.session || !data.user) {
      throw new SessionError(DEAD);
    }

    return { client, userId: data.user.id };
  }
}

module.exports = { Session, SessionError, DEAD };
