# 缺口清单（2026-10-18 第三轮：闭环与校验可信度）

本文取代 `docs/EDITOR_GAPS.md` 的**待办职能**——旧档三轮追加后已超过 1200 行，作为审计档案保留（证据价值仍在），不再追加。本文只收录**当前工作树里核实仍然成立的缺口**，每条给出核实方式；"已关闭"只认代码证据，不认旧文档的说法。

快照：HEAD = `89759b9` 加本轮（同日第三轮）未提交改动，提交后即以该提交为准。第一轮（`df08eea` 落文，`f7b6c84` 快照）关了 G3/G21/G46/G4/G39/G22/G13/G45/G40/G36 十条，但留下 13 条"未复核"；第二轮（`89759b9` 快照）把那 13 条逐条重跑，**未复核区清空**：G31/G5/G8/G14/G19/G37/G33 全部有了定论（多为关闭或大幅收窄），G2/G10/G16/G17/G18/G20/G38 核实仍然成立并重新钉了行号。第三轮关掉 G7/G6/G9（校验器可信度）与 G11/G12（闭环）：校验器现在读 schema 声明了却没人读的关键字、核对 Yarn `#line:` 与本地化表的双向一致、并对 Addressables 地址的写法提出警告；包能装进游戏自己的 Mods 目录，也能读/跟随 `Player.log`。**第二轮钉的行号因本轮 `shell/mods/validate.js`（+431）、`shell/mods/index.js`（+323）、`shell/main.mjs`（+212）、`shell/web/cards/card-mod.mjs`（+138）的增行而漂移，本轮已按当天树重钉；已关闭行保留原提交编号，不追行号。**

## 已关闭（两轮累计，均有代码证据）

