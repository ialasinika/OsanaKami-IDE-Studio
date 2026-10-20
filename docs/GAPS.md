# 缺口清单（2026-10-20 第六轮：G18/G44/G34 已关；第五轮 A/B 清账与冒烟轮并入）

本文取代 `docs/EDITOR_GAPS.md` 的**待办职能**——旧档三轮追加后已超过 1200 行，作为审计档案保留（证据价值仍在），不再追加。本文只收录**当前工作树里核实仍然成立的缺口**，每条给出核实方式；"已关闭"只认代码证据，不认旧文档的说法。

快照：第三轮 HEAD = `89759b9`（第三轮改动提交后即以该提交为准；第四轮见下一段）。第一轮（`df08eea` 落文，`f7b6c84` 快照）关了 G3/G21/G46/G4/G39/G22/G13/G45/G40/G36 十条，但留下 13 条"未复核"；第二轮（`89759b9` 快照）把那 13 条逐条重跑，**未复核区清空**：G31/G5/G8/G14/G19/G37/G33 全部有了定论（多为关闭或大幅收窄），G2/G10/G16/G17/G18/G20/G38 核实仍然成立并重新钉了行号。第三轮关掉 G7/G6/G9（校验器可信度）与 G11/G12（闭环）：校验器现在读 schema 声明了却没人读的关键字、核对 Yarn `#line:` 与本地化表的双向一致、并对 Addressables 地址的写法提出警告；包能装进游戏自己的 Mods 目录，也能读/跟随 `Player.log`。**第二轮钉的行号因本轮 `shell/mods/validate.js`（+431）、`shell/mods/index.js`（+323）、`shell/main.mjs`（+212）、`shell/web/cards/card-mod.mjs`（+138）的增行而漂移，本轮已按当天树重钉；已关闭行保留原提交编号，不追行号。**

第四轮（2026-10-20，起点快照 `0c74d9b`，代码提交 `c416b01`）：`docs/gaps2.md` 是浏览器会话实测出来的三条（问题卡路径、像素卡后台打开、缩放锚点），复核全部成立；同一轮把 C 区排队的 G16/G17 一起关掉，并补了用户在整理文档时现场报的 G54（窄窗口 mod 卡分区收不起来）。问题卡改用 `mod.validate` 回传的解析后包根打开真实文件、编辑器新增可存活重渲染的 `reveal` 位置；像素卡在标签前移到可见时按测量到的画布重新取景，平移保留人的手势、缩放锚在光标下的像素；mod 卡分区可折叠且折叠状态记在卡文档上。**G51 的另一半（mods 根在 workspace 之外时内核拒绝读）不是 bug 而是内核 containment 的产品决策，单列为 G51-b 留在 B 区；G19 的 watch 残余在同一轮末尾关掉。**

第五轮（2026-10-20，起点快照 `66d3fb0`/`b37a47c`）：用户要求"解决 A 和 B"，A 区是校验与知识库的可信度、B 区是文件/文本/像素。B 区全清：录音能在窗口里试听（新的 `audio` 卡，`file.read_bytes` 的字节交给播放器，一张录音一张卡）；mod 层的文本读语义与内核同一套规则（`shell/mods/readtext.js`，套件从 `core/include/wksp.h` 解析上限防漂移）；已提交 KB 的乱码清零（文档 evidence 区按 ICU 码点逐条核对，生成器重跑，守卫测试）；`examples/Mods/Lantern` 的 `file` 列改为包相对路径，`lock` 由 `storycsv` 写入时重算；像素读写接受知识库声明的全部 PNG 色型/位深/隔行并在能证明时按原格式写回（`pixelpng.mjs`）；帮助卡把 wiki 链接、51 类型支持矩阵和命令列表渲染进窗口（`help` 卡，第十五种）。G51-b 内核侧关闭：`--read-root` 让 workspace 之外的 Mods 目录成为显式只读根。A 区见下表：G8 的脚手架×校验交叉测试、G10 的 FMOD 引用/`GetTopic` 陷阱 lint、G37 的两条生成器自伤路径各补一条守卫。

