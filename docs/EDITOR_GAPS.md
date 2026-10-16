# 编辑器缺口分析

对着三样东西看这个编辑器：**游戏真实的 Mod 语料**、**官方 wiki**、**群里实际的工作方式**。

- 快照时间：2026-10-16（本轮只读，未修改任何代码）。
- 代码快照 = `HEAD` + 当时未提交的改动（`shell/web/cards.mjs`、`board.mjs`、`main.mjs`、`selftest.mjs`、`style.css`、`CHANGELOG.md` 已改；`shell/web/pixelpng.mjs`、`shell/web/pixelreview-zz.mjs` 未跟踪）。审计期间工作区另有写入者活动，见第 8 节。
- 语料 = `knowledge.json` 自己记录的 `gameModsDir`：`C:\Users\PC\Documents\deepseek-harness\default-workspace\ModsFull\Mods`（3 个 Mod、3359 个文件、77.4 MB）。

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

---

## 1. 这一轮是怎么得出这些结论的

1. **读代码**：`core/`（C89 内核）、`shell/mods/*`（Mod 层）、`shell/web/*`（卡片层）、`tools/`、`docs/` 全量；行号都在下文。
2. **读语料**：`ModsFull/Mods` 下 3 个真实 Mod（`Audio`、`MyMod`、`SODefines`）的扩展名、体积、时间分布；`shell/mods/knowledge.json` 的统计与文档字段。
3. **跑内核**（只读，`build/infantgod.exe rpc --root <workspace>`）拿真实错误码，而不是靠读代码猜（转录见 G1/G2）。
4. **抓 wiki**：`https://wiki.infantgod.xyz/` 172 个 URL 全量目录 + 结构/章节页 + SO 索引 + YarnCommands（82 条）/YarnFunctions（18 条）总览。
5. **两个输入源没抓到**，因此本文不对"接口需求"下任何结论：腾讯文档反馈表（`docs.qq.com/sheet/DZGtFY0xuY0xhcnpW`）是纯前端渲染 + 鉴权接口（`/dop-api/opendoc` → 401），只确认了文档存在；百度网盘歌曲分享需要提取码 + 验证码。沙箱内无出网 TLS（`schannel: SEC_E_NO_CREDENTIALS 0x8009030e`），需登录态浏览器才能取。详见第 7 节。
6. **未逐一渲染** wiki 全部 47 个 SO 详情页与 82 个命令详情页（页面级字段以已引用的为准，其余标 UNVERIFIED）；`node tools/e2e.py` 级别的测试**未在本轮重跑**；`shell/mods/*` 做过一轮逐函数审计，`shell/web/*` 的逐卡行为**本轮补做了一轮专项审计**（下文 G16–G20），审计钉在 `shell/web/cards.mjs` 的 5764 行版本上，SHA256 `96068F0049126ECC12F34F452CE9CD5C47E711C42A47585C6E20ED2F4E4BD798`。
7. **音频专项（第 2 轮，G21）**：分四路取证——wiki 音频相关 25 个 URL 逐个渲染（含两个 404）；`ModsFull/Mods` 全量扫描音频字段、wav 头、`#vo:` tag；对 `build/infantgod.exe rpc` 实测 4 MiB 与 `offset`/`limit`；再用编辑器自己的 `validate.js` 导出（`referenceMap`/`schemaSummary`/`validateModPackage`）核对"哪些字段真的会被查"。四处结论一致才写进本文；`Mods/Audio` 的 `ok: true` 是实跑结果，不是引用。

复现内核探针：

```powershell
$root = 'C:\Users\PC\Documents\deepseek-harness\default-workspace'
'{"jsonrpc":"2.0","id":1,"method":"file.read","params":{"path":"ModsFull/Mods/MyMod/Yarn/NewProject_EN.csv"}}' |
  & .\build\infantgod.exe rpc --root $root
```

---

## 2. P0：会让作者白干的问题

### G1 游戏自带的语言表，编辑器全都打不开

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

**建议**：给 `file.read`/`file.read_bytes` 加 `offset`/`limit` 分片（协议层面最容易；`view.load` 已有 `SDE_VIEW_MAX_READ` 同值上限，也应一并处理）；或把上限提到 8 MiB 并让卡片按需分块。至少要在 UI 上把"这个文件太大，编辑器打不开"变成一句明确的、带体积的提示，而不是普通读失败。

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
| 1 | `file.read`/`file.read_bytes` 支持 `offset`/`limit`（或把上限提到 8 MiB），卡片分块加载 | `core/src/wksp.c`、`core/include/wksp.h`、`shell/web/cards.mjs:3981` | 直接解锁 12 张语言表 = 群里最大的一块工作 |
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
| 14 | mod 视图接纳 `story`/`pixel`（面板或标签页补一种角色） | `shell/web/modview.mjs:26-29`、`:78-83` | 自家两张主卡在主视图里凭空消失 |
| 15 | PNG 保存保持源格式（或至少显式警告会被改写）；支持灰度/调色板 8-bit | `shell/web/pixelpng.mjs:280-286`、`:692-696` | 精灵素材进版本库会被整文件重写 |

---

## 7. 两个输入源没抓到（所以本文没有对"接口需求"下结论）

