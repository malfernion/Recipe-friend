/**
 * mcp/credential.js — reading the string an owner pasted (J16.6).
 *
 * `packCredential` in `js/api.js` writes it; this reads it. Four fields
 * travel together because the agent needs all four and none is derivable
 * from the others, and only one of them is a secret.
 *
 * base64url rather than plain base64 so that a url, a key and a token
 * survive being pasted through a chat window, an env file and a YAML
 * block without one of them being mangled — which is also why every
 * failure here is worth a sentence rather than a stack trace. The
 * likeliest cause of one is a copy that lost its last characters.
 *
 * No message this file produces ever quotes the token. It is the whole
 * of the secret, the errors go to stderr, and stderr is somewhere a host
 * may log.
 */
"use strict";

const PREFIX = "rfa1.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class CredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = "CredentialError";
  }
}

function decode(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) {
    throw new CredentialError(
      "No credential. Set RECIPE_FRIEND_CREDENTIAL to the string the Books dialog showed when the agent was added."
    );
  }
  if (!text.startsWith(PREFIX)) {
    throw new CredentialError(
      `That does not look like a Recipe Friend credential — it should begin "${PREFIX}".`
    );
  }

  let json;
  try {
    json = Buffer.from(text.slice(PREFIX.length), "base64url").toString("utf8");
  } catch {
    json = "";
  }

  let parts;
  try {
    parts = JSON.parse(json);
  } catch {
    throw new CredentialError(
      "That credential is damaged and cannot be read. The likeliest cause is a copy that lost its end; add a new agent and paste the whole string."
    );
  }
  if (!parts || typeof parts !== "object" || Array.isArray(parts)) {
    throw new CredentialError("That credential is damaged and cannot be read.");
  }

  const url = str(parts.url);
  const key = str(parts.key);
  const book = str(parts.book);
  const refreshToken = str(parts.refresh_token);

  const missing = [
    !url && "the project url",
    !key && "the publishable key",
    !book && "the book id",
    !refreshToken && "the token",
  ].filter(Boolean);
  if (missing.length) {
    throw new CredentialError(`That credential is missing ${missing.join(", ")}.`);
  }

  if (!/^https:\/\/[^/\s]+$/.test(url.replace(/\/+$/, ""))) {
    throw new CredentialError("That credential's project url is not an https address.");
  }
  if (!UUID.test(book)) {
    throw new CredentialError("That credential's book id is not an id.");
  }

  return { url: url.replace(/\/+$/, ""), key, book, refreshToken };
}

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { decode, CredentialError, PREFIX };