冒烟轮（2026-10-20 晚，第五轮之后）：把两个浏览器冒烟真正跑起来——此前"Edge 155 headless 坏"是误判，死因是 harness 拼 wrapper 时的页内脚本语法错误（Python 非 raw 字符串里的换行），修好后 `browser_smoke.py` 65/65、`input_smoke.py` 44/44 在本机真实 headless Edge 上全绿。冒烟抓到五处真实缺陷并已修：相对路径 `open README.md` 因把相对名当绝对路径与 workspace 根比较而被拒（新纯模块 `shell/web/openpath.mjs`，套件 1 条）；像素卡在 G52 改为居中取景后，冒烟仍按"画布左上即图像左上"点击，卡现在发布 `data-pan-x`/`data-pan-y`/`data-zoom`、冒烟按像素中心点击而不是在 Python 里重抄取景规则；示例包 `Audio_Lantern_Hum.json` 手写 `EventReference` 触发自己的 D019 两条（示例改为只写能诚实写的字段，`EditorNote` 说明引用必须来自游戏导出）；`D011` 行状态以路径开头、RGB 精灵按 G20 存回 RGB 两条断言过期；`audio`/`help` 已注册却不在 board 卡种表与冒烟清单里（面板点不开、冒烟点不到）。文档同轮更正：卡种数按实际注册数（十五种）与冒烟检查数（65 + 44）改齐。

第六轮（2026-10-20 晚）：用户按队列点名 18/44/34/49/内核硬化，按此顺序逐项独立提交。G18 本轮关闭：`mod.stats`/`mod.types`/`mod.search`/`mod.docFor` 接受可选包根、docs 卡新增包根输入与 `read this package`，没给 root 时所有返回形状不变（`selftest/spec.mjs` 11 条）。G44 本轮也关闭：`mod.sources` 把"KB/游戏目录从哪来"从启动日志里的一句话变成一个只读动词（`knowledgeState()` + `gameMods()` 在一帧里返回），CLI `sources [--json]` 与设置卡两行渲染同一答案，缺游戏目录或缺 KB 都是可回答的状态（`found: false` / `state: "missing"` 带 tried 列表），只有 mod 层加载失败才 exit 2。G34/G49 与 port 硬化按队列随后处理。G34 也在本轮关闭：`electron/newmod.js` 把 0.1.0 审计的 F1–F5 全部落到可测的原语上——越界父目录先问"改到 Mods 根下"（`confine()`）、二次创建带 `overwrite`（`shell/main.mjs` 的 `mod.scaffold` 转发该旗标）、POST 有截止时间（`createMod({timeoutMs})`，忽略 signal 的 fetch 也会超时）、设置写失败只是成功框里的一句备注（不再把已写好的包报成整体失败）、`?mod=` 打不开时页面继续 boot 并记 `cannot open <dir>: …`（不再变成 "kernel not reachable" 与重连风暴）。


