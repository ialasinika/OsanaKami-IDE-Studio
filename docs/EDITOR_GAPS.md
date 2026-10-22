# 编辑器缺口分析

> **已封存（2026-10-18）**：本文档是第 1–3 轮审计的档案，证据价值仍在，但**待办职能已由 [`GAPS.md`](GAPS.md) 接管**——那里只收录当日核实仍然成立的缺口。本文不再追加。

对着三样东西看这个编辑器：**游戏真实的 Mod 语料**、**官方 wiki**、**群里实际的工作方式**。

- 快照时间：2026-10-16（本轮只读，未修改任何代码）。
- 代码快照 = `HEAD` + 当时未提交的改动（`shell/web/cards.mjs`、`board.mjs`、`main.mjs`、`selftest.mjs`、`style.css`、`CHANGELOG.md` 已改；`shell/web/pixelpng.mjs`、`shell/web/pixelreview-zz.mjs` 未跟踪）。审计期间工作区另有写入者活动，见第 8 节。
- 语料 = `knowledge.json` 自己记录的 `gameModsDir`：`<workspace>\ModsFull\Mods`（3 个 Mod、3359 个文件、77.4 MB）。

已经写在别处的缺口（本仓库自己的 `docs/PARADIGM.md:262`、`docs/SURFACES.md:167`、`docs/FORK.md:351`、`docs/BUGS.md:378`）不重复展开，只在第 5 节列索引。本文只写**还没被记下来、或记下来但没意识到严重性**的问题。

---

## 0. 一句话结论

编辑器把"**文件在不在、JSON 合不合 schema**"做到了同类工具的上面，但 mod 作者真正会踩的坑集中在另外三件事上：**游戏自带的翻译表它根本打不开**、**音频它既不能听也不校验**、**"游戏会不会真的认这个定义"它一概不知道**（wiki 明确列了一批 Mod 不支持的类型，而编辑器的知识库里 51 个类型照单全收）。再加上知识库无法再生、内含乱码，编辑器会把一个"验证通过"的包交给作者，而游戏那边可能什么都不发生。

| # | 问题 | 严重度 | 一句话影响 |
| --- | --- | --- | --- |
| G1 | 游戏自带 11 张语言表全部 > 4 MiB，在`story`卡里打不开（`file.read` 1003） | P0 | 本地化——群里最主要的工作量——在编辑器里做不了 |
| G2 | 音频零支持：不能播放、不能试听、路径从不校验 | P0 | 配音/歌曲 Mod（语料里 6 个 wav）只能靠耳朵在游戏里试 |
| G3 | 与内置定义、其它 Mod 的 `techName` 冲突完全不查 | P0 | 编辑器说 clean，游戏静默丢弃这份定义（wiki：重复保留第一个） |
| G4 | 编辑器的"类型支持面"≠游戏的"Mod 支持面"，"注册≠生效"不可见 | P0 | 作者花几天做的内容，游戏里永不出现 |
| G5 | 知识库不可再生、无版本、内含乱码 | P0 | 编辑器会把乱码和过时信息当成权威教给作者 |
| G6 | 校验器只认 5 个 schema 关键字；无 KB 时静默降级 | P1 | `ok: true` 可能只意味着"什么都没检查" |
| G7 | 校验器不解析 `#line:`，CSV 与 Yarn 靠行数互相印证 | P1 | 改了行 id / 删了行，翻译静默失效 |
| G8 | 脚手架生成的模板字段自己校验不了；脚手架不自洽 | P1 | 模板带 `when:`，解析器把它丢掉 |
| G9 | 只有 sprite 字段查文件存在性；Prefab / Addressables 地址不查 | P1 | 角色 Mod 最经典的"缺地址 → null ref"发现不了 |
| G10 | wiki 已经写明的 5 个陷阱，编辑器一条都没有 | P1 | FMOD EventReference、公共字段 TechName、`GetTopic()` 副作用…… |
| G11–G15 | 无安装/打包/发布、无游戏内验证回路、无 headless CLI、1.5 s 轮询与两条读路径、无 wiki 链接 | P2 | 工具链断在最后一公里，只能人肉补 |
| G16–G20 | 浏览器层：诊断点得到文件、点不到位置；校验结果不回流；包卡数得出 csv/精灵却不给看；docs 卡看不到本包定义；幼神自家的卡在 mod 视图里排不了、也不被 watch | P2 | 功能都在，路不通——每一次校验/定位都要人肉补一步 |
| G21 | 音频：`#vo:` 与文件型音频引用**零校验**（官方演示包 6 个 wav 全丢也是 `ok: true`），而"音频编辑器"并不是缺口 | P0 | 缺的是**引用体检**，不是波形编辑；DAW 明确不做（续 G2） |
| G22 | 立绘（Spine 分层角色）：`spineAssetPath` **从不校验**、256×144/命名规范/情绪 Skin 无人查；生成图片有两条本机可跑的路：**默认 = 语料素材重组/程序化（纯 JS、无模型、无需 ComfyUI）**，可选 = 直调推理或 ComfyUI 客户端（第 9/10 节为过程，**第 11 节为最终决定**） | P1 | 新角色 Mod 最重的一步全靠人眼对 wiki；出图这半条链有官方公开的工作流文件，属于"可内嵌" |
| G23 | 生成立绘**不需要 ComfyUI、也不一定需要模型**：语料里已有 35 个角色的 `{Body,Eyes,Mouth}/<表情>/*.png` 分层素材 + 53 个角色配色 | P1 | 默认路线改为"素材重组/程序化"（纯 JS、秒级、天然分层），直接绕开"整图 vs 分层"的硬边界（第 11 节） |
| G24 | "0 网络"是**上游**承诺，不是本项目的限制；IDE 将来要支持**图像生成 / vibe code / 剧本** | P1 | 云 API 路线已可行（本机 Node 实测可出网）；但 vibe code 的第一块砖是知识库文档回填（G5），剧本的第一块砖是控制流与标签（G7）——三件事共用同一条前置链（第 12 节） |
| G25 | **卡片层正在退场**：默认视图已是 classic 瓦片，HUD 只切 classic/mod，board 被降级为 `mode`；11 种卡片里**只有 5 种**（`project`/`files`/`editor`/`mod`/`problems`）在可切换视图里有槽位，`story`/`pixel`/`docs`/`sheet`/`note`/`runner` 默认不可见 | P1 | 本文凡把落点写成"新 card kind"的建议（第 11–19 项、§11、§12）都要按**第 13 节**重挂：能力先落 Node 侧动词，视图只占已存在的槽位 |
| G26 | **分发物零游戏数据**（决定）：`knowledge.json` 与语料派生物不进安装包/仓库，改由用户本机从自己的游戏派生 | P0 | 让 CC BY-NC-SA 的 NC/SA 不适用（义务挂在"导出/分发"上）；代价是必须先补生成器 + 目录发现 + 缺失提示，否则校验静默退化（G6）——第 14.1 节 |
| G27 | 仓库与安装包**没有任何自带的可加载 Mod**；mod 层测试与教程都挂在游戏语料上（`shell/mods/selftest.mjs:103`） | P1 | 剃掉游戏数据后，"首次运行能演示什么"与"测试跑什么"同时落空——第 14.2 节 |
| G28 | 产品名 `InfantGod Studio` 含游戏名《幼神》，`publisherName` 也用它签安装包 | P1 | 商标/混淆与"暗示官方"风险；但法律暴露只集中在用户可见的那一层，必修面比 grep 计数小得多——第 14.3 节 |

---

| G29 | **画布退场后 6 种卡片在两种视图里都画不出来**：`classic`/`mod` 的标签页只收 `editor`，`story`/`pixel`/`docs`/`sheet`/`note`/`runner` 全部 `is-hidden`；空状态还提示 `note hello`，D006 行点开是建一张永远隐藏的像素卡 | P0 | 最近两个提交的主角在 UI 上不可达（第 15.1 节）——不是"没做"，是"点不到" |
| G30 | **"分发物零游戏数据"是承诺不是状态**：payload 审计把 `knowledge.json` 列进 allow-list 并写着 "must be empty before public distribution"，`--no-audit` 只警告照编，而发布候选正是这么编的；审计只扫文本标记，扫不到二进制素材 | P0 | 白名单清零才等于 G26 落地（第 15.2 节） |
| G31 | **本机派生 KB 缺接线**：目录发现（`shell/mods/gamepath.js`）与生成器（`tools/gen_knowledge.mjs`）都有，但没有调用点；缺 KB 时校验仍会静默退化 | P1 | 从"可再生"到"真再生"只差首启派生 + 缺失提示（第 15.3 节） |
| G32 | **改名只动了标识层**：`6673a89` 改到 OsanaKami IDE Studio 且免责声明已落地，但 OsanaKami 仍是《幼神》的日文读音；`appId` 变更后旧 `%APPDATA%` 设置需兼容读取 | P1 | 混淆降低但未消除；升级会"丢设置"（第 15.4 节） |
| G33 | **旧账盘点**：已关 G1 / G6 前半 / G7 部分 / G14 大幅 / G20 部分；仍开 G2·G21 / G3 / G16 / G17 / G18 / G20 残余 / G22 / G11–G13 | P1 | 每项都有复测行号（第 15.5–15.6 节） |
| G34 | **新建模组的失败路径**：越界（补救分支默认走不到）、重名（帧不带 overwrite）、设置写失败被判成整体失败、POST 无超时、`?mod=` 打开失败被误诊为内核断线 | P1 | 首次运行动作，失败看起来像"没反应"（第 16.1 节 F1–F5） |
| G35 | **`examples/` 原样进安装包**：带真实游戏台词（`hello.yarn:10`）和一张只能本机跑的开发卡（`board.json:40`），而全仓没有任何代码引用 `examples/` | P0 | G30 的具体实例；同时"示例"用户点不到（第 16.2 节 F8） |
| G36 | **安装/卸载的安全与版本**：`RMDir /r` 盲删 + 安装目录可改、无运行中检查、无原地升级、两条安装器管线写同一文件名 | P1 | 可能删掉用户目录；"安装成功"但树是混合的（第 16.2 节 F10–F12） |
| G37 | **KB 生成器会自伤**：`--check` 对已提交 KB 永不可能通过、`--out` 可把富 KB 覆盖成有损版、显式目录把 CWD 当游戏根、一个过期显式路径关掉全部回退 | P1 | "修 drift"这个动作本身会毁掉 KB（第 16.3 节 F15–F18） |
| G38 | **示例包教了两条它自己不检测的课**：CSV `file` 列锚在仓库路径、`lock` 列不校验；CLI 也仍无 mod 动词 | P2 | 示例装进游戏后自己就错了（第 16.4 节 F19–F20） |
| G39 | **4 MiB 边界只从"表"挪开，没从"文本"挪开**：blob 只接在故事卡的翻译表上；编辑器整文件读（`cards.mjs:2438`）与故事 `.yarn` 读（`:4167`）仍是 `file.read` | P1 | 11 张语言表能在表卡里开，不能在编辑器里开（第 17.2 节 N1） |
| G40 | **翻译循环只显示 + 只追加**：`translationOf` 读、`:4120` 只 append，`storycsv.setColumn` 仍无调用者；删掉 `#line:` 只留下孤儿行报告 | P1 | 故事卡"能编辑"只兑现了一半（N2） |
| G41 | **再生 KB 会静默关掉 sprite 检查**：生成器 `gen_knowledge.mjs:52` 剥 `description`，而校验器 `validate.js:77` 正是靠那段英文描述识别 25 个 sprite 字段 | P0 | 两条线各自"正确"，合起来是"全绿但没查"（N3） |
| G42 | **CSV 往返丢 BOM、把非 UTF-8 变成 U+FFFD 再写回**：`cards.mjs:1467` 的流式 `TextDecoder` 吃掉 BOM，`storycsv.mjs:183` 因此不再写 BOM | P1 | 保存会改写用户手里的表（N4） |
| G43 | **locale 搜索命中打开空白文档**：`search.js:454` 索引 locales，`docFor` 没有 `locale` 分支（`:815-829`） | P2 | 文档卡静默空白（N5） |
| G44 | **游戏目录/KB 来源不可见**：`gameModsInfo`/`knowledgeState` 已导出但不在 `MOD_METHODS`、也不进 `mod.open` 返回 | P1 | 与 G31/F18 同源，两次独立审计都命中（N6） |
| G45 | **没有导出/分发容器**：全仓无 zip/归档实现；mod 只能手拷文件夹再压缩转发，也没有"导出即过体检"的出口 | P2 | 群里的分发形态就是压缩包（18.4） |
| G46 | **格式体检缺失**：Spine 三件套与 4.2.43 版本、WAV 头、PNG 色型、CSV 的 BOM/行尾，全不检查（都在 `validate.js` 可做） | P2 | 与 G2/G9/G42 同族（18.3） |
| G47 | **"spine" 这个名字本身待复审**：卡片 kind、命令与四个模块直接用了 Esoteric Software 的注册商标名；卡片实际是"《幼神》立绘 rig 的查看/微调器"，不是 Spine 编辑器——名字在商标和语义两头都过度承诺 | P2 | 目前只在 CHANGELOG 的 Unreleased 段，改名窗口就是发布之前；一旦发布，`"kind":"spine"` 会进用户的 `board.json` 持久文档（§20） |
| G48 | **没有显式设置 UI**：README 自认 "no settings UI"；配置散在命令行参数（`--workspace`/`--mods-root`/`--no-open`）、`shell/ai/config.mjs`（userData 下的 JSON，带校验与密钥脱敏）和代码常量里（`BOOT_VIEW`、watch 1.5 s、4 MiB 上限）；这个 IDE 的最终用户是 mod 作者，不是 agent | P1 | 人改不了任何偏好 = 每个配置都要改代码或重启进程；`config.mjs` 已是现成的设置后端，缺的只是界面（§21.1） |
| G49 | **需要 agent 界面**：`shell/ai` 地基已落地（OpenAI 兼容 provider 含流式、config 脱敏、工具注册表——写工具故意没有），但"真正的对话循环、RPC 注册、diff 卡、UI 都在这一层之外"（`shell/ai/README.md`）；目标形态是三栏：会话列表 + 对话区 + 编辑/卡片区联动 | P1 | 与 AGENTS.md 非协商条款 4（"one document, two views……不要第三视图"）正面冲突，必须先决定形态再动手；它也是 G24（统一 AI 面）的 UI 落点（§21.2） |
| G50 | **没有"新建文件"**：命令表 23 条全部作用于已存在的东西（`open`/`story`/`pixel`/`mod`…），唯一沾边的是 `pixel <path.png> [w] [h]` 的可选宽高（新建画布，但只有命令行、无 UI）；`File → New Mod…` 是包级脚手架，不是文件级。作者想加一张 Yarn、一个 define、一张翻译表，只能去资源管理器徒手建空文件 | P1 | "+" 是 IDE 的第一手势；类型选择器恰好是 G4 支持矩阵与 schema 必填字段的天然展示位（§21.3） |

## 1. 这一轮是怎么得出这些结论的

1. **读代码**：`core/`（C89 内核）、`shell/mods/*`（Mod 层）、`shell/web/*`（卡片层）、`tools/`、`docs/` 全量；行号都在下文。
2. **读语料**：`ModsFull/Mods` 下 3 个真实 Mod（`Audio`、`MyMod`、`SODefines`）的扩展名、体积、时间分布；`shell/mods/knowledge.json` 的统计与文档字段。
3. **跑内核**（只读，`build/infantgod.exe rpc --root <workspace>`）拿真实错误码，而不是靠读代码猜（转录见 G1/G2）。
4. **抓 wiki**：`https://wiki.infantgod.xyz/` 172 个 URL 全量目录 + 结构/章节页 + SO 索引 + YarnCommands（82 条）/YarnFunctions（18 条）总览。
5. **两个输入源没抓到**，因此本文不对"接口需求"下任何结论：腾讯文档反馈表（`docs.qq.com/sheet/DZGtFY0xuY0xhcnpW`）是纯前端渲染 + 鉴权接口（`/dop-api/opendoc` → 401），只确认了文档存在；百度网盘歌曲分享需要提取码 + 验证码。沙箱内无出网 TLS（`schannel: SEC_E_NO_CREDENTIALS 0x8009030e`），需登录态浏览器才能取。详见第 7 节。
6. **未逐一渲染** wiki 全部 47 个 SO 详情页与 82 个命令详情页（页面级字段以已引用的为准，其余标 UNVERIFIED）；`node tools/e2e.py` 级别的测试**未在本轮重跑**；`shell/mods/*` 做过一轮逐函数审计，`shell/web/*` 的逐卡行为**本轮补做了一轮专项审计**（下文 G16–G20），审计钉在 `shell/web/cards.mjs` 的 5764 行版本上，SHA256 `96068F0049126ECC12F34F452CE9CD5C47E711C42A47585C6E20ED2F4E4BD798`。
7. **音频专项（第 2 轮，G21）**：分四路取证——wiki 音频相关 25 个 URL 逐个渲染（含两个 404）；`ModsFull/Mods` 全量扫描音频字段、wav 头、`#vo:` tag；对 `build/infantgod.exe rpc` 实测 4 MiB 与 `offset`/`limit`；再用编辑器自己的 `validate.js` 导出（`referenceMap`/`schemaSummary`/`validateModPackage`）核对"哪些字段真的会被查"。四处结论一致才写进本文；`Mods/Audio` 的 `ok: true` 是实跑结果，不是引用。
8. **立绘/美术专项（第 3 轮，G22 + 第 9 节）**：wiki 渲染 `d.美术`（8 分钟，含字段清单与命名规范）、`AI美术资产的处理`（2 分钟，ComfyUI 流程）、`g.角色与动画`（5 分钟，状态/皮肤/皮肤槽链路）、`添加一个新角色`（stub）、`sitemap.xml`（47 个 SO 页）；**并实读 wiki 公开附件 `PixelArt.json`**（UI 格式 v0.4、全部 core 节点、检查点 `SPixelartModel_v10.safetensors`，全文已解析）；语料侧统计 `ModsFull/Mods` 的 `.spine` 49 / `.aseprite` 38 / `.psd` 36 / PNG 1461、`SODefines/Spine/*.skel.bytes` 20+、`.atlas` 1（文本格式，已读）；并读 `Character` 定义的真实字段（`portrait`/`emailPortrait`/`spineAssetPath`/`targetSpinePrefab`，`Aistalt.json` 为例）。"哪些字段真的会被查"仍用编辑器自己的 `schemaSummary` 核对，不靠推断。

复现内核探针：

```powershell
$root = '<workspace>'
'{"jsonrpc":"2.0","id":1,"method":"file.read","params":{"path":"ModsFull/Mods/MyMod/Yarn/NewProject_EN.csv"}}' |
  & .\build\infantgod.exe rpc --root $root
```

---

## 2. P0：会让作者白干的问题

### G1 游戏自带的语言表，编辑器全都打不开（**已被并发提交 `5076afa` 修复**，见 §13.4）

内核单次读取上限 4 MiB，常量在 `core/include/wksp.h:24`（`SDE_WKSP_MAX_READ = 4u * 1024u * 1024u`），判定在 `core/src/wksp.c:487`：

```c
if (sde_port_file_size(abs) > (long) SDE_WKSP_MAX_READ) {
    set_err_path(err, errcap, "file is too large to open", rel);
```

这是**写进规范的行为**（`docs/PROTOCOL.md:224`、`:334`），不是 bug。问题是没人把它和语料对一遍——`MyMod/Yarn/` 下 11 张语言表（1 张基准 + 10 张语言）**全部超过 4 MiB**，第 12 个 CSV（行元数据，0.89 MB）列在最后作对照：

| 文件 | 大小 | `file.read` |
| --- | --- | --- |
| `NewProject_RU.csv` | 5.49 MB | 1003 `file is too large to open` |
| `NewProject_bg.csv` | 5.48 MB | 同上 |
| `NewProject_JA.csv` | 4.88 MB | 同上 |
| `NewProject_ko.csv` | 4.71 MB | 同上 |
| `NewProject_fr.csv` | 4.69 MB | 同上 |
| `NewProject_de.csv` | 4.65 MB | 同上 |
| `NewProject_esUS.csv` | 4.63 MB | 同上 |
| `NewProject_ptBR.csv` | 4.61 MB | 同上 |
| `NewProject_EN.csv` | 4.46 MB | 同上（4 677 787 B） |
| `NewProject.csv`（基准） | 4.31 MB | 同上 |
| `NewProject_zhTW.csv` | 4.29 MB | 同上 |
| `NewProject-metadata.csv` | 0.89 MB | 唯一能读的一张 |

现场转录（同一台机器、同一个二进制）：

```json
{"jsonrpc":"2.0","id":1,"error":{"code":1003,"name":"IO","message":"file is too large to open: ModsFull/Mods/MyMod/Yarn/NewProject_EN.csv"}}
{"jsonrpc":"2.0","id":2,"result":{"path":".../NewProject-metadata.csv","text":"id,file,node,lineNumber,metadata\nline:07c13ab,..."}}
{"jsonrpc":"2.0","id":6,"result":{"path":".../NewProject_EN.csv","exists":true,"dir":false,"size":4677787,"mtime":1791986738,"revision":0}}
```

**为什么这是 P0**：wiki 的整个 `nameKey`/`descKey` 体系和多语言工作都落在这堆 CSV 上，而这个编辑器唯一处理翻译表的卡片 `story` 恰恰用 RPC 读文件——`shell/web/cards.mjs:3981`（`loadTable`）、`:3956`（故事本体）、`:4007`（`.ysls.json`）。于是 `story Foo.yarn MyMod/Yarn/NewProject_EN.csv` 只能得到一行 `could not read ...`，翻译列退回 `no translation table`（`:3489`）。作者拿编辑器**做不了这个游戏里最大的一块翻译工作**。

**更值得注意的不对称**：Mod 层（`shell/mods/*`）用的是 Node 的 `fs.readFileSync`，完全绕过内核——`shell/mods/index.js:78/158/183`、`shell/mods/validate.js:462/787/918/969/1075`。所以同一个 4.5 MB 文件："`mod`卡片能扫、`problems`能查、`mod.localization`能统计（`:920-951`）"，但"`story`卡片打不开"。**两条读路径，两套上限与二进制语义**，这是架构级的不一致，不只是差一个数字。

**顺带**：`file.stat` 对大文件仍可用，但 `revision: 0`（`docs/PROTOCOL.md:270` 已记录）。`shell/web/watch.mjs:63` 的注释承认了这一点——"the kernel has no revision to give (binary, or too large to read)"。也就是说这 12 张语言表 + 所有图片/音频，**外部改动检测和乐观锁都退化成"没有版本"**，而 watch 本身还是 1.5 s 轮询（`docs/PARADIGM.md:269-274`）。

**建议**：给 `file.read`/`file.read_bytes` 加 `offset`/`limit` 分片（协议层面最容易；`view.load` 已有 `SDE_VIEW_MAX_READ` 同值上限，也应一并处理）；或把上限提到 8 MiB 并让卡片按需分块。至少要在 UI 上把"这个文件太大，编辑器打不开"变成一句明确的、带体积的提示，而不是普通读失败。**但要分成"跟上游"和"自己做"两类来做，见 G1b。**

### G1b 4 MiB：跟上游还是自己做（决策）

**结论：按"同一个请求，两边答案是否相同"这条线切三块。只有改既有动词语义的那块必须跟上游；能本地做的产品功能自己做，但不要本地调大常量。**

| 类别 | 内容 | 处置 | 为什么 |
| --- | --- | --- | --- |
| 语义面 | `file.read` / `file.read_bytes` 的行为 + `docs/PROTOCOL.md:224/:334` 的规范 | **跟上游** | 本地抬常量 = "同一个请求两种答案"（上游拒绝、我们接受）。这类分叉最难在 rebase 时发现，也最容易让两边客户端互不兼容 |
| 产品面 | G1 真正的诉求：`story` 卡打开 11 张 4.3–5.8 MB 语言表 | **自己做**，走 Node 侧大文件读 | Mod 层已经用 `fs.readFileSync` 读同一个文件（G1 的不对称），`story` 卡切到同一条路径即可，**零协议改动** |
| 扩展面 | 音频/像素的读字节（G2/G20/G21） | 同产品面；若真要碰内核，做成**新动词**（additive，如 `file.read_slice`），不改既有动词 | 新请求/新动词不产生"同请求两答案" |
| 写路径 | 长音频写回（`core/src/wksp.c:962` 同样是 4 MiB） | **等上游** | G21 已明确不做 DAW，抬写上限的收益 ≈ 0 |

**判断规则（建议写死）**：语义面（同一请求答案不同）→ 跟上游；新请求 / 新动词 / 本地产品功能 → 自己做。上游若只是"把常量调大"，我们要的是它的**决策与数值**，不是它的 diff：把新数值同步进 `docs/PROTOCOL.md` 后跟着走。

**"跟上游"的先决条件今天不成立**（三条都是本轮实测）：

1. `git remote -v` **为空**，`.git/config` 里根本没有 `[remote]` 段（只有 `[core]`/`[user]`），存在的只有一个本地 ref `refs/remotes/upstream/main`（`89d012d`，tag `v0.3.0-alpha.1`）——**现在 fetch 不到上游**。跟上游今天是一句意愿，落地要先加回 remote，并需要一个能出网/带凭证的环境。
2. 手上能看到的这个上游 ref 里，上限**仍然是 4 MiB**：`git show upstream/main:core/include/wksp.h` → `#define SDE_WKSP_MAX_READ (4u * 1024u * 1024u)`，`core/src/wksp.c` 里还是 `file is too large to open` / `file is too large to overwrite`。也就是说"上游在改"这件事**在当前 ref 里不可见**——这正是不能把本轮交付押在它上面的直接理由。
3. 分叉已经不小，而且两边都改了内核主体：**38 behind / 18 ahead**；历史被重写（本地 `bbe5099` 与上游 `c0cfd48` 同一句提交信息、不同 hash）；`core/` 双向合计 27 个文件 `+1228/−985`（其中上游单侧 17 个文件 `+618/−846`），`core/src/rpc.c`、`core/src/wksp.c`、`core/src/main.c` 与文档模型（`board`/`view`）都在里面。本地 `core/` 已有 5 个提交（含 `cca9f73` "kernel reads/writes bytes"）。→ **跟上游的真实形态是 rebase + 消解，不是 merge。**

**因此本轮建议的落地顺序**：

