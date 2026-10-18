# 缺口清单（2026-10-18 重核版）

本文取代 `docs/EDITOR_GAPS.md` 的**待办职能**——旧档三轮追加后已超过 1200 行，作为审计档案保留（证据价值仍在），不再追加。本文只收录**当前工作树里核实仍然成立的缺口**，每条给出核实方式；"已关闭"只认代码证据，不认旧文档的说法。

快照：HEAD = `4393125`（G22 提交后重核；G3/G21/G46/G4/G39/G22 已分别随 `59be772`、`e0b0886`、`9648c02`、`deda198`、`97f96e2`、`4393125` 关闭，G13 随本提交关闭）。核实方法：对每条缺口在当日树上跑 grep / 读码复核，命令与行号随条目给出。

## 已关闭（本轮抽查核实）

| 条目 | 关闭证据 |
| --- | --- |
| G3 撞名不查 | `59be772`：`validate.js` D103 跨包/同包重名、D102 提级、M012 兄弟目录不可读 |
| G21 音频引用零校验 | `e0b0886`：D006 音频分支、`#vo` 的 Y122、`#vo:` 补全 |
| G46 格式体检 | `9648c02`：D007/D008/D009/D010（PNG/WAV/Spine/CSV 头） |
| G4 类型支持矩阵 | `deda198`：`shell/mods/support.json`（51 类型四档 + manager）、M013/M014、模板不再生成 `Attr` |
| G39 编辑器/`.yarn` 仍整文件读 | `97f96e2`：`cards/blob.mjs` 的 `readTextFile`/`writeTextFile` 把 4 MiB 拒读接到会话；编辑器（`card-editor.mjs:731`）与故事（`card-story.mjs:595`）都改走它 |
| G22 立绘路径零校验 | `4393125`：`validate.js` 的 `D011` 解析 `Character.spineAssetPath`（包根 + `Spine/` 前缀容错）、空串放行、`.json` 骨架要求同名图集；SODefines 30 个带路径角色 0 误报 |
| G13 无 headless 校验 CLI | 本提交：`main.mjs` 加 `validate DIR [--json] [--mods-root] [--user-dir]`，只用 `shell/mods/`、不 spawn 内核，退出码 0/1/2，`--json` 只打一个对象（日志走 stderr）；`selftest/cli.mjs` 14 检查 |
| G1 语言表打不开 | story 卡走 blob 分块：`cards/card-story.mjs:17,625`（`readTextInChunks`） |
| G25/G29 卡片可达性 | 13 种卡分模块落 `cards/`，两个视图都有标签页（`36f32df` 及更早） |
| G41 再生 KB 关掉 sprite 检查 | `tools/gen_knowledge.mjs:16-22` 注释明确保留两类事实型 description |
| G42 CSV 往返丢 BOM | `cef2056` |
| G43 locale 文档空白 | `search.js:253` 有 `case 'locale'` |
| G44 KB 来源不可见 | **部分关闭**：启动日志报 KB 状态（`main.mjs:447`）、`config.get`/`config.set` 动词存在（`:755-759`）；但仍无独立动词暴露 `gameModsInfo` |
| G47 spine 命名 | `58a38ab` 改名 rig，`cards/card-rig.mjs` |
| G48 设置 UI | `cards/card-settings.mjs`：表单编辑 AI provider / 启动视图 / 轮询间隔 |
| G50 "+"新建文件 | `mod.newFile` / `mod.importFile` 已进 `MOD_METHODS`（`main.mjs:616` 起） |
| G30/G35 分发物 | `package.json` 的 filter 排掉 `knowledge.json`、`hello.yarn`、`board.json`、`sample.json` |
| spine 编辑 | `9f8d4d7`：rig 卡可读可写回 |

## 仍然成立（本轮逐条核实）

### A. 校验可信度——"编辑器说 clean"还不能全信

| 条目 | 当日证据 |
| --- | --- |
| G7 `#line:` 双向核对 | `validate.js` 无 `#line` 命中（0 处） |
| G6 校验关键字面 | `validate.js` 无 `pattern`/`minimum` 实现，仍只认五个关键字 |
| G9 prefab/地址不查 | `validate.js` 无 `Prefab`/`Addressable` 命中 |

### B. 文件与文本

| 条目 | 当日证据 |
| --- | --- |
| G40 翻译写回半成 | `storycsv.setColumn`（`storycsv.mjs:128`）仍无调用者，只追加不改写 |
| G15 无 wiki 链接 | `shell/` 全树无 `wiki.infantgod` 命中 |

### C. 全流程断点（装进去 → 验证 → 发出去 → 互审）

| 条目 | 当日证据 |
| --- | --- |
| G11 无"装进游戏" | 内核无 copy/delete；`StreamingAssets` 只出现在 scaffold 的说明文字里 |
| G12 无游戏内验证回路 | 全树无 `Player.log` 跟随/游戏启动 |
| G45 无 zip 导出 | 无任何 archive 动词 |

### D. 产品与安装

| 条目 | 当日证据 |
| --- | --- |
| G36 卸载盲删 | `tools/installer.nsi:165` 仍是 `RMDir /r "$INSTDIR"`，无归属标记 |
| G34 新建模组失败路径 | `electron/newmod.js` 无 `overwrite` 命中（旧档 F1–F5 未见修复） |
| G49 agent 界面 | `cards/` 无 agent 卡；`shell/ai` 仍只是地基（provider/config/tools） |

### 已决策关闭

- **G28/G32 名称**：保留 OsanaKami IDE Studio。裁定理由：产品的问题集合对这一款游戏是特异的，不需要为"改嫁其他游戏"预留距离；实测无混淆。
- **G24 "0 网络"**：已决策不继承上游约束，`shell/ai` 已落地。

## 本轮未复核（诚实声明）

G2（音频试听卡）、G5（KB 乱码存量）、G8、G10、G14、G16–G20、G33、G37、G38：本轮未逐条重跑旧档的复现步骤，状态以旧档为准。其中 G16–G20 所引用的 `cards.mjs` 行号已因拆分全部漂移，复核时需以 `cards/` 下的新模块重新定位。

## 建议队列（下一步，按依赖与成本排序）

1. ~~**G3** 撞名检测~~（`59be772`）
2. ~~**G21** 音频引用体检~~（`e0b0886`）
3. ~~**G46** 格式体检~~（`9648c02`）
4. ~~**G4** 支持矩阵进 KB~~（本提交）
5. ~~**G39** blob 接到编辑器与 `.yarn`~~（本提交）
6. ~~**G22** `spineAssetPath` 校验~~（本提交）
7. ~~**G13** headless `validate <dir> --json`~~（本提交）
8. **G45** 导出 zip——补上分发断点
9. **G40** 翻译写回（`setColumn` 接调用者）——故事卡"能编辑"的另一半
10. **G36** 卸载安全——唯一能删用户数据的路径，发布前必修

第一替补：**G12** 游戏日志跟随（`file.blobRead` 的 offset 恰好能做 tail）。G49 agent 界面依赖 G44 完全关闭，排在这批之后。上游 0.4.2 的 port 层硬化（junction 逃逸、revision 0 二义、原子写）建议作为并行技术轨同步。