| 条目 | 关闭证据 |
| --- | --- |
| G3 撞名不查 | `59be772`：`validate.js` D103 跨包/同包重名、D102 提级、M012 兄弟目录不可读 |
| G21 音频引用零校验 | `e0b0886`：D006 音频分支、`#vo` 的 Y122、`#vo:` 补全 |
| G46 格式体检 | `9648c02`：D007/D008/D009/D010（PNG/WAV/Spine/CSV 头） |
| G4 类型支持矩阵 | `deda198`：`shell/mods/support.json`（51 类型四档 + manager）、M013/M014、模板不再生成 `Attr` |
| G39 编辑器/`.yarn` 仍整文件读 | `97f96e2`：`cards/blob.mjs` 的 `readTextFile`/`writeTextFile` 把 4 MiB 拒读接到会话；编辑器与故事卡都改走它 |
| G22 立绘路径零校验 | `4393125`：`validate.js` 的 `D011` 解析 `Character.spineAssetPath`（包根 + `Spine/` 前缀容错）、空串放行、`.json` 骨架要求同名图集 |
| G13 无 headless 校验 CLI | `e90b16d`：`main.mjs` 加 `validate DIR [--json]`，只用 `shell/mods/`、不 spawn 内核，退出码 0/1/2；第三轮复核仍在：`main.mjs:1805` |
| G45 无 zip 导出 | `bd4c01e`：`shell/mods/zip.js` + `mod.export`（可复现 zip）；CLI `export` 动词第三轮复核仍在：`main.mjs:1806` |
| G40 翻译写回 | `f7b6c84`：`card-story.mjs:270-271` 点单元格成 input，Enter/blur 走 `setColumn`，`lock` 重算为源行哈希 |
| G36 卸载盲删 | `89759b9`：安装清单进卸载宏，卸载只删清单内文件；`tools/installer_smoke.py` 进 `make test` |
| G31 本机派生 KB 缺接线 | `resolveKnowledge()`（`shell/mods/index.js:408-427`）：四个候选位置都没有 KB 时，自动从 `gameModsDir` 调 `knowledge-build.buildKnowledge` 派生并写进 userDir；读不了的 KB 报 `loadError`，绝不静默当空 |
| G5 知识库不可再生/无版本 | **主体关闭**：生成器重写为 `shell/mods/knowledge-build.js` + 薄 CLI `tools/gen_knowledge.mjs`；KB 带 `version:1` 与 `generatedAt`（`knowledge.json` 头部）；首启自动派生见 G31。残余见下文 A 区 |
| G8 脚手架模板自伤 | **主体关闭**：`yarn.js:402` 把 `when` 收进节点元数据，`autoSubtitle`（`yarn.js:700-702`）用它造确定性 subtitle——`when:` 不再被丢掉。残余见下文 A 区 |
| G14 1.5 s 轮询不可调 | **主体关闭**：`WATCH_POLL_MS = 1500` 仍是默认（`watch.mjs:23`），但设置卡可在 250 ms–60 s 间调（`watch.mjs:33-34`，G48 的界面）；卡片层读路径已由 G39 统一走 blob。残余见下文 B 区 |
| G19 前半：mod 视图排不了非 editor 卡 | `modview.mjs:57-70`：`tabs` 收**每一种**卡，hidden 卡经标签条一键可达（G29 修复的另一半）。残余（watch 只盯 editor）见下文 B 区 |
| G37 KB 生成器会自伤 | **主体关闭**：生成器重写后 `--diff` 是只读报告（退出码恒 0，逐条摊开"已提交 KB 更富"），`--check` 对富 KB 报漂移已写明为预期行为（`gen_knowledge.mjs:35-41`）。两条残余见下文 A 区 |
| G33 旧账盘点 | 盘点项全部已被本轮两张表吸收，条目退役 |
| G1 语言表打不开 | story 卡走 blob 分块：`cards/card-story.mjs` 的 `readTextInChunks` |
| G25/G29 卡片可达性 | 13 种卡分模块落 `cards/`，两个视图都有标签页 |
| G41 再生 KB 关掉 sprite 检查 | `gen_knowledge.mjs:16-22` 注释明确保留两类事实型 description |
| G42 CSV 往返丢 BOM | `cef2056` |
| G43 locale 文档空白 | `search.js` 有 `case 'locale'` |
| G47 spine 命名 | `58a38ab` 改名 rig，`cards/card-rig.mjs` |
| G48 设置 UI | `cards/card-settings.mjs`：表单编辑 AI provider / 启动视图 / 轮询间隔 |
| G50 "+"新建文件 | `mod.newFile` / `mod.importFile` 已进 `MOD_METHODS` |
| G30/G35 分发物 | `package.json` 的 filter 排掉 `knowledge.json`、`hello.yarn`、`board.json`、`sample.json` |
| spine 编辑 | `9f8d4d7`：rig 卡可读可写回 |
| G6 校验关键字面 | 第三轮：`validate.js` 的 `checkConstraints` 真读 `const`/`pattern`/`minLength`/`maxLength`/`minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/`multipleOf`/`minItems`/`maxItems`/`uniqueItems`/`oneOf`/`anyOf`/`allOf`/`not`（D012 error），`type` 接受数组，`additionalProperties: false` 把未声明字段提为 D012；知识库当前没用这些关键字，所以 `selftest/spec.mjs` 用合成 schema 钉住 3 条 D012；解析不到的 `$ref` 报 D013 |
| G7 `#line:` 双向核对 | 第三轮：`validate.js` 用 `yarn.js` 解析每个 `.yarn` 的 `#line:` id，再读本地化表的 `id` 列做双向核对——D014（yarn 有、表无）、D015（表有、yarn 无）、D016（同一 id 跨文件重复）、D017（非 7 位 hex 的演示 id 汇总成一条 info，不假装核对过）。真语料 `MyMod` 上 D014=0、D016=0、D015=1（真实孤儿 `line:094007b`）、D017=1（57 个非 hex id） |
| G9 prefab/地址不查 | **主体关闭**：description 恰为 `Addressable asset address` 的字段（知识库 9 处）若值是 `Assets/...`、盘符路径、含反斜杠、或 `.prefab`/`.asset`/`.unity` 结尾，报 D018 warning——游戏按 Addressables 窗口登记的 address 查，不按资源路径；`Backgrounds/Office` 这类正常 address 静默，真语料 0 误报。残余：无法知道 Addressables 窗口里到底登记了哪些 address，只能查"写法像不像路径" |
| G11 无"装进游戏" | 第三轮：`shell/mods/index.js` 的 `installPackage`/`installGame`（CLI `install DIR [--game-dir DIR] [--overwrite]`、`mod.installGame` RPC、mod 卡一行）复用 `gamepath.js` 的发现；预检与 `export` 同一校验（errors 拦、`E000` 不拦），已有目录不加 `--overwrite` 拒绝；复制经 `.<Name>.installing-<stamp>` 暂存、按数量与大小复核后 rename 换入，旧目录先改名备份、失败回滚，从不会递归删自己没改过名的目录；`selftest/game.mjs` 18 条 |
| G12 无游戏内验证回路 | 第三轮：`gamepath.js` 的 `discoverPlayerLog`/`readLogTail`/`scanLogText`/`followPlayerLog`（LocalLow、`~/Library/Logs`、`.config/unity3d`，取深度 1–2 里最新的 `Player.log`），`mod.gameLog`/`mod.followGameLog`（CLI `log`、卡上一行）；只发新增字节、文件消失报 `gone` 不抛、轮转从零重读；注入时钟与 sleep，`selftest/game.mjs` 19 条 |

