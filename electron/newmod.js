/*
 * "新建模组…" -- the File-menu shortcut that scaffolds an empty mod.
 *
 * The mod layer already owns the scaffolding (shell/mods/scaffold.js); all
 * this file decides is *where* and *what name*, and it asks for the files over
 * the shell's own JSON-RPC.  That is why it lives apart from main.js: the work
 * is one frame, not an Electron call, so a Node test can drive every branch
 * except the native save dialog itself.
 *
 * It is CommonJS because electron/main.js is, and it requires nothing but
 * node:path -- no `electron`, and nothing from `shell/` at run time: in a
 * packaged build the shell is shipped beside the executable
 * (`process.resourcesPath/shell`), not inside `app.asar`, so the only sane
 * client is HTTP.
 */

"use strict";

const path = require("node:path");

/*
 * The four templates shell/mods/scaffold.js already ships, in its order.  The
 * labels are scaffold.js's `nameZh` verbatim: a menu that offers a template id
 * the engine does not know would fail only after the user picked it, and with
 * no useful message.  shell/mods/selftest.mjs fails if the two lists drift.
 */
const TEMPLATES = [
  { id: "minimal", label: "最小可加载" },
  { id: "yarn-story", label: "对话剧情" },
  { id: "define-pack", label: "定义包" },
  { id: "full", label: "完整工程" },
];

/*
 * The characters Windows refuses in a file name -- scaffold.js keeps the same
 * set for its placeholders (`ILLEGAL_NAME_CHARS`).  `.` and `..` are not
 * characters to strip: a name made of dots is a path, and `plan` refuses the
 * ones it can see rather than resolving them into somewhere the user did not
 * type.
 */