## 已关闭（历轮累计，均有代码证据）

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
| G5 知识库不可再生/无版本 | **主体关闭**：生成器重写为 `shell/mods/knowledge-build.js` + 薄 CLI `tools/gen_knowledge.mjs`；KB 带 `version:1` 与 `generatedAt`（`knowledge.json` 头部）；首启自动派生见 G31。**乱码残余第五轮关闭**：`docs/*.md` 的 evidence 区按 ICU 码点逐条核对（21 段 `闊抽…`/U+FFFD 清零），KB 重生成，`selftest` 的文档守卫断言已提交 KB 的文本与文档一致且无替换字符 |
| G8 脚手架模板自伤 | **主体关闭**：`yarn.js:402` 把 `when` 收进节点元数据，`autoSubtitle`（`yarn.js:700-702`）用它造确定性 subtitle——`when:` 不再被丢掉。**残余第五轮关闭**：`selftest/scaffold-cross.mjs` 把四种模板各生成一个包再跑 `validatePackage`，模板改动过不了自己产物的校验就红 |
| G14 1.5 s 轮询不可调 | **主体关闭**：`WATCH_POLL_MS = 1500` 仍是默认（`watch.mjs:23`），但设置卡可在 250 ms–60 s 间调（`watch.mjs:33-34`，G48 的界面）；卡片层读路径已由 G39 统一走 blob。**mod 层读语义残余第五轮关闭**：`shell/mods/readtext.js` 统一目录/4 MiB/NUL/BOM 规则，`selftest/foundation.mjs` 从 `core/include/wksp.h` 解析上限并断言与内核一致 |
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
| G16 诊断点不到位置 | `c416b01`：`mod.validate` 的回复新增 `root`（解析后的绝对包根，诊断的 `path` 相对它），problems 卡用 `report.root` 拼出能读的绝对路径；点行调 `app.openFile(path, {line, pointer})`，编辑器落到该行/JSON Pointer 指向的位置。诊断外侧的 `pointer` 分支仍保留（无 `root` 的旧回复照旧打印），不再让指针只出现在行尾 |
| G17 校验结果不回流 | `c416b01`：`card-mod.mjs` 的 `validate()` 把 `report.diagnostics` 交给 problems 面板（`app.openProblemsCard(report, {root})`，各严重度分节、可点行），模块状态仍压一行；已有面板按 root 复用，不重跑校验 |
| G51 G51-a 问题卡行打不开 | `c416b01`：`card-problems.mjs` 用 `mod.validate` 回传的 `root` 拼绝对路径（原来拼的是用户输入的 `--mods-root` 字符串），`root` 缺失时才退回旧拼法；`tools/input_smoke.py` 改用真实存在的 D011 行（不再只点故意缺精灵的 D006），`shell/web/selftest/mods.mjs` 钉住根与行参数 |
| G52 像素卡后台打开不重绘 | `c416b01`：tile 在卡第一次可见时调 `handle.shown?.()`；`card-pixel.mjs` 的 `shown()` 按新测的画布尺寸重取景（未平移→居中），后台创建不再停 0×0；`shell/web/selftest/pixel.mjs` 5 条 |
| G53 缩放锚点错 | `c416b01`：`shell/web/pixelview.mjs` 纯几何 `place`/`zoomAt`：未平移时按测量面居中，平移后保留人的位置，wheel 以光标下像素为锚且 clamp 到图内，缩放范围 `0.25×–32×`（`selftest/pixel.mjs` 钉住） |
| G54 窄窗口分区收不起 | `c416b01`：`dom.mjs` 的 `section()` 支持可折叠标题；`card-mod.mjs` 分区折叠状态记在卡文档（`card.collapsed`，重渲染不丢），窄窗口下卡体滚动；`shell/web/selftest/cards.mjs` +1 条 |
| G2 音频不能试听 | 第五轮：`shell/web/audioinfo.mjs`（纯：扩展名→media type、大小与时长的人读写法、data URL、`Audio` 构造函数即用）；`cards/card-audio.mjs` 用 `file.read_bytes` 取字节（同一内核上限与 containment），同一路径复用同一张卡；`openFile` 把九种音频扩展名路由过去；`selftest/cards.mjs` 钉住 helper 与卡注册 |
| G20 像素格式窄、保存改写格式 | 第五轮：`shell/web/pixelpng.mjs` 读 PNG 全部合法色型/位深（1/2/4/8-bit 灰、RGB、调色板、灰+alpha、RGBA、16-bit）与 Adam7，逐块 CRC 校验；`planFormat` 能证明可逆时按源格式写回（RGB 精灵存回去仍是 RGB），不能证明时退回 RGBA8 并在注释里说明理由；`selftest/pixel.mjs` 11 条 |
| G15 编辑器内零帮助入口 | 第五轮：新 `help` 卡渲染 wiki 链接、`mod.stats` 新增的 `support` 字段（51 类型 × 4 档矩阵）与 `COMMAND_HELP`；命令 `help` 打开它，`selftest` 钉住卡注册与矩阵形状 |
| G38 示例包教了它不检测的课 | 第五轮：`examples/Mods/Lantern` 两张 CSV 的 `file` 列改为包相对 `Yarn/Lantern.yarn`（LF 保持）；`validate.js` 新增 `D023`：`lock` 必须是包内某行文本 `sha256(text)` 的前 4 字节（MyMod 11 表 × 18609 行实测 18609/18609 成立，译文表逐行沿用源行 hash；全零视为未锁定），改台词不重算 lock 会报 warning；`scaffold.js` 改写真 lock（原来是随机 hex），`selftest/spec.mjs` 4 条（合成包 ×2、全零跳过、语料零误报） |
| G51-b mods 根在 workspace 外时文件读不到 | 第五轮：内核新增 `--read-root`（`SDE_APP_MAX_READ_ROOTS = 8`，规范化、大小写折叠去重、必须是目录；`file.read`/`file.read_bytes`/`file.stat` 与 blob 来源共用同一组只读根），shell 的 `rpc`/`serve` 转发该参数；`tools/kernel_probe.py` 钉住"外围根可读、workspace 越界仍拒绝" |
| G10 wiki 陷阱提示 | 第五轮：`validate.js` 新增 D019（手写 `EventReference`，warning，路径指向 `#eventReference`，说明值必须由 Unity/FMOD 产生）、D020（Yarn 里调用 `GetTopic()`/`WasVisited()`，每个调用文件一条，跳过散文与注释）、D021（脚手架画布 256×144 与 `initialTransform: -7.2`）、D022（全零 GUID warning、8-4-4-4-12 或非法形状 info）；`selftest/traps.mjs` 逐条钉住（D019 三条 + 完整 `{Guid,Path}` 不误报、D020 三条、GUID 形状） |
| G37 KB 生成器两条自伤路径 | 第五轮：`tools/gen_knowledge.mjs` 的 `outOverwriteRefusal()`：`--out` 指向的已有文件如果带文档/命令签名（facts-only 没有的数据）默认拒绝覆盖并 exit 2，`--force` 才允许；`selftest/knowledge-facts.mjs` 造一份富 KB 当靶子。显式 `schema-dir`/`defines-dir` 失效时 `knowledge-build.js` 在错误上带 `explicit` 标记，文案说明"回退被显式设置关闭" |
| G19 残余：watch 只盯 editor 卡 | 第四轮：`watch.mjs` 新增 `watchTarget()`（带 `path` 且带 `reload()` 的 handle 才入轮询，按规范斜杠取路径）与 `watchStateOf()`（getter 和方法两种读法归一）；`main.mjs` 的 `watchedPaths()`/`applyFileChange()`/`groupKnown()` 改为按这套接口收卡。story/pixel/rig 卡补 `reload()`/`onFileChanged()`/`onFileGone()`（rig 另补 `path` getter、沿用 `revision()`/`dirty()` 方法）；干净卡自动重读、脏卡只提示，`selftest/main.mjs` 钉住两种读法与"无 reload 的卡不进轮询" |
| G44 残余：KB/游戏目录来源无动词 | 第六轮：`shell/main.mjs` 新增 `mod.sources`（`{knowledge: knowledgeState(), game: gameMods()}`）与 CLI `sources [--json]`（0 作答、2 只在 mod 层加载失败）；设置卡在路径区下渲染 `describeSources()` 两行（game mods 带 source/tried 数，knowledge base 带 state/source/schemas 与 load/derive 错误）；`selftest/dispatch.mjs` 钉转发、`selftest/cli.mjs` 3 条钉命令、`selftest/cards.mjs` 钉文案两种形态 |
| G18 docs 卡看不到本包定义 | 第五轮后：`mod.stats`/`mod.types`/`mod.search`/`mod.docFor` 都接受可选 `root`——`stats` 多回 `package {root, name, summary, types}`，`types` 每型多 `packageCount`（KB 不认识的类型也列出），`search` 在 KB 命中之后追加该包的 `define`/`node`/`file` 命中，`docFor` 能返回包内定义原文、节点所在的 Yarn 文件或整份文件文本；不带 root 时形状与以前完全一样。docs 卡新增包根输入与 `read this package`，列表显示包名/各类型数量、搜索覆盖包内容（`selftest/spec.mjs` 11 条钉住有无 root 两种形状） |

