#!/usr/bin/env node
// Native messaging host — spawned directly by Firefox when the extension
// calls browser.runtime.connectNative(). Talks to the extension over
// stdin/stdout using Firefox's length-prefixed native messaging protocol,
// and exposes a tiny localhost-only HTTP bridge that mcp-server.js (a
// *separate* process, launched by Claude Code) uses to relay tool calls.

import http from "node:http";

let stdinBuf = Buffer.alloc(0);
const pending = new Map();
let reqCounter = 0;

function sendToExtension(msg) {
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([len, json]));
}

process.stdin.on("data", (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  while (stdinBuf.length >= 4) {
    const len = stdinBuf.readUInt32LE(0);
    if (stdinBuf.length < 4 + len) break;
    const jsonBuf = stdinBuf.subarray(4, 4 + len);
    stdinBuf = stdinBuf.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(jsonBuf.toString("utf8"));
    } catch (e) {
      continue;
    }
    handleExtensionMessage(msg);
  }
});

process.stdin.on("end", () => process.exit(0));

function handleExtensionMessage(msg) {
  if (msg && msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error));
    else resolve(msg.result);
  }
}

function callExtension(action, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = "r" + ++reqCounter;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timed out waiting for the Firefox extension. Is Firefox open with the connector loaded?"));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    sendToExtension({ id, action, params });
  });
}

const PORT = Number(process.env.CLAUDE_FIREFOX_BRIDGE_PORT || 8765);

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/call") {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const { action, params } = JSON.parse(body || "{}");
      const result = await callExtension(action, params || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
    }
  });
});

// Bind to loopback only — never expose this bridge beyond localhost.
server.listen(PORT, "127.0.0.1");

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