| 输入 | 结果 | 精确原因 |
| --- | --- | --- |
| 腾讯文档「mod 接口需求反馈」`docs.qq.com/sheet/DZGtFY0xuY0xhcnpW?tab=BB08J2` | **拿不到内容**；只能确认文档存在（标题 `需求`；伪造 id 的对照探针只返回 `腾讯文档`） | 纯前端渲染（无 `__INITIAL_STATE__`/`data` 负载）；数据接口 `https://docs.qq.com/dop-api/opendoc?id=...` → **401**；`mobile/sheet` → 404；web 搜索无镜像/缓存 |
| 百度网盘歌曲 `pan.baidu.com/s/1BF-DBBcw6m3sjTnYXiklRQ`（提取码 `ieef`） | **拿不到文件列表** | 302 到 `share/init`，需要"提取码 + 验证码 CAPTCHA"，之后还要 per-share token；URL 带 `pwd` 无效 |

沙箱环境的硬限制：**没有可用的出网 TLS**（`curl.exe https://example.com` → exit 35，`schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)`）。两者都需要**沙箱之外、带登录态、能跑 JS/过验证码的浏览器**。

wiki 自身也有几处硬伤，顺手记下（都是抓取时验证过的）：`sitemap.xml` 里所有 `<loc>` 的 host 仍指向上游 `https://quartz.jzhao.xyz/...`；`SO/ScriptableObject` 被 `e.Mod结构与限制` 链接但 **404**；`添加一个新角色` 实际是一个只有 SpinePro 下载链接的 1 分钟 stub；`表单` 页的"可用的音效表 / 可用的结果标识"是空表；`mod.json` 的字段结构**官方未文档化**（原话："具体字段以当前工程的 Mod 示例和 ModLoader 实现为准"）——这直接关系到下面这条：编辑器在 `validate.js:831-857` 发明并强制了 `loadOrder`（`M003`/`M004`），脚手架还把它写进 README（`scaffold.js:11/1046`）。**在确认真实 `ModLoader` 是否读这个字段之前，`M003`/`M004` 有"用自造规范误导作者"的风险**，建议先对照游戏工程验证。

---

## 8. 审计快照与并发写入说明

- 本轮全程只读：没有修改任何代码文件；唯一写入是本文件 `docs/EDITOR_GAPS.md`。
- 浏览器层的行号钉在 `shell/web/cards.mjs` 的 **5764 行**版本（SHA256 `96068F0049126ECC12F34F452CE9CD5C47E711C42A47585C6E20ED2F4E4BD798`）——审计过程中该文件在 19:40:32 被另一个写入者改动过，所以 `shell/web/*` 的任何行号都只在那一刻成立；`modview.mjs`、`main.mjs`、`pixelpng.mjs`、`storycsv.mjs` 的行号同理按当时快照理解。
- 审计期间工作区**另有写入者活动**（同一时刻的 `git status`）：已改 `CHANGELOG.md`、`shell/web/board.mjs`、`cards.mjs`、`main.mjs`、`selftest.mjs`、`style.css`、`tools/input_smoke.py`；未跟踪 `shell/web/pixelpng.mjs`、`shell/web/pixelreview-zz.mjs`（194 536 B，19:40:44 出现，内容与 `cards.mjs` 同行号）。因此本文所有行号对应**该时刻的快照**；同时提醒一句：`pixelreview-zz.mjs` 是 `cards.mjs` 的一份 194 KB 副本，工作区里出现了同一份代码的两个拷贝，容易被后续编辑/审计误读（是否保留由该会话决定）。
- 未验证项（明确标出，避免当成结论）：wiki 的 47 个 SO 详情页与 82 个命令详情页未逐页渲染；`docs/BUGS.md` 的探针、`node tools/e2e.py` 级别的测试未在本轮重跑；`M003`/`M004` 是否对应真实 `ModLoader` 字段未与游戏工程对照（G/第 7 节已标注为待确认）。
- G21（音频）的来源与口径：基线计数（`AudioEvent` 117、`Song` 52、`VoiceOverDefinition` 4、`Attachment` 21）与 `#vo:` 16 次来自对 `ModsFull/Mods` 的只读扫描，并且**做过一次交叉复核**：`ModsFull/Mods/SODefines/Defines/Attachment/` 下确有 **21 个** json、其中 **21 个**都写了对象型 `audioEvent`（与本次一路取证的"1 个附件"说法不一致，本文采用可复现的 21）；`#vo:TestProgrammerVO` 在任何 `.yarn` 里出现 **0 次**（211 个文件全扫）；4 MiB 上限、base64 比值、`offset`/`limit` 被忽略这三个读数来自对 `build\infantgod.exe rpc` 的只读实测；`Mods/Audio` 是**游戏自带的演示包**（`mod.json` 自称 "Audio Programmer Sound Demo"），不代表社区 Mod 的平均形态——它的价值在于"唯一一个走外部音频文件的可运行范例"。其中"6 个 wav 全丢也是 `ok: true`"是**推论**：实测部分是该包确实报 `ok: true` 且无音频相关诊断，推论部分是字段分类（`referenceMap`/`schemaSummary`）显示没有任何代码路径检查这三个字段；本轮**没有**真的删除过任何文件。
