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
      // A thrown error here is the network, not the credential, and
      // saying "revoked" about a flaky connection sends somebody to
      // delete a working agent.
      throw new SessionError(`Could not reach ${url}: ${err && err.message}`);
    }
    if (error || !data || !data.session || !data.user) {
      throw new SessionError(DEAD);
    }

    return { client, userId: data.user.id };
  }
}

module.exports = { Session, SessionError, DEAD };
