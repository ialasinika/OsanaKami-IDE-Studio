/* ------------------------------------------------------------------ */
/* rpc.mjs
/* ------------------------------------------------------------------ */

import assert from "node:assert/strict";
import {
  RpcError,
  SseParser,
  createClient,
  isStaleRevision,
  staleCurrentRevision,
} from "../rpc.mjs";
import {
  fakeFetch,
  tick,
} from "./fixtures.mjs";
import {
  test,
  testAsync,
} from "./harness.mjs";

/* ------------------------------------------------------------------ */
/* rpc.mjs                                                             */
/* ------------------------------------------------------------------ */

await testAsync("sse: a frame split across chunk boundaries is reassembled", async () => {
  const fetchImpl = fakeFetch({
    chunks: [
      "data: {\"event\":\"log\",\"level\":\"inf",
      "o\",\"message\":\"one\"}\n",
      "\ndata: {\"event\":\"log\",\"level\":\"warn\",\"message\":\"two\"}\n\n",
    ],
  });
  const client = createClient({ origin: "http://127.0.0.1:1", fetchImpl });
  const seen = [];
  client.on("log", (event) => seen.push(event.message));
  client.connect();
  await client.ready();
  await tick();
  assert.deepEqual(seen, ["one", "two"]);
  assert.equal(client.connected, false, "a closed stream must report disconnected");
});

await testAsync("sse: three frames arriving in one chunk all dispatch, in order", async () => {
  const fetchImpl = fakeFetch({
    chunks: [
      "data: {\"event\":\"log\",\"message\":\"a\"}\n\n"
      + "data: {\"event\":\"log\",\"message\":\"b\"}\n\n"
      + "data: {\"event\":\"log\",\"message\":\"c\"}\n\n",
    ],
  });
  const client = createClient({ fetchImpl });
  const seen = [];
  client.on("log", (event) => seen.push(event.message));
  client.connect();
  await client.ready();
  await tick();
  assert.deepEqual(seen, ["a", "b", "c"]);
});

await testAsync("sse: UTF-8 split mid-codepoint does not corrupt a frame", async () => {
  // "→" is E2 86 92; cut it after the first byte.
  const bytes = new TextEncoder().encode("data: {\"event\":\"log\",\"message\":\"a→b\"}\n\n");
  const fetchImpl = fakeFetch({
    chunks: [bytes.slice(0, 30), bytes.slice(30)],
  });
  const client = createClient({ fetchImpl });
  const seen = [];
  client.on("log", (event) => seen.push(event.message));
  client.connect();
  await client.ready();
  await tick();
  assert.deepEqual(seen, ["a→b"]);
});

test("sse: SseParser keeps an incomplete frame buffered", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("data: {\"event\":\"log\"}"), []);
  assert.deepEqual(parser.push("\n\n"), ["{\"event\":\"log\"}"]);
  assert.deepEqual(parser.push("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n"), ["{\"a\":1}", "{\"b\":2}"]);
  assert.deepEqual(parser.push(": keep-alive comment\n\n"), []);
});

await testAsync("rpc: an ok:false reply becomes an RpcError carrying code/name/message/data", async () => {
  const fetchImpl = fakeFetch({
    replies: [{
      ok: false,
      error: { code: 409, name: "STALE_REVISION", message: "file moved on", data: { current_revision: 42 } },
    }],
  });
  const client = createClient({ fetchImpl });
  let caught = null;
  try {
    await client.call("file.write", { path: "a.yarn", text: "x", base_revision: 7 });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof RpcError, "expected an RpcError");
  assert.equal(caught.code, 409);
  assert.equal(caught.errorName, "STALE_REVISION");
  assert.equal(caught.message, "file.write: file moved on");
  assert.equal(caught.message_, "file moved on");
  assert.deepEqual(caught.data, { current_revision: 42 });
  assert.equal(caught.method, "file.write");
  assert.equal(client.state.pending, 0, "a settled call must leave nothing pending");
});

await testAsync("rpc: a success reply resolves to result and the request is well formed", async () => {
  const fetchImpl = fakeFetch({ replies: [{ ok: true, result: { protocol: "infantgod/2" } }] });
  const client = createClient({ origin: "http://127.0.0.1:3939", fetchImpl });
  const result = await client.call("hello", {});
  assert.deepEqual(result, { protocol: "infantgod/2" });
  assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3939/rpc");
  assert.equal(fetchImpl.calls[0].init.method, "POST");
  // A request, not a notification: the id is what makes the host answer.
  assert.equal(typeof fetchImpl.calls[0].body.id, "number");
  assert.deepEqual(fetchImpl.calls[0].body, {
    jsonrpc: "2.0", id: fetchImpl.calls[0].body.id, method: "hello", params: {},
  });
  assert.equal(fetchImpl.calls[0].init.headers["Content-Type"], "application/json");
});

