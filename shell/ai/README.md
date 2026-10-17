# shell/ai —— Agent 地基

这一层只做三件事，别的一概不管：

1. **说 OpenAI 的 chat-completions**（DeepSeek / Ollama / llama.cpp 任何 base URL 都行）；
2. **存一个配置**（端点、模型、密钥、采样参数），并且保证密钥永远不出现在日志、错误和 `describe()` 里；
3. **把已有域动词包成工具**，本片只有两个只读工具，写工具故意没有。

Agent 本身是**普通 RPC 客户端**：真正的对话循环、RPC 注册、diff 卡、UI 都在这一层之外。
这个目录不 import `electron/`、不碰 `shell/main.mjs`、不写游戏目录、不发遥测。

```
shell/ai/
  provider.mjs   OpenAI 兼容适配器：非流式 + SSE 流式、tool calling、超时/重试/AbortSignal、错误分类
  config.mjs     userData 下的配置读写 + 校验 + 脱敏
  tools.mjs      工具注册表（defineTool / createToolRegistry）与两个只读工具
  selftest.mjs   完全脱网自测（本地假 OpenAI 服务 + 临时目录）
  README.md      本文件
```

只有 Node 内置模块和全局 `fetch`：**没有新增 npm 依赖**，没有 `child_process`，Node 18+ 可加载。

## HTTP 契约（provider.mjs）

对任意 base URL `B` 发 `POST B + "/chat/completions"`：

```
content-type: application/json
accept: application/json            # 非流式
accept: text/event-stream           # 流式
authorization: Bearer <apiKey>      # apiKey 为空时这个头根本不发
```

请求体（只发确实设置了的字段）：

```json
{
  "model": "deepseek-chat",
  "messages": [{"role": "user", "content": "..."}],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 2048,
  "tools": [{"type": "function", "function": {"name": "kb.search", "description": "...", "parameters": {}}}],
  "tool_choice": "auto"
}
```

- `tools` 与 `tool_choice` 必须成对；只给 `toolChoice` 会抛 `ConfigError`。
- `extra` 可以追加任意字段（如 `top_p`），但不得覆盖 `model/messages/stream/tools/tool_choice`。
- `messages` 支持 `system/user/assistant/tool`；`assistant.tool_calls[].id` 与 `tool.tool_call_id` 原样透传。
- base URL 会被规范化：去掉尾部 `/`，以及误粘贴进来的 `/chat/completions`；拒绝 `ftp:`、URL 内嵌账号密码、空白和 fragment。

返回值统一成一个形状（流式也是这个形状）：

```js
{
  id, model, created,
  message: { role: "assistant", content: "..." | null, tool_calls?: [{id, type, function: {name, arguments}}] },
  finishReason, usage, streamed
}
```

### SSE 流

- 按空行切帧，`data:` 行拼接；`\n\n` 和 `\r\n\r\n` 都接受；**一帧被 TCP 切成两半时会等齐再解析**。
- `data: [DONE]` 结束；若没有 `[DONE]` 但已经收到 `finish_reason`，也算正常结束。
- `delta.content` 累积成 `message.content`，`delta.reasoning_content` 累积成 `message.reasoning_content`。
- `delta.tool_calls` **按 `index` 跨帧累积**：`id`/`name` 只来一次，`arguments` 是碎片串接；
  同一个响应里可以有多个工具调用；`name` 被拆到两帧也能拼回。
- `onEvent` 逐事件回调：`{type:"text"|"reasoning"|"tool_call"|"done", ...}`，UI 可以直接消费。
- 服务端忽略 `stream:true`、回了一个 JSON 补全：当作非流式接受（`streamed: false`）。

### 错误分类（ProviderError.kind）

| kind | 何时 | retryable | 自动重试 |
| --- | --- | --- | --- |
| `auth` | 401 / 403 | false | 否 |
| `rate` | 429，带 `retryAfterMs`（来自 `retry-after`） | true | 否 |
| `network` | 连接失败、连接被断、读超时 | 见下 | **仅一次** |
| `protocol` | 非 2xx 其它状态、body 不是 JSON、没有 choices、SSE 协议错误、流中途 `{"error":...}` | 5xx 为 true | 否 |
| `cancelled` | 调用方的 `AbortSignal` 触发 | false | 否 |

自动重试**仅限**：`kind === "network" && retryable && !timedOut && 还没有向调用方发过事件`。
超时不重试（`timedOut: true`、`kind: "network"`），因为它只是让用户多等一次。
错误里的 `detail` 是截断、单行、**已脱敏**的响应片段；密钥不会出现在 `message`/`detail`/日志里。

`timeoutMs` 覆盖整个请求（含读完 body）；`AbortSignal` 可随时取消。

## 配置（config.mjs）

存在 Electron `app.getPath("userData")` 下的 `ai-provider.json`，原子写（临时文件 + rename，权限 0600）：

```json
{
  "version": 1,
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "apiKey": "sk-...",
  "temperature": 0.7,
  "maxTokens": 2048,
  "timeoutMs": 60000,
  "stream": true
}
```