1. **现在（不依赖上游、不碰协议）**：`story` 卡改走 Node 侧大文件读（复用 `shell/mods` 的 `fs` 路径）；> 4 MiB 的文件在 UI 上给"文件太大（5.49 MB），编辑器打不开"这种**带体积的显式提示**。这是 G1 的最小可交付。
2. **同时（防尾巴）**：在 `docs/PROTOCOL.md` 把 `offset`/`limit` 标成 *upstream-pending*，并在 `core/include/wksp.h:24` 的两个常量旁加一条注释指向该条目，避免下一个人"顺手把常量调大"。
3. **上游 0.3.0 落地之后**：原样采纳上游的 `offset`/`limit`（或流式路由），删掉本地临时路径，不留第二套语义。
4. **若上游最终选的是"抬常量"**：跟着它的取舍，但本地保留一个可配置上限（默认跟上游，允许 `--max-read` 覆盖）——这是**实现细节**，不改协议语义。内存是线性的：4 MiB ≈ 28 MB 峰值，20 MB 文件 ≈ 140 MB 峰值再叠加 1.33× 的 base64。
5. **rebase 试跑**：放在独立 worktree / 临时 clone 里做，别动当前工作区（还有另一个写入者在改 `shell/web/*` 与 `CHANGELOG.md`）。

### G2 音频：不能听、不能试听、也从不校验

三件事叠加：

1. `file.read` 拒绝二进制：`1003 file is binary -- use file.read_bytes`（探针 id 3，真实 wav）。
2. `file.read_bytes` 受同一个 4 MiB 上限：语料里最大的音频 `Audio/Tech_Monologue.wav` = 5.31 MB（5 567 220 B）→ `1003 file is too large to open`（探针 id 4）。
3. **整个 shell 没有任何播放能力**：`AudioContext` / `new Audio` / `<audio>` / `decodeAudioData` 在 `shell/**` 零命中（唯一的 `http://` 命中是无关字符串和注释）。

而音频在这个游戏里是 Mod 的一等公民：wiki 有 `AudioEvent`、`VoiceOverDefinition`（`voiceOverFolder`/`voiceOverFiles`）、`Song.externalAudioFile`，命令里有 `PlayAudioEvent`、`UnlockSong`、`PlaySong`、`StopSong`；语料 `Mods/Audio/` 有 6 个 wav（含 5.31 MB 独白）。**作者唯一能做的事是启动游戏去听**——而 wiki 说了，游戏内测试要开 Demo、开 Mod、进【鲸鱼娘测试Mod】。

同时**音频引用从来不校验**：`validate.js` 的存在性检查只认描述等于 `Relative path to sprite image file` 的字段（`shell/mods/validate.js:77`，`RE_SPRITE_DESC`，共覆盖 25 个字段），`yarn.js` 里 `#vo` 也从不解析。所以 `Song.externalAudioFile` 写错、`voiceOverFiles` 少一个文件、`#vo` 指向不存在的资源，**全部 clean**。

**建议**：`#vo` 与文件型音频字段**先做存在性体检**（便宜、直接堵住静默失效），再谈**音频卡试听**（`docs/SURFACES.md:37` 已经把 `waveform` 卡当示例写了，但没有实现）；**"波形编辑 / DAW"不在范围内**。三层怎么分、为什么，见下面的 G21（本轮针对"要不要集成音频编辑器"专门补的）。

### G21 音频（续 G2）：语料说缺的不是"音频编辑器"，而是"引用体检"

问题原话是"也就是说还需要集成一个音频编辑器吗"。按语料回答：**不要做波形/DAW 类音频编辑器；要做的是"音频引用体检 + 短音频试听"，且前者远比后者值钱。**

**证据一：Mod 里的音频只有两种存在形态，都不是"作品"，没有可编辑面。**

- **FMOD 事件引用**：基线 117 个 `AudioEvent`（`ModsFull/Mods/SODefines/Defines/AudioEvent/*.json`）**每一个都同时带 `techName` + `TechName` + `eventReference` + `EventReference`**（如 `Aistalt_Voice` → `event:/Voice/Aistalt_Voice`）。wiki 明确写着 JSON 转换器**不能可靠构造 `EventReference`**，所以 Mod 侧只能**复用已有的 AudioEvent、不能新建事件**。事件这一层没东西可编。
- **外部文件引用**：`Song.externalAudioFile`、`VoiceOverDefinition.voiceOverFolder` + `voiceOverFiles[]`。全语料只有一个范例——官方 `Mods/Audio`（`mod.json` 里叫 "Audio Programmer Sound Demo"）：`Tech_Monologue.wav`（5 567 220 B，PCM，2 声道 / 44100 Hz / 16-bit / ≈31.6 s）挂在 `Defines/Song/Tech_Monologue.json`；`test_vo_1..5.wav`（各 265 254 B，1 声道 / 44100 Hz / 16-bit / ≈3.0 s）挂在 `Defines/VoiceOverDefinition/TestProgrammerVO.json`；**6 个 wav 全部放在包根目录**。而且它真正的教程是包里的 `README.txt`，不是 wiki："Add `#vo:TestProgrammerVO` to a Yarn dialogue line to use it."、"The FMOD events must contain a Programmer Instrument and must be included in the loaded banks."——**wiki 里没有对应的音频文件规范页**（格式/体积/目录约定全无）。
- **基线反向证据**：52 个基线 `Song` **全部** `externalAudioFile: ""`；4 个基线 `VoiceOverDefinition` **全部** `voiceOverFiles: []`。游戏本体一个外部音频文件都不用，全部走 FMOD。
- **全语料只有 6 个音频文件**（全部 `.wav`，全在 `Mods/Audio/`，共 6 893 490 B = 语料 81 209 899 B 的 **8.49%**；`.bank`/`.fsb` **零个**——也就是说非 Programmer 的声音都是游戏银行里的内容，Mod 只能"指"，不能"供"）。**能被读的恰好没人用、有人用的恰好读不了**：唯一有活引用的外部音频是 `Tech_Monologue.wav`（31.5 s / 5 567 220 B，`externalAudioFile`，且该 Song `isInitial: true`）——**正是编辑器读不了的那个**；而读得开的 5 个 3 s 语音（`test_vo_1..5.wav`）只被 `TestProgrammerVO` 引用，`#vo:TestProgrammerVO` 在 211 个 yarn 里出现 **0 次**（它只存在于 `Mods/Audio/README.txt:12`）。所以"音频试听"今天能服务的对象几乎不存在，而"引用体检"服务的对象很多。
- **社区真实做法**：211 个 yarn 文件里 `#vo:` 出现 **16 次**，全在 `MyMod` 的 `Masturbator_1`/`Masturbator_2_WeAsk`，引用的全是**游戏自带**的 4 个 VO（`Lick`/`Menbo`/`Tap`/`Xiko`，各 4 次），没有一条引用自制录音。群友要的不是"编辑音频"，是"**把台词挂到某个语音集合上、并确认它真的会响**"。

**证据二：编辑器在音频上的空洞全在"引用"层（5 条，都能复现）。**

1. **`#vo:` 编辑器完全不认识**：`shell/**` 全库 grep `#vo` 零命中；`story.mjs:134` 只认 `#line:`（`LINE_ID = /#line:([^\s#]+)/g`），`story.mjs:315/332/343` 只额外解析 `#state:`，其余只作为通用 `tags` 保存（`cards.mjs:3668` 只是不把它们当正文文本）。而 `#vo:` 是外部语音**唯一的开关**：写错 tag、指向不存在的 VO、VO 没有 `voiceOverFiles` 却指望出声——编辑器一律 `ok: true`。（语料里另外还有 `#Check:` 149、`#Topic:` 183、`#Modify:` 47、`#Idle:` 1 等 tag，同样一个都不校验。）
2. **文件型音频引用零校验**：`schemaSummary` 证明 `externalAudioFile` / `voiceOverFolder` / `voiceOverFiles` **既不在 D005 的 ref 表、也不在 D006 的 sprite 表**（`Song.refs = { album: "Album" }`、`Song.sprites = ["image"]`、`VoiceOverDefinition.sprites = []`）。我用官方演示包实测：`problems` 对它报 **`ok: true`**（唯一告警是 M002「mod.json 的 name 与文件夹名不一致」），而按验证器自己的字段分类，这 6 个 wav **没有任何代码路径会去看一眼**——也就是说 6 个文件全丢光，输出一个字都不会变。那个"外部音频演示包"即使坏掉，编辑器也还说它是好的。
3. **`AudioEvent` 的双命名怪癖无人解释**：`knowledge.json` 里 `AudioEvent.required = ["techName", "TechName"]`（`validate.js:24` 只用源码注释记了一句）。语料 117 个文件两个键都写，所以基线不报错；但**手写 AudioEvent 的作者必然吃 D001**，诊断只说"缺少 `TechName`"，没有任何地方解释这是双命名怪癖——这正是 wiki 第 10 条陷阱里"公共字段 TechName"那一类。
4. **对象型 FMOD 引用不在任何表里**：哪些音频字段会被查，取决于 schema 属性的 `description` 命中哪条正则——`flattenSchema()` 只认 `RE_TECH_REF`（描述里的 `TechName reference to …`）和 `RE_SPRITE_DESC`（`Relative path to sprite image file`，`validate.js:360-362`）。所以 `Character.mainAudioEvents[]`、`VoiceOverDefinition.mainAudioEvents[]`、`PixelAnimation.audioEvent`（描述为 "TechName reference to AudioEvent"）**是**受 D005 管的，语料里 23 个引用也确实全部命中；而对象型引用 `AudioEvent.eventReference`/`EventReference`、`Song.eventReference`、`Attachment.audioEvent`（21 个基线附件**全部**有值，且都是对象而不是字符串）**没有任何校验路径**。另外 `Song.album` 被声明为 ref → `Album`，但 **51 个 schema 里没有 `Album` 类型**（wiki 的 `SO/Album` 页也 404），D005 因此静默跳过（`validate.js:35` 的注释：只在目标类型确有基线时才判定错误）。
5. **音频文档基本是空的**：4 个音频命令里 3 个 `documentation` 为空（`PlayAudioEvent` 用法 6 次、`PlaySong` 14、`StopSong` 11），唯一非空的 `UnlockSong` 还是 C# `#region 歌曲系统命令`；`PlayDialogueWithVoice` 的文档是**乱码**（`#region 闊抽涓庡璇濈郴缁熷懡浠?`）且**已废弃**（wiki：方法还在，内部已无播放逻辑）。6 个音频查询函数（`IsSongUnlocked`/`GetCurrentSongTechName`/`IsAnySongPlaying`/`GetPlayListCount`/`IsPlayingDialogue`/`GetCurrentVoiceLanguage`）**全部无文档**，wiki 的兜底是 `表单` 页里的一行表格——而那张"可用的音效表"是**空表**。

**证据三：真做"播放器"，三个硬约束决定了它最多是"短音频试听"。**

- 唯一的字节通道是：内核整文件读取 → C 端 base64（`core/src/wksp.c:518`）→ JSON-RPC → 浏览器 `atob`（`cards.mjs:4921`）。像素卡（`cards.mjs:4917-5010` + `pixelpng.mjs` 手写 PNG 编解码）是唯一先例。
- **4 MiB 上限**在 size 检查处就生效（`core/include/wksp.h:24`、`core/src/wksp.c:487`）：265 254 B 的语音实测变成 353 672 个 base64 字符（1.3333×，固定开销 145 B），**读得开**；5 567 220 B 的 `Tech_Monologue.wav` 两个读动词都是 `{"code":1003,"name":"IO","message":"file is too large to open: …"}`。**没有任何 `offset`/`limit`**：我传 `offset:1000,limit:10` 到 `file.read`、`offset:44,limit:16` 到 `file.read_bytes`，两次都返回整文件，未知参数被静默忽略（只有 `file.list` 校验 `limit`，`core/src/rpc.c:165-190`）。静态路由只服务 `shell/web/**`（`shell/main.mjs:39`、`:682-699`；穿越 403 在 `:883-886`），**无 Range、无流式、无 audio MIME**。
- 依赖政策明确：`docs/ARCHITECTURE.md:27-28`、`README.md:162`、`shell/web/README.md:5`——根目录只有 devDependencies，**没有 `shell/package.json`**，所以不能引音频库，只能靠浏览器内建 `decodeAudioData` 或再手写一个 RIFF 解析。
- 后果：4 MiB 上限 ≈ 5.33 MiB base64；30 MiB 的曲子差 7.5 倍；4 MiB 处内核峰值约 28 MB。**3 秒级语音能试听，整首歌曲（≈31 s / 5.5 MB）今天读不出来**——除非先改内核。而且**写路径同样是 4 MiB**（`core/src/wksp.c:962`）：就算做出波形编辑，**超过 4 MiB 的 wav 也存不回去**，长音频编辑的收益接近零。

**建议（三层，连"不做"一起写清楚）**

- **必做（引用层，成本低、直接堵静默失效）**：① `#vo:<techName>` 进入 story/mod 的校验与补全——`techName` 必须能在基线或本包 `VoiceOverDefinition` 里找到，引用已废弃的 `PlayDialogueWithVoice` 时给提示；② D006 增加"文件型音频引用"分支，覆盖 `Song.externalAudioFile`、`VoiceOverDefinition.voiceOverFolder`/`voiceOverFiles[]`，**基准目录 = Mod 包根**（语料证据：wav 就在包根，不在 define 同级——我第一版脚本按 define 同级解析，6 个 wav 全部误报 MISS，改成包根后全部命中）；③ 修 `knowledge.json` 的音频文档：把 C# `#region` 头当解析失败而非文档、修掉乱码、补上 6 个查询函数与 `#vo:` 的说明；④ 在诊断文案里解释 `AudioEvent` 的 `techName`+`TechName` 双命名。
- **值得（中等成本、真省时间）**：一张 **audio 卡**——解析 RIFF **块链**后给出格式/采样率/声道/位深/时长（不需要解码；注意**不能假设 44 字节定长头**：语料 6 个 wav 每个都带 602 B 的 `bext`，`Tech_Monologue.wav` 还有 `fact`/`acid`/`iXML`/`_PMX`，`data` 块偏移只能走块链得到；6 个文件全是 44.1 kHz / 16-bit PCM，且**没有 `smpl`/`cue` 循环点**，所以第一版不用做循环标记），≤4 MiB 的文件加试听按钮（`file.read_bytes` → `decodeAudioData`），再加一张"本包音频体检表"（每个 VO 的 tag ↔ 文件、格式是否一致、是否超 4 MiB / 静音 / 削波）。**它替代不了游戏内试听，但能替掉"开 Audacity 看一眼格式"这一步**——不过按上面的语料事实，它的**现实价值偏低**：读得开的 5 个语音今天没有任何台词触发它们。
- **不做（建议写成明确的范围声明）**：多轨 / 混音 / 降噪 / 变调 / 编码导出这类 DAW 功能。三条理由：零依赖政策、4 MiB 读写上限、游戏侧只接受"复用 FMOD 事件"或"一个文件路径"两种形态——而 Audacity / FMOD 在这两件事上已经远强于我们，编辑器的差异化价值只在"**引用是否正确、能不能生效**"。
- **前置条件（将来真要支持长音频）**：先给内核加 `offset`/`limit`，或加一条带 Range 的原始字节路由。这是**内核改动**，不是音频编辑器的功能。

### G3 撞名 = 静默丢弃，而编辑器不查