await testAsync("rpc: STALE_REVISION surfaces data.current_revision to the caller", async () => {
  const fetchImpl = fakeFetch({
    replies: [{
      ok: false,
      error: { code: 409, name: "STALE_REVISION", message: "nope", data: { current_revision: 8 } },
    }],
  });
  const client = createClient({ fetchImpl });
  let caught = null;
  try {
    await client.call("file.write", { path: "a.yarn", text: "x", base_revision: 3 });
  } catch (err) {
    caught = err;
  }
  assert.ok(client.isStaleRevision(caught), "the client must recognise a stale write");
  assert.equal(staleCurrentRevision(caught), 8);
  assert.equal(caught.data.current_revision, 8);
  // The same rejection is recognised when the endpoint puts the name in `code`.
  const alt = new RpcError({ code: "STALE_REVISION", message: "nope" }, "file.write");
  assert.ok(isStaleRevision(alt));
  assert.equal(staleCurrentRevision(alt), null);
  assert.ok(!isStaleRevision(new RpcError({ code: 404, name: "NO_SUCH_FILE", message: "x" }, "file.read")));
});

await testAsync("rpc: an unreachable host rejects the call and flips the status", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  const states = [];
  const client = createClient({ fetchImpl, onStatus: (state) => states.push(state.connected) });
  let caught = null;
  try {
    await client.call("hello", {});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof RpcError);
  assert.equal(caught.symbol, "TRANSPORT");
  assert.ok(caught.message.includes("network error"), caught.message);
  client.connect();
  await tick();
  assert.equal(client.connected, false);
  assert.ok(states.includes(false));
});

await testAsync("rpc: a non-JSON body is a BAD_REPLY, not a crash", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "<html>nope" });
  const client = createClient({ fetchImpl });
  let caught = null;
  try {
    await client.call("hello", {});
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.symbol, "BAD_REPLY");
});

await testAsync("rpc: a reply carrying a different id is a BAD_REPLY, not an answer", async () => {
  // The host echoes the id; that echo is the only thing tying a reply to the
  // request it answers, so a reply for some other id must never resolve a call.
  const fetchImpl = async (url, init) => {
    const sent = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        jsonrpc: "2.0",
        id: sent.id + 1,
        result: { an_answer: "for somebody else" },
      }),
    };
  };
  const client = createClient({ fetchImpl });
  let caught = null;
  try {
    await client.call("hello", {});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof RpcError, "a mismatched id must not resolve the call");
  assert.equal(caught.symbol, "BAD_REPLY");
  assert.match(caught.message, /hello: the host answered a different request \(id 2, expected 1\)/);
  assert.equal(client.state.pending, 0, "the rejected call leaves nothing pending");
});

await testAsync("rpc: with two calls in flight a swapped reply rejects instead of misdelivering", async () => {
  // Answer each request with the *other* request's id and hold the replies back
  // until both are in flight. Before the id check this resolved both calls with
  // the wrong result, which is the bug: one caller got another's answer.
  const sent = [];
  const fetchImpl = (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return new Promise((resolve) => {
      const answer = () => {
        if (sent.length < 2) {
          setTimeout(answer, 0);
          return;
        }
        const other = sent.find((entry) => entry.id !== body.id);
        resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            jsonrpc: "2.0",
            id: other.id,
            result: { answered: other.method },
          }),
        });
      };
      answer();
    });
  };
  const client = createClient({ fetchImpl });
  const settled = await Promise.allSettled([client.call("first", {}), client.call("second", {})]);
  assert.equal(settled[0].status, "rejected");
  assert.equal(settled[1].status, "rejected");
  assert.equal(settled[0].reason.symbol, "BAD_REPLY", "the first call takes no answer but its own");
  assert.equal(settled[1].reason.symbol, "BAD_REPLY", "the second call takes no answer but its own");
  assert.equal(client.state.pending, 0, "both rejected calls are cleaned up");
});

await testAsync("rpc: a handler that throws does not stop the other handlers", async () => {
  const fetchImpl = fakeFetch({
    chunks: ["data: {\"event\":\"log\",\"message\":\"one\"}\n\n"],
  });
  const client = createClient({ fetchImpl });
  const seen = [];
  client.on("log", () => {
    throw new Error("boom");
  });
  client.on("log", (event) => seen.push(event.message));
  // The client is supposed to report the bad handler on the console; that is the
  // behaviour under test, so silence it rather than let it look like a failure.
  const realError = console.error;
  console.error = () => {};
  try {
    client.connect();
    await client.ready();
    await tick();
  } finally {
    console.error = realError;
  }
  assert.deepEqual(seen, ["one"]);
});