## 仍然成立（本轮逐条核实）

### A. 校验与知识库的可信度——"编辑器说 clean"还不能全信

| 条目 | 当日证据（2026-10-18 第三轮，行号已重钉） |
| --- | --- |
| G10 wiki 陷阱提示 | **收窄**：Spine 版本 4.2.43 已查（`validate.js:946-962`，随 G46）。仍无：FMOD `EventReference` 不可由 JSON 构造的提示、`GetTopic()`/`WasVisited()` 副作用提示（全 `shell/mods` 仅 `knowledge.json` 数据命中）、256×144 画布与 `initialTransform: -7.2` 的脚手架检查、Unity GUID 形状串的 lint（`guid` 零命中） |
| G5 残余：已提交 KB 内含乱码 | `knowledge.json` 的 `documentation` 字段仍带 `#region 闊抽…` 乱码（头部 `PlayDialogueWithVoice` 即一例）；乱码只在仓库回退路径出现——安装包已不含 KB（G30），首启派生的是 facts-only 干净版 |
| G8 残余：脚手架×校验无自洽测试 | `shell/mods/selftest/` 无 scaffold×validate 交叉检查（grep 0 命中）：模板改动不会被"自己生成的包自己过不了校验"拦住 |
| G37 残余：生成器两条自伤路径 | `--out` 仍可把富 KB 覆盖成 facts-only 版（`gen_knowledge.mjs:319-324`，无守卫）；显式目录失效时不回退环境变量/探测，直接报"未找到"（`gamepath.js:176-182`，当前为有意设计，但报错文案不提示"回退被显式设置关闭"） |

### B. 文件、文本与像素

| 条目 | 当日证据（2026-10-18 第二轮） |
| --- | --- |
| G2 音频不能试听 | `shell/web` 全树无 `new Audio`/`<audio>`/`AudioContext`/`.play()` 命中（0 处）。引用体检半条已随 G21 关闭，试听这半条仍在 |
| G14 残余：mod 层仍是另一套读语义 | 卡片层已统一走 `cards/blob.mjs`；`shell/mods/*` 仍直接用 `node:fs` 读文件，大小上限/二进制判定与 RPC 层各说各话。`revision: 0` 盲写仍是规范行为（`docs/PROTOCOL.md`） |
| G20 像素格式窄、保存改写格式 | `pixelpng.mjs:280-286` 仍只读 8-bit、色型 6/2、无隔行；`pixelpng.mjs:693` 保存恒写 RGBA——RGB 精灵存回去字节全变 |
| G38 示例包教了它不检测的课 | **收窄**：`lock` 列表头已查（`validate.js:1008-1020` D010），写回时重算（G40）。仍在：`examples/Mods/Lantern/Yarn/Lantern.csv` 的 `file` 列锚在仓库路径 `examples/Mods/Lantern/Yarn/Lantern.yarn`（装进游戏即错），`lock` 值与源行哈希的一致性仍不校验 |
| G15 编辑器内零帮助入口 | **证据更新**：`shell/` 不再是 0 命中——`support.js:7` 与 `support.json` 引了 wiki URL 作**数据来源注释**，但没有任何一处把链接渲染给用户；docs 卡内容仍只来自 KB。条目本身成立，旧证明行作废 |

