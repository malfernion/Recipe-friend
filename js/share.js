/**
 * share.js — encode/decode single recipes as URL-fragment share links.
 *
 * Format: #add=<mark><base64url payload>
 *   mark "1." = deflate-raw compressed JSON (CompressionStream)
 *   mark "0." = plain UTF-8 JSON (fallback for browsers without the API)
 *
 * The payload lives in the fragment, so it never reaches the server. Photos
 * stored as data URIs are stripped before encoding — they are far too large
 * for a URL — but http(s) image links are kept.
 */
(function (global) {
  "use strict";

  const MARK_DEFLATE = "1.";
  const MARK_PLAIN = "0.";

  // A link is decoded on page load, before anyone has clicked anything, so
  // the cost of reading a hostile one has to be bounded. Raw deflate can
  // exceed 1000:1, which turns a link that fits in the address bar into
  // gigabytes of string. A real recipe is a few kilobytes.
  const MAX_DECODED_BYTES = 256 * 1024;
  const MAX_ENCODED_CHARS = 64 * 1024;

  function toBase64Url(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }

  function fromBase64Url(text) {
    const b64 = text.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** The subset of a recipe that travels in a share link. */
  function shareablePayload(recipe) {
    return {
      v: 1,
      r: {
        id: recipe.id,
        name: recipe.name,
        description: recipe.description,
        servings: recipe.servings,
        prepMinutes: recipe.prepMinutes,
        cookMinutes: recipe.cookMinutes,
        ingredients: recipe.ingredients,
        steps: recipe.steps,
        tags: recipe.tags,
        image: /^https?:\/\//i.test(recipe.image || "") ? recipe.image : "",
      },
    };
  }

  async function encodeRecipeShare(recipe) {
    const json = JSON.stringify(shareablePayload(recipe));
    if (typeof CompressionStream === "function") {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"));
      const buffer = await new Response(stream).arrayBuffer();
      return MARK_DEFLATE + toBase64Url(new Uint8Array(buffer));
    }
    return MARK_PLAIN + toBase64Url(new TextEncoder().encode(json));
  }

  /**
   * Read a decompression stream, giving up past a ceiling instead of
   * expanding whatever the sender chose to compress.
   */
  async function inflateBounded(bytes, limit) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const joined = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      joined.set(chunk, at);
      at += chunk.length;
    }
    return new TextDecoder().decode(joined);
  }

  /** Returns the raw shared recipe object, or null if the link is unreadable. */
  async function decodeRecipeShare(encoded) {
    try {
      if (typeof encoded !== "string" || encoded.length > MAX_ENCODED_CHARS) return null;
      const mark = encoded.slice(0, 2);
      const bytes = fromBase64Url(encoded.slice(2));
      let json;
      if (mark === MARK_DEFLATE) {
        if (typeof DecompressionStream !== "function") return null;
        json = await inflateBounded(bytes, MAX_DECODED_BYTES);
        if (json === null) return null;
      } else if (mark === MARK_PLAIN) {
        if (bytes.length > MAX_DECODED_BYTES) return null;
        json = new TextDecoder().decode(bytes);
      } else {
        return null;
      }
      const payload = JSON.parse(json);
      if (!payload || payload.v !== 1 || typeof payload.r !== "object") return null;
      return payload.r;
    } catch {
      return null;
    }
  }

  global.RecipeShare = { encodeRecipeShare, decodeRecipeShare };
})(window);
