import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { HttpScanner, CommandScanner, validateSpans } from "../src/scanners.ts";

test("validateSpans clamps bounds and drops garbage (trust boundary)", () => {
  const text = "0123456789";
  const spans = validateSpans(
    [
      { start: 0, end: 3, label: "private_email", score: 0.9 },
      { start: -5, end: 2, label: "secret" },          // clamped to 0..2
      { start: 5, end: 999, label: "account_number" },  // clamped end
      { start: 3, end: 3, label: "private_phone" },     // empty -> dropped
      { start: "x", end: 2, label: "secret" },          // bad type -> dropped
      { start: 1, end: 2, label: "BAD LABEL!" },        // bad label -> dropped
      { start: 1, end: 2, label: "secret", score: 5 },  // score clamped to 1
      null,
    ],
    text.length,
  );
  assert.equal(spans.length, 4);
  assert.deepEqual(spans[0], { start: 0, end: 3, label: "private_email", score: 0.9 });
  assert.deepEqual(spans[1], { start: 0, end: 2, label: "secret", score: 1 });
  assert.equal(spans[2].end, 10);
  assert.equal(spans[3].score, 1);
});

test("http backend: posts text, returns spans", async () => {
  let received = "";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = JSON.parse(body).text;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ spans: [{ start: 0, end: 4, label: "secret", score: 0.8 }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const scanner = new HttpScanner(`http://127.0.0.1:${port}/scan`);
    const { spans } = await scanner.scan("abcd efgh");
    assert.equal(received, "abcd efgh");
    assert.deepEqual(spans, [{ start: 0, end: 4, label: "secret", score: 0.8 }]);
  } finally {
    server.close();
  }
});

test("http backend: non-200 and non-JSON surface as errors", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/bad") { res.statusCode = 500; res.end("boom"); return; }
    res.end("not json");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    await assert.rejects(() => new HttpScanner(`http://127.0.0.1:${port}/bad`).scan("x"), /HTTP 500/);
    await assert.rejects(() => new HttpScanner(`http://127.0.0.1:${port}/ok`).scan("x"), /not JSON/);
  } finally {
    server.close();
  }
});

test("command backend: text on stdin, spans on stdout", async () => {
  // echo a span covering the first 2 chars of whatever arrives on stdin
  const cmd = `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({spans:[{start:0,end:2,label:"private_person",score:0.7}]})))'`;
  const { spans } = await new CommandScanner(cmd).scan("John Doe");
  assert.deepEqual(spans, [{ start: 0, end: 2, label: "private_person", score: 0.7 }]);
});

test("command backend: non-zero exit reports stderr", async () => {
  const cmd = `node -e 'console.error("detector exploded");process.exit(3)'`;
  await assert.rejects(() => new CommandScanner(cmd).scan("x"), /exited 3.*detector exploded/s);
});

test("command backend: timeout kills the command", async () => {
  const cmd = `node -e 'setTimeout(()=>{},10000)'`;
  await assert.rejects(() => new CommandScanner(cmd, 300).scan("x"), /timed out/);
});
