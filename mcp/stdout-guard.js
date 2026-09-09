/**
 * mcp/stdout-guard.js — keeping the wire clean.
 *
 * On stdio, stdout is not somewhere to write: it is the transport. The
 * specification says a server must write nothing there that is not a
 * valid MCP message, and a stray line does not appear in the
 * conversation, it breaks it.
 *
 * That is a real risk here rather than a theoretical one, because this
 * process loads modules written for a browser, where `console.log` costs
 * nothing. So every channel that would otherwise reach stdout is pointed
 * at stderr, which the same specification says a server may write to and
 * a host may capture, forward or ignore.
 *
 * It is its own file so that it can be tested. Inside `index.js` it ran
 * before anything else was required, which is the right place for it and
 * the wrong place to reach.
 */
"use strict";

/** Channels node sends to stdout. `error` already goes to stderr. */
const TO_STDOUT = ["log", "info", "debug", "trace", "dir", "table", "group", "groupCollapsed"];

/**
 * Point them all at stderr. Returns a function putting them back, which
 * only the tests use — the server never wants them back.
 */
function guardStdout(target = console) {
  const held = new Map();
  for (const channel of TO_STDOUT) {
    if (typeof target[channel] !== "function") continue;
    held.set(channel, target[channel]);
    target[channel] = (...args) => target.error(...args);
  }
  return () => {
    for (const [channel, original] of held) target[channel] = original;
  };
}

module.exports = { guardStdout, TO_STDOUT };