wiki（[e.Mod结构与限制](https://wiki.infantgod.xyz/e.Mod结构与限制)）写得很清楚：重复的 `(类型 + TechName)` **保留第一个、忽略后者**，并特别提醒不要用重名去覆盖内置定义。编辑器的现状：

- `validate.js:891,929-931` 收集的 `techNames` 只用来喂 `D005` 的"引用目标集合"（`:445-475`），**从没有任何地方比较两个 techName 是否相等**——同类型不查，跨类型也不查。
- `D102`（`techName` 已在 baseline）只是 **info**（`validate.js:732`），在一堆 warning 里基本看不见，而它恰恰是"你的定义会被内置吞掉"的最高风险信号。
- 跨 Mod 只有 `loadOrder` 相等这一条（`M004`，`:852`），而且 `listInstalledMods` 在 `gameModsDir` 缺失/被移动时返回 `[]`（`index.js:790`，`DEFAULT_GAME_MODS_DIR` 硬编码在 `index.js:35-36`）→ **`M004` 静默失效**，作者得到一个"无冲突"的假结论。

**建议**：新增一个 D 码（例如 D103）做"新定义的 techName 是否已在 `baseline[type]` 或兄弟 Mod 中出现"，error/warning 分档；把 D102 从 info 提级；`gameModsDir` 不可用时把 `M004/M005` 的沉默改成显式 warning（"无法读取游戏 Mods 目录，跨 Mod 检查已跳过"）。

### G4 编辑器的类型支持面，比游戏的支持面大得多

wiki 把话说死了：**支持**新角色 / 角色状态 / 像素动画 / 邮件 / CG / 部分 VoiceOver / 部分 HexProtocol·HexModule / 剧情节点；**明确不支持** Achievement、Song/Album、Combat、弹幕与人气、NameTable、GoodsList·GoodsType、全部 Hardware 定义、Attr、InteractItem、Memory 辅助类型、News、Review、Situation、全部 Pet 资产、UITheme/FairyGUI。还有一句最要命的："**注册 ≠ 生效**"——只有 11 个 manager 真的会合并 `ModRegistry`。

编辑器的知识库是**从游戏类型系统倒出来的**：`knowledge.json` 51 个 schema / 1305 条基线定义，其中 `AchievementDefinition:14`、`Song:52`、`News:72`、`Goods:32`、`HardwareDefinition:1`、`Attr:7`、`InteractItem:52`、`Memory:188` 全在里面，而且 `mod.scaffold` 会照着它生成 `Defines/<Type>/…`（`shell/mods/scaffold.js`，模板含 `CutScene`、`Goods`、`Attr`、`Topic`）。==没有任何"这个类型 Mod 用不了"的白名单、提示或诊断==。作者完全可以按编辑器**一路绿灯**做一个 News/Song/Hardware 定义包，然后游戏里什么都没有。

同一类盲区还有 wiki 的 **10 步排查顺序**（被扫描 → `mod.json` 能解析 → Addressables catalog → 类型目录正确 → TechName 唯一 → `IsValid()` → 引用能解 → manager 消费 ModRegistry → Yarn 节点合并 → 内容真的被触发）。编辑器实际只能覆盖到第 5~6 步，**第 7 步之后（地址、Spine、manager、真实触发）完全不可见**——而那正是"游戏里没反应"最常见的所在。

**建议**：把 wiki 的支持矩阵做成知识库里的元数据（`type → supported | unsupported | partial`，附 wiki 链接），在打开/生成/校验时把不支持的类型报出来；知识库补一列"由哪个 manager 消费"，让"注册≠生效"变成可见状态。

### G5 知识库不可再生、无版本、还含乱码

`shell/mods/knowledge.json`（295 902 B，单行 JSON）自称：`version: 1`、`generatedAt: 2026-10-14T14:19:04.148Z`、`warnings: []`、`stats` 里 136 命令 / 63 函数 / 678 变量 / 1221 节点 / 51 schema / 1305 基线定义 / 11 语言 / 18 637 行 id。问题：

1. **没有任何再生成入口**：`tools/` 全树没有 `knowledge|generatedAt|ModsFull` 命中，RPC 方法表（`shell/main.mjs:469-505`）也没有 regenerate 动词；生成器在这个 checkout 之外（注释指向原 `app/core/api.js:308`）。游戏一更新，编辑器只能靠人手改 296 KB 单行 JSON。
2. **没有游戏版本/build id**：只有 `generatedAt`，无法判断"这份知识对应哪个游戏版本"（wiki 提到的 Demo 是 Steam app 4238140，Spine 有 4.2.43 这种硬约束）。
3. **绝对路径硬编码**：`index.js:35-36` 的 `DEFAULT_GAME_MODS_DIR`、`scaffold.js:738-739` 的 `SCHEMA_DIR`/`DEFINES_DIR` 都指向提取出来的游戏树；换机/换目录即失效。加上进程级缓存无 mtime 检查（`index.js:211-219,255-294`），改了知识库要重启。
4. **`warnings: []` 是假的，正文已经有乱码**：25 条非空 `documentation` 里有 **15 条是 GBK/UTF-8 误解码**，例如 `"#region 闊抽涓庡璇濈郴缁熷懡浠?"`（原文应为 `#region 音频与对话系统命令`）。`mod.docFor` 会把这些原文展示给作者。
5. **文档覆盖率**：136 条命令里可用的文档只有 **10 条**（25 条非空 − 15 条乱码），63 条函数里可用 **1 条**；51 个 schema **没有一个**有类型级说明，420 个属性里只有 **62 个**有描述；53 个角色条目里只有 1 个有 `displayName`（"吸血鬼"），其余 52 个是 `null`；136 条命令里 **51 条在语料中一次都没被用过**（`usage: 0`），所以连"抄一个例子"都做不到。

**建议**：把生成器搬进 `tools/`（哪怕只是一段"从游戏工程倒 JSON"的脚本 + 校验和），记录 game build id，加 `knowledge.stale` 诊断（生成时间 vs 仓库/游戏版本），乱码按源编码修一遍，`warnings` 真的写进去；模板里出现 `#region` 一律当解析失败处理。

---

## 3. P1：正确性与可信度

### G6 `ok: true` 可能只意味着"什么都没检查"

- 校验器只实现 `type` / `enum` / `required` / `properties` / `items` 五个关键字（`validate.js:591-663`），`pattern`、`minimum`/`maximum`、`minLength`、`uniqueItems`、`additionalProperties` 全部忽略，`oneOf`/`anyOf`/`allOf` 只被用来建 `$ref` 标题索引（`:269-271`），**从不校验**。schema 里写了约束但编辑器不查 → 作者以为过了。
- `validateModPackage` 在拿不到知识库时用 `{}` 顶替（`validate.js:768-769`），结果是每个类型一条 `M005` warning，而不是 `E000`。`E000` 只在单文件 `mod.validateDefine` 里发（`:679`）。
- 没有任何"未引用定义"检测：删了引用、留下孤儿定义，静默。
- Yarn 表达式（类型/运算符/插值）、`when:`/`tracking:`/`tags:` 取值、跨文件重复 `<<declare>>`、Yarn 与 CSV 的 `#state` 一致性，全部不查。

### G7 翻译表和 Yarn 之间没有一根线

`validate.js` **完全不解析 `#line:`**（只认节点标题的正则，`:78-79`）；`M008` 只比"CSV 行数是否一致"（`:1091-1100`）。CSV 的 `id` 值从头到尾没被读过、没和 Yarn 的 `#line:` 比过、没查过格式、也没查过全局唯一性（`Y107` 只管 Yarn 同文件重复，`yarn.js:839`）。

后果：把某行 `#line:` 改掉、或删掉一行，游戏里那就是"没翻译"的原文，而编辑器 **0 条诊断**。这也让 `storycsv.mjs` 里那套 `stale/untranslated/missing/orphan`（`docs/ARCHITECTURE.md:243` 描述得很清楚）只能靠手工对齐的文件才生效。

补一条浏览器层的观察（不是为校验器开脱，而是把现状说准）：两者之间**只剩一根线，而且是单向的**——`story` 卡点"+ line"时，`appendTableRow` 会把新 id 写成一行并置 `tableDirty`（`cards.mjs:3885-3898`），`saveTable` 再 `file.write` 回去（`cards.mjs:3925-3945`，由 `save()` 调用，`:4048`）。也就是说：**新增行会同时写 Yarn 和 CSV，删行/改 id/孤儿行则完全没人管**；`storycsv.mjs:128` 的 `setColumn`、`:263` 的 `metadataOf`、`:281` 的 `speakersOf` 都是导出但 UI 到不了的死代码，而 `cards.mjs:3975` 的注释还写着翻译表"kept read-only"——**注释已经过期**（代码是能写的）。

### G8 脚手架与自己的校验器/README 打架

- 脚手架生成 `when: always`（`scaffold.js:539`），而 Yarn 解析器把**除 `title`/`tags`/`subtitle`/`tracking` 之外的所有头部键丢进 `default: break;`**（`yarn.js:300`，注释原文："其它头部键（when/position/colorID ...）暂不建模"）→ 模板自带的字段，编辑器自己不校验，写错了永远是静默。
- `Sprites/README.md` 的说明写着"生成器不会写入任何二进制文件 / 目前生成器只产出文本文件"（`scaffold.js:988`、`:1013`），但 `:1254-1258` 真的在写占位 PNG——文档与实现矛盾。
- `scaffold.js:225` 的 `KNOWLEDGE_PATH` 指向 `shell/knowledge/knowledge.json`，**这个文件不存在** → 角色色板永远落在 7 个硬编码 `FALLBACK_CHARACTERS`（`:228-236`），而语料里有 52 个真实角色。
- 脚手架从不创建音频目录（全文没有 wav/voice 路径），也不在任何地方登记这个 Mod（`:16`、`:1291`）。

### G9 引用检查只覆盖 sprite

`D006` 只对 25 个 `icon/image/portrait/emailPortrait/sprite` 类字段做存在性检查。wiki 里角色/背景/CG/硬件最容易出事的是 **Addressables 地址与 Prefab**（"缺地址 → null ref"），编辑器对 `targetSpinePrefab`、`modelPrefab`、`cameraPrefab` 这类字段**一个都不查**，而且这些地址在工程里本来就没有文件可查——所以更需要"能解/不能解"的显式状态，而不是沉默。

### G10 wiki 已知的陷阱，编辑器一无所知

wiki 已经把坑写出来了，编辑器里没有任何一处（无 per-type 备注、无诊断、无卡片提示）：

| wiki 明写的陷阱 | 编辑器现状 |
| --- | --- |
| FMOD `EventReference` **不能**由 JSON 构造，只能复用已有 `AudioEvent` | 无提示；作者会照 schema 写一个地址然后静默失败 |
| TechName 抽取只认属性 `TechName` 或私有字段 `techName`，**公共字段类型可能注册失败**（`CutSceneDefinition`、`MemoryDefinition`、`QuestDefinition`、`AchievementDefinition`、`SpecialEffect`、`Result`、Pet 公共字段资产） | 知识库按类型照单全收，`M005` 之外没有"这个类型的技术名可能抽不到"的警告 |
| `GetTopic()` 内部会调用 `EndCombat()` | 无提示（这是会改状态的函数副作用） |
| `WasVisited()` 恒返回 `false`（占位实现） | 无提示；作者会以为它能用 |
| Spine 必须 4.2.43、画布 256×144、`initialTransform` 写 `-7.2` | 脚手架不检查、不提示 |
| 参考优先级 TechName → 相对资源路径 → Addressables 地址，**禁止 Unity GUID** | 无 lint（可以顺手查 `guid` 形状的串） |

---

## 4. P2：断掉的最后一公里

### G11 没有"放进游戏"，也没有"发出去"

内核没有 delete/rename/copy 之类的文件操作，`README.md:490` 直接承认把 Mod 目录拷进 `StreamingAssets/Mods/` 是**手工步骤**；`mod.scaffold` 只在工作区里造包（`scaffold.js:16`），不安装、不登记。编辑器的另一端也没有：**没有 zip/打包/发布动词**。而社区现实是——wiki 的[发布页](https://wiki.infantgod.xyz/h.Mod的发布)写着"暂留。现在创意工坊还没整出来呢"，群里靠网盘/群文件分发。也就是说：**每次分享都靠手抄目录 + 手动压缩**，这是编辑器最该吃掉的一段体力活。

### G12 没有游戏内验证回路

全树 grep `StreamingAssets|infantgod\.exe|steam://|LaunchGame` 只命中文档、构建脚本和 Electron 打包路径（`electron/README.md:79` 的 `modsRoot`、`:128` 的打包搬运），**没有任何"启动游戏 / 跟随日志 / 热重载 Mod"的能力**。而 wiki 的测试法是"开游戏 → 开启 Mod → 【鲸鱼娘测试Mod】→ 改 `Yarn/DeepSeekDemo.yarn` 立刻生效"。编辑器无法回答作者唯一想问的问题："我改的东西，游戏里到底生效了吗？"日志跟随（把游戏 `Player.log` 之类读进一张卡）可能是性价比最高的下一步。

### G13 没有 headless 校验 CLI

验证逻辑全在 `shell/mods/*`（Node），入口只有 GUI/`serve`；`tools/` 里没有 Mod 校验脚本。所以：群友互审一个包、CI 上防回归、批量扫 12 张语言表——都得先开界面。**一个 `infantgod validate <moddir> --json` 就能让群里的协作方式升级**（也能反过来给 wiki 的 10 步排查表提供第 5~6 步的自动化）。

### G14 时效性与两套读语义

- watch 是 1.5 s 轮询，且内核只对"自己写的"文件发 `file.changed`（`docs/PARADIGM.md:269-274`）→ 用别的编辑器改同一个文件，最坏 1.5 s 才被看到。
- 大文件/二进制 `revision: 0`（`docs/PROTOCOL.md:270` + `watch.mjs:63`）→ **这些文件的乐观锁是失效的**：别人（或另一个会话）改了，编辑器可能直接覆盖。
- Mod 层（Node `fs`）与卡片层（RPC）**读文件的两套语义**：大小上限、二进制/UTF-8 判定、NUL 处理都不同（G1 已述）。建议把"读文件"统一到一个薄封装，哪怕只是在 Mod 层复用同一套上限与错误文案。

### G15 知识发现性：编辑器里没有 wiki，docs 卡语义为空

- 全 shell 无 `wiki.infantgod.xyz`（或任何 `fantgod.xyz`）引用 → 编辑器内部**零帮助入口**，作者遇到不懂的还得回浏览器。
- `docs` 卡的内容完全来自 `knowledge.json`，也就是 G5 说的 10/136 命令文档、1/63 函数文档、62/420 属性描述；而 wiki 有 82 个命令页 + 18 个函数页 + 47 个 SO 页（虽然它自己也在施工中）。**把 wiki 的 URL 按名字挂到补全/文档卡上**是低成本、高感知收益的动作。

### G16 诊断点得到文件，点不到位置

`problems` 卡（`cards.mjs:5410-5522`）算出了诊断的 JSON Pointer（`diagWhere`，`:5186-5190`），也把它**打印**在行尾 meta 里（`:5442`），但点击时只把文件路径交给 `app.openFile`（`:5445`、`:5472`）；而 `app.openFile(path, options)` **只认 `options.at`（世界坐标）**，没有任何行号/Pointer 参数（`main.mjs:1252-1270`）。结果：一条 `mod.json` 或 define 里的错误，打开的就是那个文件的**第 1 行**，作者还得自己搜。唯一有"精确目标"的诊断是 D006：它会开一张 `pixel` 卡指向那张精灵（`:5447-5464`）——**这恰好证明"诊断能指向具体东西"在架构上早就成立，只是没推广**。

### G17 校验结果不回流，每换一个视角就要重来一遍

- `mod` 卡的 "validate" 把结果**全部丢成一行状态 + 一条日志**（`cards.mjs:5360-5406`）：不发诊断、不建/不聚焦 `problems` 卡、不留可点的清单。想细看错误只能自己再敲一次 `problems <dir>`（而 `problems` 卡自己也**没有**过滤、严重度开关、按文件分组、抑制/基线、导出、单行重跑——`:5413-5419`、`:5430-5470`）。
- `mod` 卡只列 Defines 与 Yarn（`:5276-5278`、`:5327-5354`），**它自己数出来的 `N csv · N sprites` 一行都不显示**（`:5313-5318`）：语言表和精灵文件只能绕去 `files`/`project` 卡找，音频更是完全没有（G2）。
- 卡片生命周期不一致：`mod` 是**单例**（第二次 `mod` 只改根目录，`main.mjs:1834-1851`），`problems`/`docs` 却**每次都新建一张卡**（`:1852-1857`、`:1859-1864`）→ 反复校验会把画板堆满同名卡，而"跟随 mod 根目录"的预期**并不是代码行为**。

### G18 `docs` 卡看不到"本包自己的定义"

`docs` 卡只从随编辑器发布的 `knowledge.json` 取数据：`mod.search`（`cards.mjs:5573`）、`mod.stats`（`:5595`）、`mod.types`（`:5608`）、`mod.docFor`（`:5551`）**全都不带 root/包路径**，卡片也没有这个输入框（它连 `app` 都没取，`:5527`，所以连文件都打不开）。于是"我这个包里的 `Goods_Folk` 定义要用哪些字段"这类**最该问编辑器的问题**，只能退化成在编辑器里看裸 JSON（包卡的 define 行点开就是 JSON 文本，`:5345`）。G15 说的"挂 wiki 链接"因此更值钱：**wiki 是唯一覆盖到包外知识的来源**。

### G19 幼神自家的卡片是二等公民：mod 视图排不了它们，也不 watch

- `mod` 视图的角色分配是硬编码的：侧栏只认 `mod`/`project`/`files`（`modview.mjs:26`），底部面板只认 `problems`（`:29`），标签页**只认 `editor` 卡**（`:78-83`），其余一律进 `roles.hidden`（`:92-97`）。所以 `story`、`pixel`、`sheet`、`docs`、甚至**第二张 `mod` 卡**，进 mod 模式后直接不可见。这行为被自测钉着（`selftest.mjs:2382`、`:2528-2530`），属于设计而非 bug——但结果就是：**幼神自己最骄傲的两张卡（Yarn 编辑、像素画）在主视图里消失**，作者要切回 board 才能用。
- `watchedPaths()` **跳过一切非 `editor` 卡**（`main.mjs:2232-2236`），所以 `story`/`pixel`/`mod`/`problems`/`docs` 卡都**不在轮询范围内**：用别的工具改了 `.yarn` 或 `.png`，这些卡不会刷新，只有关掉重开才看到新内容——而它们恰恰是"显示磁盘状态"的卡。

### G20 像素/精灵：能开的格式窄，保存会改写格式

- 打开：`decodePng` 只接受 8-bit、颜色类型 6(RGBA)/2(RGB)、compression 0、filter 0、interlace 0（`pixelpng.mjs:280-286`），**16-bit、调色板、灰度、隔行 PNG 全部拒绝**——而这类图在游戏素材里很常见（`unsupported` 抛错是像素层里唯一的显式拒绝，其余问题都以注释形式存在）。
- 保存：`encodePng` 永远写 8-bit RGBA、逐行 filter `none`（`pixelpng.mjs:651-652`、`:692-696`）→ **一个 RGB 精灵存回去就变成 RGBA，字节全变**。对 Mod 作者的实际后果：精灵一进版本库就是"整文件重写"，diff 里看不出真正改了哪几个像素；D006 提示的"尺寸不符"修复动作本身也会顺手改格式。
- 有一处做对了、值得保留：**解不出来的 PNG 会让保存被拒绝**（`cards.mjs:4978-4980`），不会把源文件覆盖掉。
- 没有任何路径把 `mod.json`/define 里的 sprite 引用连到 pixel 卡（唯一入口是 D006 一行诊断，`:5457`），所以"从包里点开这张图"目前是走不通的。

---

## 5. 已经自认的缺口（不要重复劳动）

| 已有记录 | 内容 |
| --- | --- |
| `docs/PARADIGM.md:262-292` | 无 minimap/多选、watch 是轮询、链接没人消费、无运行时插件系统、`sheet` 不是通用结构化编辑框架、highlight 的 UTF-16 口径 |
| `docs/SURFACES.md:167-183` | 卡片种类在加载期注册、无 schema/版本协商、无沙箱、`CARD_KINDS` 只是文档 |
| `docs/FORK.md:351+` | 原型"留在桌面上"的想法 |
| `docs/MODS.md:119-137` | 语料事实（11 种语言、`bg` 后缀映射为空从而与基准语言冲突等）——本文不再重复 |
| `docs/BUGS.md:378-395` | 两处"记录但不修"：无 `revision` 的 `view.save` 会盲写；两个探针与当前树不同步 |
| `docs/PROTOCOL.md:224/270/334` | 4 MiB 上限与 `revision: 0` 是**规范行为**——本文 G1 的诉求是"规范要改"，不是"实现有 bug" |

---

## 6. 建议的优先级（按"作者被卡住的频率 × 修复成本"）

| 顺序 | 动作 | 落点 | 为什么先做 |
| --- | --- | --- | --- |
| 1 | **先自己做**：`story` 卡改走 Node 侧大文件读 + >4 MiB 的显式体积提示；**不要本地抬常量**；`offset`/`limit` 走"上游待定"（G1b） | `shell/web/cards.mjs:3981`、`shell/mods/*` 的 fs 路径、`docs/PROTOCOL.md` | 直接解锁 12 张语言表 = 群里最大的一块工作，且不制造协议分叉（G1b） |
| 2 | 音频**引用体检**：`#vo:` 补全/校验 + `externalAudioFile`/`voiceOverFiles` 存在性 + 音频文档去乱码；随后才是 ≤4 MiB 的音频卡试听 | `shell/mods/validate.js`、`shell/mods/search.js`、`shell/web/story.mjs:134`、新 card kind（`docs/SURFACES.md:37`） | 现在音频是纯盲区；**波形/DAW 明确不做**（G21），因为它既受 4 MiB 读写上限、又和 Audacity 比没有优势 |
| 3 | 撞名检测（vs baseline + 兄弟 Mod）+ 提升 D102 + `gameModsDir` 缺失时显式 warning | `shell/mods/validate.js:732/891`、`index.js:790` | 把"编辑器说 clean、游戏静默丢弃"这条最坏的体验堵死 |
| 4 | 知识库加 `supported/unsupported/partial` + `manager` + wiki URL；把这些字段在打开包时报警 | `knowledge.json` + `shell/mods/*` | 拦住"做完了不生效" |
| 5 | 知识库再生成脚本进 `tools/` + game build id + 乱码修复 + `warnings` 说真话 | `tools/`、`knowledge.json` | 编辑器可信度的根 |
| 6 | CSV `id` ↔ Yarn `#line:` 双向核对（缺失/多余/重复/格式） | `shell/mods/validate.js`、`yarn.js` | 本地化静默失效的唯一解 |
| 7 | `infantgod validate <dir> --json`（headless） | `shell/main.mjs`、`tools/` | 群友互审 + CI + 批量扫表 |
| 8 | 一键安装到 `<游戏>/StreamingAssets/Mods` + 打包 zip | 内核加 copy（或用 shell 侧）、新动词 | 消灭"手抄目录" |
| 9 | 游戏日志跟随卡（只读 tail） | 新 card kind + `file.read` offset | 唯一能回答"游戏里生效了吗"的近似手段 |
| 10 | 文档卡/补全挂 wiki 链接；`#region` 当解析失败 | `shell/mods/search.js`、`knowledge.json` | 低成本、每天都被感知 |
| 11 | 诊断点击跳到行 / JSON Pointer：`openFile` 支持 `at` 之外的 `line`/`pointer`，`problems` 行传目标 | `shell/web/main.mjs:1252`、`shell/web/cards.mjs:5445` | 改动面极小，直接消灭"点开还要自己搜" |
| 12 | `problems` 卡：过滤 + 按文件分组 + 抑制基线 + 导出 + 从 `mod` 卡"交给 problems 卡" | `shell/web/cards.mjs:5413-5470`、`:5360-5406` | 校验结果目前用不了第二次 |
| 13 | `mod` 卡列 CSV/精灵/音频（可点开），`docs` 卡接受 root 看本包定义 | `shell/web/cards.mjs:5276-5354`、`:5551-5608` | 让"包里有什么"在一张卡里闭合 |
| 14 | **槽位扩展**：让 classic/mod 两个瓦片接纳 `story`/`pixel`（mod 视图的面板或标签页补一种角色；classic 的标签页目前只认 `editor`） | `shell/web/modview.mjs:26-29`、`shell/web/classic.mjs:23/69`、`shell/web/main.mjs:1985` | 自家两张主卡（`3906458` 故事卡、`dd5f1cd` 像素卡）在默认与可切换视图里凭空消失（G25/§13.2） |
| 15 | PNG 保存保持源格式（或至少显式警告会被改写）；支持灰度/调色板 8-bit | `shell/web/pixelpng.mjs:280-286`、`:692-696` | 精灵素材进版本库会被整文件重写 |
| 16 | **立绘接线体检**：`spineAssetPath` 存在性 + 画布/命名规范 + `#state:`/`CharacterState` 注册表核对；随后再做纯 PNG 的 Eyes×Mouth 预览（Spine 绑定不做；**出图见第 17 项**） | `shell/mods/validate.js`、`shell/mods/index.js`、新 card kind | 新角色 Mod 最重的一步今天全靠人眼对 wiki，且 `spineAssetPath` 写错是**静默**失效（G22） |
| 17 | **出图卡**（引擎无关，三种路线共用一套动词与门禁）：**默认 R1 = 语料素材重组/程序化**（`art.parts`/`art.compose`，纯 JS、天然分层、不需模型）；可选后端 R2 = 直调推理（diffusers/sd.cpp，需权重+GPU，见 11.3）或 ComfyUI（§10.6 冻结图）；后处理 + 规格检查通过后才允许写入 Mod | 新 card kind `art`、`shell/art/*`、`shell/main.mjs` 的 `art.*`、`shell/mods` 的 fs 路径 | 用户决定不用 ComfyUI（11 节）；R1 零依赖、本机可完整验收，且直接绕开"整图 vs 分层"（10.4）；引擎只决定"像素怎么来"，下游复用 |
| 18 | **质量指标 + `art.sweep` 实验矩阵**：网格对齐率 / 调色板偏离 / 边缘硬度 / 尺寸格式合规 / 分层可分离性，既当实验裁判又当 `art.save` 的门禁 | `shell/art/quality.mjs`、`art.sweep` 动词 | "质量"不量化就退化成审美；五个指标全用纯 JS 算、不需要 GPU，且与 G22 的规格检查同源 |
| 19 | **AI 面（第 12 节）**：`ai.env` / `ai.generate`（复用 `/events` 流式）/ `ai.repair`（吃 `mod.diagnose` 的 diagnostics）/ `ai.apply`（diff → 校验 → 带 `base_revision` 才写）/ `ai.sweep`；provider = OpenAI 兼容 HTTP（云端与本地同一协议，Node 内置 `fetch`，不加依赖）；key 只在 Node 侧（`--ai-config`），出网显式、可取消、可只发选中文件 | `shell/main.mjs` 的 `ai.*`、`shell/ai/*`、新 card kind、`--ai-config`（沿用 `shell/main.mjs:1031` 的 `takesValue`） | 用户决定不继承上游"0 网络"（G24）；加网络不违约的前提是**既有动词语义不变 + 离线仍可用**（G1b 的加法规则）；写入必须过门禁，否则 AI 会把不可信内容直接落盘 |
| 20 | **AI 的前置（不是体验优化）**：把 wiki 的 **82 个 YarnCommands + 18 个 YarnFunctions** 页回填 `knowledge.json`（顺带修 `#region` 乱码）+ 补 `mod.json` schema（wiki 未文档化，从 ModLoader 实现/示例反推）+ 补控制流（`if/jump/once/detour/wait/set/declare/return` 等 13 条无文档命令）与 4 类标签（`#Check:`/`#Topic:`/`#Modify:`/`#vo:`）模型 | `shell/mods/knowledge.json`、`tools/` 的再生成脚本、`shell/mods/yarn.js`、`shell/mods/validate.js` | 没有它，vibe code 只会发明不存在的命令、剧本卡也解释不了命令语义；与第 5/10 项同源，但这里是**功能前置**——第 12 节的三件事都排在这条链后面 |
| 21 | **分发物剃游戏数据**（G26）：`knowledge.json` 出包 + `tools/` 生成器 + 游戏目录发现 + KB 缺失显式提示；同时清掉 `scaffold.js:229-233` 的硬编码角色色板、`search.js:51-54` 的 15 个状态名，并把 `selftest*` 从 `extraResources` 里挪出去 | `package.json` 的 `files`/`extraResources`、`shell/mods/*`、新 `tools/` 生成器 | 发布的准入条件；**顺序上生成器必须先行**，否则删完就只剩"什么都没查"（G6） |
| 22 | **自带测试 Mod**（G27）：`examples/mods/DemoMod` + `DemoModBroken`（覆盖 G20/G21/G22 与全部诊断码），测试改以它为默认语料，`mod.scaffold` 以它作兜底模板 | `examples/mods/*`、`shell/mods/selftest.mjs`、`shell/mods/scaffold.js` | 剃数据之后唯一还留在包里的 Mod，同时是教程、回归夹具与"零游戏也能演示"的前提 |
| 23 | **名称与标识**（G28）：`productName`/`appId`/窗口标题/文档改用不含游戏名的名字（或保留 + 免责声明 + 问作者一次），`publisherName` 必须是真实签名主体 | `package.json`、`electron/main.js`、`README.md`、`EULA.txt` | 发布前最容易忽略、事后最贵的一项 |

> **落点重挂（第 13 节）**：上表第 11–19 项里凡把落点写成"新 card kind"的，一律按 §13.3 重读——**能力先落 Node 侧动词（`shell/mods/*`、`shell/art/*`、`shell/ai/*`、`shell/main.mjs` 的 RPC），视图只占槽位**；一个只在 `mode board` 可见的能力，等于随 board 一起消失。第 7 项（headless CLI）与第 11 项（诊断跳行）不受此影响，应当优先。

---

| 24 | **让 6 种卡在视图里可达**（G29）：标签页接受一切有 `file`/`title` 的卡，或给 mod 视图加"工具"面板 | `shell/web/classic.mjs:67-72`、`shell/web/modview.mjs:78-83`、两个视图的 selftest | 已实现的功能今天点不到，首次运行提示就会踩到 |
| 25 | **payload 白名单清零 + 禁 `--no-audit` 出包**（G30）：从安装包里去掉 `knowledge.json`，发布脚本断言审计真的跑过 | `tools/make-installer.mjs:248-256`、`:411-414`、`package.json` 的 dist 脚本、CI | G26 决定的执行面；否则"零游戏数据"只是注释 |
| 26 | **首启派生 KB**（G31）：生成器接线 + 游戏目录发现 + 缺失显式提示 + 状态目录 | `shell/mods/gamepath.js`、`tools/gen_knowledge.mjs`、`shell/mods/index.js:209-211` | 让 G26 可执行，同时解掉 G5 的过时问题 |
| 27 | **体检类旧账一轮清**（G33）：诊断跳行（G16）、problems 筛选/重跑（G17）、docs root（G18）、PNG 保格式（G20）、音频/spine/重名引用（G2/G3/G22） | `shell/web/cards.mjs`、`shell/web/pixelpng.mjs`、`shell/mods/validate.js` | 与 IDE 的核心卖点同源，且全是"静默失效"类 |
| 28 | **改名收尾**（G32）：旧 `%APPDATA%` 设置兼容读取 + 免责声明进安装许可页/关于框 + 问作者一次 | `electron/main.js`、`EULA.txt`、`README.md` | 已改名，不做兼容会有一次"丢设置"的升级事故 |
| 29 | **新建模组失败路径收口**（G34）：越界预检 + 帧带 overwrite + 成功优先于设置写 + POST 超时 + `?mod=` 失败单独归类 | `electron/main.js:418-482`、`electron/newmod.js:130`、`shell/web/main.mjs:2272/2352-2357` | 首次运行动作，最贵的失败是"看起来没反应" |
| 30 | **`examples/` 过滤或移出 payload**（G35）：`extraResources` 用 filter 只收演示 Mod，`hello.yarn`/`board.json` 换成自造内容或干脆不发 | `package.json:54-57`、`examples/hello.yarn:10`、`examples/board.json:40` | 法规面 P0，且示例本来就点不到 |
| 31 | **卸载安全 + 单管线**（G36）：`RMDir /r` 前校验归属标记、删 `%APPDATA%` 设置、升级前检查进程与版本、砍掉 `dist:nsis` 或改名 | `tools/installer.nsi:111/128-153/165`、`package.json:14/16` | 唯一能删用户数据的路径 |
| 32 | **KB 生成器护栏**（G37）：`--out` 拒绝覆盖 `DEFAULT_KB`、`--check` 与事实基线对齐、显式目录不给 CWD 兜底、显式路径失效继续回退 | `tools/gen_knowledge.mjs:49/671/707/737-743`、`shell/mods/gamepath.js:144-150` | 防止"修 drift"毁掉 KB（与第 26 项相邻） |
| 33 | **旧名残留 + 示例 CSV 锚点**（G38）：`scaffold.js:1194` 的 description、`Lantern*.csv` 的 `file` 列与 `lock` 校验 | `shell/mods/scaffold.js:1194`、`examples/Mods/Lantern/Yarn/*.csv`、`shell/mods/validate.js:1082-1112` | 低成本、直接影响交付物质感 |
| 34 | **拆掉"再生 KB 就关掉体检"的耦合**（G41）：生成器保留 sprite 描述字段，或校验器改用 `schemaSummary` 的 sprites 集合，别再靠英文描述文本 | `tools/gen_knowledge.mjs:52/91-97`、`shell/mods/validate.js:77/564-579` | 与第 26/32 项相邻；不拆的话 G31 一落地 D006 就静默失效 |
| 35 | **把 blob 接到编辑器与 `.yarn`**（G39）：编辑器打开与故事加载改走 `file.blobOpen` 分块 | `shell/web/cards.mjs:2438/4167`、`:1464` 的 `readTextInChunks` | G1 只修了"表"，没修"文本" |
| 36 | **CSV 往返保真**（G42）：写回时补 BOM；非 UTF-8 拒绝而不是替换成 U+FFFD | `shell/web/cards.mjs:1467`、`shell/web/storycsv.mjs:160/183` | 保存动作可能改写用户的表 |
| 37 | **故事卡的"编辑"补齐 + 两处小洞**（G40/G43/G44）：翻译文本写回（`setColumn`）、locale 文档分支、`mod.open` 带 KB 来源 | `shell/web/cards.mjs:3793/4120`、`shell/web/storycsv.mjs:128`、`shell/mods/search.js:815-829`、`shell/mods/index.js:631-640` | 与第 26 项同源，观感与可信度兼具 |
| 38 | **导出 zip**（G45）：顶层 `<ModName>/` 一层、排除表、文件名 UTF-8 flag、>4 MiB 文件走流式、导出前跑 `validatePackage`、固定排序与 mtime | `electron/main.js:295`、`shell/mods/validate.js`、`shell/mods/gamepath.js:183` | 便宜、可见、对上群里"压缩包转发"的分发方式（18.4） |
| 39 | **格式体检**（G46）：Spine 三件套与 4.2.43、WAV 头、PNG 色型、CSV 的 BOM/行尾 | `shell/mods/validate.js`、`shell/web/pixelpng.mjs`、`shell/web/storycsv.mjs` | 纯读，不依赖游戏在跑，也不依赖 KB |

## 7. 两个输入源没抓到（所以本文没有对"接口需求"下结论）

| 输入 | 结果 | 精确原因 |
| --- | --- | --- |
| 腾讯文档「mod 接口需求反馈」`docs.qq.com/sheet/DZGtFY0xuY0xhcnpW?tab=BB08J2` | **拿不到内容**；只能确认文档存在（标题 `需求`；伪造 id 的对照探针只返回 `腾讯文档`） | 纯前端渲染（无 `__INITIAL_STATE__`/`data` 负载）；数据接口 `https://docs.qq.com/dop-api/opendoc?id=...` → **401**；`mobile/sheet` → 404；web 搜索无镜像/缓存 |
| 百度网盘歌曲 `pan.baidu.com/s/1BF-DBBcw6m3sjTnYXiklRQ`（提取码 `ieef`） | **拿不到文件列表** | 302 到 `share/init`，需要"提取码 + 验证码 CAPTCHA"，之后还要 per-share token；URL 带 `pwd` 无效 |

沙箱环境的硬限制：**沙箱内的 `curl.exe` 没有可用的出网 TLS**（`curl.exe https://example.com` → exit 35，`schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)`）。两者都需要**沙箱之外、带登录态、能跑 JS/过验证码的浏览器**。
> **更正（见 §12.1）**：这一条只对沙箱里的 `curl.exe` 成立——用 IDE 自己的运行时（Node）实测可以出网（wiki 200 / `api.deepseek.com` 401 / 本地端口全 closed）。本节的结论（两个输入源需要交互式登录浏览器）不受影响。

wiki 自身也有几处硬伤，顺手记下（都是抓取时验证过的）：`sitemap.xml` 里所有 `<loc>` 的 host 仍指向上游 `https://quartz.jzhao.xyz/...`；`SO/ScriptableObject` 被 `e.Mod结构与限制` 链接但 **404**；`添加一个新角色` 实际是一个只有 SpinePro 下载链接的 1 分钟 stub；`表单` 页的"可用的音效表 / 可用的结果标识"是空表；`mod.json` 的字段结构**官方未文档化**（原话："具体字段以当前工程的 Mod 示例和 ModLoader 实现为准"）——这直接关系到下面这条：编辑器在 `validate.js:831-857` 发明并强制了 `loadOrder`（`M003`/`M004`），脚手架还把它写进 README（`scaffold.js:11/1046`）。**在确认真实 `ModLoader` 是否读这个字段之前，`M003`/`M004` 有"用自造规范误导作者"的风险**，建议先对照游戏工程验证。

---

## 8. 审计快照与并发写入说明

- 本轮全程只读：没有修改任何代码文件；唯一写入是本文件 `docs/EDITOR_GAPS.md`。
- 浏览器层的行号钉在 `shell/web/cards.mjs` 的 **5764 行**版本（SHA256 `96068F0049126ECC12F34F452CE9CD5C47E711C42A47585C6E20ED2F4E4BD798`）——审计过程中该文件在 19:40:32 被另一个写入者改动过，所以 `shell/web/*` 的任何行号都只在那一刻成立；`modview.mjs`、`main.mjs`、`pixelpng.mjs`、`storycsv.mjs` 的行号同理按当时快照理解。
- 审计期间工作区**另有写入者活动**（同一时刻的 `git status`）：已改 `CHANGELOG.md`、`shell/web/board.mjs`、`cards.mjs`、`main.mjs`、`selftest.mjs`、`style.css`、`tools/input_smoke.py`；未跟踪 `shell/web/pixelpng.mjs`、`shell/web/pixelreview-zz.mjs`（194 536 B，19:40:44 出现，内容与 `cards.mjs` 同行号）。因此本文所有行号对应**该时刻的快照**；同时提醒一句：`pixelreview-zz.mjs` 是 `cards.mjs` 的一份 194 KB 副本，工作区里出现了同一份代码的两个拷贝，容易被后续编辑/审计误读（是否保留由该会话决定）。
- **快照已推进（同日 21:06）**：那位写入者的 WIP 已经落地为两个提交——`dd5f1cd A pixel card draws a sprite, and the file is the image`（其中含本文件的首版，所以 `docs/EDITOR_GAPS.md` 现在是被跟踪文件，工作区改动是它的后续修订）与 `5076afa Read a file the kernel will not read whole`（上游 blob 层整套移植，见 §13.4）；`shell/web/pixelreview-zz.mjs` 已消失，`git status` 现在只剩本文件的修改。**§13 引用的行号（`views.mjs`/`classic.mjs`/`modview.mjs`/`main.mjs`）均已按 `5076afa` 之后的版本重核**；更早章节里对 `cards.mjs` 的行号仍按 19:40 的旧快照理解。
- 两个**删不掉的临时文件**：`docs/.tmp-b12.txt`（44 960 B）与 `docs/.tmp-b13.txt`（154 821 B）是 `decompress … toFile` 的产物。`Remove-Item`/`cmd del`/`[IO.File]::Delete`/`SetAttributes` 全部返回 NTFS"对路径的访问被拒绝"；`icacls` 显示它们只带沙箱 SID（`S-1-4-*`），而 `docs/` 带有继承的 `Everyone:(I)(CI)(DENY)(DC)`。按 DSH 沙箱的既定行为，这是**预期内的限制、不是 ACL 故障**，因此不做 ACL 修复，只在此披露（留给人工删除）。
- 未验证项（明确标出，避免当成结论）：wiki 的 47 个 SO 详情页与 82 个命令详情页未逐页渲染；`docs/BUGS.md` 的探针、`node tools/e2e.py` 级别的测试未在本轮重跑；`M003`/`M004` 是否对应真实 `ModLoader` 字段未与游戏工程对照（G/第 7 节已标注为待确认）。
- G21（音频）的来源与口径：基线计数（`AudioEvent` 117、`Song` 52、`VoiceOverDefinition` 4、`Attachment` 21）与 `#vo:` 16 次来自对 `ModsFull/Mods` 的只读扫描，并且**做过一次交叉复核**：`ModsFull/Mods/SODefines/Defines/Attachment/` 下确有 **21 个** json、其中 **21 个**都写了对象型 `audioEvent`（与本次一路取证的"1 个附件"说法不一致，本文采用可复现的 21）；`#vo:TestProgrammerVO` 在任何 `.yarn` 里出现 **0 次**（211 个文件全扫）；4 MiB 上限、base64 比值、`offset`/`limit` 被忽略这三个读数来自对 `build\infantgod.exe rpc` 的只读实测；`Mods/Audio` 是**游戏自带的演示包**（`mod.json` 自称 "Audio Programmer Sound Demo"），不代表社区 Mod 的平均形态——它的价值在于"唯一一个走外部音频文件的可运行范例"。其中"6 个 wav 全丢也是 `ok: true`"是**推论**：实测部分是该包确实报 `ok: true` 且无音频相关诊断，推论部分是字段分类（`referenceMap`/`schemaSummary`）显示没有任何代码路径检查这三个字段；本轮**没有**真的删除过任何文件。
- **快照已推进（同日 22:50）**：文件策略回到 workspace-write，本轮写入的是本文件新增的第 14 节（`G26`/`G27`/`G28`）与 §0/§6 的三行；仍未修改任何代码文件。§14 的 grep 计数（`git grep -i -E 'infantgod|infant god|幼神'`、游戏名词扫描）取自该时刻的工作树。

---

- 2026-10-17 16:57 复审（§15）：HEAD `6673a89`；工作树只有 ` M docs/EDITOR_GAPS.md` 与两个删不掉的临时文件；§15 的每条结论由 Lead 本机重跑（当时 `list_agents` 只剩 lead）。**更正（21:2x / 21:3x）**：两名子代理的只读审计其实都交付了，只是都晚于 §15 —— 一份是 §16 的 F1–F20，一份是 §17 的逐条判定 + N1–N6。教训：子代理"没回传"要等到会话结束通知再判，不要中途断言丢失。

## 9. 提案评估：**自动立绘**该不该进 IDE（G22）

先说结论：**这个游戏里的"立绘"不是一张图**。wiki `d.美术` 的原话是"本游戏使用 Aseprite + Spine，来制作角色的立绘与动画"——立绘 = **Spine 分层绑定的 256×144 像素角色**（2K 屏下放大 4 倍到 1024×576），`portrait`/`emailPortrait` 只是两个 UI 用的小 PNG。所以"自动立绘"至少要拆成六件事（"出图"一栏再分三层），它们的价值与可行性差别极大。**注意修正**：本节初稿把"出图"整体判为"不做"，那是把"内嵌工作流"错当成了"内置推理运行时"；A1/A2 是修正后的判断，理由见下方"证据四"。

| 层 | 含义 | 建议 | 关键理由 |
| --- | --- | --- | --- |
| A1 客户端内嵌工作流 | IDE 当本机 ComfyUI 的客户端：内置 wiki 那份工作流 + 参数注入 + 取回 PNG | **可行；但后续决定不用 ComfyUI，见第 11 节**（模型可换、两种模式见第 10 节） | 工作流是 wiki **公开附件**（`https://wiki.infantgod.xyz/attachments/PixelArt.json`），**只用 core 节点**；IDE 侧只要 Node 内置 `http`/`crypto`/`WebSocket`（本机 Node v24.16.0 实测全有）→ **不违反零依赖**；回环 HTTP 实测连通（`curl http://127.0.0.1:19387/` → 401，说明沙箱不禁本机端口） |
| A2 纯 JS 后处理 | 生成结果 → 调色板量化 / 网格对齐 / 裁到 256×144 | **可行，且决定"像不像游戏"** | wiki 第 4 步的 Unfake.js/PixelOver 做的正是这件事；像素卡已有 PNG 编解码（`shell/web/pixelpng.mjs`），不加依赖即可实现（先确认 Unfake.js 的许可证，或自行实现同类效果） |
| A3 内置推理运行时 | 把扩散模型跑进编辑器进程 | **不做** | 要 GPU + 数 GB 权重 + 运行时依赖；A1 已用本机 ComfyUI 覆盖同一件事，没必要重造 |
| B 体检 | 立绘资产/规格/命名/引用是否正确 | **做**（最高性价比） | 和 G6/G9/G10 同一条线：今天 `spineAssetPath` 写错也报 `ok: true` |
| C 接线 | 从美术资产生成 Character/CharacterState/调色板 | **半自动** | 能让 `添加一个新角色` 从"1 分钟的 SpinePro 链接 stub"变成可用模板；顺手修 `FALLBACK_CHARACTERS`（G8 的邻居） |
| D 预览 | 在卡里拼 Eyes×Mouth 预览情绪 | **可选** | 像素卡已经能画图（`dd5f1cd`），但**前置是先修 G20**（格式被改写）；Spine 骨骼面做不了 |

**证据一：wiki 把"立绘"定义成一条必须机器可读的命名链，而这条链今天没人校验。**

- 画布 256×144；情绪（Sad/Happy/…）通过**开关 Eyes/Mouth 图层组**实现；眨眼要 Eyes 的 Open/Close 差分；说话要 Mouth 的 `Lips_00`/`Lips_01`/`Lips_02`（不说话时停在 `Lips_00`）。
- 层命名规范固定为 `Accessory/FrontHair/Mouth/Eyes/Body`，其下再分 `-Normal`/`-Sad`/`-Fear`（以及可选 `-Skin1`/`-Skin2`）；**遵循规范时 Spine 能自动设置 skin 与槽位**。
- 官方为此专门发了 **3 个脚本**：`normalize_spine_tags.lua`、`Export-as-psd.lua`（Aseprite）与 `normalize_spine_tags.jsx`（PS）——这本身就是"手工极易错"的证据，也正是自动化体检最该覆盖的地方。
- 版本红线：Spine **4.2.43**（wiki 点名 **4.2.23 是个"微妙"的版本**：能导出给 Unity，但消费不了游戏内已导出的 `.json`）；导出要打包到 `<Mod>/Spine`；骨骼要有 `Root`（游戏会给 Root 施加上下位移模拟呼吸）。

**证据二：语料说这些资产真实存在，而且形态决定了"能查什么"。**

| 资产 | 语料事实 | 编辑器今天能做什么 |
| --- | --- | --- |
| `.skel.bytes`（Spine 导出） | `SODefines/Spine/` 下 20+ 个，如 `Aistalt.skel.bytes` 53 742 B | **只能看存在与体积**：二进制，内核拒读（`file.read` → `1003 file is binary`） |
| `.atlas` + 图集 PNG | 1 个，`SODefines/SpineOrigin/ForTest …/SpineExport/Anime_Spine.atlas`，**文本格式**（`size:477,537`、`pma:true`、`filter:Linear,Linear`、区域 `BG`/`Body`/`ExtraHair`/`Flower`…） | 可解析：区域名 ↔ 图集 ↔ skin 命名的交叉检查在这一层可行 |
| `.psd` / `.aseprite` / `.spine` 源文件 | 38 / 36 / 49 个（`SODefines/ASEOrigin/*.aseprite`、`*.psd`；`SpineOrigin/…/Spine/*.spine`） | **读不了**（二进制），只能做存在性/体积清单 |
| PNG | 1461 个，**没有一张 > 4 MiB** | 像素卡可解码，但只认 8-bit 非隔行 RGB/RGBA（G20） |
| Character 定义 | 56 个；`Aistalt.json` 里 `portrait` → `Sprites/Resources/Art/UI/Icon/ShortCut/ShortCut_Aistalt.png`、`emailPortrait` → `Sprites/Resources/Art/Character/Portrait/Aistalt_Portrait.png`、**`spineAssetPath` → `Spine/Aistalt.skel.bytes`**、`targetSpinePrefab` = null | `portrait`/`emailPortrait` **已被** D006 覆盖（25 个 sprite 字段之一）；**`spineAssetPath` 不在**（`schemaSummary` 里 Character 的 sprite 字段只有前两个）→ 写错/漏导出 = 静默不生效 |

**证据三：编辑器侧"立绘"相关的检查面今天几乎为空。** 除了上面那条，还有：`#state:` / `dialogueEmotionTags` / `CharacterState.skins` 与状态注册表**不核对**（`shell/mods/search.js:51-54` 的 `EMOTION_TAGS` 只有 15 项且缺 `Idol_1`，而 wiki 列了 24 个通用面部状态 + 一堆角色专属状态；wiki 明确说"状态是全局注册的，不代表每个角色都支持——缺 Skin 时可能应用失败或只应用一部分"）；256×144 画布、`Lips_00/01/02` 差分、`Eyes/Open|Close`、`-Normal/-Sad/-Fear` 皮肤层次、`Root` 骨骼、4.2.x 版本——**一条检查都没有**；脚手架里没有角色/美术模板，且 `scaffold.js` 的 `KNOWLEDGE_PATH` 指向不存在的 `shell/knowledge/knowledge.json`，导致角色调色板永远退回 7 个硬编码 `FALLBACK_CHARACTERS`，而知识库里躺着 53 个真实角色（含颜色）。

**证据四（修正 A 的依据）：wiki 的工作流文件是公开附件，而我已经把它读完。**

- `AI美术资产的处理` 给出完整四步：① 生成平涂底图（AI 或手绘）② 装 ComfyUI、导入附件 `PixelArt.json`、把 `CheckpointLoaderSimple` 的模型换成 `SPixelartModel` ③ 底图裁到 1024×576（缩放 2）或 2048×1152（缩放 1），降噪 0.3~0.6 ④ 后处理（Unfake.js 免费开源 / PixelOver 需购买，硬边缘）。视频参考 B 站 `BV1R5hH6cEpP`。`d.美术` 明说"AI 生成的美术资产是可接受的，前提是您做了基本的处理"——**让 IDE 承接这条流程是官方认可的方向，不是绕过规则。**
- 附件实测可下载（HTTP 200）。读完有三条直接影响设计：(a) 它是 **UI 格式**（`"version":0.4`、`nodes`/`links`、`extra.node_versions.comfy-core = v0.3.10`），而 ComfyUI 的 `POST /prompt` **要 API 格式**（扁平 `node_id → {class_type, inputs}`）——所以"内嵌"不能只把 wiki 文件塞进去，必须再生一份 API 格式孪生（或带一个图→API 转换器）；(b) **全部是 core 节点**（LoadImage、CheckpointLoaderSimple、CLIPTextEncode×2、EmptyLatentImage、VAEEncode×2、VAEDecode×2、KSampler×2、ImageScaleBy×7、SaveImage×2、PreviewImage），**没有自定义节点包**，所以不需要 ComfyUI-Manager 那类依赖；(c) 参数面很清楚：正/负面提示词在节点 6/7，两条采样支路（节点 3：`euler_ancestral`/28 步/`denoise 0.45`；节点 22：`dpmpp_2m_sde`/24 步/`denoise 0.3`）恰好对应 wiki 说的"降噪 0.3~0.6"，底图在节点 10 `LoadImage`，检查点在节点 4 = `SPixelartModel_v10.safetensors`——**模型名就在文件里**，不必去认 wiki 那张截图。附带发现：节点 5 `EmptyLatentImage`（1112×1624）没有任何出边，是死支路；输出侧有 2 个 SaveImage + 1 个 PreviewImage。
- 接口都是公开文档化的：`POST /prompt`（带 `client_id`）、`GET /history/{prompt_id}`、`GET /view?filename=…&subfolder=…&type=output` 取图、`GET /object_info`、`GET /system_stats`、`WS /ws?clientId=…` 推进度（[ComfyUI 服务器路由](https://docs.comfy.org/zh/development/comfyui-server/comms_routes)、[工作流 API 格式](https://docs.comfy.org/zh/development/api-development/workflow-api-format)、[`websockets_api_example.py`](https://github.com/Comfy-Org/ComfyUI/blob/master/script_examples/websockets_api_example.py)）。
- **必须在 Node 侧调，不能在卡片里直接 `fetch`**：ComfyUI 不返回 CORS 头，浏览器跨源（卡片 origin 是 shell 的 `127.0.0.1:<port>`）会被拦；shell 侧是 Node，本机回环既无 TLS 也无跨源问题（本机 Node v24.16.0 实测有 `http`/`https`/`crypto`/全局 `fetch`/全局 `WebSocket`）。正确形态是**新增一组 additive 的 RPC 动词**（沿用 `mod.*` 那套：在 `shell/main.mjs` 的 dispatch 里先应答，不碰内核、不改上游语义，符合 G1b 的规则）：`art.env`（探测 ComfyUI 与缺哪个 checkpoint）、`art.plan`（返回内置工作流的参数映射并校验节点 id）、`art.generate`（注入参数 → `POST /prompt`）、`art.watch`（`/ws` 进度经 SSE 桥到卡片）、`art.result`（`/view` 取回 PNG → base64）、`art.save`（`file.write_bytes` 写进 `<mod>/…`）。
- 体积算得过来：工作流输出是 1024×576 PNG，通常几百 KB，`file.write_bytes` 的 4 MiB 上限**够用**（`core/src/wksp.c:962`）；真要喂 >4 MiB 的底图，走 Node 侧 multipart 直接 POST 给 ComfyUI 的 `/upload/image`，不必经过内核的 base64 上限。
- 仍然要留在外面、也该如实告诉作者的：**模型权重**（wiki 只说"你需要想办法获取这个模型"，不随 wiki 分发，产品也不能打包）、**ComfyUI 本体**（Python/GPU 环境；零依赖政策下 IDE 只能探测 + 给指引，不能替用户装）、**平涂底图**这一步（人或别的工具）、以及 **Spine 绑定**（A3/D 的边界）。另有一件事要在做之前定：把 wiki 的 `PixelArt.json` 打进产品涉及授权——附件本身没写许可证（模组语料里的 LICENSES 是 CC-BY-NC-SA-4.0），建议**保留出处链接与署名，并在打包前向作者确认一次**。

**建议的落地形态（四层，按性价比排序）**：

1. **接线体检（先做，便宜）**：① `Character.spineAssetPath` 的存在性 + 与 `<mod>/Spine/*.{skel.bytes,json,atlas}` 的对应；② `portrait`/`emailPortrait` 已有（补"尺寸是否 256×144 / 是否 8-bit"这类规格提示）；③ 情绪矩阵：按 `Emotion × {Eyes Open/Close, Mouth Lips_00/01/02, Body Idle}` 列出缺哪些——从 PNG/文件夹名或 `.atlas` 区域名可读，**v1 只查可读面**；④ `dialogueEmotionTags` / `#state:` / `CharacterState.skins` ↔ 注册表核对（把"状态存在但角色没有对应 Skin → 静默不生效"变成一条 diagnostic）；⑤ `initialCharacterStates` 指向的状态是否存在。
2. **半自动 codegen**：从美术资产目录生成 `Character` + `CharacterState` + 调色板条目（顺手修 `FALLBACK_CHARACTERS`）；wiki 的字段清单（`nameKey`/`descKey`/`textAnimatorStyleTag`/`initialTransform: -7.2`/`defaultBodySkin|EyesSkin|MouthSkin: Normal`/`mainAudioEvents`/`voiceFrequencyUnits`/`lipsFrequency`）可以直接变成模板——`添加一个新角色` 这一页今天只有一个 SpinePro 下载链接。
3. **可选预览**：像素卡基础上做 256×144 @4× 的 Eyes×Mouth 合成预览（纯 PNG 面可行；Spine 骨骼面不可行），**前置是 G20 的格式保留**；本机**没有游戏安装**（四个标准 Steam 库位置都没有 `libraryfolders.vdf`），所以预览只能是近似，不能替代游戏内验证。
4. **出图卡（A1+A2）**（**引擎已改为"默认素材重组"，见第 11 节**）：新 card kind `art` + 上面那组 `art.*` 动词；内置 `PixelArt.json`（UI 格式，供人拿回 ComfyUI 用）**与它的 API 格式孪生**；流程是 `art.env` 先体检（ComfyUI 是否在跑、`SPixelartModel_v10.safetensors` 在不在）→ 生成 → A2 后处理 → G22 的规格检查 → 才允许 `art.save` 写进 Mod 目录。**权重、ComfyUI、底图仍由作者提供**，卡片只负责把这条链串起来并如实报错。

**边界（说清楚才可信）**：`.skel.bytes` 解析不了（无 Spine runtime，且零依赖政策）→ 骨骼/skin/slot 级检查需要作者提供 `.json` 导出或 `.spine` 工程；`.psd`/`.aseprite` 同理由 IDE 读不了；wiki 的 47 个 SO 详情页未逐页渲染。**但"存在性 + 规格 + 注册表"这三类检查不需要解析任何二进制**，今天就能做。

**一句话**："自动立绘"里真正适合 IDE 的是**体检 + 接线 + 以客户端形态内嵌官方工作流出图**；不适合的是把**推理运行时与权重**搬进仓库。出图用作者本机的 ComfyUI，IDE 负责"把工作流串起来、把参数和引用查对、把产出处理到能生效"——这仍然是 G1–G21 反复指向的同一件事。这也和 G11/G12 同构：编辑器能验的东西越多，作者需要进游戏试错的次数就越少。

## 10. 提案评估（续）：模型无关、两种出图模式、质量实验（G22 延伸）

**结论：三件事都成立，而且都比"锁死 wiki 那个模型 + 单条链路"更好；但真正的硬边界不在模型，而在"AI 出的是整图，游戏立绘要分层"。**

### 10.1 模型无关：模型名是唯一的硬指向（**后续收敛见 10.6**：图固定、不做 profile 框架）

- （**收敛说明**：本节最初提"多 profile 框架"，按后续决定改为**一份硬编码的图 + 换 checkpoint 字符串**，理由见 10.6。本节保留下来的结论是"工作流里只有一处指向模型，因此换模型成本极低"以及下面那条家族边界。）

- 事实：当前那份 `PixelArt.json` 里只有**一处**指向模型——节点 4 `CheckpointLoaderSimple` 的 `ckpt_name`（值 `SPixelartModel_v10.safetensors`）。链路其余部分（LoadImage → VAEEncode → KSampler → VAEDecode → ImageScaleBy）**与具体 checkpoint 无关**，所以"换模型"的成本 ≈ 改一个字符串。
- 但家族边界是真的：`EmptyLatentImage`/`VAEEncode`/`KSampler` 这套结构对 SD1.5 / SD2.x / SDXL 通用（都是 4 通道 latent）；**Flux / SD3 这类新架构不是**（要换 CLIP/VAE 加载器与采样链）。所以"用其他生图模型"的正确形态是**多个 profile**：每个 profile = 一份工作流（UI 原件 + API 孪生）+ 参数映射（node id）+ `requires`（checkpoint 名、node class 列表）。
- 校验天然存在：ComfyUI 的 `GET /object_info` 会返回 `CheckpointLoaderSimple.ckpt_name` 的**可用取值列表**。于是 `art.env` 能直接回答"这个 profile 要 `SPixelartModel_v10.safetensors`，你机器上有 A/B/C，缺 X"——比 wiki 现在那句"你需要想办法获取这个模型"强得多，也让"模型自由"变成可管理的事。
- 注意 wiki 的规格约束**不随模型变化**：256×144 画布（4× 到 1024×576）、Eyes/Mouth 图层组、`Lips_00/01/02`、`Accessory/FrontHair/Mouth/Eyes/Body` + `-Normal/-Sad/-Fear`、Spine 4.2.43。**模型可以随便换，产物规格不能随便**——这句应当直接写在卡片上。

### 10.2 两种模式：img2img（wiki）已就绪，txt2img（我们）离可用只差一根线

- **图生图（wiki 原流程）**：`LoadImage`(10) → `ImageScaleBy`×2(17) → `VAEEncode`(11) → `KSampler`(3, `denoise 0.45`)；第二条支路 `ImageScaleBy`×2(29) → `VAEEncode`(32) → `KSampler`(22, `denoise 0.3`)——这就是 wiki 说的"降噪 0.3~0.6"的两个档位：**同一张底图跑两档，取更好的那张**。
- **文生图**：工作流里**已经有** `EmptyLatentImage`（节点 5，1112×1624），但它的 `outputs[0].links` 是空数组、`links` 表里也没有任何一条引用节点 5——**它是一条断线的死支路**。也就是说 txt2img 不需要新工作流，只要把节点 5 接到采样支路的 `latent_image` 输入（并设成 1024×576）。这也正好解释"两种模式为何能并存"：**同一张图，两个入口**（节点 10 的图 / 节点 5 的空 latent）。
- 两模式的下游完全相同（KSampler 参数、VAEDecode、ImageScaleBy 链、SaveImage/PreviewImage），所以卡片只需切换"底图 or 空 latent"这一个开关，参数面板、进度、质检、保存全部复用。
- `art.plan` 应对 profile 做**结构自检**：必需 node id 在不在、类型对不对、有没有断线节点（节点 5 这种）——正是 G6/G8/G9 那条"别静默"的线。
- 一个值得进实验矩阵的假说（**未验证**）：SD1.5 系在原生 512×512 之外直出大图容易出现重复肢体/双头，所以"512×288 直出 → 4× 最近邻放大"可能比"1024×576 直出"更干净；SDXL 系则相反。**这是"实验找方法"最该先量化的第一件事**。

### 10.3 质量：先把"对这个游戏而言什么叫好"变成可计算的数字

"图像质量"若不可度量，实验就会退化成各人审美。这个游戏的规格天然给了一把尺子，而且**全部能用纯 JS 在卡片里算，不需要 GPU**：

| 指标 | 怎么算 | 为什么对《幼神》成立 |
| --- | --- | --- |
| 网格对齐率 | 4×4 像素块内的颜色方差 → 0 的比例 | 立绘是 256×144、2K 屏放大 4×，**真的只有 4 像素一格** |
| 调色板偏离 | 量化到角色/游戏调色板后的颜色数 + 平均色差 | 知识库里 53 个角色带配色（如 `Aistalt #7c4ec1`），语料里 1461 张 PNG 可统计真实调色板 |
| 边缘硬度 | 相邻像素差超阈值的比例 | wiki 明写后处理要"硬边缘"（PixelOver 那条） |
| 尺寸/格式合规 | 是否 256×144、是否 8-bit 非隔行 PNG | 与 G22/G20 同一套检查，生成物必须先过门禁 |
| 分层可分离性 | 眼睛/嘴巴区域能否被独立抠出 | **AI 出图的硬边界**，见 10.4 |

有了指标，"实验找出方法"就是一条 `art.sweep`：给定参数矩阵（模型 × txt2img/img2img × denoise 0.3/0.45/0.6 × steps 20/24/28 × cfg × 分辨率策略）排队跑、每张自动打分、最后出一张对比表。**同一个指标模块既当"实验裁判"，又当"写入 Mod 前的门禁"**（不达标就拦住 `art.save`），一举两得；而且它是新动词，不碰内核、不改上游语义（G1b 的三分法）。

### 10.4 真正的硬边界：AI 出的是整图，游戏立绘要分层

Eyes/Mouth/Body 是 Spine 的独立槽位/skin，情绪靠开关图层组实现。一张 AI 整图**不能直接变成立绘资产**，必须先拆层。所以：

- A1 的产出**默认定位是"底图/参考图"**，不是"可直接用的立绘"；
- 想让它更接近可用，得按区域分别生成（眼睛一张、嘴巴一张、身体一张），或在提示词/底图阶段就约束分层结构——这属于**待实验**的题目，且**没有 wiki 依据**，必须标成探索项；
- 拿到分层素材后，作者仍要走 wiki 的 `normalize_spine_tags.lua` → PSD 导出 → Spine 4.2.43 绑定这条人工链（A3/C 的边界）。

一句话：**换模型能改善观感，但改不了"整图 vs 分层"这个结构性落差**；IDE 应把这点写在卡片上，而不是让作者以为点一下按钮就得到立绘。

### 10.5 落地清单与前置条件

1. `shell/art/workflows/` 存 **profile**（每个含 UI 格式原件 + API 格式孪生 + `params` 映射 + `requires`）；首个 profile = wiki 原样，第二个 = txt2img 变体（接回节点 5）。
2. 动词组：`art.env`（`/object_info` + `/system_stats`：ComfyUI 在不在、缺哪个 checkpoint、有哪些）、`art.plan`（profile 结构自检）、`art.generate`、`art.watch`（`/ws` → SSE）、`art.result`、`art.sweep`（矩阵实验）、`art.save`（过质检门禁后 `file.write_bytes`）。
3. `shell/art/quality.mjs`：10.3 的五个指标，纯 JS，复用 `shell/web/pixelpng.mjs` 的解码。
4. 前置条件（不在 IDE 内，必须由作者提供）：ComfyUI 本体、权重、img2img 模式的底图。**本机目前没装 ComfyUI**（`127.0.0.1:8188` 无响应，常见路径下无 ComfyUI 目录），所以这一节只能在**有 ComfyUI 的机器上验收**；在那之前能交付的只有"探测 + 指引 + 工作流导入导出"。
5. 授权：把 wiki 的 `PixelArt.json` 打包进产品要保留署名与出处；换用其他模型时，各模型许可证由使用者自负（卡片给一句提示即可）。

**一句话（第 10 节）**：模型无关 = 把"模型"从代码里挪到 profile + `/object_info` 校验；两种模式 = 同一张图的两个入口（img2img 已有，txt2img 只差接回那个断线节点）；质量 = 先用本游戏的规格把"好"变成 5 个可计算的数字，再让 `art.sweep` 去比。**这三件事都不需要新依赖，也不会和上游分叉——但"整图 vs 分层"只有作者能解，IDE 只能如实说。**

### 10.6 硬编码工作流：我们不是通用生成工具（决定；**前提是 ComfyUI 作后端，最终引擎选择见第 11 节**）

**结论：对。把那张图冻结进代码，只留三个可变量——checkpoint 名、参数表、img2img/txt2img 模式开关。** 这一刀同时消掉 10.1/10.2 里最麻烦的两块复杂度：

- **不需要 UI→API 转换器**：图固定，随代码走的就是 **API 格式**（`node_id → {class_type, inputs}`，连线写成 `[node_id, output_index]`）；wiki 那份 UI 格式只作为"人能回 ComfyUI 打开"的参考件留档。原来"必须维护一份 API 孪生"的工作量变成"一份随代码冻结的常量"。
- **不需要 profile 框架**：10.1 的"多 profile"收敛为**一份图 + 换 checkpoint 字符串**；Flux/SD3 那种要换拓扑的架构，等真需要时再加第二张冻结图，不为它先建抽象。
- **不需要运行时结构审计**：node id 是常量，`art.plan` 从"读图做结构检查"退化成编译期常量；剩下的运行时检查只有三件——ComfyUI 在不在、checkpoint 在不在、**核心节点的输入名有没有变**。

**冻结图的节点与可控输入**（就是 wiki 那份，重复支路收敛为一条）：

| 节点 | class_type | 我们注入的输入 |
| --- | --- | --- |
| 检查点 | `CheckpointLoaderSimple` | `ckpt_name`（从 `/object_info` 的可用清单里选） |
| 正面提示词 | `CLIPTextEncode` | `text` |
| 负面提示词 | `CLIPTextEncode` | `text`（默认锁 wiki 原值，可展开） |
| 底图（img2img） | `LoadImage` | `image` |
| 空画布（txt2img） | `EmptyLatentImage` | `width`/`height`（256×144 的 4 倍 = 1024×576） |
| 采样 | `KSampler` | `seed`/`steps`/`cfg`/`sampler_name`/`scheduler`/`denoise` |
| 编解码 | `VAEEncode` / `VAEDecode` | `vae` ← checkpoint |
| 缩放链 | `ImageScaleBy` ×n | `upscale_method`=`nearest-exact`、`scale_by` |
| 存图 | `SaveImage` | `filename_prefix` |

**唯一的真风险（硬编码必须配的护栏）**：ComfyUI 的 core 节点输入名会随版本漂移。所以 `art.env` 除了报"缺不缺模型"，还要拿 `/object_info` **逐个核对我们硬编码的 `class_type` 与输入 key**；缺哪个就直接说"你这台 ComfyUI 与内置工作流不兼容（缺 `KSampler.denoise`）"，而不是等生成时报一堆看不懂的错。这是"非通用"省下复杂度之后**换来的唯一新增义务**。

**非通用还带来一个通用工具拿不到的好处**：UI 不必长得像节点编辑器，而是长在游戏上——角色（读知识库 53 个角色+配色）→ 情绪 `#state:` → 底图或文生图 → 生成 → 质检 → 写入 Mod；而且**游戏规格可以直接预置进那张固定的图**：缩放链直接落到 256×144、后处理锁角色调色板、网格对齐到 4×。通用工具不可能默认知道"这个游戏是 256×144、放大 4 倍"。

**维护纪律（硬编码的代价）**：随代码冻结的那份 API 图要写清出处——upstream URL（`https://wiki.infantgod.xyz/attachments/PixelArt.json`）、抓取日期、内容 hash、与 wiki 原件的差异（例如把两条重复采样支路收敛成一条 `denoise` 参数化的支路）；wiki 那份有更新（`lastmod 2026-09-23`）时 diff 后再重新冻结，文件头注释写明"本图 = wiki 版 + 这些改动"，保证对得上。

**仍未解决的（与是否硬编码无关）**：权重、ComfyUI 本体、以及 10.4 的"整图 vs 分层"。

## 11. 不用 ComfyUI：生成图像的其余路线（G23，决定）

**决定：ComfyUI 从"前置条件"降为"可选后端"。** 第 9/10 节都建立在"作者本机已有 ComfyUI"这个前提上；既然不用它，就必须回答"像素从哪里来"。以下三条路线，R1 为默认。

### 11.1 一个改变判断的发现：语料里已经有一整套**分层**立绘素材库

| 事实 | 证据（`ModsFull/Mods` 实测） | 含义 |
| --- | --- | --- |
| 每个角色一个分层目录 | `SODefines/SpineOrigin/<角色>/{Body,Eyes,Mouth}/<表情>/*.png`，35 个角色带这三层 | 游戏要的"分层"在语料里**本来就是分层文件**，不是一张整图 |
| 情绪/嘴型 = 可枚举的目录名 | Aistalt：`Eyes/` 16 个表情 ×3、`Mouth/` 14 个表情 ×3（`Lips_00/01/02`）、`Body/` 9 组（Normal 11、Neko 5、Soldier 4、Traditional 4、Tech/Troll/Politician/Empathy/Kitsch 各 3–4） | 正是 wiki 说的 Eyes/Mouth 图层组与 `Lips_00/01/02` 差分 |
| 挂件层 | Aistalt 顶层 `BackHair/B_Hair/Eyebrow/Deco_*.png`（Deco_Angel、Deco_Rainbow、Deco_Sweater…） | 换装配件同样是文件 |
| 素材规模 | Aistalt 150、Soldier 97、Greta 88、Masturbator 85、Victim 58、JournalistTest 54、Maogirl 49、Gachi 47、Judge 45…（最小角色 5–7 张） | 远超"给 Mod 加一个角色"所需 |
| 源文件与产物 | `SODefines/ASEOrigin/<角色>.aseprite`/`.psd`（38/36）；`SODefines/Spine/<角色>.{atlas.txt,png,skel.bytes}` | 源文件二进制读不了；`.atlas.txt` 是文本，可解析 |
| 配色 | `knowledge.json` 的 **53 个角色全带 hex**（Aistalt `#7c4ec1`、Vampire `#b30000`、Greta `#389f3b`…） | "调色板"已是结构化数据，不必从图上猜 |

所以对这个游戏，**"生成一张立绘"不等于"跑一个扩散模型"**：它是"选哪套 Body + 哪个 Eyes 表情 + 哪个 Mouth 表情 + 套哪个配色"，而这些参数在语料里全都有名字。

### 11.2 R1 素材重组 / 程序化（默认：纯 JS、无模型、无需 ComfyUI）

- 做法：读部件 PNG（`file.read_bytes`，单张几十 KB，远低于 4 MiB）→ 按部件位置合成 256×144 → 调色板映射（用角色 hex，或从基底取色）→ 输出**分层** PNG 集（保持 `Body/Eyes/Mouth/<表情>/` 与 `Lips_00/01/02` 命名）→ 后处理 → 过 G22 体检 → 写入 `<Mod>/SpineOrigin/<角色>/`（或按 wiki 打包进 `<Mod>/Spine`）。
- 为什么它比扩散模型更适合这条流水线：① **天生分层**，直接绕过 10.4 的硬边界；② 尺寸/网格/命名天然合规（素材本就是游戏体系）；③ 秒级、离线、零权重、零 GPU；④ 无许可证问题（素材来自游戏本体与官方 demo 语料）；⑤ 纯 JS 可实现——PNG 解码已有（`shell/web/pixelpng.mjs`），要新写的只有合成、调色板映射与命名生成。
- 真实局限（必须写在卡片上）：**造不出新轮廓**，产出是"变体"（换配色 / 换服装体型组 / 换表情组合 / 换挂件）。对"给我的 Mod 加一个角色"（wiki 教程本身就是复制 `DeepSeekDemo/Defines/Character/DeepSeek.json` 再改）通常够用；对"从零原创一张新风格美术"不够。
- 首版动词建议：`art.parts`（列出可组合的部件与表情矩阵）→ `art.compose`（参数 → 分层 PNG）→ `art.preview`（卡片按 4× 显示）→ 复用 10.3 质检 + G22 体检 → `art.save`。

### 11.3 R2 直调推理：可以不用 ComfyUI，但本机的代价要如实算

不经过 ComfyUI 的图执行器，直接跑推理管线（`diffusers` / `onnxruntime` / `stable-diffusion.cpp`）。本机实测：

| 项 | 实测值 |
| --- | --- |
| Python | 3.12.9（`%ProgramFiles%\Python312\python.exe`；项目 `tools/` 本来就是 Python 3.12） |
| torch | 2.13.0**+cpu**，`torch.cuda.is_available()` = **False** |
| diffusers / onnxruntime | **均未安装** |
| GPU | NVIDIA GeForce MX150，**2048 MiB**，驱动 572.40 |

结论：在这台机器上"用扩散模型生成图像"**并不轻松**——torch 是 CPU 版（要用显卡得换 CUDA 版并确认 MX150 支持），2 GB 显存装不下 SDXL 类模型，CPU 出 1024×576 是**分钟级/张**，权重还是几 GB 的下载。三种形态：① **Python side-car**（沿用 `tools/` 的 Python 传统，改动最小，但把"零依赖"变成"运行时要装几个 GB"）；② **Node 内 ONNX Runtime**（`onnxruntime-node` 是 npm 依赖 → 与 `docs/ARCHITECTURE.md:27-28`、`README.md:162` 的「零依赖」冲突；vendored WASM 可行但体积大）；③ **`stable-diffusion.cpp` 单文件**（不引入 Python 生态，仍要权重，而且 CUDA/Vulkan 后端与许可证要逐项确认）。

与第 10 节的关系：**下游全不变**——`art.*` 动词、10.3 质检门禁、G22 体检、写入 Mod 与接线全部复用；变的只是 `art.generate` 的实现（HTTP → 子进程/进程内）。§10.6 的"冻结工作流"只在"ComfyUI 作后端"时适用。

### 11.4 R3 云 API：可选（**结论已修订**，见第 12 节）

「no network」是**上游**的承诺，不是本项目的限制。用编辑器自己的运行时（Node v24.16.0）实测可出网：`https://wiki.infantgod.xyz/` → 200（489 ms）、`https://api.deepseek.com/` → 401（可达、缺 key）、`http://example.com/` → 200；内置 `fetch`/`WebSocket` 就够，不需要任何 SDK。所以 R3 与 R1/R2 并列为 `art.generate` 的一个后端；代价从"能不能"转移到**隐私与声明**（素材出网、可取消、可只发选中文件），见 §12。唯一保留的性质是**默认离线可用**：没配置就明确说，其余功能不受影响。

### 11.5 公共下游（无论像素从哪来）

质检（10.3 五指标）→ 规格/命名/引用体检（G22）→ 分层输出 → 写入 Mod → `Character`/`CharacterState` 接线。**引擎只决定"像素怎么来"**，所以 R1/R2/R3 共用一个卡片、一套动词、一套门禁；先做 R1 不会挡住以后接 R2/R3 或 ComfyUI。

### 11.6 落地顺序（建议）

1. **R1 素材重组生成器**（不需要任何外部服务，本机可完整验收）：`art.parts` / `art.compose` / `art.preview`，复用 `shell/web/pixelpng.mjs` 与 10.3 质检；顺带把 `Character`/`CharacterState` 生成（G22 的 C 层）接上，修 `FALLBACK_CHARACTERS`。
2. **G22 体检先行**：没有它，生成得再快也不知道能不能生效（`spineAssetPath`、256×144、命名、情绪矩阵）。
3. **R2 引擎探测 + 参数面板**：先只做"探测到没有"（diffusers/sd.cpp 在不在、显存多少、权重在不在）并如实报前置条件，再决定是否真接推理。
4. **ComfyUI 客户端**（§10.6 冻结图）保留为可选后端之一：作者机器上已经有 ComfyUI 就直接用，IDE 不替它做任何安装。

**一句话（第 11 节）**：不用 ComfyUI 是对的，而且这条路在本游戏里**更短**——语料已经把立绘拆成 `Body/Eyes/Mouth/<表情>/Lips_00..02` 的分层文件，53 个角色还带配色，所以"生成"首先是**重组 + 调色**（纯 JS、秒级、天然分层），扩散模型只负责"原创轮廓"这一件重组做不到的事；把两者放在同一组 `art.*` 动词与同一套质检/门禁后面，先交不依赖任何外部服务的那一半。

## 12. 网络不是禁区：图像生成 / vibe code / 剧本 的统一 AI 面（G24）

**决定：上游承诺的"0 网络"是上游的，不是我们的。** IDE 将来会支持**图像生成**、**vibe code**、**剧本**。本节先把两个事实摆清（其中一条纠正我上一轮的判断），再给出三件事在这个代码库里分别意味着什么、共用哪套动词、以及**必须先补的前置**。

### 12.1 事实核查（纠正上一轮的错误）

- 上一轮"沙箱无 TLS 出网"是 `curl.exe` 在这个受控 shell 里的失败，**不是本机**。用编辑器自己的运行时（Node v24.16.0）实测：`https://wiki.infantgod.xyz/` → **200（489 ms）**、`https://api.deepseek.com/` → **401（可达，缺 key）**、`http://example.com/` → 200；内置 `fetch` / `WebSocket` / `https` 都在。**云 API 现在就能走，而且不需要任何 SDK。**
- 编辑器当前代码**零出网**：`shell/**/*.mjs` 里唯一的外部 URL 是回环（`shell/main.mjs:958`）与 SVG 命名空间（`shell/web/main.mjs:82`）；全仓没有任何 provider / apiKey / LLM 代码；本机也没有本地模型服务在跑（11434 / 1234 / 8080 / 8000 / 5000 / 8188 全 closed，无 `ollama` 命令）。
- 所以 R3（云 API）从"不做"改成**可选后端**（§11.4 已改），同时保留**默认离线可用**这条性质：没配置就明确提示，其余功能一律不受影响。

### 12.2 与上游的关系：只做加法，不改语义（G1b 照用）

- fork 已经分叉（18/38、历史被重写、core 两套），加网络**不违约**；但必须守住 G1b 的三分法：**既有动词语义不动**（`file.*`/`mod.*` 永远是纯本地、离线可跑、可审计），新能力一律走**新增动词 + 新卡片**。
- **key 只能待在 Node 侧**：`shell/web/selftest.mjs:3113/3309/4203/4326` 明令 web 模块不得触碰 `window`/`document`/`localStorage` —— 浏览器里既不存 key、也不发请求；出网统一由 `ai.*` 动词代发，卡片只收结果。配置沿用现有 flag 机制（`shell/main.mjs:1031` 的 `takesValue`）：`--ai-config FILE`。
- 护栏（缺一条都会变成"作者被坑"）：① **离线可用**（未配置时明说，不静默失败）；② **显式同意**（每次出网前说清把哪些文件/内容发往哪个 host）；③ key 脱敏（不进日志、不进错误、不进 board 文档）；④ 可取消、可超时、可重试、有限流；⑤ token/花费计量；⑥ **写入必须过门禁**（见 12.4）。

### 12.3 三件事在这个代码库里的含义（按缺口倒推）

| 方向 | 在这里意味着什么 | 今天缺什么 |
| --- | --- | --- |
| 图像生成 | §11 的 R1/R2 + 新增 R3 云 API：`art.generate` 的第三个后端 | 只差 provider 与隐私声明；下游（质检 / G22 体检 / 写入 Mod）全部复用，不需要新设计 |
| **vibe code** | 让模型产出 **Mod 产物**：`.yarn`、`Defines/*.json`（51 个 schema）、`mod.json`、11 张语言 CSV | **知识库文档近乎为空**：136 条命令只有 25 条有文档、其中 15 条乱码（G5）；wiki 有 **82 个 YarnCommands + 18 个 YarnFunctions** 页可回填；`mod.json` **schema 未文档化**（wiki 原话：以 Mod 示例与 ModLoader 实现为准）；校验器只认 type/enum/required/properties/items 五个关键字（G6），`pattern`/`minimum`/`oneOf` 全被忽略 → 生成物能"通过"却未必正确。好在 `mod.validateDefine`/`mod.diagnose` 已经在 → **天生有"生成→校验→修复"回路** |
| **剧本** | 故事卡（`.yarn` + 翻译 CSV + `commands.json`）从"逐行追加"升级为可被 AI 辅助的写作与结构工具 | 只能**追加**：不能删 / 不能改序 / 不能增删节点（G7）；**没有控制流模型**，而 `if`/`elseif`/`else`/`endif`/`once`/`endonce`/`jump`/`detour`/`wait`/`set`/`declare`/`return` 正是知识库里 **13 条无文档命令**；标签只认 `#line:`/`#state:`，语料里还有 `#Check:` 149、`#Topic:` 183、`#Modify:` 47、`#vo:` 16；知识库已有 1221 节点 / 211 yarn / 53 角色 → 足够支撑节点图、分支与死端分析 |

（若"vibe code"指的是**让 AI 改编辑器自身的代码**：那是另一件事。本仓库零依赖、纯 JS + C89、无构建步骤，改动门槛低，但同样要先有门禁——`shell/web/selftest.mjs` 与 `shell/mods/selftest.mjs` 的 `make test` 加 `docs/PROTOCOL.md` 的协议约束。本节先按"生成 Mod 内容"写。）

### 12.4 一组 additive 动词（`ai.*`）

- `ai.env`：provider / 模型 / 是否配置 / key 是否存在（**只回布尔与脱敏尾号**）/ 限流与余额探测。
- `ai.generate`：流式补全；复用已有的 SSE `/events` 通道推 token，卡片不需要新协议。
- `ai.repair`：把 `mod.diagnose` / `mod.validateDefine` 的 diagnostics 当输入，产出**补丁**而不是整文件重写。
- `ai.apply`：**门禁写入**——先 diff 预览 → 跑 `mod.validateDefine`/`mod.validate` → 通过才 `file.write`（带 `base_revision`，正是 `docs/BUGS.md` 里那类守卫的用法）。
- `ai.sweep`：§10.3 的质量矩阵，把"实验找方法"接到真的跑（图像方向）。
- provider 抽象：**OpenAI 兼容 HTTP** 一个协议覆盖大多数云端；本地（Ollama / llama.cpp / vLLM）同协议；全部 Node 内置 `fetch`，零依赖。

### 12.5 顺序（三件事共用同一条前置链）

1. **知识库文档回填 + 乱码修复**（第 20 项）——这是**功能前置**，不是体验优化。没有它，vibe code 只会发明不存在的命令，剧本卡也解释不了命令语义。
2. **`mod.json` schema + 控制流与标签模型**：前者 wiki 没写（从 ModLoader 实现与示例反推），后者是剧本方向的结构基础。
3. **生成 → 校验 → 修复回路**：先把 G17 的"校验结果不回流"修掉，`ai.repair` 才有输入。
4. **人在环 + 门禁**：AI 只出 diff，写入一律走 `ai.apply` 的验证门；出网可见、可取消。
5. 之后才是体验层：图像卡（第 17 项）、剧本卡、代码补全。

### 12.6 隐私 / 许可 / 声明（做之前先定）

- **出网 = 作者的剧本、定义、美术会发往第三方**：UI 必须明说，并允许"只发选中的文件 / 只发脱敏片段"。
- **AI 产物进 Mod**：wiki 只对**美术**说过"（做了基本处理后）可接受"，对 Yarn/剧本**没有表态**；建议在 `mod.json` 或 IDE 侧清单里留一处 provenance（哪些文件由 AI 生成），把将来的社区/Steam 审核争议前置解决。
- 模型许可与商用限制由使用者承担，IDE 不打包权重（与 §11.3 一致）。
- **提示注入**：`.yarn`、定义、README 都是**不可信输入**——模型读到它们不能直接变成写入指令或工具调用；一切写入仍走 12.4 的门禁。

**一句话（第 12 节）**：上游的"0 网络"是上游的承诺，加网络只需守住"**既有动词语义不变、新能力 additive、离线仍然可用**"；而图像生成、vibe code、剧本三件事的最短路径其实是同一条——**先把知识库的文档与控制流补全，AI 才有规则可依，校验器才拦得住**。

---

## 13. 卡片层正在退场：本文哪些结论绑在卡片上（G25）

> **2026-10-17 状态更新（§15.1）**：画布已经删掉（`745cd83`）。这一节当时按 P1 处理，理由是"board 视图还能兜底"；现在没有兜底了 —— 6 种卡在两种视图里都不可见，已升级为 P0 的 G29。

方向来自使用者本人：**"我们正在逐渐去掉卡片版本的 IDE"**（user said, m00701）。这不是本文档里的既有教条（`docs/` 里没有"卡片将被移除"的声明），但它**已经写在代码里**：三次提交、两个常量。所以本节先把"已经发生的"和"将要发生的"分开，再给出其余章节的落点重挂。

### 13.1 代码里的证据（本轮只读重核）

| 事实 | 位置 |
| --- | --- |
| 窗口默认落在 `classic`（传统 IDE 瓦片），不是 board | `shell/web/views.mjs:31` `export const DEFAULT_VIEW = "classic"` |
| HUD 的视图开关**只有** classic / mod，board 被刻意排除 | `shell/web/views.mjs:46` `SWITCH_VIEWS = ["classic","mod"]`；理由在同一处注释："It is a *mode*, not a destination"、"the paradigm this product stopped asking anyone to learn" |
| 视图是纯投影：只算矩形，不写文档，因此**可以整个删掉** | `shell/web/classic.mjs:1-20`（"keeping it a projection is why it can be deleted"）、`docs/VIEWS.md:106-113`（两个瓦片"create nothing, move nothing and save nothing"） |
| 两个瓦片读的是同一份 card 文档（card 仍是渲染单元） | `shell/web/classic.mjs:55-89`、`shell/web/modview.mjs:63-100`；`docs/VIEWS.md:84-89` 的词汇表仍把 card 定义为"the shell's unit inside that board" |
| 提交史：先是代码区/标签/侧栏，再是 classic 瓦片，再是 mod 瓦片 | `e4b7b60 The same board, drawn as a code area, tabs and a sidebar`、`56febc2 A window opens on the classic tile…`、`7a990f6 The board drawn for mod work: mode mod` |

`docs/VIEWS.md:117-122` 把当前状态写得最清楚：窗口默认开在 `classic`，HUD 只提供两个瓦片，board "is still a mode … and none of it was removed — but it is not a button"。

### 13.2 已经发生的硬后果：11 种卡片里只有 5 种在可切换视图里有位置

- **classic** 只放 `project`/`files`（侧栏，`classic.mjs:23`）与 `editor`（标签 + 代码区，`classic.mjs:69`）。
- **mod** 只放 `mod`/`project`/`files`（侧栏，`modview.mjs:26`）、`editor`（标签/代码区，`modview.mjs:80`）与 `problems`（底部面板，`modview.mjs:29`）。
- 其余 6 种 —— `note`、`runner`、`sheet`、`story`、`pixel`、`docs` —— **在两个可切换视图里都没有槽位**：`roles.hidden` 吞掉它们，只加一个 `is-hidden`（`shell/web/main.mjs:806-812`；DOM 不卸载，所以未保存的文本、滚动位置和监听器都不丢）。
- **没有任何自动切视图**：只有 `mode` 命令与 HUD 按钮调用 `setView`（`main.mjs:1985`、`main.mjs:2090`）。而 `sheet`/`story`/`docs` 命令直接 `addCard(...)`（`main.mjs:1714`、`:1761`、`:1870`），`pixel` 命令走同一个 `addCard` 辅助函数（`main.mjs:1414`）——日志打印"card added"，屏幕上什么都没有。编辑器自己承认这条规则：`main.mjs:1662` "the ${viewMode} view does not drop notes — \`note <text>\`, or \`mode board\`"。
- 所以**本文最近两轮讨论的主角正落在这 6 种里**：故事卡（`3906458`）、像素卡（`dd5f1cd`）、`docs` 卡，在默认视图与 mod 视图里都不可见；`problems` 卡只在 mod 视图有位置（这让 G16/G17 更急：那张卡你不一定看得见）。

这不是 bug（`main.mjs:806-810` 的注释把"隐藏而不移除"写成了设计），而是"卡片版在退场、槽位还没跟上"的直接后果。

### 13.3 对本文的直接影响：落点重挂

建议把下面这条写进 `shell/web/README.md`，作为以后所有功能提案的准入规则：

> **能力先落在 Node 侧动词**（`shell/mods/*`、`shell/art/*`、`shell/ai/*`、`shell/main.mjs` 的 RPC），**视图只负责占槽位**。一个新能力只有在 (a) 于 classic 或 mod 至少一个视图里有槽位，或 (b) 明确接受"只在 `mode board` 可见 = 随 board 一起消失"时，才算落地。

| 章节 / 优先级项 | 原来的落点（卡片） | 重挂点 |
| --- | --- | --- |
| G16 诊断跳行 | `cards.mjs` 给 `openFile` 传 `at` | **与卡片无关**：`openFile(path, {line|pointer})` 是 `main.mjs:1252` 的能力，classic/mod 的代码区都吃；这个修不受方向影响，**应该最先做** |
| G17 校验回流 / 过滤 / 导出 | `problems` 卡加过滤、分组、导出 | 分组/过滤/导出做成 `mod.validate` 的输出选项（动词侧），面板只渲染；否则每换一次视图就要重做一遍 |
| G18 `docs` 卡看本包定义 | `docs` 卡加 `root` 参数 | 参数属于 `mod.search`/`mod.docFor`/`mod.stats`/`mod.types`（动词已有），卡只是传参；动词侧先行 |
| G19 mod 视图接纳自家卡 | 改 `modview.mjs:26-29` | 这正是**槽位扩展点**：改 `MOD_SIDEBAR_KINDS`/`MOD_PANEL_KINDS`/标签页的 kind 判据，不碰 board；与"去掉卡片版"不冲突（card 还是渲染单元） |
| G20 像素格式 | `pixelpng.mjs` 的编解码 | 与卡片无关（纯编解码）——但像素卡要在默认视图里看得见才有意义，否则是在给 board-only 功能修 bug；顺序上应与 G19 一起 |
| §11 出图卡 | 新 card kind `art` | 必须同时给 classic/mod 一个槽位（标签页或面板），否则"图像生成"在默认视图里等于不存在——**这是它能不能算落地的判据** |
| §12 `ai.*` | 新 card kind + 新动词 | 动词是主体（不受视图影响）；UI 只借已存在的区域（编辑器卡的代码区、mod 视图的 `problems` 面板、`mod` 面板），**不再新增只在 board 存在的卡** |
| 第 6 节第 11–19 项 | 多处写"新 card kind" | 一律按本节重读；其中第 7 项（headless CLI）与第 11 项（诊断跳行）是纯粹的"动词/宿主"能力，反而更该提前 |

### 13.4 顺带更新：G1 已被并发提交修掉，G1b 的决策被执行

- `5076afa Read a file the kernel will not read whole`（21:06）把**上游的 blob 层整套移植**进来：`file.blobOpen` / `file.blobRead` / `file.blobAppend` / `file.blobCommit` / `file.blobAbort`（`core/src/rpc.c:1000-1004`），1 MiB/帧、八个会话、只读已解析路径、seek-and-read、`.tmp` 邻居原子替换、流式 FNV-1a 版本号、提交时发 `file.changed`。
- 故事卡的翻译表随之改走会话分帧读取与写回（`shell/web/cards.mjs` 里 10 处引用；`shell/web/README.md` 已描述该路径），提交信息记录的真实浏览器验证是：**读完整 5 751 617 B 的 `NewProject_RU.csv`，逐行比对 18 609 行**，并用会话写回后与源文件 sha256 相同。
- **"4 MiB 拒绝"原样保留**（`file.read`/`file.read_bytes` 的语义一个字没动）——这正是 G1b 建议的走法：**加法、不动既有动词、语义面跟上游**。因此：
  - G1 的标题（"编辑器全都打不开"）**已过期**，正文保留作为决策记录；
  - G1b 的"跟上游还是自己做"**已由这次提交回答**（跟随上游 blob 层 + 不动既有语义）；
  - 仍未覆盖：**写回超过 4 MiB 的非表格文件**，以及像素/音频走的 `file.read_bytes` 字节路径（它们仍是 4 MiB）。
- 快照随之更新，见 §8 最后两条。

---

## 14. 发布前的三件事：剃数据、自带案例、名称（G26–G28）

四轮拍板把"能不能发"变成了一个独立的缺口簇：`m00865`「我们真正分发时把游戏数据剃掉就可以了吧，毕竟我们是用于测试的」、`m00867`「那个 json 也去掉」、`m00876`「我们需要有我们自带的测试 mod 案例」、`m00882`「名字本身也可能有合规问题」。本节只记**决定、清单与前置**。

### 14.1 G26 分发物零游戏数据（决定）

**为什么成立**：游戏自己的声明把 CC BY-NC-SA 4.0 的义务挂在"导出/分发"这个动作上（原话 "exporting or distributing constitutes acceptance"）。安装包与仓库里不含游戏数据的复制件 → NC/SA 不适用；用户在自己机器上从自己安装的游戏派生 → 自用。EULA 的 "internal test only" 只降低现实风险，**不构成豁免**——真正起作用的是"不导出、不分发"。

**要剃的清单**（除 `shell/mods/knowledge.json` 外都是实测 grep 命中）：

| 位置 | 内容 |
| --- | --- |
| `shell/mods/knowledge.json` | 完整基线：1305 个定义名、53 个角色名+配色、`#region` 注释、`gameModsDir` 本机路径、`projectName` |
| `shell/mods/scaffold.js:229-233` | 硬编码 7 组角色名+配色（`Aistalt #7c4ec1` …）；`:555` 默认主角 `'Aistalt'`；`:65` 注释 |
| `shell/mods/search.js:51-54` | `EMOTION_TAGS` 15 个游戏状态名 |
| `shell/mods/selftest.mjs`、`shell/web/selftest.mjs` | 测试夹具里的真实台词与角色名（`Aistalt: 早。 #state:Idle #line:07c13ab`、`MaoGirl`…）；**`extraResources` 整份拷 `shell/`，所以它们会随安装包发出去** |
| `shell/mods/yarn.js:37/47/209`、`shell/web/cards.mjs:1253/5858` | 注释与 placeholder 里的语料文件名/游戏名词 |
| `docs/*.md` | 本文有 19 处游戏名词（事实与短引用，可保留，但应补一行出处） |
| `docs/board.png`、`electron/icon.ico` | 待目视确认是否含游戏立绘/素材 |
| `shell/mods/scaffold.js:738-739` | `SCHEMA_DIR`/`DEFINES_DIR` 写死本机绝对路径（非游戏数据，但同样不该随包发） |

**代价与前置（这条是重点）**：KB 一缺，`shell/mods/validate.js:768-769` 直接把 `{}` 当知识库用，`ok: true` 退化成"什么都没查"（G6）。所以"删除"之前必须先有：

1. **生成器进 `tools/`**——今天仓库里没有任何东西能重建 KB（G5），游戏路径还冻结在代码里；
2. **游戏目录发现**——`DEFAULT_GAME_MODS_DIR` 是硬编码（`shell/mods/index.js:35-36`、`scaffold.js:738-739`），要变成设置项/自动探测；
3. **KB 缺失时的显式提示**（"未找到游戏，校验能力不可用"），不要静默降级成一批 M005 警告。

**收益**：KB 永远与用户本机版本一致（G5 的过时、无 build id 问题自动消掉），还能把用户已装的其它 Mod 纳入，做今天完全缺失的撞名检查（G3）。

**中间路线**（想保留"没装游戏也能开着用"的体验时）：只留事实的 KB——命令/函数名、参数名与类型、`required`/`enum`、类型名；去掉 `documentation`、`#region` 乱码、property description、53 个角色名与配色。它仍是派生数据，属于有意为之的决定。

**仓库面与历史面（2026-10-22 处理完毕）**：`knowledge.json` 原先是被跟踪文件（`git log -- shell/mods/knowledge.json` 只有初始 fork 提交），没有被 `.gitignore` 忽略。现在 `git rm --cached shell/mods/knowledge.json` 并加进 `.gitignore`：开发树从本机游戏派生一份留在本地，tip 与后续提交、安装包都不再携带它；套件在缺这份文件时按组名 skip（`selftest/foundation.mjs` 的 `SHIPPED_KNOWLEDGE`、`selftest.mjs` 的组循环），干净 clone 上 `mods: ok`。用户当日回复“改写历史。”后，`git filter-branch --index-filter 'git rm --cached --ignore-unmatch shell/mods/knowledge.json' -- --branches --tags` 重写 145 个提交（旧→新映射留在 `build/_map.txt`，判据是作者/提交时间戳 + 标题）；改写后 tip 树与改写前逐字节相同，`git rev-list --objects --branches --tags` 不再含该文件，文档里的旧提交号已按映射重钉。强推后 `main` 与 8 个 tag 都不再可达旧对象；残留副本只在本地 bundle、改写前的 clone 与 GitHub 缓存里，彻底清除需要向 GitHub 支持申请。

### 14.2 G27 自带测试 Mod 案例（决定：要做）

**为什么必须有**：剃掉游戏数据之后，仓库与安装包里**没有任何一个可加载的 Mod**——`examples/` 只有 `board.json`(3211 B)、`hello.yarn`(807 B)、`sample.json`(287 B) 三个小文件；mod 层测试的主入口挂在游戏语料上（`shell/mods/selftest.mjs:103` 的 `HAVE_CORPUS`，缺语料时 `:107`/`:312` 两整段直接跳过）；教程 `MyMod/Yarn/Main/Days/Day1_Tutorial.yarn`（82 478 B）随游戏走、不在我们手里、也不能随我们分发；无 KB 时 `mod.scaffold` 出不了可加载的包（`scaffold.js:148-218` 的 `TEMPLATES`，选择在 `:1125`）。

**覆盖矩阵**（全部自造名字，不复制游戏的 `Schema/*.schema.json`、不引用基线 `techName`）：

| 目录 | 覆盖的缺口 |
| --- | --- |
| `mod.json` | 文档化字段（`loadOrder` 用 5，避开 0/1） |
| `Defines/Character/Demo_Hero.json` | `portrait`/`emailPortrait`/`spineAssetPath` → G22 的接线体检 |
| `Defines/CharacterState/*`、`Defines/PixelAnimation/*` | `#state:` 应用链、骨骼/物理轨道、`audioEvent` |
| `Defines/Song/*`、`Defines/VoiceOverDefinition/*` + 2 个小 PCM WAV | G21 的音频引用体检（`>4 MiB` 的样本用 `tools/` 脚本现场生成，测 G1b 的上界） |
| `Yarn/Demo.yarn` | 一跳一转 + `#line:`/`#state:`/`#vo:`/`#Check:`/`#Topic:`/`#Modify:`（把故事层只认两个标签的缺口变成可见用例） |
| `NewProject.csv` + 一种第二语言 | G7 的 CSV ↔ Yarn 核对 |
| 2 个 PNG | 一个 8-bit RGBA（像素卡可存），一个 **8-bit RGB** → 把 G20"保存即改字节"钉成回归测试 |
| `README.md` | 当教程用（比 `Day1_Tutorial.yarn` 短、贴合 IDE 操作流） |

**负样本包 `DemoModBroken`**：`D001–D007`/`Y00x`/`M00x` 各触发一次，同时充当"诊断码含义"的唯一可执行规格（今天这些码只散在 `shell/mods/validate.js` 里）。

**放置与授权**：`examples/mods/` 最省事——`.gitignore:3` 明确"examples/ 故意不忽略"，`LICENSE-DOCS:18` 写明 examples/ 里的源码按 MIT。体积目标 < 200 KB；安装包的 `extraResources` 目前只收 `shell/`、`langs/` 与 `build/infantgod.exe`，要再加 `examples/`。

**顺带解决**：`HAVE_CORPUS` 从硬门槛降级为额外增强；没装游戏也能演示 mod/docs/problems 三张卡在干活；无 KB 时 `mod.scaffold` 以它作兜底模板（取代 `scaffold.js:229-233` 那 7 个假角色）；`mod demo` 落一份到工作区（配合 §13 的"动词优先"）。

**待定**：绿色包+负样本包还是只做一个；教程用中文还是中英双语；是否随安装包分发。

### 14.3 G28 名称与标识合规

> **2026-10-17 状态更新（§15.4）**：已改名 OsanaKami IDE Studio（`6673a89`）并落地免责声明（`README.md:597`）；剩余的是旧设置路径兼容与"问作者一次"。

风险从重到轻：**商标/混淆**（产品名 `InfantGod Studio` 含游戏名《幼神》）→ **代码签名主体**（`package.json:57` 的 `publisherName: "InfantGod Studio"`，签名是对外的身份声明）→ **暗示背书**（名字 + 图标 + 只发给该游戏的玩家）→ **标识占位**（将来要发布时名字已被占用）。

实测出现面（`git grep -i -E 'infantgod|infant god|幼神'`）：identity 层在 `package.json`（`name`/`productName`/`appId: com.infantgod.studio`/`publisherName`）与 `electron/main.js`（`APP_ROOT`、`infantgod.exe`、`.infantgod/board.json`、`%APPDATA%\InfantGod Studio\settings.json`、`Documents/InfantGodStudio` 默认工作区、`%USERPROFILE%\.infantgod\{codesign.cer,codesign.pfx,codesign.pw}`）；代码标识层是 `core/include/*` 的 `INFANTGOD_*` 宏、`core/include/infantgod_cfg.h`、`build/infantgod.exe`；文档层 README 32 处 / `CHANGELOG.md` 20 / `electron/README.md` 19 / `docs/*` 10–17 / `EULA.txt` 6 / `LICENSE`+`LICENSE-DOCS` 7 / `tools/*` 2–20。

**关键判断**：法律暴露集中在**用户看得见的那一层**（`productName`、`appId`、`publisherName`、窗口标题、安装目录名、文档），`INFANTGOD_*` 这类 include guard 没有商标意义——所以"改名"的必修面比 grep 计数小得多。三档处置：

1. **描述性使用 + 免责声明**（今天就能做，零迁移）：产品名去掉游戏名；或保留名字，但在 README / EULA / 安装许可页 / 关于框写明"非官方，与《幼神》作者无关；游戏名称为其各自所有者商标"，同时问作者一次（群规：一次，不要反复 @）。**招牌下发之前这是最便宜的一步。**
2. **产品名去游戏名**（中等，需迁移）：改 `productName`/窗口标题/文档与 `%APPDATA%` 目录名；`appId` 一改，安装目录与卸载注册表键就变，升级会变成"装了两个程序"——必须配一次兼容读取（读旧设置路径）。
3. **彻底改名**（最贵）：`core/include` 的 `INFANTGOD_*`、`infantgod_cfg.h`、`build/infantgod.exe`、`%USERPROFILE%\.infantgod`、内核状态目录 `.infantgod/board.json`（`core/src/wksp.c`）与协议文档同步。只在要做品牌时做。

**与 §14.2 的关系**：自带示例包的命名同样不能带游戏标记（包名、`techName`、角色名、`#state:` 名）。**另记（安全，非命名）**：`codesign.pw` 是明文口令，与 `.pfx` 同目录（`%USERPROFILE%\.infantgod\`）。

### 14.4 剃数据之后仍需在发布前做完的许可动作（与游戏数据无关）

> **2026-10-17 状态更新**：见新增的 §15（复审）。本节列的四类许可动作仍然有效；§15.2 说明"零游戏数据"当前还只是承诺。

- **seIDE 的 MIT 声明**（上游 fork 的硬义务）；
- **安装目录里的许可文件**：`LICENSE.electron.txt` 与 `LICENSES.chromium.html` 今天只在 `dist/win-unpacked/`，`extraResources` 不收它们 → 装完后在程序目录里看不到；补文件并让 `package.json` 的 `files.nsis.license` 指向根 `EULA.txt`；
- **`EULA.txt` 入库**（当前是未跟踪的 `?? EULA.txt`）；
- **`LICENSE-DOCS` 范围表**补上漏列的 `docs/VIEWS.md`、`docs/EDITOR_GAPS.md`；

## 15. 复审 2026-10-17（HEAD `6673a89`）：画布退场之后，哪些结论坏了、哪些已经关掉

> 状态更新：本节写于 `6673a89` 之后，替代第 9–14 节里"当前状态"的部分判断；判断过程保留在原节，不重写。

### 15.0 快照与方法

- HEAD `6673a89 Rename the product to OsanaKami IDE Studio`；其上 `8388a85`（新建模组 + 安装器 + 示例包）、`745cd83`（删画布）。
- 工作树：只有 ` M docs/EDITOR_GAPS.md`（本文件）与两个删不掉的临时文件 `docs/.tmp-b12.txt`、`docs/.tmp-b13.txt`。
- 本轮只用只读手段（读代码 + `git grep`）。§15 的每条结论由我自己重跑；两名子代理的独立审计都延迟到达：F1–F20 收进 §16，逐条判定 + N1–N6 收进 §17（Lead 对两份都抽查了关键行号）。教训见 §8。

### 15.1 G29（P0）画布退场后，6 种卡片在两种视图里都画不出来

机制链（每步都实测）：

1. `shell/web/views.mjs:37` `VIEWS = Object.freeze(["classic", "mod"])`；`:13-18` 自述 "what is gone is the view that drew every card exactly where the document put it"。
2. `shell/web/classic.mjs:68-72` 标签页只收 `card.kind === "editor"`；`:81-86` 其余全部进 `hidden`。
3. `shell/web/modview.mjs:78-83` 同上；`:92-97` 只有 `problems` 能占面板。
4. `shell/web/main.mjs:743-744` `layout.boxes.get(id)` 为 `undefined` → `classList.toggle("is-hidden", true)`；`shell/web/style.css:122` `.card.is-hidden { display: none; }`。
5. `shell/web/index.html` 只有 `#cards`、`#tabs`、`#log`，没有"隐藏卡片"抽屉或列表。

于是：可见 = `project`/`files`/`editor`（mod 视图再加 `mod`/`problems`）；不可见 = `note`/`runner`/`sheet`/`story`/`pixel`/`docs`。

最刺眼的三处：

- 空状态提示写 "Type `note hello` or `open <path>`"（`shell/web/main.mjs:788-789`），而 `note hello` 建的 `note` 卡正是不可见的那类（`shell/web/main.mjs:1418-1422`）。首次运行照做，界面只会"空状态消失、别的不变"。
- 最近两个提交的主角都在不可见列表里：`story` 卡（.yarn 行 ↔ 翻译表）与 `pixel` 卡（精灵编辑）。`story <a.yarn>` / `pixel <a.png>` 只 `addCard`、不切视图（`shell/web/main.mjs:1435-1482`、`:1484-1514`）。
- D006 行点开 = `app.openPixelCard`（`shell/web/cards.mjs:5918-5928`），卡被建出来但恒 hidden —— 点击看起来没反应，只有日志多一行 "pixel card added"（`shell/web/main.mjs:1300-1301`）。

修法（代价从低到高）：① 标签页从"只收 editor"放宽到"收一切有 `file`（或 `title`）的卡"，两个视图共用（`classic.mjs:67-72`、`modview.mjs:78-83` + 两个 selftest）；② 给 mod 视图加第三槽位（"工具"面板）轮放 story/pixel/docs；③ 恢复一个卡片抽屉。

这一条不是"新功能"，是"已有功能不可达"：`story`/`pixel` 卡的实现、selftest、命令都齐全，缺的只是布局给它一个矩形。

### 15.2 G30（P0）"分发物零游戏数据"是承诺，不是状态

- `tools/make-installer.mjs:248-256`：注释 "Payload audit -- the game's own data must not ship"；`AUDIT_ALLOW` 第一项就是 `resources/shell/mods/knowledge.json`，理由 "the characters/commands/nodes ARE the game"；`:254` 写 "TODO: must be empty before public distribution"。
- 闸门确实会失败（`:411-412`），但 `--no-audit` 只打 WARNING 照编（`:414`），而 `CHANGELOG.md:724-725` 明写 "release candidates are built with `--no-audit`"。
- 审计是**文本标记扫描**（`:397` 跳过非文本文件）：能查"游戏名字出现"，查不出"这张 PNG / 这个 `.atlas` 来自游戏"。
- 所以今天按 CHANGELOG 的办法出包，安装包里仍带 295 KB 游戏知识库（53 角色 + 配色、136 命令签名、1221 节点标题、18637 个 lineId）。
- 落地三步：白名单清零（= G26 的执行）；`--no-audit` 只许 dev（CI/发布脚本禁止）；把"名字扫描"扩一条"素材来源/哈希扫描"。
- 安装器 e2e 的 `dist/` 退异已在 `CHANGELOG.md:730-735` 记录并判为环境效应（sha256 相同、`build/` 里 8 秒装好），本轮不重复追；但发布验收只应认"交给用户的那份字节"。

### 15.3 G31（P1）本机派生 KB：两块砖已有，缺的是接线

- 已有：`shell/mods/gamepath.js` + `shell/mods/index.js:30/33/36/209-211`（`--game-dir` → `INFANTGOD_GAME_DIR` → 搜索根，不再写死路径）；`tools/gen_knowledge.mjs`（`--help` 顶部自述"派生数据"边界，`:556` 用 `discoverGameModsDir`）。
- 缺：**没有任何调用点**；`make-installer` 还把 `knowledge.json` 当"要发的东西"（15.2）；缺 KB 时 `validate.js:780` 已能报 `E000`（G6 前半已修），但 `validateModPackage` 的 `{}` 兜底是否仍在需要重测（上一轮记在 `validate.js:768-769`）。
- 目标形态：发布物不带 `knowledge.json` → 首启读 `gamepath` → `gen_knowledge` 派生到 `%APPDATA%\OsanaKami IDE Studio\knowledge.json`（或 `<workspace>/.infantgod/`）→ 缺失时 UI 明说"没找到游戏目录，只做结构与引用自查"。
- 副产品：KB 与用户游戏版本天然一致（G5 的"过时 + 无 build id"消失）；跨 Mod 撞名检查（G3）可覆盖用户已装的所有包。

### 15.4 G32（P1）改名只动了标识层：§14.3 的执行进度

- 已做：`6673a89` 改 `package.json` 的 name/productName/author/publisherName、appId `com.osanakami.idestudio`、卸载键、窗口标题、关于框、HUD 品牌、`.lang` 头、新建 Mod 的 README 生成行、首启工作区 `Documents/OsanaKamiIDEStudio`、安装器产品名与输出文件名、EULA/README/LICENSE/docs、签名主体 `CN=OsanaKami IDE Studio`（`CHANGELOG.md:29-34`）。
- 免责声明已存在：`README.md:597` "OsanaKami IDE Studio is not affiliated with, endorsed ..."；`CHANGELOG.md:40-41` "The game's own names are still used only descriptively"。
- 也就是说 §14.3 的第 1 档（描述性使用 + 免责声明）已落地，第 2 档（产品名去游戏名）做了一半。
- 仍未解：OsanaKami 是《幼神》的日文读音，混淆没有真正消除（改名日志自己把它列为未决）；`appId` 已变 → 旧安装与旧 `%APPDATA%\InfantGod Studio\settings.json` 需要一次兼容读取，否则升级 = "新程序 + 丢设置"；`infantgod.exe`/`.infantgod/`/协议名 `infantgod/2` 保持不变（作者说明是内部标识、且无 C 工具链不能重编内核，判断合理）。
- 剩下的两件是流程不是代码：问作者一次（群规：一次）；把免责声明放进安装许可页与关于框（今天只在 README）。

### 15.5 已关闭（本轮复测）

| 编号 | 结论 |
|---|---|
| G1 4 MiB | 已修：blob 会话（`file.blobOpen/Read/Append/Commit/Abort`）+ 故事卡翻译表走会话；4 MiB 拒绝保留，作为 blob 路径的边界 |
| G6 前半 | 已修：KB 缺失 → `E000`（`shell/mods/validate.js:780`） |
| G7 部分 | 已修：`#line:` 解析、行 ↔ CSV 行、新增行写 CSV；仍无删除/重排/节点增删 |
| G14 大幅 | 已修：`tools/e2e.py`、`tools/demo.py`、`browser_smoke`、`input_smoke`、`kernel_probe` |
| G20 部分 | 已修：解码按名字拒绝非 8-bit / 非 RGB(A) / 隔行 PNG（残余见 15.6） |
| G25 部分 | 视图只剩两种 —— 但代价见 G29 |

### 15.6 仍开（复测行号）

- **G2·G21 音频引用**：`shell/mods/**` 仍无 `externalAudioFile` / `voiceOverFiles` 的存在性校验（全仓 grep 只命中提示文案）。
- **G3 重名 TechName**：仍无检测（`duplicate` 零命中）。
- **G16 诊断跳行**：`shell/web/cards.mjs:5909`、`:5925` 调 `app.openFile(path)` 不带 `{at}`；`shell/web/main.mjs:1138-1156` 的 `openFile` 只把 `options.at` 当"卡片放哪"，不传给编辑器。
- **G17 problems 卡**：`shell/web/cards.mjs:5874-5969` 只有 root 输入 + validate + 计数 + 列表；无筛选/分组/抑制/导出/单行重跑。
- **G18 docs 卡无 root**：`shell/web/cards.mjs:6015/6037/6059/6072` 的 `mod.docFor`/`mod.search`/`mod.stats`/`mod.types` 都不带 root。
- **G20 残余**：`shell/web/pixelpng.mjs:651-655` 的 `encodePng(image)` 固定写 8-bit RGBA（colour type 6）→ 语料 9 张 RGB PNG 保存后整文件变 RGBA。
- **G22 spine**：`spineAssetPath` 仍不校验 —— 示例包自己都写了 "the editor does not validate spineAssetPath today (docs/EDITOR_GAPS.md G22)"（`examples/Mods/Lantern/Spine/Warden_Rig.json:2`）。
- **G11/G12/G13**：本轮未复测；上一轮结论仍是"无安装到游戏 / 无启动游戏 / CLI 无 mod 动词"。
- **判定修正（见 §17.1）**：G17 的"单行重跑"其实已经有了（`cards.mjs:5966-5968` 自动跑 validate），只是仍无筛选/分组/导出；G11 因 IDE 自己有了安装器而算"部分"（装的是 IDE，不是 Mod）；G25 判定为已修（画布退场）。

### 15.7 G33（P2）文档开始自我引用，而本文第 9–14 节已部分过期

- `examples/Mods/Lantern/README.txt:8`、`:157` 与 `Spine/Warden_Rig.json:2` 已把 `docs/EDITOR_GAPS.md` 当项目文档引用（G22/G26）。
- 但本文件当前是 ` M`（未提交），且 §9（决定不用 ComfyUI）、§10（冻结 ComfyUI 图）、§13（五卡不可见）、§14.3（名称）在本轮被推进/推翻 → 示例包引用的是过期结论。
- 处置：只追加本节 + 在 §13、§14.3 顶部加"状态更新"指针；历史节保留判断过程，不重写。

### 15.8 本轮结论

1. **P0 只有两件**：G29（6 种卡在两种视图里不可见，含首次运行的 `note hello` 与 D006 的像素卡）与 G30（白名单未清 + `--no-audit` 出包 = 游戏数据仍在安装包里）。
2. 上一轮 P0 的 G1/G3/G6/G7 里，G1、G6 前半与 G7 大部已关；G3 仍开。
3. 改名与免责声明把 G28 从"风险"降成"流程项"；真正的法律状态取决于 G30。
4. 如果把本文当路线图用：先把 G29 修到"点得到"，再清 G30 白名单，再接 G31 的首启派生 —— 这三件做完，G26 的决定才算真的落地。
### 15.9 §14 修法表漏掉的一条

- **NOTICE**：Electron/Chromium + seIDE（MIT，必须），游戏那段改成一句"本程序不包含游戏数据；所有定义/命令/schema 均由你在本机从已安装的游戏派生"。

## 16. 复审补充：一轮独立只读审计的 20 项（F1–F20）

> 来源：2026-10-17 21:2x 另一名子代理的独立只读审计（HEAD `6673a89`，与 §15 同一棵树），报告到达晚于 §15。Lead 抽查了 F1/F2/F3/F6/F7/F8/F9/F10/F13/F19/F20 的关键行号，全部对上；其余按报告记录，未复跑 `npm run dist`（按设计会 exit 1）。它与 §15 不重叠的领域是：Electron 新建模组交互、NSIS 安装器、KB 生成器、headless CLI、示例包 CSV。

### 16.1 新建模组（F1–F6）

| 编号 | 发现 | 证据 | 后果 |
|---|---|---|---|
| F1 | 保存对话框不受工作区约束，唯一的补救分支默认走不到 | `electron/main.js:420-425` 只设 `defaultPath`，无 containment 预检；`:429` 直接把所选路径交给 `plan()`；`shell/main.mjs:440` root 默认 workspace；`shell/mods/index.js:250-251` 抛 `路径越界`；补救在 `:462-477`（`isInside` 为假才问"设为工作区"），而默认 `defaultParent` 是 modsRoot 不是 workspace | 对话框邀请用户选 `<another-volume>/Mods`，唯一反馈是一句原始 EOUTSIDE；补救代码存在但默认永不执行 |
| F2 | 同名二次尝试是死局 | 帧不带 `overwrite`（`shell/main.mjs:487-491` 只转发 dir/modName/template），`shell/mods/scaffold.js:1227` 拒绝非空目标；对话框却带 `showOverwriteConfirmation`（`electron/main.js:424`） | 任何部分失败后只能去资源管理器删目录，菜单永远修不好自己写了一半的东西 |
| F3 | 脚手架成功后写设置失败，被报成整体失败 | `electron/main.js:436` 先写 `newModDir` 再弹成功框；任何抛错落到 `:478-482` → "新建模组失败"，`:462-466` 被跳过 | 包已在盘上却报失败，用户重试即撞 F2 |
| F4 | scaffold POST 没有超时 | `electron/newmod.js:130-134` 裸 `await post(...)`，无 `AbortController`；shell 启动有 10 s 界（`electron/main.js:197-201`） | 内核卡住 = 菜单项毫无反应（无对话框、无错误），连按 Ctrl+N 会叠请求 |
| F5 | `?mod=` 打开失败被误诊为内核断线 | `shell/web/main.mjs:2272` 在 `boot()` 里 await `openRequestedMod()`；reject 进 `:2352-2357` → status `unreachable` + "kernel not reachable" + `scheduleReconnect()` | 包打不开（被删/ACL/越界）时告诉作者"内核死了"，并启动重连风暴 |
| F6 | 脚手架生成的 `mod.json` 仍写旧产品名 | `shell/mods/scaffold.js:1194` 默认 description 是 `${modName} — 由 Infant God Mod IDE 脚手架生成的 Mod。`；README 生成行 `:1076` 已改为新名 | 作者第一个交付物保留一个已不存在的产品名，且没有测试钉住这个字符串 |

### 16.2 安装器与安装包（F7–F14）

| 编号 | 发现 | 证据 | 后果 |
|---|---|---|---|
| F7 | 发布闸门是红的，而发布候选都带 `--no-audit` 编 | `tools/make-installer.mjs:411-414`（`--no-audit` 只 `console.warn`）；allow-list `:254-258` 只有 3 个文件而发布树在 14 个文件里出现《幼神》；`CHANGELOG.md:722-725` 自述 red 且 RC 用 `--no-audit` | 唯一的自动防泄漏在文档化发布路径上被关掉（= G30） |
| F8 | 安装包里有真实游戏台词 + 一张只能本机跑的开发卡 | `package.json:54-57` 原样收 `examples`（`dist/win-unpacked/resources/examples` 26 文件）；`examples/hello.yarn:10` = `Aistalt: 嗨，大家好。欢迎来到幼神的直播间。 #line:0630975`；`examples/board.json:40` 跑 `python tools/e2e.py`；而 electron/ 与 shell/ 全仓不引用 `examples/` | 游戏文本进 Program Files；这份"示例"用户点不到（既泄漏又不可达） |
| F9 | 295 KB 知识库是游戏数据、被 git 跟踪、未被过滤地进包 | `package.json:37-45` 只排除两个 selftest；`git ls-files` 含 `shell/mods/knowledge.json`；内容 = 53 角色名+配色（`{"name":"Aistalt","colour":"#7c4ec1"}`）、1221 节点标题+文件路径、1305 baseline 定义名、136 命令+C# 源路径 | 分发问题集中在一个文件里 —— 而这正是审计 allow-list 第一项（= G30） |
| F10 | 卸载是盲删，而安装目录可改 | `tools/installer.nsi:111` `MUI_PAGE_DIRECTORY`、`package.json:75` 可改目录、`:165` `RMDir /r "$INSTDIR"` 无标记/归属校验；且从不删 `%APPDATA%\<product>`（`electron/main.js:60-61`：settings.json、boot.log） | 装到 `<another-volume>/Mods` 再卸载会删掉无关文件；"卸载"又留下设置，重装不是干净状态 |
| F11 | 无原地升级、无运行中检查 | `installer.nsi:128-129` `SetOverwrite on` + `File /r`；`:142-153` 只覆盖一个 HKCU 卸载键；无版本比较、无进程检查、无旧目录清理 | 程序开着升级 → 0.1/0.2 混合树但"安装成功"；旧副本变孤儿（卸载器还在盘上，已不注册） |
| F12 | 两条安装器管线写同一文件名、卸载语义不同 | `package.json:14`（`dist` = sign `--dir` + 我们的 `installer.nsi`）vs `:16`（`dist:nsis` = electron-builder 自己的 NSIS）+ 惰性的 `nsis` 块 `:73-78`；两者默认都产出 `dist/OsanaKami IDE Studio Setup 0.1.0.exe` | 最后跑谁就发谁：注册表键/页面流/卸载器完全不同 |
| F13 | MIT 文本没进包，而 EULA 让人去看它 | `EULA.txt:7` 指向 LICENSE/LICENSE-DOCS；`package.json:28-58` 两个都不收；`dist/win-unpacked` 只有 Electron 的两个许可 + `installer.nsi:134` 放的 EULA；文档同样缺席（demo README 引用的 docs/MODS.md、docs/EDITOR_GAPS.md 都不在包内） | 声称 MIT 却发不带许可的二进制；装完的程序让读者去查两个不存在的文件 |
| F14 | 陈旧 payload 检测不出来 | `make-installer.mjs:471-472` 只比安装器 mtime 与 `startedAt`、`:475-476` 只设 25 % 体积下限；没有任何一步比较 `dist/win-unpacked` 与 `shell/`、`electron/`、`build/infantgod.exe` | 改完 `shell/` 直接 `npm run installer` 会把昨天的应用重新打包并报成功；单文件修复不改变文件数也不触发体积下限 |

### 16.3 KB 生成器与游戏发现（F15–F18）

| 编号 | 发现 | 证据 | 后果 |
|---|---|---|---|
| F15 | `--check` 对已提交的 KB 永不可能通过，且不记录游戏版本 | `gen_knowledge.mjs:27-33`/`:646-650` 自述提交版故意比 facts-only 富（文档文本、136/63 签名、53 角色配色、undocumentedCommands）；`--check` 默认比较 `DEFAULT_KB`（`:49`/`:707`）；`knowledge.json` 无 `generatedBy`/游戏版本/哈希（`generatedBy` 只出现在新生输出 `:375`） | 无法断言"这份 KB 对应该版本的游戏"：用 0.9 的 KB 校验 1.0 的包，静默通过 |
| F16 | `--out` 可能把富 KB 覆盖成有损版 | `gen_knowledge.mjs:737-743` 无条件 `mkdirSync`+`writeFileSync`，不保护 `DEFAULT_KB`，也不警告目标是富版 | 最自然的"修 drift"动作（`--out shell/mods/knowledge.json`）会毁掉 53 角色/文档文本/命令签名，之后 `--check` 反而通过、`mod.characters` 静默变空 |
| F17 | 显式 schema/defines 目录把 CWD 当游戏根 | `:670-671` `resolved.dir = path.resolve(args.gameDir || process.cwd())`；`ENOGAME` 守卫 `:360-364` 只在没给显式目录时生效 | 在仓库根跑生成器，得到的"游戏 KB"混进本仓库 examples/fixtures，且无警告 |
| F18 | 一个过期的显式路径会关掉全部回退，且状态不可见 | `shell/mods/gamepath.js:144-150` 显式值不是游戏目录就立即返回 `not found`（在 env/Steam 探测之前）；`tried` 上限 240；`mods.gameMods()`/`knowledgeState()`（`index.js:969-976`/`:982-991`）已导出但不在 `MOD_METHODS`（`shell/main.mjs:469-505`）、也未被 shell/web 使用；KB 缺失时 `mod.stats` 返回 `{}`（`index.js:384-386`） | 游戏搬家或更新后只说"not found"，没有原因、没有 UI 去改设置；KB 在不在同样不可见，类型列表静默变空 |

### 16.4 CLI 与示例包（F19–F20）

| 编号 | 发现 | 证据 | 后果 |
|---|---|---|---|
| F19 | headless CLI 没有任何 mod 动词 | `tools/seide_cli.py:1-41` 只有 hello/info/ls/cat/write/board/run/selfcheck，且只是内核客户端（`:107-109`，`.infantgod/board.json`）；`mod.*` 只在 `shell/main.mjs:469-505`；全仓无 pack/deploy/zip；`docs/MODS.md` 不提 CLI。另有两处契约破坏：`cmd_run` 返回子进程退出码（`:366`）与文档的 1/2/3/124 冲突；`--from` 的 `io.open` 无 try（`:263-264`）→ 原始 traceback | 作者 headless 最需要的 validate/scaffold/install 恰好都做不到；CI 只能驱动内核（= G13 的具体化） |
| F20 | 示例包的翻译表锚在仓库路径，且它教的第二条课无人检测 | `Lantern.csv:2-6`、`Lantern_en.csv:2-5` 的 `file` 列写 `examples/Mods/Lantern/Yarn/Lantern.yarn`（按 README 拷进 `<game>\StreamingAssets\Mods\` 后就错）；`validate.js:1082-1112` 只查表头与行数（`:1103-1111`），`Lantern_en.csv:5` 故意写坏的 `lock` `00000000` 不产生任何诊断，只有行数差被报 | 示例装完自己就错了；"两条故意的缺陷"实际只检测到一条 |

### 16.5 与 §15 的对应

- F7/F9 = G30（同一问题的具体证据）；F13 = §14.2 的 L3 复现；F19 = G13 的具体化。
- 本轮新增独立问题：F1–F6（新建模组交互，G34）、F8（`examples/` 进包，G35）、F10–F12（安装/卸载/双管线，G36）、F14（陈旧 payload，归入 G36）、F15–F18（KB 生成器，G37）、F20（示例 CSV，G38）。

### 16.6 校准：这份审计认为做得对的地方

- 新建模组的内核接缝拆分干净（plan/create/url/menu 纯函数，`shell/mods/selftest.mjs:625-904` 钉住模板对齐、每个拒绝分支、帧形状、CJK 修剪、一次真实 `serve`+POST，还钉住历史上的双重嵌套 bug）。
- containment 在服务端强制，被拒的异步动词是帧而不是崩溃（`index.js:250-251`、`shell/main.mjs:560-567`）。
- 安装器会验证自己产出的东西：mtime、25 % 体积下限、sha256、签名后重算、`Get-AuthenticodeSignature === "Valid"`、`build/make-installer.json` 汇总。
- per-user 免 UAC 安装做对了（`RequestExecutionLevel user`、`SetShellVarContext current`、HKCU 卸载键含 `QuietUninstallString`、内嵌 `WriteUninstaller`）。
- 目录发现不写死任何机器路径并报告来源（`gamepath.js:134-181`）；整棵发布树 grep 不到用户主目录；`tools/make_icon.py:22-23` 同样干净。
- 审计设计本身是对的（身份遮蔽、真解 `app.asar` 条目、从 payload KB 推角色表、allow-list 带理由与 TODO）——问题只在它默认不执行。

### 16.7 本轮结论（与 15.8 合并读）

1. P0 由两件变三件：G29（6 种卡不可达）、G30（游戏数据仍可进包）、**G35**（`examples/` 原样进包且不可达）。
2. 安装器在"删用户数据"和"发错字节"两条路径上都没有护栏（G36），而它是唯一能删用户文件的组件。
3. KB 生成器的四个自伤（G37）说明"可再生产"还没到"可安全再生"；在接上首启派生（G31）之前，`--out` 应当被禁止指向 `DEFAULT_KB`。
4. 新建模组是首次运行唯一显式的入口，六处失败路径（G34）里没有一处给出可操作信息 —— 这一项的成本最低、观感收益最高。

## 17. 复审补充（二）：逐条判定 G1–G25 + 六个新洞（N1–N6）

> 来源：第二名子代理的独立只读复审（HEAD `6673a89`，只读、未写任何文件；它把本文件当成"另一会话正在改"的证据而排除）。与 §15/§16 的差别是它**逐条判定**（FIXED / PARTIAL / STILL TRUE）并给出复测行号；Lead 抽查了 N1–N6 与 G17 的关键行号，全部对上。

### 17.1 逐条判定（G1–G25）

| 编号 | 判定 | 复测证据 | 与 §15 的关系 |
|---|---|---|---|
| G1 | **FIXED** | `core/include/blob.h:43` `SDE_BLOB_MAX_CHUNK = 1 MiB`；`core/src/rpc.c:1000-1004` 注册 `file.blobOpen/Read/Append/Commit`；`shell/web/cards.mjs:1464/1559` 分块助手；故事表读 `:4197`、写 `:4143` | 一致 |
| G2·G21 | STILL TRUE | `validate.js` 对 `externalAudioFile`/`voiceOver` 零命中；`shell/web` 无 `AudioContext`/`<audio>`/`new Audio`；KB 里有字段但没人读 | 一致 |
| G3 | STILL TRUE | `validate.js:851-871` 只查 loadOrder（M004）；`:939-943` 的 techNames 只用于解析本包引用；无重名诊断 | 一致 |
| G5 | **PARTIAL** | `tools/gen_knowledge.mjs` 已有（764 行，`--check`/`--diff`）+ `gamepath.js`；但 `DROP_KEYS` 含 `description`（`:52`、剥离 `:91-97`），而校验器的 sprite 启发式正靠它（`validate.js:77`）；头注释 `:29-33` 自认 drift；无 Makefile 目标 | 补上"再生后更穷"（→ G41） |
| G6 | **FIXED** | `validate.js:775` `kbPresent`、`:779-784` 推 E000、`:1132-1133` `ok = errors===0` | 一致；E000 文案提到"baseline 撞名检查"但该检查并不存在 |
| G7 | **PARTIAL** | id 双向解析（`story.mjs:134/471`、`storycsv.mjs:38/120`、`cards.mjs:3793`），但保存仍只 append（`cards.mjs:4120`）、译文只读、无更新/删除；孤儿行只报告（`storycsv.mjs:331-347`） | 一致（→ G40） |
| G9 | STILL TRUE | `validate.js:77` 的 `RE_SPRITE_DESC` 仍是唯一的存在性启发式（25 个属性）；无 `spineAssetPath`/`externalAudioFile`/`voiceOver`/Addressables 检查（9 个 Addressable 引用属性未查）；D006 `:564-579` 是唯一的文件检查 | 一致 |
| G11 | **PARTIAL** | `tools/installer.nsi:70` 装到 `$LOCALAPPDATA`；`electron/main.js:361-368` 有 mods 目录选择器；但没有任何代码把 Mod 拷进 `StreamingAssets`，`scaffold.js:1083` 仍教手动拷 | 修正：IDE 有了安装器，Mod 分发仍无 |
| G12 | STILL TRUE | `electron/main.js:185` 只 spawn Electron 内核；无 `Player.log`/`steam://`/开 Mod 代码 | 一致 |
| G13 | STILL TRUE | `shell/main.mjs:1031-1069` 只收 rpc/serve；`seide_cli.py:188-372` 无 validate 动词，Makefile 也无 validate 目标 | 一致 |
| G16 | STILL TRUE | `cards.mjs:5536` `diagWhere`、`:5902-5906` 指针进行 meta、`:5909` `openFile(path)` 无位置；`main.mjs:1151` 把 `options.at` 当屏幕坐标 | 一致 |
| G17 | **PARTIAL** | `cards.mjs:5882` 有 validate 按钮、`:5966-5968` 自动跑（重跑确实有）；`:5894-5930` 无筛选/分组/抑制/导出 | 修正我把"重跑"也算缺 |
| G18 | STILL TRUE | `cards.mjs:6015` `mod.docFor {kind,name}`、`:6037` `mod.search {query,limit}`；`index.js:434-446` 忽略 root、索引只来自 KB（`:430`） | 一致 |
| G19 | STILL TRUE | `classic.mjs:23` 侧栏只有 project/files；`modview.mjs:26/29` 只有 editor+problems；`main.mjs:1974` 只 watch `kind==="editor"` | 一致（→ G29） |
| G20 | STILL TRUE | `pixelpng.mjs:280-286` 拒绝 depth≠8 / type 非 2/6 / 隔行；encode `:651-696` 恒写 8-bit RGBA filter 0 | 一致 |
| G25 | **FIXED** | `views.mjs:37/46` 只剩 classic/mod；`main.mjs:1676` 拒绝 `mode board`；`index.html:29` 有 `#board` 无 `#stage`；`board.json` 退化为瓦片布局 | 一致（代价见 G29） |

### 17.2 六个新洞（N1–N6 → G39–G44）

- **N1 → G39（`file.read` 边界仍在编辑器与 `.yarn` 上）**：`cards.mjs:2438` 编辑器打开整文件读、无分页兜底（catch `:2455-2458`）；`:4167` 故事 `.yarn` 同样整文件读。于是 11 张语言表能在表卡里开、不能在编辑器里当文本开，>4 MiB 的 `.yarn` 仍失败。G1 只把"表"挪过了边界，没挪"文本"。
- **N2 → G40（翻译循环只显示 + 只追加）**：`translationOf`（`cards.mjs:3793`）读行，`:4120` 只 append；`storycsv.mjs:128` 的 `setColumn` 在 `cards.mjs` 里**没有任何调用点**；删掉一个 `#line:` 后孤儿行只被报告（`storycsv.mjs:331-347`），不会被清理。
- **N3 → G41（再生 KB 静默关掉 sprite 检查）**：`gen_knowledge.mjs:52` 的 `DROP_KEYS` 含 `description`（`:91-97` 剥离），而 `validate.js:77` 的 `RE_SPRITE_DESC` 正是用 "Relative path to sprite image file" 这句英文描述去识别 25 个 sprite 字段。于是"按第 32 项修好 drift、重新生成 KB"之后，sprite 字段集变成空集，D006 不再报，`ok:true` 依旧。**没有测试或 CI 护栏**。这是全部复审里最阴的一条：两条线各自都对，合起来是"全绿但没查"。
- **N4 → G42（CSV 往返丢 BOM、非 UTF-8 被改写）**：`cards.mjs:1467` 用流式 `TextDecoder` 解码，BOM 在解码时被吃掉 → `storycsv.mjs:161` 的 `parseCsv` 永远读不到 BOM → `serializeCsv`（`:183`）也就不写 BOM，而游戏导出的表是带 BOM 的（`storycsv.mjs:32`）；非法 UTF-8 字节变成 U+FFFD 并在保存时写回（子代理用 node 验证过）。
- **N5 → G43（locale 搜索命中打开空白文档）**：`search.js:454` 把 locales 编进索引，但 `docFor` 的 switch（`:815-829`）没有 `locale` 分支、默认返回 null → 文档卡拿到空串、面板静默空白。
- **N6 → G44（游戏目录/KB 来源不可见）**：`index.js:969-986` 有 `gameModsInfo`/`knowledgeState`，但 `MOD_METHODS`（`main.mjs:469-505`）一个都没暴露，`openMod`（`:631-640`）也不返回 KB 信息 → UI 无法告诉用户"没找到游戏目录"或"KB 是 2026-10-14 的"。

### 17.3 两份补充审计的交叉点

- **完全一致**：G1/G6/G25 已修；G2·G21、G3、G9、G12、G13、G16、G18、G19、G20 仍真；G7/G11/G17 部分。
- **互相补位**：§16 看的是 Electron 交互、NSIS 安装器、KB 生成器、CLI、示例包；§17 看的是 mod 层与卡片的代码路径，并补上了"生成器与校验器耦合"这个 §16 只擦到边的后果（§16 的 F15/F16 是"生成器会自伤"，§17 的 N3 是"自伤之后校验器还假装全绿"）。
- **冲突已消解**：G17 的"重跑"、G11 的"安装器"、G5 的"可再生"这三处差异都在上面表格里改判并注明。

### 17.4 优先级补丁

- 新增第 34–37 项（见 §6）：拆 G41 耦合 → 把 blob 接到编辑器/`.yarn`（G39）→ CSV 往返保真（G42）→ 故事卡编辑补齐 + locale/KB 可见性（G40/G43/G44）。
- **P0 最终是四件**：G29（可达性）、G30 与 G35（分发物带游戏数据）、G41（再生 KB 静默关掉体检）。四件里三件的共同点是"系统在对自己撒谎"——报告成功、报告干净、报告没检查。

## 18. 格式兼容与分发：逐格式对照与 zip 方案（2026-10-17 实测）

### 18.1 逐格式对照

| 文件 | 语料实测 | IDE 怎么处理 | 往返保真 | 判定 |
| --- | --- | --- | --- | --- |
| `mod.json`、`Defines/**.json` | UTF-8；`validate.js:462/809/930/1087` 解析前剥 BOM 兜底；`scaffold.js:1345` 只在新建时统一成无 BOM + `\n` | 当文本编辑，JSON 解析/校验 | 保真 | 兼容 |
| `*.yarn` | 无 BOM、LF（`MyMod/Yarn/Logic/0.Initial.yarn`，1 544 B，CRLF 对 = 0） | 故事卡保留 BOM 与行尾：`story.mjs:592` 先探 `\r\n`、`:835` 报告行尾、`selftest.mjs:3058` "a BOM is kept" | 保真 | 兼容（全仓样板） |
| `NewProject*.csv` | **UTF-8 带 BOM**（`ef bb bf` 后紧接表头；`NewProject_EN.csv` 4 677 787 B） | 表卡流式 `TextDecoder`（`cards.mjs:1492`）**已改为** `{ stream: true, ignoreBOM: true, fatal: true }`（`ff4693a`）：BOM 留在正文里 → `storycsv.mjs:161` 读到 `bom:true` → `:183` 原样写回；非 UTF-8 字节直接拒绝 | 保真 | ✅ 已修 = G42 |
| `*.png` | 374 张：365 RGBA / 9 RGB | `pixelpng.mjs` 只吃 8-bit RGB/RGBA 非隔行；保存固定写 RGBA（`:651-655`） | RGB → RGBA | 兼容但非保真 = G20 残余 |
| `*.wav` | 6 个：`Tech_Monologue.wav` 5.31 MB 立体声 31.6 s；`test_vo_1..5` 各 265 KB 单声道 3 s；PCM 44.1 kHz | 只按文件名识别；不能打开、不能试听、不校验头 | 不可检 | 不校验 = G2 |
| Spine 三件套 `<Name>.skel.bytes` + `<Name>.atlas.txt` + `<Name>.png` | 40+ 组；`.atlas.txt` 是既有命名；`.spine` 工程文件实测首字节 `ec 7d 07 58 …`（32 627 B），不是 JSON 文本 | **spine 卡已落地**（`cards.mjs:6065` `renderSpine`，加 `spine.mjs` 字节→模型、`spinepose.mjs` 模型→姿态、`spineframe.mjs` 姿态→绘制矩形，`7e4e3d2`）：能读 `.skel.bytes` 与 `.atlas.txt`；但"三件套齐不齐、命名、4.2.43 版本"仍不校验 | 可看不可校 | 部分支持；校验仍缺 = G46 |
| `*.psd` / `*.aseprite` | 36 / 38 个 | 不读 | — | 作者源资产，不是运行格式 |

### 18.2 一条该写进架构的原则

**编辑既有文件＝字节保真；新建文件＝归一化。**

- 做对的样板：`story.mjs` 保留 BOM 与行尾；`scaffold.js:1345` 只在新建时统一成无 BOM + `\n`，而新建 CSV 反而主动写 BOM（`:726`，与游戏导出一致）。
- 反例：CSV 表卡（G42）、pixel 卡（G20）。

理由：Mod 的文本是给 Unity/FMOD 消费的输入，不是 IDE 自己的项目文件。任何"顺手规范化"都会让作者的文件与游戏、与群里别人的文件不再字节一致；`NewProject-metadata.csv` 的 `lock` 取 SHA-256 前 4 字节，文件一变 lock 就抖，跨人比对直接失效。

### 18.3 该补的格式体检（纯读，不需要游戏在跑）

1. **Spine**：三件套齐不齐、是不是 `.atlas.txt` 命名、skeleton 版本是不是 **4.2.43**（wiki `d.美术`：4.2.23 能导出，但读不回游戏导出的 `.json`）。
2. **WAV**：RIFF/WAVE/PCM、采样率、声道（对应 `Mods/Audio` 的 FMOD Programmer Instrument 用法）。
3. **PNG**：色型/位深/隔行；保存前若发现是 RGB，提示"保存会变成 RGBA"。
4. **CSV**：BOM、行尾、8 列、`lock` 列存在性。

四条都落在 `shell/mods/validate.js`，与 G2/G9/G42 同族。

### 18.4 zip：该做，但定位是"分发容器"

**游戏侧不认 zip。** ModLoader 扫的是 `StreamingAssets/Mods/<Name>/` 目录；创意工坊对 Demo 不可用（wiki `h.Mod的发布`：「现在创意工坊还没整出来呢！…先别管了」）。所以 zip 只是传输形态：作者导出、群友下载、解压到 `Mods/` —— 与群里现在百度盘/群文件分发的路径一致。

**现状**：全仓没有 zip/归档实现（`zip` 只命中注释里的"打包"字样）；工具链里也没有归档器。Node v24.16.0 实测自带 `zlib.crc32` 与 `deflateRaw`，所以零依赖写入器可行（local header + central directory + UTF-8 flag，约 200 行）。

**设计要点**

1. **入口**：mod 卡的"导出 zip…"，复用 `electron/main.js:295` 的 `dialog.showSaveDialog`；顺手补 CLI `export`（F19 记录 CLI 只有 `view.load`/`view.save`，这正好补 mod 动词）。
2. **顶层一层目录**：zip 内必须是 `<ModName>/…`，解压到 `Mods/` 即得 `Mods/<Name>/…`；与 M002「文件夹名 ≠ mod.json」的警告呼应。
3. **包含/排除**：包含 `mod.json`、`Defines/`、`Yarn/`、`Sprites|Addressables/`、`Spine/`，以及 `ATTRIBUTIONS.txt`/`LICENSES/`（游戏自带的两个 Mod 都带；也是 G26 剃掉游戏数据后唯一还能放署名的地方）；排除 `.code-workspace`、`.tmp*`、`Thumbs.db`/`.DS_Store`、`dist/`、`*.log`。
4. **编码与大小**：文件名 UTF-8 并置 flag（语料里已有 `ForTest ▓Γ╩╘╙├` 这种乱码目录，说明编码是真实痛点）；>4 MiB 的文件（`wav` 5.31 MB）走流式，不要碰内核 `file.read` 的 4 MiB 上限。
5. **预检门**：导出前跑 `validatePackage`，error 拦下、warning 放行；与 G17 的重跑按钮复用。
6. **确定性**：固定排序 + 固定 mtime，同一个 mod 两次导出字节一致 —— 群里核对"我下的是不是同一个版本"。

**不做**：一键上传/分享（没有服务器，创意工坊不可用）。首版也可以不做"导入 zip"，但**导入才是收件人那一侧**，值得排在后面。

**优先级 P2**：不如 P0/P1 紧急，但便宜、可见、直接对上群里的分发方式。做它时顺手能把 `gamepath.js`（游戏 Mods 目录的唯一发现入口，`:183`）接成"装进游戏"——那才是 G11/§16-F7 那条线，比 zip 更贴 IDE 的本职。

### 18.5 与 §6 的关系

- G42 维持 P1，并升级描述为"唯一确定会改坏 mod 文件的格式问题"；
- G20 的剩余部分（PNG 色型）降为"保存时提示即可"；
- G45（导出 zip）、G46（格式体检）按 P2 排在 §6 的第 38–39 项。

### 18.6 状态更新（2026-10-17 晚，HEAD 已到 `7e4e3d2`）

§18 写完的几小时内，工作树正好修掉了本文主张的三件事，逐条记在这里，免得 §18 的旧描述被当成现状：

- `ff4693a`「A translation table comes back byte for byte, and bytes that are not text are refused」→ **G42 已修**：`cards.mjs:1492` 的 `TextDecoder` 改成 `ignoreBOM: true, fatal: true`，BOM 留在正文里，写回时原样带上；非 UTF-8 字节不再变 U+FFFD。
- `6cf9522`「The build ships no game data, and finds the game to rebuild what it needs」→ **G30/G31 方向已修**：构建不再把游戏数据打进安装包，并会去找游戏目录以重建 KB。§18.4 里 zip 的前提（包里不带游戏数据）因此在安装器侧成立。
- `7e4e3d2`「Spine's transforms are arithmetic before they are a card」→ 立绘/动画这条线开始按"数据 → 算术 → 布局 → 卡"分层：`spine.mjs` / `spinepose.mjs` / `spineframe.mjs` 三层纯模块，`cards.mjs` 只留 `spine` 卡。这正是 §19 要推广到其余大文件上的范式。
- 仍未解决：G46（Spine 三件套/版本、WAV 头、PNG 色型、CSV 列的校验）、G45（zip）、G39/G40/G41，以及 P0 的可达性。

## 19. 文件体积与拆分预案（2026-10-17 实测，工作树状态）

### 19.1 体积实测

`git` 跟踪文件里按行数排前 16（`knowledge.json` 是单行数据文件，只列体积）：

| 文件 | 行数 | 体积 | 为什么大 | 拆不拆 |
| --- | --- | --- | --- | --- |
| `shell/mods/knowledge.json` | 1 | 295 678 B | 游戏基线数据（1305 个 define、51 类 schema） | **不拆**；随 G30/G31 移出分发、改首启生成 |
| `shell/web/cards.mjs` | 7 716 | 267 036 B | 12 种卡 + 84 个导出 + 全部 DOM/画布代码 | **拆（第一优先）** |
| `shell/web/selftest.mjs` | 5 614 | 250 262 B | 237 个 `test()`，覆盖全部卡与纯模型 | **拆（跟随 cards）** |
| `tools/input_smoke.py` | 2 511 | 131 541 B | 浏览器手势逐条验证 | 拆（按手势组） |
| `tools/browser_smoke.py` | 2 757 | 117 495 B | 真浏览器逐面验证 | 拆（按界面） |
| `shell/web/main.mjs` | 2 769 | 106 193 B | 命令表 + 手势 + 启动 + 接线 | 拆（三段） |
| `shell/mods/selftest.mjs` | 2 103 | 105 166 B | 校验/扫描/脚手架的语料测试 | 拆（跟随 mod 层） |
| `CHANGELOG.md` | 1 460 | 101 735 B | 全history | 归档旧版本 |
| `tools/e2e.py` | 2 218 | 97 375 B | 内核 + 壳两套端到端 | 拆（按协议面） |
| `shell/mods/index.js` | 1 440 | 54 539 B | mod 动词与扫描 | 暂不拆 |
| `shell/mods/yarn.js` | 1 224 | 51 376 B | Yarn 诊断 | 暂不拆 |
| `shell/mods/scaffold.js` | 1 393 | 50 900 B | 模板与脚手架 | 暂不拆 |
| `shell/mods/validate.js` | 1 230 | 48 353 B | schema/包/Yarn 三套校验 | 可拆三块 |
| `shell/web/style.css` | 1 878 | 50 194 B | 全部样式 | 暂不拆 |
| `core/tests/test_blob.c` | 1 318 | 46 459 B | C89 测试 | 暂不拆（改 Makefile 目标） |
| `docs/EDITOR_GAPS.md` | 1 071 | 163 825 B | 本文 | 可选分卷（锚点会失效） |

### 19.2 拆分范式（把 `7e4e3d2` 的做法推广）

1. **按"数据 → 算术 → 布局 → 卡"分层**：字节/文件格式解析一层（纯、可在 Node 跑）；几何/变换一层（纯）；像素/矩形计算一层（纯）；卡只做 DOM/画布绑定。纯层是 `selftest.mjs` 真正能测的东西，卡层只测绑定。
2. **入口文件保留为桶（barrel）**：`shell/web/cards.mjs` 继续 `export` 全部 84 个公开名，并**按原顺序**调用 12 次 `registerCardKind(...)`。这样 237 个测试、`shell/web/README.md`、`AGENTS.md` 的"加一种卡"配方、`Makefile` 的 `node shell/web/selftest.mjs` 全都不用动。
3. **避免循环依赖**：卡模块直接 `import` 纯层与 `dom.mjs`，不 import 桶；桶只做 re-export 与注册。
4. **一次一刀**：一个文件一个 commit，每刀之后 `node shell/web/selftest.mjs` 必须绿；`make test` 在阶段末跑。
5. **公开面不变**：导出名集合、`registerCardKind` 的 kind 顺序、测试名逐字不变（文档和 CHANGELOG 引用过测试名）。

### 19.3 `cards.mjs` 的边界（当前行号，会随工作树漂移）

| 行区间 | 现在是什么 | 目标文件 |
| --- | --- | --- |
| 107–665 | 词法/格式化/清单/`projectRows`/命令行解析 | `cards/format.mjs` |
| 691–820 | `KIND_REGISTRY` + `registerCardKind`/`cardKind`/`describeCard` | `cards/registry.mjs` |
| 821–1 147 | sheet 文档模型（单元格、行列、TSV） | `cards/sheet-model.mjs` |
| 1 149–1 447 | story 文档模型（行、说话人、锚点、追加） | `cards/story-model.mjs` |
| 1 428–1 450 | base64/分块 | `cards/bytes.mjs` |
| 1 653–1 810 | DOM 原语（`h`、`cardShell`、`paintTokens`、`renderCard` 分发） | `cards/dom.mjs` |
| 1 813–2 192 | 编辑文本算子（缩进、补全、查找替换、标记） | `cards/editing.mjs` |
| 2 194–3 168 | `renderEditor`（约 975 行） | `cards/editor.mjs`（再拆"壳/工具栏/查找/补全"） |
| 3 169–3 335 | `renderRunner` | `cards/runner.mjs` |
| 3 336–3 375 | `renderNote` | `cards/note.mjs` |
| 3 376–3 499 | `renderFiles` | `cards/files.mjs` |
| 3 500–3 766 | `renderProject` | `cards/project.mjs` |
| 3 784–4 135 | `renderSheet` | `cards/sheet.mjs` |
| 4 136–4 908 | `renderStory`（约 773 行） | `cards/story.mjs` |
| 4 909–5 987 | pixel 常量 + `renderPixel`（约 1 080 行） | `cards/pixel.mjs` |
| 5 988–6 934 | spine 卡（`renderSpine`） | `cards/spine-card.mjs`（数据/算术/布局已在 `spine*.mjs`） |
| 6 935–7 350 | mod 面辅助 + `renderMod` | `cards/mod.mjs` |
| 7 351–7 466 | `renderProblems` | `cards/problems.mjs` |
| 7 467–7 613 | `renderDocs` | `cards/docs.mjs` |
| 7 614–7 716 | 12 次 `registerCardKind(...)` | **留在 `cards.mjs`**（桶，约 150 行） |

估完的桶：≈150 行；单文件最大 ≈1 080 行（pixel），其次 editor ≈975、story ≈773 — 都在 1 200 行以内，符合"可单屏浏览"的实践。

### 19.4 `selftest.mjs`（5 614 行 / 237 test）

- 目标：`shell/web/selftest.mjs` 变为入口（import 各分卷并汇总计数），`shell/web/selftest/<unit>.mjs` 与被测模块一一对应；公共夹具（假 client、假 DOM、样例 yarn/csv）放 `selftest/fixtures.mjs`。
- 顺序：先拆纯模型（format/sheet/story/pixel/spine），再拆卡（DOM 部分）。
- 硬约束：**test 名字逐字不变**（CHANGELOG 与文档引用过测试名）；计数打印仍由入口负责。

### 19.5 其他候选

| 文件 | 建议 |
| --- | --- |
| `shell/mods/selftest.mjs`（2 103） | 同 19.4：`shell/mods/selftest/` 按 validate / yarn / scaffold / search / index 分卷，入口不变 |
| `tools/input_smoke.py` / `browser_smoke.py` / `e2e.py` | 按场景拆 + 共享 `tools/smoke_harness.py`（只标准库）；入口脚本保留，`Makefile` 不动 |
| `shell/web/main.mjs`（2 769） | 拆"命令表 / 手势 / 启动与接線"三块；`view` 相关已在 `views.mjs`/`classic.mjs`/`modview.mjs` |
| `shell/mods/validate.js`（1 230） | 可拆"define 校验 / 包校验 / Yarn 校验"三块；共享 `diagnostics` 先从里面抽出来 |
| `CHANGELOG.md`（1 460） | 旧版本移入 `docs/CHANGELOG-archive.md`，`CHANGELOG.md` 只留当前 `VERSION` 段与指针（`version-check` 依赖当前段仍在主文件） |
| `shell/web/style.css`（1 878） | 不拆：`@import` 会多一轮请求且破坏"一个文件"的可审查性；若必须拆，按 `views/kinds` 分并在 `index.html` 里多 `<link>` |
| `core/tests/test_blob.c`（1 318） | 不拆：C89 且 `Makefile` 有独立目标（`build/obj/test_blob.exe`），拆了要改目标和 `core/tests` 约定 |
| `docs/EDITOR_GAPS.md`（1 071） | 可选：`docs/gaps/` 索引 + 分卷。代价是所有 `#L` 深链与外部引用失效；建议等 §19 落地后再做 |
| `docs/board.png`（179 735 B） | 二进制示例，压缩或从 `examples/` 移除（G35 已指出它随安装包走） |

### 19.6 执行顺序与风险

1. **等卡片层现行改动落地**：此刻 `cards.mjs`、`selftest.mjs`、`spinepose.mjs`、`board.mjs`、`main.mjs`、`style.css`、`browser_smoke.py` 全是 `M`，`spine.mjs`/`spineframe.mjs` 还是 untracked。不在别人手上剪枝（AGENTS.md §6）。
2. `cards.mjs` 桶化：先建 `shell/web/cards/` 并逐个搬运，`cards.mjs` 只留 re-export + 注册；一刀一个文件。
3. `selftest.mjs` 跟随拆分。
4. `shell/mods/selftest.mjs` 与三个 Python 驱动。
5. 文档类（CHANGELOG 归档、本文分卷）最后做。
6. 每刀验收：`node shell/web/selftest.mjs` → `make test` → `make cli-check` → `make path-check` → `git diff --check`；`make smoke` 必须独占跑（AGENTS.md 明写会与别的 agent 冲突）。
7. 文档同步清单（拆完必改，否则文档说谎）：`AGENTS.md` 仓库地图、`README.md` 的"twelve kinds … in the core of `cards.mjs`"、`shell/web/README.md`、`docs/SURFACES.md`、`docs/ARCHITECTURE.md` 的模块清单（trim manifest）、`CHANGELOG.md` 一条。

### 19.7 验收标准

- `shell/web/cards.mjs` ≤ 300 行且不再含 `function render*`；每个新模块 ≤ ~1 100 行。
- 公开导出名集合与拆分前**完全一致**（拆分前后各跑一次 `node -e "import('./shell/web/cards.mjs').then(m=>console.log(Object.keys(m).sort().join(',')))"` 比对）。
- 237 个测试名逐字不变，`node shell/web/selftest.mjs` 与 `make test` 全绿。
- `git grep` 里被移走的函数名只出现在文档/CHANGELOG；`git diff --check` 干净。



## 20. 命名复审：`spine` 该不该叫 spine（2026-10-17，G47，待进行项）

### 20.1 问题

新落地的骨架卡片（§18.6、`7e4e3d2`/`ce93e0b`）把用户可见的卡片 kind、命令与文档概念名都定成了 `spine`。两个理由说明这个名字应该在发布前重新考虑：

1. **商标与许可**。Spine 是 Esoteric Software 的注册商标。这个仓库对第三方名称一向谨慎：README 专门声明对游戏名不主张商标、不暗示官方关系，G28/G32 两轮改名就是为了把游戏名从产品标识里拿掉。而 `spine.mjs` 的文件头明确写着布局参考 `SkeletonBinary.java`（Spine Runtimes License，见 CHANGELOG Unreleased 段）——解析器是独立重写、没有 vendored 代码，合法上是干净的；但把功能**命名**为别人的商标，是在品牌层面替这个格式背书，与仓库自己的谨慎不一致。
2. **语义过度承诺**。这张卡片不是通用 Spine 编辑器：只读 4.2 二进制的一个子集（`spine.mjs` 头注），不认识的 timeline 类型是故意忽略的（`spinepose.mjs`），正在做的 `spineedit.mjs` 编辑的是游戏的 rig 文件而不是 Spine 工程。叫 `spine`，作者会期待"一个 Spine"。对照组是同仓库的 `pixel` 卡——README 明说 "Not a paint program"，按名字拒绝其它 PNG 形状；`spine` 这个名字恰恰在相反方向暗示。

### 20.2 保留一方的理由（记录在案，免得复审时重来一遍）

- **诚实与可搜索**：解析器实现的就是 Spine 4.2 格式，文件头引用官方运行时，名字叫 `spine.mjs` 让人立刻知道字节布局的出处；`yarn`/`json` 卡也是按格式命名的，有先例。
- **作者词汇表对齐**：游戏字段叫 `spineAssetPath`，wiki 也管这个叫 Spine，Mod 作者搜 "spine" 能找到。
- **改名有成本**：`spine*` 四个模块、`cards.mjs` 注册、`PARADIGM.md` 卡表、README、CHANGELOG、MODS.md、自测与 smoke 约 13 个文件；AGENTS.md 要求 rename 走 documented, mechanical change 并进 `docs/FORK.md`，不能零散改。

### 20.3 建议切法

- **用户可见层改名**：卡片 kind、命令（`spine <path>`）、文档概念名 → `rig`。这是仓库里已有的词：`examples/Mods/Lantern/Spine/Warden_Rig.json`、提交信息原文 "A Spine **rig** becomes a card"；§19.3 规划里的 `cards/spine-card.mjs` 随之变 `cards/rig-card.mjs`。
- **格式层留名**：`spine.mjs`/`spinepose.mjs`/`spineframe.mjs`/`spineedit.mjs` 保留——它们确实就是 Spine 4.2 格式的实现，对兼容性格式的指名使用（nominative use）与"拿商标当产品名"不是一回事，注释里继续引用官方布局不变。

### 20.4 时机与联动

- 目前 `spine` 只出现在 CHANGELOG 的 **Unreleased** 段，改名窗口就是发布之前；一旦随版本发布，`"kind":"spine"` 会进用户的 `.infantgod/board.json` 持久文档，再改就要处理存量文档的迁移。
- 与 §19 的拆分放在同一刀里做最省：拆出 `cards/rig-card.mjs` 时顺势改 kind 字符串，而不是先拆 `spine-card.mjs` 再改一遍名。
- 与 G46 不冲突：G46 要的是"Spine 三件套/4.2.43 版本体检"，那里按格式名指称是对的，不受本条影响。

## 21. 给人用的三件事：设置 UI、agent 界面、"+"（2026-10-17，G48–G50，待进行项）

### 21.0 出处

这一轮元分析（"项目管理为 AI 优化、人类可读性是付掉的代价"）的三个直接落地项。理由一句话：**这个 IDE 的最终用户是 mod 作者，是人**；而为 AI 优化的那套机制（CLI、协议、文档论证）人可以绕，但"没有设置界面"、"AI 能力没有界面"、"文件不能从编辑器里出生"这三件事人绕不过去。

### 21.1 G48 显式设置 UI

**现状盘点（配置今天散在哪）**：

- 命令行参数：`--workspace` / `--mods-root` / `--no-open`（`shell/main.mjs`）——改一次要重启进程；
- AI 配置：`shell/ai/config.mjs` 已经实现了 userData 下的读写、校验和密钥脱敏（密钥不进日志、错误和 `describe()`）——**这是现成的设置后端，缺的只是界面**；
- 代码常量：`BOOT_VIEW`（窗口打开在哪个视图，`shell/web/main.mjs`）、watch 轮询间隔 1.5 s（`shell/web/watch.mjs`）、4 MiB 读上限（`core/include/wksp.h:24`）——普通作者一个都够不到。

**建议形态与决策点**：

1. **分层持久化**：用户级偏好（AI 端点/模型、默认视图、轮询间隔）→ userData，复用 `config.mjs` 的校验与脱敏；项目级状态 → 仍是 `.infantgod/board.json` 的职责，不混。
2. **界面载体**：一张 `settings` 卡是最省的路（卡片管线、关闭确认、watch 全都现成），但按 G25 的结论，能力先落 Node 侧动词（如 `config.get`/`config.set`），卡片只做绑定——这条前置链与 G44（`gameModsInfo`/`knowledgeState` 未暴露）同源，可以一起做。
3. **文档同步**：README 的 "What it is not" 里 "no settings UI" 一句要删——这是它第一次从"明确不做"清单里划掉一项，CHANGELOG 记一笔，措辞按"哪几项可配、其余仍不可配"写，别把门开得比实际大。

### 21.2 G49 agent 界面

**现状**：`shell/ai/` 三件地基已在（provider 非流式 + SSE 流式 + tool calling、config、两个只读工具），且明确声明"Agent 是普通 RPC 客户端；对话循环、RPC 注册、diff 卡、UI 都在这一层之外"。也就是说**引擎在、车身没有**。

**形态冲突必须先解决**：AGENTS.md 非协商条款 4 写着 "one document, two views……不要第三视图"。三个候选形态，按对架构的侵入排序：

| 形态 | 与条款 4 的关系 | 代价 / 收益 |
| --- | --- | --- |
| a) 第三视图（HUD 上加 `agent`） | **正面违反**，需要先改条款本身并更新 `docs/PARADIGM.md` | 概念最整齐，但等于推翻一条已论证过的约束，论证负担在提议方 |
| b) 侧挂面板（不占视图槽位的常驻抽屉） | 兼容：视图仍是两个，面板不属于视图系统 | 与 G25 的落点规则一致；对话区宽度受限，长 diff 看着挤 |
| c) 独立窗口（Electron 第二窗口，或独立进程） | 完全无关：条款管的是 board 的投影 | 截图那种三栏（会话列表 + 对话 + 编辑区）只有这个形态放得下；但多一个窗口生命周期要管 |