| G34 新建模组失败路径（旧档 F1–F5） | 第六轮：`electron/newmod.js` 新增 `writableRoot()`/`confine()`（越界父目录先问再改到 Mods 根下，不再把原始 `EOUTSIDE` 抛给用户）、`needsOverwrite()` 与 `createMod({overwrite})`（二次创建可修复自己写了一半的包，`shell/main.mjs` 的 `mod.scaffold` 转发旗标）、`createMod({timeoutMs})` 以 `Promise.race` 兜底（fetch 忽略 signal 也会以 `TimeoutError` 结束）；`electron/main.js` 把"记住文件夹"从创建里拆出（失败只记 log 与成功框备注），`?mod=` 打开失败由 `shell/web/main.mjs` 自己 catch 并 log（boot 继续、状态保持 ready）。验证：`selftest/dispatch.mjs` 7 条原语检查 + 2 条真实端点（二次被拒、`overwrite` 修复），`tools/browser_smoke.py` 新增 D5（缺目录的 `?mod=` 仍 `kernel ready` 且日志可见） |

## 仍然成立（本轮逐条核实）

### A. 校验与知识库的可信度（第五轮全清）

第五轮把 A 区四条全部关掉：G5 已提交 KB 的乱码（文档 evidence 区按 ICU 码点逐条核对、KB 重生成、守卫测试）；G8 脚手架×校验交叉测试（`selftest/scaffold-cross.mjs`：四种模板各生成一个包再跑 `validatePackage`）；G10 剩下的 wiki 陷阱（`validate.js` 的 D019 手写 `EventReference`、D020 `GetTopic()`/`WasVisited()`、D021 脚手架画布/`initialTransform`、D022 GUID 形状，`selftest/traps.mjs` 逐条钉住）；G37 两条生成器自伤路径（`tools/gen_knowledge.mjs` 的 `outOverwriteRefusal` 覆盖守卫 + `--force`、`knowledge-build.js` 的显式目录失败带 `explicit` 标记并说明回退已关闭）。