const ILLEGAL_IN_NAME = /[<>:"/\\|?*\u0000-\u001f]/;

/**
 * Where a new mod goes when the settings hold no remembered folder.  The mods
 * root is the narrowest writable place `mod.*` accepts; the workspace is the
 * fallback, exactly as on the command line.
 */
function defaultParent(session) {
  const modsRoot = session && session.modsRoot;
  if (typeof modsRoot === "string" && modsRoot !== "") return modsRoot;
  return session ? session.workspace : undefined;
}

/**
 * Turns what the save dialog returned into the two strings `mod.scaffold`
 * takes.  It throws instead of guessing: a name the filesystem cannot hold has
 * to send the user back to the dialog, not create a differently-named folder
 * behind their back.
 *
 * `dir` is the *parent* `mod.scaffold` wants, never the package path: the
 * dialog already named the folder the user chose, and the package lands in
 * `dir/<modName>` -- scaffold.js's own contract, pinned by the check at
 * shell/mods/selftest.mjs:212.  So `dir` is `parent` unchanged; handing over
 * `join(parent, modName)` would nest the mod one level too deep and leave the
 * folder the user named empty.
 *
 * @returns {{dir: string, modName: string}} `dir` is `parent`, `modName` is the
 *   trimmed name the package takes inside it.
 */
function plan({ parent, typedName }) {
  if (typeof parent !== "string" || parent.trim() === "") {
    throw new Error("新建模组：没有可写入的目录");
  }
  if (typeof typedName !== "string") {
    throw new Error("新建模组：名字必须是文本");
  }
  const modName = typedName.trim();
  if (modName === "") {
    throw new Error("新建模组：名字不能为空");
  }
  if (modName === "." || modName === "..") {
    throw new Error(`新建模组："${modName}" 不是名字，是路径`);
  }
  if (ILLEGAL_IN_NAME.test(modName)) {
    throw new Error('新建模组：名字里不能有 < > : " / \\ | ? * 或控制字符');
  }
  if (modName.endsWith(".")) {
    throw new Error("新建模组：名字不能以点结尾（Windows 会把它删掉）");
  }
  return { dir: parent, modName };
}

/**
 * The one frame this menu speaks.  `id` is fixed at 1 because the dialog is a
 * single request/response with nothing to correlate it against.
 */
function request(method, params) {
  return { jsonrpc: "2.0", id: 1, method, params };
}

/** True when `child` is `parent` itself or lives under it. */
function isInside(child, parent) {
  if (typeof child !== "string" || typeof parent !== "string" || parent === "") return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Asks the shell's `mod.scaffold` to write the mod.  `fetchImpl` is a seam:
 * main.js omits it and gets the global fetch, while the test passes a stub and
 * inspects the frame.
 *
 * @returns {Promise<{modRoot: string, created: string[], warnings: string[]}>}
 */
async function createMod({ endpoint, dir, modName, template, fetchImpl }) {
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new Error("新建模组：还没有 shell 端点");
  }
  if (typeof dir !== "string" || dir === "" || typeof modName !== "string" || modName === "") {
    throw new Error("新建模组：dir 和 modName 都不能为空");
  }
  const post = fetchImpl || globalThis.fetch;
  if (typeof post !== "function") {
    throw new Error("新建模组：这个运行时没有 fetch");
  }

  // session.url ends in "/" and a hand-typed endpoint may not: neither may
  // produce "//rpc".
  const url = `${endpoint.replace(/\/+$/, "")}/rpc`;
  const response = await post(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request("mod.scaffold", { dir, modName, template })),
  });

  const text = await response.text();
  let reply = null;
  try {
    reply = JSON.parse(text);
  } catch (err) {
    throw new Error(`mod.scaffold 的回答不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  if (reply === null || typeof reply !== "object") {
    throw new Error(`mod.scaffold 的回答不是对象（HTTP ${response.status}）`);
  }
  if (reply.error !== undefined && reply.error !== null) {
    const server = reply.error;
    const failure = new Error(
      typeof server.message === "string" && server.message !== ""
        ? server.message
        : `mod.scaffold 失败（${server.name || server.code || "unknown"}）`
    );
    // Carried, not flattened: the caller wants to show the containment rule by
    // name (`EOUTSIDE`) and the JSON-RPC code, not just the prose.
    if (server.code !== undefined) failure.code = server.code;
    if (typeof server.name === "string" && server.name !== "") failure.name = server.name;
    throw failure;
  }
  if (reply.result === undefined || reply.result === null || typeof reply.result !== "object") {
    throw new Error("mod.scaffold 的回答没有 result");
  }
  return reply.result;
}

/**
 * The page address that makes the open window show `modRoot` as a mod on its
 * board.  A reload is the only way a shell hands a path to the page (there is
 * no preload IPC and no query string on the normal boot), so the mod travels as
 * `?mod=`; the page reads it in `boot`, puts the directory on the mod card and
 * opens the package.  `dsh web` and a hand-pasted URL use the same address.
 *
 * `modRoot` is passed through encoded, not resolved: `mod.open` resolves a
 * workspace-relative name itself, and an absolute path is the case the
 * scaffold shortcut produces.  An empty root is refused rather than made into a
 * URL that would open an empty card.
 */
function openModUrl(shell, modRoot) {
  if (shell === null || typeof shell !== "object" || typeof shell.url !== "string") {
    throw new Error("openModUrl: 需要带 url 的 shell 会话");
  }
  const root = typeof modRoot === "string" ? modRoot.trim() : "";
  if (root === "") {
    throw new Error("openModUrl: 没有要打开的模组目录");
  }
  const base = shell.url.replace(/\/+$/, "");
  if (base === "") {
    throw new Error("openModUrl: shell 端点为空");
  }
  return `${base}/?mod=${encodeURIComponent(root)}`;
}

/**
 * The File-menu fragment.  The `click` handlers are the only side effect --
 * that is what lets a test call them and watch `onPick`.
 */
function menuTemplate({ onPick }) {
  if (typeof onPick !== "function") {
    throw new Error("menuTemplate: onPick must be a function");
  }
  return [
    {
      label: "新建模组…",
      submenu: TEMPLATES.map((template) => ({
        label: template.label,
        click: () => onPick(template.id),
      })),
    },
  ];
}

module.exports = {
  TEMPLATES,
  defaultParent,
  plan,
  request,
  isInside,
  createMod,
  openModUrl,
  menuTemplate,
};
