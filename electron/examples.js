/*
 * "打开示例 Mod" -- the File-menu shortcut that puts a demo package into the
 * user's mods folder and shows it.
 *
 * Why a copy and not an open: the demo ships beside the editor
 * (`<resources>/examples/Mods`), and the shell refuses to open a mod outside the
 * mods folder on purpose (`resolveArg`) -- a card's `dir` must not reach into the
 * filesystem.  `mod.example` copies the package in, which is also what makes it
 * editable: the demo the user studies is their own copy, not the install's.
 *
 * Like newmod.js this file knows nothing about `electron` and speaks one JSON-RPC
 * frame over HTTP; `main.js` supplies the endpoint and shows the window.
 */

"use strict";

const newMod = require("./newmod.js");

/** The one frame, like `newmod.js`'s: one request, one reply, nothing to correlate. */
function request(method, params) {
  return { jsonrpc: "2.0", id: 1, method, params };
}

/**
 * Asks the shell's `mod.example` to copy the demo package into the mods folder.
 *
 * @returns {Promise<{installed: boolean, dir: string, modRoot: string, files: number}>}
 */
async function install({ endpoint, name, fetchImpl }) {
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new Error("打开示例 Mod：还没有 shell 端点");
  }
  const post = fetchImpl || globalThis.fetch;
  if (typeof post !== "function") {
    throw new Error("打开示例 Mod：这个运行时没有 fetch");
  }
  const url = `${endpoint.replace(/\/+$/, "")}/rpc`;
  const params = typeof name === "string" && name.trim() !== "" ? { name: name.trim() } : {};
  const response = await post(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request("mod.example", params)),
  });

  const text = await response.text();
  let reply = null;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new Error(`mod.example 的回答不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  if (reply === null || typeof reply !== "object") {
    throw new Error(`mod.example 的回答不是对象（HTTP ${response.status}）`);
  }
  if (reply.error !== undefined && reply.error !== null) {
    const server = reply.error;
    const failure = new Error(
      typeof server.message === "string" && server.message !== ""
        ? server.message
        : `mod.example 失败（${server.name || server.code || "unknown"}）`
    );
    if (server.code !== undefined) failure.code = server.code;
    if (typeof server.name === "string" && server.name !== "") failure.name = server.name;
    throw failure;
  }
  const result = reply.result;
  if (result === null || typeof result !== "object" || typeof result.dir !== "string" || result.dir === "") {
    throw new Error("mod.example 的回答没有可打开的目录");
  }
  return result;
}

/**
 * The address that shows `dir` (a name inside the mods folder) as the open mod.
 * Same `?mod=` channel as the File menu's new-mod shortcut, so there is one way
 * a path reaches the page.
 */
function openUrl(shell, dir) {
  return newMod.openModUrl(shell, dir);
}

module.exports = { install, openUrl };