```js
import { createConfigStore } from "./config.mjs";
const store = createConfigStore({ dir: app.getPath("userData") });
store.load();                                  // 合并默认值后的配置（含密钥，别打印）
store.read();                                  // {config, exists, warnings, errors, error}
store.write({ model: "deepseek-reasoner" });   // 返回脱敏回执，非法值抛 ConfigError，文件不动
store.describe();                              // 可安全进日志：apiKey: "***" / null
store.clear();
```

- 密钥只在磁盘和 `load()` 里存在；`describe()`、`write()` 回执、错误消息、脱敏工具 `redact`/`redactText`/`snippet` 都只给 `***`。
- 文件损坏：回退默认值，`error` 里只说"不是合法 JSON"，**不回显文件内容**（那里面有密钥）。
- 非法写入（`temperature: 9` 等）整笔拒绝；`version` 由 store 自己写，调用方不能改。
- 不写 repo、不写游戏目录：`dir` 必须是绝对路径，且由调用方（Electron userData）提供。
  纯 Node 场景可以用 `defaultUserDataDir()` 兜底。

## 工具（tools.mjs）

```js
import { createToolRegistry, createReadOnlyTools, invokeToolCall, toolResultMessage } from "./tools.mjs";
import { createMods } from "../mods/index.js";

const modsRoot = /* 用户的 mod 目录 */;
const registry = createToolRegistry({ tools: createReadOnlyTools({ mods: createMods({ modsRoot }), modsRoot }) });
registry.openaiTools(); // → 直接塞进 provider 的 tools
```

| 工具 | 包的是 | 输入 | 输出 |
| --- | --- | --- | --- |
| `kb.search` | `shell/mods/search.js` 的 `suggest` | `prefix`（必填）、`context`、`limit` | `{prefix, context, count, isIncomplete, items[{label,kind,detail,insertText,documentation}]}` |
| `mod.validate` | `shell/mods/index.js` 的 `validatePackage` | `root`（相对 modsRoot 或其中绝对路径）、`maxDiagnostics` | `{root, ok, knowledge, manifest, summary, typeCount, diagnostics[{severity,code,path,message,schemaType}], diagnosticsTotal, truncated}` |

规则：

- `defineTool({name, description, parameters, handler, safety})`，名字形如 `domain.verb`；`parameters` 是 JSON Schema 子集（`type/properties/required/additionalProperties/items/enum/const/oneOf/min|max`…）。
- `createToolRegistry({tools, allowWrite})` 默认**只收只读工具**：带 `safety: "write"` 的工具会当场抛错；写工具以后走 diff 卡，那时才显式 `allowWrite: true`。
- `invoke()` 先校验参数再执行；handler 抛错或返回不可 JSON 序列化的值一律变成 `handler_failed`，不把栈泄给模型。
- `invokeToolCall()` **永不抛**，把失败当数据返回 `{ok:false, error:{code, message}}`，直接能当 `role:"tool"` 消息内容。
- 路径沙箱：`resolveInside(root, target)` 先做词法检查（`..`、绝对路径），再做 symlink/junction 解析，逃逸一律 `path_outside_root`；相对路径相对 root，**相对的是 root 而不是进程 cwd**。`mod.validate` 没配 modsRoot 时拒绝相对路径。
- 错误码：`invalid_tool / invalid_arguments / unknown_tool / unavailable / path_outside_root / handler_failed`。

## 自测

```bash
node shell/ai/selftest.mjs
```

完全脱网：自己起一个 127.0.0.1 临时端口的假 OpenAI 服务（覆盖流式、跨 chunk 的 tool_calls、超时、abort、各类错误、配置往返与脱敏、一次完整工具调用环），所有文件写在系统临时目录并在结束时删掉。全部通过时最后一行是 `shell/ai: ok`，退出码 0。

## 边界（这里故意没有的东西）

- **没有**在 `shell/main.mjs` 注册任何 RPC 方法 —— 接线是别一层的事。
- **没有**写工具、没有 diff 卡、没有 apply/undo。
- **没有**对话历史存储、没有 token 计数、没有上下文裁剪策略。
- **没有** UI 事件桥；流式事件通过 `onEvent` 回调交给调用方决定怎么显示。
- **没有**厂商特判分支：所有厂商走同一条 chat-completions 路径，差异只由 base URL/模型名/`extra` 承担。
- **没有**遥测、没有联网自检、没有 `child_process`。

## 接线清单（下一步）

```js
// shell/main.mjs（由接线的人加，本目录不含）
const store = createConfigStore({ dir: app.getPath("userData") });
const mods = createMods({ modsRoot: options.modsRoot ?? options.workspace });
const provider = createProvider({ ...store.load() });
const registry = createToolRegistry({ tools: createReadOnlyTools({ mods, modsRoot: options.modsRoot }) });
```

然后把 `provider.complete` 包成一个 RPC 方法（例如 `ai.complete`），把 `registry.openaiTools()`
原样放进请求；工具调用回到 `invokeToolCall`；写操作等 diff 卡那片落地后再加 `safety: "write"` 工具。
