/* ------------------------------------------------------------------ */
/* end to end: a real HTTP server speaking the frozen contract
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import {
  createServer,
} from "node:http";
import {
  applyTokenSpans,
  segmentsText,
} from "../cards.mjs";
import {
  RpcError,
  createClient,
  isStaleRevision,
  staleCurrentRevision,
} from "../rpc.mjs";
import {
  tick,
} from "./fixtures.mjs";
import {
  test,
  testAsync,
} from "./harness.mjs";

/* ------------------------------------------------------------------ */
/* end to end: a real HTTP server speaking the frozen contract          */
/* ------------------------------------------------------------------ */

/**
 * The whole point of this section: the fake-fetch tests above prove the logic,
 * this one proves the *wire*.  A real `node:http` server answers `/rpc` exactly
 * as `node shell/main.mjs serve` promises to and streams `/events` as chunked
 * `text/event-stream`, and the client is left to use real fetch, real sockets
 * and real chunk boundaries.
 */
await testAsync("e2e: a real HTTP host, real SSE and real chunk boundaries", async () => {
  const board = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, cards: [], links: [] };
  let boardRevision = 3;
  let fileRevision = 11;
  const seenMethods = [];
  const sockets = new Set();

  const server = createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (object) => res.write(`data: ${JSON.stringify(object)}\n\n`);
      send({ event: "log", level: "info", message: "hello from the host" });
      // Two events written into a single TCP segment, so the reader has to split
      // a chunk that contains more than one frame.
      res.write(`data: ${JSON.stringify({ event: "log", level: "warn", message: "one" })}\n\n`
        + `data: ${JSON.stringify({ event: "log", level: "info", message: "two" })}\n\n`);
      setTimeout(() => {
        send({ event: "exec.output", run_id: 1, stream: "stdout", data: "out\n" });
        send({ event: "exec.exit", run_id: 1, code: 0 });
        res.end();
      }, 20);
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed = { method: "", params: {} };
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = { method: "", params: {} };
      }
      seenMethods.push(parsed.method);
      const reply = (value) => {
        // The real host speaks JSON-RPC, so the mock does too: the same id
        // comes back with either a result or an error.  Replying in any other
        // shape would be testing a host that does not exist.
        const body = value.ok === true
          ? { jsonrpc: "2.0", id: parsed.id, result: value.result }
          : { jsonrpc: "2.0", id: parsed.id, error: value.error };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      switch (parsed.method) {
        case "hello":
          reply({ ok: true, result: { protocol: "infantgod/2", kernel_version: "0.1.0", root: "<workspace>", pid: 4242 } });
          return;
        case "view.load":
          // The client names the document it wants; the host answers with that
          // path, exactly as the kernel does.
          reply({ ok: true, result: { path: parsed.params.path, revision: boardRevision, document: board } });
          return;
        case "view.save":
          if (parsed.params.base_revision !== boardRevision) {
            reply({
              ok: false,
              error: {
                code: 409, name: "STALE_REVISION", message: "the view document moved on",
                data: { current_revision: boardRevision },
              },
            });
            return;
          }
          boardRevision += 1;
          reply({ ok: true, result: { path: parsed.params.path, revision: boardRevision, saved: true } });
          return;
        case "file.read":
          // The real first line of `examples/hello.yarn` -- the text the token
          // spans below are the shipped descriptor's answer for.
          reply({ ok: true, result: { path: parsed.params.path, text: "title: Live_Node\n", revision: fileRevision, size: 17, eol: "lf" } });
          return;
        case "file.write":
          if (parsed.params.base_revision !== fileRevision) {
            reply({
              ok: false,
              error: {
                code: 409, name: "STALE_REVISION", message: "file moved on",
                data: { current_revision: fileRevision },
              },
            });
            return;
          }
          fileRevision += 1;
          reply({ ok: true, result: { path: parsed.params.path, revision: fileRevision, size: parsed.params.text.length, eol: "lf" } });
          return;
        case "lang.tokenize":
          // The spans `langs/yarn.lang` really produces for `title: Live_Node\n`:
          // the keyword, the `:` command, the space, the identifier, the newline.
          reply({ ok: true, result: { lang: { id: "yarn", title: "Yarn" }, tokens: [[0, 5, "keyword"], [5, 6, "command"], [6, 7, "ws"], [7, 16, "ident"], [16, 17, "ws"]] } });
          return;
        default:
          reply({ ok: false, error: { code: 404, name: "NO_METHOD", message: `no method ${parsed.method}` } });
      }
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  try {
    const client = createClient({ origin: `http://127.0.0.1:${port}` });
    const events = [];
    client.on("log", (event) => events.push(event.message));
    client.on("exec.output", (event) => events.push(event.data));
    client.on("exec.exit", (event) => events.push(`exit ${event.code}`));
    client.connect();
    await client.ready();
    assert.equal(client.connected, true);

    const hello = await client.call("hello", {});
    assert.equal(hello.protocol, "infantgod/2");
    assert.equal(hello.pid, 4242);

    const loaded = await client.call("view.load", { path: ".infantgod/board.json" });
    assert.equal(loaded.path, ".infantgod/board.json", "the host answers with the path that was asked for");
    assert.equal(loaded.revision, 3);
    assert.deepEqual(loaded.document.cards, []);

    const saved = await client.call("view.save", { path: ".infantgod/board.json", document: board, base_revision: 3 });
    assert.equal(saved.saved, true);
    assert.equal(saved.revision, 4, "the host bumps the revision");

    const stale = await client.call("view.save", { path: ".infantgod/board.json", document: board, base_revision: 3 }).then(
      () => null,
      (err) => err,
    );
    assert.ok(stale instanceof RpcError, "a stale save must reject");
    assert.equal(stale.code, 409);
    assert.equal(stale.errorName, "STALE_REVISION");
    assert.equal(stale.data.current_revision, 4);
    assert.equal(staleCurrentRevision(stale), 4);
    assert.ok(client.isStaleRevision(stale));

    const read = await client.call("file.read", { path: "examples/hello.yarn" });
    assert.equal(read.revision, 11);
    const written = await client.call("file.write", {
      path: read.path, text: read.text, base_revision: read.revision,
    });
    assert.equal(written.revision, 12);
    const staleWrite = await client.call("file.write", {
      path: read.path, text: "x", base_revision: 11,
    }).then(() => null, (err) => err);
    assert.equal(staleCurrentRevision(staleWrite), 12, "the second writer sees the live revision");

    const tokenized = await client.call("lang.tokenize", { path: read.path, text: read.text });
    assert.equal(tokenized.lang.id, "yarn");
    const segments = applyTokenSpans(read.text, tokenized.tokens);
    assert.equal(segmentsText(read.text, tokenized.tokens), read.text);
    // The whole pipeline over the wire: a Yarn header key is the first span, and
    // the `:` command and the identifier that follow are not swallowed by it.
    assert.deepEqual(segments.map((seg) => seg.kind), ["keyword", "command", "plain", "plain", "plain"]);
    assert.deepEqual(segments.map((seg) => read.text.slice(seg.start, seg.end)),
      ["title", ":", " ", "Live_Node", "\n"]);

    const unknown = await client.call("nope", {}).then(() => null, (err) => err);
    assert.equal(unknown.errorName, "NO_METHOD");
    assert.equal(unknown.code, 404);

    // The stream's frames were split by the real socket, not by the test.
    for (let i = 0; i < 40 && !events.includes("exit 0"); i += 1) {
      await tick(1);
    }
    assert.deepEqual(events, ["hello from the host", "one", "two", "out\n", "exit 0"]);
    assert.equal(client.connected, false, "the host ended the stream, so we report disconnected");

    assert.deepEqual(seenMethods, [
      "hello", "view.load", "view.save", "view.save",
      "file.read", "file.write", "file.write", "lang.tokenize", "nope",
    ]);
    client.close();
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
});
