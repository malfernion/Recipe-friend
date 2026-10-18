#!/usr/bin/env node
/**
 * Copies every object in the hosted `recipe-photos` bucket to the
 * self-hosted Storage, at the same path and with the same content type
 * (Workstream E). Paths hold the book id and recipes refer to their photo
 * by path, so the path is the one thing that must not change.
 *
 *   node server/migrate-from-supabase/copy-photos.js
 *
 * Safe to re-run: an object already on the target at the same size is
 * skipped, anything else is uploaded with upsert. Reads HOSTED_URL and
 * HOSTED_SERVICE_KEY, writes TARGET_URL with TARGET_SERVICE_KEY. Nothing
 * is ever written to the hosted project.
 */
"use strict";

const lib = require("./lib.js");

const CONCURRENCY = 4;

async function main() {
  if (process.argv.length > 2) throw new lib.Usage(`copy-photos.js takes no arguments (got ${process.argv[2]}).`);
  const hosted = lib.hostedStorage();
  const target = lib.targetStorage();
  console.log(`hosted: ${lib.describeUrl(hosted.base)}/…/${lib.BUCKET}`);
  console.log(`target: ${lib.describeUrl(target.base)}/…/${lib.BUCKET}`);

  // The bucket comes from migration 004 on the target; uploading into a
  // missing one would fail for every object, so say so once instead.
  const bucket = await fetch(`${target.base}/bucket/${lib.BUCKET}`, { headers: lib.storageHeaders(target.key) });
  if (!bucket.ok) {
    throw new Error(`target has no ${lib.BUCKET} bucket (HTTP ${bucket.status} ${await lib.safeText(bucket)}). Has the migrate service run?`);
  }

  const source = await lib.listBucket(hosted.base, hosted.key);
  const existing = new Map((await lib.listBucket(target.base, target.key)).map((o) => [o.path, o]));
  const total = source.reduce((n, o) => n + o.size, 0);
  console.log(`hosted has ${source.length} object(s), ${lib.formatBytes(total)}; target already has ${existing.size}.`);

  const stats = { uploaded: 0, uploadedBytes: 0, skipped: 0, skippedBytes: 0, failed: [] };
  const queue = [...source];
  async function worker() {
    for (let o = queue.shift(); o; o = queue.shift()) {
      const there = existing.get(o.path);
      if (there && there.size === o.size) {
        stats.skipped++;
        stats.skippedBytes += o.size;
        continue;
      }
      try {
        await copyOne(hosted, target, o);
        stats.uploaded++;
        stats.uploadedBytes += o.size;
      } catch (e) {
        stats.failed.push(`${o.path}: ${lib.redact(e.message)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const extra = [...existing.keys()].filter((p) => !source.some((o) => o.path === p));
  console.log(`\nuploaded ${stats.uploaded} (${lib.formatBytes(stats.uploadedBytes)}), skipped ${stats.skipped} already there at the same size (${lib.formatBytes(stats.skippedBytes)}), failed ${stats.failed.length}.`);
  if (extra.length) {
    console.log(`note: target has ${extra.length} object(s) the hosted bucket does not (left alone; verify will list them):`);
    for (const p of extra.slice(0, 20)) console.log(`  ${p}`);
  }
  if (stats.failed.length) {
    console.error(`\n${stats.failed.length} object(s) failed:`);
    for (const f of stats.failed) console.error(`  ${f}`);
    return 1;
  }
  return 0;
}

async function copyOne(hosted, target, o) {
  const path = lib.encodePath(o.path);
  const res = await fetch(`${hosted.base}/object/${lib.BUCKET}/${path}`, { headers: lib.storageHeaders(hosted.key) });
  if (!res.ok) throw new Error(`download: HTTP ${res.status} ${await lib.safeText(res)}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length !== o.size) throw new Error(`download: got ${body.length} bytes, listing said ${o.size}`);

  const headers = {
    ...lib.storageHeaders(target.key),
    "content-type": o.mimetype || res.headers.get("content-type") || "application/octet-stream",
    "x-upsert": "true",
  };
  if (o.cacheControl) headers["cache-control"] = o.cacheControl;
  const up = await fetch(`${target.base}/object/${lib.BUCKET}/${path}`, { method: "POST", headers, body });
  if (!up.ok) throw new Error(`upload: HTTP ${up.status} ${await lib.safeText(up)}`);
}

lib.run(main);
