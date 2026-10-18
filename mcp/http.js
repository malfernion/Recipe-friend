#!/usr/bin/env node
/**
 * mcp/http.js — the hosted MCP server (J17.1).
 *
 * MCP's Streamable HTTP transport, stateless: every POST to /mcp carries
 * its own `Authorization: Bearer rfk_…`, is answered on its own, and
 * leaves nothing behind. The twelve tools are the ones `server.js` has
 * always served; only the way in changed.
 *
 *   POST   /mcp      the protocol, one JSON-RPC message or batch per request
 *   GET    /mcp      405 — a stateless server offers no standalone stream
 *   DELETE /mcp      405 — there is no session to end
 *   GET    /health   200, for the container's healthcheck; no database trip
 *
 * Environment:
 *
 *   SUPABASE_URL           where /rest/v1 is, from inside the stack
 *                          (the dev stack uses http://caddy)
 *   JWT_SECRET             the stack's JWT secret: resolves keys and signs
 *                          the agent's short-lived token (see auth.js)
 *   ANON_KEY               optional; sent as `apikey`, which only a gateway
 *                          that checks it needs
 *   PORT                   default 3100
 *   KEY_CACHE_SECONDS      default 30, at most 60: how long a resolved key
 *                          is believed, and so how long a revoked one can
 *                          still be used
 *
 * Keys are never logged. The access log names the agent by the first
 * eight characters of its id.
 */
"use strict";

const http = require("node:http");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { makeServer } = require("./server.js");
const { KeyResolver, ResolveError, agentToken, bearer, AGENT_TOKEN_SECONDS } = require("./auth.js");
const { version } = require("../package.json");

const MAX_BODY = 4 * 1024 * 1024;
const REALM = 'Bearer realm="recipe-friend"';

/**
 * What a tool call runs against: the agent's own client, holding a token
 * that is re-signed a minute before it would run out. Built per request;
 * nothing is shared between agents or between requests.
 */
function agentSession(resolved, { supabaseUrl, jwtSecret, anonKey, createClient }) {
  let token = null;
  let renewAt = 0;
  const fresh = async () => {
    const now = Date.now();
    if (!token || now >= renewAt) {
      token = agentToken(resolved, jwtSecret, now);
      renewAt = now + (AGENT_TOKEN_SECONDS - 60) * 1000;
    }
    return token;
  };
  let client = null;
  return {
    bookId: resolved.bookId,
    async open() {
      if (!client) client = createClient(supabaseUrl, anonKey || "unused", { accessToken: fresh });
      return { client, userId: resolved.agentId };
    },
  };
}

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text);
}

/** A JSON-RPC error with no id, which is what the transport sends for these too. */
function rpcError(code, message) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The request handler, separate from listening so that a test can drive
 * it with a resolver and a client of its own.
 */
function createHandler({
  supabaseUrl,
  jwtSecret,
  anonKey,
  resolver,
  createClient = require("@supabase/supabase-js").createClient,
  log = (line) => console.log(line),
}) {
  return async function handle(req, res) {
    const started = Date.now();
    let who = null;
    res.on("finish", () => {
      const agent = who ? ` agent=${who.agentId.slice(0, 8)}` : "";
      log(`${req.method} ${req.url.split("?")[0]} ${res.statusCode} ${Date.now() - started}ms${agent}`);
    });

    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/health") {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "", { Allow: "GET" });
      return send(res, 200, { ok: true, version });
    }
    if (path !== "/mcp" && path !== "/mcp/") return send(res, 404, "not found");
    if (req.method !== "POST") {
      return send(res, 405, rpcError(-32000, "Method not allowed: this server is stateless; use POST."), {
        Allow: "POST",
      });
    }

    const key = bearer(req.headers.authorization);
    if (!key) {
      return send(res, 401, rpcError(-32001, "An agent key is required: Authorization: Bearer rfk_…"), {
        "WWW-Authenticate": REALM,
      });
    }
    try {
      who = await resolver.resolve(key);
    } catch (err) {
      if (!(err instanceof ResolveError)) throw err;
      log(`resolve failed: ${err.message}`);
      return send(res, 503, rpcError(-32002, "Recipe Friend could not be reached just now. Try again in a moment."), {
        "Retry-After": "5",
      });
    }
    if (!who) {
      return send(
        res,
        401,
        rpcError(-32001, "That agent key is not valid. It may have been removed; an owner can add a new agent in the Books dialog."),
        { "WWW-Authenticate": `${REALM}, error="invalid_token"` }
      );
    }

    let body;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : undefined;
    } catch (err) {
      if (err && err.status === 413) return send(res, 413, rpcError(-32600, "Request too large."));
      return send(res, 400, rpcError(-32700, "Parse error."));
    }

    const session = agentSession(who, { supabaseUrl, jwtSecret, anonKey, createClient });
    const server = makeServer({ session, version });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}

function configFromEnv(env = process.env) {
  const supabaseUrl = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const jwtSecret = env.JWT_SECRET || "";
  const missing = [!supabaseUrl && "SUPABASE_URL", !jwtSecret && "JWT_SECRET"].filter(Boolean);
  if (missing.length) throw new Error(`set ${missing.join(" and ")}`);
  return {
    supabaseUrl,
    jwtSecret,
    anonKey: env.ANON_KEY || "",
    port: Number(env.PORT) || 3100,
    cacheSeconds: env.KEY_CACHE_SECONDS === undefined ? 30 : Number(env.KEY_CACHE_SECONDS),
  };
}

function main() {
  const config = configFromEnv();
  const resolver = new KeyResolver({
    restUrl: `${config.supabaseUrl}/rest/v1`,
    jwtSecret: config.jwtSecret,
    apikey: config.anonKey,
    cacheSeconds: config.cacheSeconds,
  });
  const handle = createHandler({ ...config, resolver });
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`recipe-friend mcp: ${err && err.stack ? err.stack : err}`);
      if (!res.headersSent) send(res, 500, rpcError(-32603, "Internal error."));
      else res.end();
    });
  });
  server.listen(config.port, () => {
    console.log(`recipe-friend mcp ${version}: listening on ${config.port}, key cache ${resolver.cacheMs / 1000}s`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`recipe-friend mcp: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { createHandler, agentSession, configFromEnv };