**建议**：先做 b 的最小闭环（对话 + 只读工具 + 状态栏），把 c 当目标形态——因为写路径无论如何都要经过 diff 卡（`shell/ai` 的约定是写工具故意没有，agent 的修改必须变成人可审的 diff 再落盘），而 diff 卡天然属于板面/编辑区一侧，三栏布局才摆得开。

**缺口清单（地基之外要补的）**：对话循环与会话持久化（截图左侧的会话列表意味着会话是可存、可切换、可恢复的一等数据，存放位置：userData，不进 `board.json`）；工具面从两个只读工具扩到 `mod.*` 动词；diff 卡本体；agent 会话与打开卡片之间的联动（"看看当前这张卡"是最低要求）。

**与已有条目的关系**：这是 G24（统一 AI 面：图像生成 / vibe code / 剧本）的 UI 落点——G24 说三件事共用知识库回填这条前置链，agent 界面就是那条链露给作者的一端；也依赖 G44 先让"游戏目录/KB 来源"在 UI 可见，否则 agent 会在没有 KB 的情况下静默给错答案（G6 的 AI 版）。

### 21.3 G50 "+"：按类型新建文件

**现状**：命令词汇表（`COMMAND_HELP`，`shell/web/cards.mjs:807-831`）23 条全部作用于已存在的东西；唯一的文件创建入口是 `pixel <path.png> [w] [h]` 的可选宽高（新建画布，命令行，无 UI）和包级的 `File → New Mod…`（`electron/newmod.js` → `mod.scaffold` 四模板）。文件级、带类型选择的"新建"不存在。佐证：`mod` 卡能列出包里的 define 和 Yarn（点击即编辑），但没有"往这个包里加一个 define"的行。