### C. 浏览器层：功能都在，路不通

| 条目 | 当日证据（2026-10-18 第三轮，行号已按 `cards/` 拆分重钉） |
| --- | --- |
| G16 诊断点不到位置 | `card-problems.mjs:45,61` 点击仍只 `app.openFile(path)`；`main.mjs:1434` 的 `openFile` 仍只认 `options.at`（世界坐标，`:1451`），无行号/Pointer 参数——诊断算出的 JSON Pointer 仍只是打印在行尾 |
| G17 校验结果不回流 | `card-mod.mjs:655-676`：`validate()` 仍把整个 report 压成一行状态 + 一条日志，不建/不聚焦 problems 卡、不留可点清单 |
| G18 docs 卡看不到本包定义 | `card-docs.mjs:34,56,78,91`：`mod.docFor`/`mod.search`/`mod.stats`/`mod.types` 仍全部不带 root，卡片仍无包路径输入 |
| G19 残余：watch 只盯 editor 卡 | `main.mjs:2502-2508` `watchedPaths()` 仍 `handle.kind !== "editor"` 就跳过——story/pixel/mod/problems/docs 卡外部改动不刷新（mod 视图可达性半条已关闭，见已关闭表） |

### D. 全流程断点与产品

| 条目 | 当日证据（2026-10-18 第三轮，行号已重钉） |
| --- | --- |
| G44 残余：KB/游戏目录来源无动词 | 启动日志报 KB 状态、`config.get`/`config.set` 在（`main.mjs:790,794`），但 `gameModsInfo` 仍无动词暴露（`main.mjs` 仅 `:452` 一处内部使用 knowledgeState） |
| G34 新建模组失败路径 | `electron/newmod.js` 仍无 `overwrite` 命中（旧档 F1–F5 未见修复） |
| G49 agent 界面 | `cards/` 13 种卡无 agent；`shell/ai` 仍只是地基（provider/config/tools） |

### 已决策关闭

- **G28/G32 名称**：保留 OsanaKami IDE Studio。裁定理由：产品的问题集合对这一款游戏是特异的，不需要为"改嫁其他游戏"预留距离；实测无混淆。
- **G24 "0 网络"**：已决策不继承上游约束，`shell/ai` 已落地。

## 建议队列（第三轮，按"作者被卡住的频率 × 修复成本"排序）

第三轮关掉的 G7/G6/G9/G11/G12 已从队列移除：校验器不再对"表里有没有这一行"沉默，包也能装进游戏并读回日志。剩下的"改 → 验 → 定位"环，卡在浏览器层这三条上：

第一批（低成本、高频、互相咬合——三条是同一个动作的三个面）：

1. **G16 诊断定位到行**：`openFile` 加 `line`/`pointer` 参数，problems 卡把已算出的 JSON Pointer 传过去。架构上"诊断指向具体东西"早已被 D006 证明成立，只是没推广。
2. **G17 校验结果回流**：mod 卡 `validate()` 出诊断时建/聚焦 problems 卡（复用 `mod.validate` 的 report，不用重跑）。与 G16 合并做最省：回流过去的清单每一行都可点到行。
3. **G19 残余 watch**：`watchedPaths()` 放开 story/pixel/mod 等带 path 的 handle。这三条做完，"改 → 验 → 定位"环就闭了。

第二替补：**G18** docs 卡带 root（`mod.search`/`docFor` 加包路径参数，顺手关掉 G44 残余的 `gameModsInfo` 动词——同一层）；**G10** 残余陷阱 lint（FMOD/GUID/副作用函数，都是 `validate.js` 里各加一条的事）。**G34**（Electron 新建模组失败路径）与 **G49**（agent 界面，依赖 G44 完全关闭 + 先决定形态）排在这批之后。G9 的残余（Addressables 窗口里登记了哪些 address）没有本地数据源，只能等游戏侧暴露清单，暂不排期。上游 0.4.2 的 port 层硬化（junction 逃逸、revision 0 二义、原子写）建议作为并行技术轨同步。