### B. 文件、文本与像素（第五轮全清）

第五轮把 B 区六条全部关掉，证据在上表：G2 音频试听（`audio` 卡）、G14 mod 层读语义（`readtext.js`）、G15 帮助入口（`help` 卡）、G20 像素格式（`pixelpng.mjs` 读写）、G38 示例包 `file` 列 + `D023` lock 校验 + 脚手架真实 lock、G51-b 内核只读根（`--read-root`）。

### C. 浏览器层：功能都在，路不通（G16/G17/G18/G19 已关闭）

第五轮后 C 区清空：G16/G17/G19 在第四轮关闭，G18 的 docs 卡按包根读本包定义也在本轮关掉（见上表）。浏览器层剩下的都是上游 port 硬化那类底层问题，不再是"路不通"。

### D. 全流程断点与产品

| 条目 | 当日证据（2026-10-18 第三轮，行号已重钉） |
| --- | --- |
| G49 agent 界面 | `cards/` 十五种卡仍未注册 agent；`shell/ai` 仍只是地基（provider/config/tools） |

### 已决策关闭

- **G28/G32 名称**：保留 OsanaKami IDE Studio。裁定理由：产品的问题集合对这一款游戏是特异的，不需要为"改嫁其他游戏"预留距离；实测无混淆。
- **G24 "0 网络"**：已决策不继承上游约束，`shell/ai` 已落地。

## 建议队列（第六轮后，按"作者被卡住的频率 × 修复成本"排序）

第五轮（起点 `66d3fb0`/`b37a47c`）把 A 区（G5/G8/G10/G37）与 B 区（G2/G14/G15/G20/G38/G51-b）清空：录音可试听、mod 层读语义与内核同规则、帮助卡渲染 wiki 与类型矩阵、像素按原格式读写、示例包 `file` 列改包相对且 `D023` 按真实 lock 校验（脚手架也改写真实 lock）、内核显式只读根；校验器补上手写 `EventReference`/`GetTopic`/GUID/脚手架画布的陷阱 lint，生成器不再能用 `--out` 静默覆盖富 KB，脚手架模板有了"自己生成的包自己过校验"的交叉测试，已提交 KB 的乱码清零。第六轮继续关掉 G18（docs 卡按包根读本包定义）、G44（KB/游戏目录来源成为 `mod.sources` 动词）、G34（新建模组五条失败路径）。仍开：

第一批：

1. **G49** agent 界面：`cards/` 十五种卡仍未注册 agent；`shell/ai` 仍只是地基（G44 已关闭，形态可以先定）。

其余：**G9 残余**（Addressables 窗口里登记了哪些 address）无本地数据源，等游戏侧暴露清单。上游 0.4.2 的 port 层硬化（junction 逃逸、revision 0 二义、原子写）仍建议作为并行技术轨。