**为什么类型选择器是这里的关键，而不是附加**：这个游戏的文件类型不是通用文件类型——是 `Defines/<Type>/<Name>.json`（51 个 schema 在知识库里）、`.yarn`（带 title/tags 头部）、翻译 CSV（`id,file,node,lineNumber,metadata` 表头）、精灵 PNG（8-bit RGBA/RGB，像素卡只认这两种）。徒手建空文件意味着作者要背目录约定、头部格式和必填字段——全是知识库里已有的东西。所以 "+" 的菜单应该**从知识库生成**，不是硬编码列表：

- **菜单项 = 知识库能力**：每个 schema 类型一项（生成带 `required` 字段的骨架 JSON）、Yarn 故事（带头部的空节点）、翻译表（带表头）、精灵（直接开像素卡到新建路径）；
- **生成即合法**：模板字段按 `validate.js` 实际检查的那五个关键字（`type`/`enum`/`required`/`properties`/`items`）预填——G8 的教训（脚手架生成的字段自己校验不了）要求生成器和校验器对着同一份知识库出活；
- **不支持的类型在菜单里就标灰**：G4 建议的支持矩阵（`type → supported | unsupported | partial`）如果做了，第一道展示位就是这个菜单——在作者写第一个字节之前告诉他 News/Hardware 在游戏里不生效；
- **不能创建的类型明说**：Spine 三件套和音频不是文本能生成的（rig 要 Spine 本体，音频要录音/合成），菜单项给出"这需要什么工具"的一句话，而不是假装能建。

**落点**：按 G25 的规则，能力先落 Node 侧动词（`mod.newFile {dir, type, name}`，或并入 `scaffold.js` 的模板机制），UI 三处共享同一动词：files/project 卡的 "+"、命令行 `new <type> <path>`、Electron 的 File 菜单（挨着 `New Mod…`）。写路径不用动内核：`file.write` 已会创建父目录（scaffold 就靠它）。

**与 G48/G49 的关系**：三者是同一条"给人用"的线——设置 UI 管环境，agent 界面管对话，"+" 管产出物的出生。