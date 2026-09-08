#!/usr/bin/env node
/**
 * mcp/index.js — the program a host launches.
 *
 * A stdio MCP server: the host runs this as a subprocess and speaks
 * JSON-RPC over stdin and stdout. No listener, no port, no TLS and no
 * OAuth — the specification says a stdio server takes its credentials
 * from the environment, which is what the one variable below is.
 *
 *   RECIPE_FRIEND_CREDENTIAL   the rfa1… string the Books dialog showed
 *                              once when the agent was added (J16.6)
 *
 * **stdout is the wire.** The specification is explicit that a stdio
 * server must write nothing to stdout that is not a valid MCP message,
 * and this process loads modules written for a browser. So the first
 * thing it does, before requiring any of them, is point every console
 * channel at stderr — which the same specification says a server may
 * write to and a host may capture, forward or ignore.
 */
"use strict";

for (const channel of ["log", "info", "debug", "warn", "trace"]) {
  console[channel] = (...args) => console.error(...args);
}

const { decode } = require("./credential.js");
const { Session } = require("./session.js");
const { makeServer } = require("./server.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { version } = require("../package.json");

async function main() {
  // The credential is read and checked now, because a string that is not
  // one is the host's configuration being wrong, and that should stop the
  // program rather than turn into a puzzling answer later. It is not
  // *exchanged* now — see mcp/server.js.
  const credential = decode(process.env.RECIPE_FRIEND_CREDENTIAL);

  const server = makeServer({ session: new Session(credential), version });
  await server.connect(new StdioServerTransport());
  console.error(`recipe-friend ${version}: ready, for one book at ${credential.url}`);
}

main().catch((err) => {
  console.error(`recipe-friend: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
