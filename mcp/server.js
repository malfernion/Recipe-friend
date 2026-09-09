/**
 * mcp/server.js — the tools, met by the protocol.
 *
 * Everything interesting is in the modules beside this one; this is the
 * adapter. It is separate from `index.js` so that a test can drive the
 * whole surface — list the tools, call one, watch a failure become an
 * answer — without a subprocess and without stdio.
 *
 * **The book is opened on the first call, not at startup**, and pulled
 * before every call after it. A host may spawn this speculatively, and a
 * server that spends a token exchange per spawn is one somebody turns
 * off. It is also where a dead credential should be reported: a failure
 * at boot happens where nobody is looking, and one in a tool result is
 * something the model can read out to the person who can fix it.
 */
"use strict";

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const TOOLS = [...require("./tools-read.js"), ...require("./tools-write.js")];

/**
 * A failure the person running this can do something about.
 *
 * Returned as a tool result rather than thrown as a protocol error, so
 * the model sees the sentence and can repeat it. A protocol error is for
 * something the caller got wrong; this is something the world got wrong.
 */
function refuse(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function answer(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * `openBook` is a seam for the tests, which hand over a book already
 * standing rather than a credential and a network.
 */
function makeServer({ session, version = "0.0.0", openBook = require("./book.js").openBook }) {
  const server = new Server(
    { name: "recipe-friend", version },
    { capabilities: { tools: {} } }
  );

  // One book per process, opened once and shared by every tool. The
  // promise is what is kept, so two calls arriving together open it
  // between them rather than twice.
  let opening = null;
  function book() {
    if (!opening) {
      opening = openBook(session).catch((err) => {
        // Not cached: a credential that is fine and a network that was
        // not should not leave the server dead for the rest of its life.
        opening = null;
        throw err;
      });
    }
    return opening;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { title: tool.title, ...tool.annotations },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) return refuse(`There is no tool called ${request.params.name}.`);

    let opened;
    try {
      opened = await book();
      // Every tool call, read or write. A stdio server outlives the
      // question it was started for, and the household goes on cooking:
      // answering a question about the plan from a snapshot taken an
      // hour ago is the same wrong shopping list as computing it with
      // the wrong code (J17.9). Concurrent calls queue on one sync
      // rather than racing, which `Book.refresh` arranges.
      await opened.refresh();
    } catch (err) {
      // The credential, the membership, or the network — all three are
      // written to be read by somebody who can act on them.
      return refuse(err.message);
    }

    try {
      return answer(await tool.run(opened, request.params.arguments || {}));
    } catch (err) {
      return refuse(`${tool.name} could not finish: ${err.message}`);
    }
  });

  return server;
}

module.exports = { makeServer, TOOLS };
