# 04 · 工作区、暂存区与 CLI

本文件定义 iaqs 与用户交互的整个表层：工作区规则、index（暂存区）、status/diff、
命令面、i18n 与输出约定。

## 1. 工作区语义

- 工作区 = 仓库根目录（`.iaqs/` 所在目录），仓库内的文件都处于版本管理之下，
  除非被 `.iaqsignore` 忽略。
- 路径规则：
  - 仓库内相对路径，分隔符统一 `/`；显示时 Windows 也输出 `/`（可读性一致）。
  - 按**字节**比较与存储（UTF-8 是主要形态，但不校验编码；GBK/拉丁文件名也能用）。
    Windows 上大小写不敏感的文件系统会让 `A.txt` 与 `a.txt` 指向同一文件，iaqs 按字节
    视为两个不同路径——文档化：**同一目录不要放仅大小写不同的文件名**。
  - 拒绝：绝对路径、含 `..` 段的路径、以 `/` 结尾的文件名、`.`/`..` 段、NUL、
    与 `.iaqs` 冲突的路径。
  - 符号链接：v1 作为「内容为链接目标字符串的 blob + mode 0120000」记录，不跟随
    （Windows 需开发者模式的符号链接；普通快捷方式 `.lnk` 按普通文件处理）。
- `.iaqsignore`（仓库根，可选）：gitignore 子集。
  - `#` 注释、空行忽略；`/` 开头锚定根；结尾 `/` 仅匹配目录；`*` 任意非分隔符、
    `?` 单字符、`**` 跨目录；`!` 取反；`\` 转义。
  - 默认忽略（无需写进文件）：`.iaqs/`、`*.iaqs-tmp`、`.dsh-*` 等内部临时文件。
  - 忽略规则只影响未跟踪文件；已跟踪文件继续跟踪（与 git 一致）。
- 行尾/编码：不做任何转换（CRLF/LF/BOM 原样存储与 diff）。

## 2. 暂存区（index）

- 表 `index_entries(path TEXT PRIMARY KEY, mode INTEGER, oid BLOB, size INTEGER,
  mtime_ns INTEGER)`，path 按字节排序（SQLite 式 TEXT 比较即字节序）。
- index 是「下一次提交的内容」；`commit` 只提交 index，不提交工作区未暂存的改动。
- index 全量载入内存（条目多为 MB 级，可接受；超大仓库按需扫描）。修改后一次事务写回。
- stat 缓存：`status` 先用 (size, mtime_ns) 快速判断未变文件；mtime 变化时再比内容
  （假 mtime 工具不误报：内容相同则更新缓存不报修改）。
- 空目录不被跟踪（同 git）；目录本身不作为条目。

## 3. 命令面

### 3.1 仓库与库

| 命令 | 说明 |
| --- | --- |
| `iaqs init [dir]` | 创建仓库（含加密库；交互设置密码，`--password-stdin` 供脚本） |
| `iaqs clone` | 不支持（单机无远程）；`init` 即全部 |
| `iaqs info` | 仓库信息：路径、库大小、页/段数、分支、HEAD、是否加密 |
| `iaqs passwd` | 改密码（重包 DEK，秒级） |
| `iaqs rekey --data [--password]` | 轮换数据密钥（离线逐页重加密，见 07） |
| `iaqs backup <file.iaqs>` | 一致性热备（加密副本；`--offline` 直接拷贝目录） |
| `iaqs version` | 版本号与格式版本 |

### 3.2 工作区与提交

| 命令 | 说明 |
| --- | --- |
| `iaqs status [--porcelain] [--json]` | 已暂存/未暂存/未跟踪 |
| `iaqs add <path>...` | 暂存文件/目录（`-A` 全部、`-u` 仅已跟踪） |
| `iaqs rm <path>...` | 删除跟踪并暂存删除（`--cached` 只出 index） |
| `iaqs mv <src> <dst>` | 重命名跟踪文件并暂存 |
| `iaqs diff [--cached] [--stat] [--name-only] [<rev>] [<rev>] [-- path]` | 差异 |
| `iaqs commit -m <msg> [--amend] [--allow-empty] [--no-verify]` | 从 index 建提交 |
| `iaqs restore <path>...` / `restore --staged <path>...` | 工作区/暂存区还原 |
| `iaqs clean [-n] [-f]` | 删除未跟踪文件（默认 dry-run） |
| `iaqs stash`（可选，M4） | 暂存未提交改动 |

### 3.3 版本树

| 命令 | 说明 |
| --- | --- |
| `iaqs log [--oneline] [--graph] [--all] [-n N] [--topo] [-p] [--stat]` | 历史 |
| `iaqs show <rev>` | 提交/标签/树/文件内容 + diff |
| `iaqs branch [...]` | 见 03 |
| `iaqs switch <branch>` / `iaqs checkout <branch|commit> [-- path]` | 切换 |
| `iaqs merge <rev> [--no-ff] [--abort|--continue]` | 合并 |
| `iaqs reset [--soft|--mixed|--hard] <rev>` | 移动 HEAD |
| `iaqs tag [...]` | 见 03 |
| `iaqs reflog [<ref>]` | 引用历史 |
| `iaqs rev-parse <rev>` | 修订解析 |

### 3.4 对象与维护

| 命令 | 说明 |
| --- | --- |
| `iaqs cat-file <type> <rev> [path]` | 读取 blob/tree/commit/tag（调试/脚本） |
| `iaqs ls-tree <tree> [path]` | 列树 |
| `iaqs fsck [--full] [--lost-found]` | 校验库与对象图 |
| `iaqs gc [--prune=now] [--aggressive] [--dry-run]` | 回收不可达对象、重排 delta、vacuum 段 |
| `iaqs verify` | 快速校验 page/crc/aead |
| `iaqs checkpoint` | 强制 WAL checkpoint（内部/调试） |

> SQL 引擎是数据库的内部实现细节（表/行/索引/事务），**不提供面向用户的 SQL 命令**；
> 用户通过上述版本管理命令操作。设计文档 06 中的 SQL 表仅描述内部存储结构。

### 3.5 全局选项

`--repo <path>`（默认从 cwd 向上找 `.iaqs/`）、`--lang <zh-CN|en>`、`-q`/`-v`、
`--no-color`、`--password-stdin`、`--yes`（危险操作免确认）、`--json`（机器输出）。

## 4. status / diff 的判定

```
HEAD tree ──diff──► index ──diff──► 工作区
```

- **staged**：index 相对 HEAD 的新增/修改/删除。
- **unstaged**：工作区相对 index 的修改/删除（untracked 单列）。
- **untracked**：工作区存在、index 没有、且未被忽略的文件。
- `status --porcelain` 每行两列状态字母（`A/M/D/R` + `?`/`!`），路径相对仓库根，
  **不做本地化、不做颜色**，供脚本解析；`--json` 输出结构化。
- `diff` 默认「工作区 vs index」；`--cached`「index vs HEAD」；指定 rev 时「该提交 vs 工作区」，
  两个 rev 则互相比较；路径过滤 `-- <path>`。
- diff 算法：行级 Myers（01/linediff 设计）；输出 unified，默认 3 行上下文、`a/`、`b/` 前缀
  可配；二进制（含 NUL）只输出 `Binary files a/x and b/x differ`；大文件超阈值
  （`diff.max_size` 默认 64 MiB）不逐行 diff，输出 `Large file ... differ`。

## 5. 错误、退出码与锁

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 运行错误（合并冲突、文件不存在、校验失败等） |
| 2 | 用法错误（未知命令/选项、缺参数） |
| 3 | 锁冲突（另一进程在写仓库） |
| 4 | 密码错误或库损坏 |

- 错误信息写 stderr，带命令上下文；不打印堆栈（除非 `IAQS_DEBUG=1`）。
- 运行中获取仓库锁（`.iaqs/locked`，含 pid/主机/时间戳，1 小时陈旧清理）；
  只读命令同样加读锁？——v1 只读命令**不加写锁**（打开为只读事务），写命令加锁。
  锁冲突时提示「请等待另一个 iaqs 进程完成或确认其已退出」。
- 危险操作（`reset --hard` 丢弃改动、`branch -D`、`gc --prune=now`、`rekey`）要求确认，
  `--yes` 或非 TTY 时由 `--yes` 明确放行，否则拒绝。

## 6. i18n（用户要求 m00125）

- **范围**：所有面向人类的输出（命令帮助、status 摘要、log 头部、错误提示、确认提示、
  进度、警告）做本地化；机器可解析格式（`--porcelain`/`--json`/`rev-parse` 输出、
  对象内容、路径）**不翻译**。
- **语言集**：v1 内置 `zh-CN`（默认跟随系统中文 locale）与 `en`；未知 locale 回退 `en`。
- **选择顺序**：`--lang` > 环境变量 `IAQS_LANG` > 系统 UI 语言
  （Windows `GetUserDefaultLocaleName`，Linux `LC_ALL`/`LANG`）> `en`。
- **实现方式**（零依赖、可编译期检查）：

  ```cpp
  enum class Msg { StatusHeader, StagedAdded, ErrNoRepo, /* ... */ Count };
  struct MsgTable { std::span<const Str> zh; std::span<const Str> en; };
  // 编译期断言两张表长度 == (size_t)Msg::Count，缺 key 直接编译失败
  std::string_view tr(Msg m, std::initializer_list<std::string_view> args = {});
  ```

  - 消息模板用 `{0}`/`{1}` 占位，`tr` 做简单替换；不引入 gettext/ICU。
  - 两种语言都编译进二进制（体积可忽略），无需外部语言包文件。
- **格式细节**：数字用千分位/本地小数点（`std::locale` 或按语言规则自行格式化，
  避免全局 locale 副作用）；时间本地格式（`2026-10-20 17:30 +0800`），可 `--utc`；
  单词序差异用完整句子模板而非拼接片段（避免「已暂存 3 个文件」的语序问题）。
- **测试**：每个 Msg key 在两种语言表中都存在（编译期 + 单测遍历）；`--lang` 冒烟测试
  断言关键输出；`--porcelain` 在两种语言下输出完全一致。

## 7. 输出与编码

- Windows：启动时 `SetConsoleOutputCP(CP_UTF8)`（失败则回退本地代码页）+ 启用 VT 序列，
  颜色可选；管道重定向时按字节直出。
- 文件对比与 diff 都按字节；显示层遇到非法 UTF-8 的路径/内容时，用 `\xNN` 转义显示
  （`--raw` 关闭转义），保证不丢信息且终端不闪烁。
- 颜色：默认 TTY 开启（新增绿/删除红/冲突黄），`--no-color`/`NO_COLOR` 关闭；
  `color.ui=auto|always|never` 配置。
- 分页：默认不内建 pager（管道给 `less` 即可）；`core.pager` 可选（Windows 下最小支持）。

## 8. 帮助与文档

- `iaqs help`、`iaqs <cmd> --help`、`iaqs help <cmd>`，中英双语，内容来自同一份消息表
  （帮助文本较长的按 key 分条，避免拼接）。
- `iaqs version --format` 输出机器可读（含 db format version、aead 算法）。
- 根 README 与 `docs/` 中文为主；`docs/en/` 可选（v1 不做完整英文文档，仅 CLI 英文输出）。

## 实现注记（M2–M4 已落地命令）

- 已实现：`init add status commit log show cat-file ls-tree branch switch|checkout merge diff
  tag reset passwd rekey info gc fsck rm mv restore clean rev-parse checkpoint placeholder
  export-git import-git lang version help`。
- `rm [--cached]`：默认删工作区文件并暂存删除；`--cached` 只移出索引。
- `mv <from> <to>`：工作区改名并在索引里同步路径。
- `restore [paths...]`：从 HEAD 恢复文件内容与索引项（无参数 = 全部跟踪文件）。
- `clean [-n|--dry-run]`：删除未跟踪文件；`-n` 只列出。
- `rev-parse <rev>`：打印解析后的完整 oid（支持 HEAD / 分支 / tag / 前缀 / `^` `^N` `~N`）。
- `checkpoint`：手动把 WAL 合并进段文件（正常在关闭/自动阈值时也会做）。
- 退出码遵循 04 §9：0 成功、1 运行时错误、2 用法错误、4 密码错误/损坏；写锁冲突由
  `Database::open` 报 `repository is locked by another process`。

## 实现注记（i18n 收尾）

- 文案集中在 `src/i18n/i18n.h` 的 `Msg` 枚举与 `src/i18n/i18n.cpp` 的 `kZh`/`kEn` 表，
  `tr(Msg, {args})` 做 `{0}`/`{1}` 占位替换；机器可读输出（`status --porcelain`、
  `log`/`show` 的对象帧）保持不变，便于脚本消费。
- 语言探测优先级：`--lang <zh-CN|en>` > `IAQS_LANG` > 仓库 `config.ui.lang` >
  `LANG`（以 `zh` 开头则中文）> `en`。全局 `--lang` 可放在命令前后（`iaqs --lang zh-CN status`）。
- Windows 控制台：`main` 先用 `GetCommandLineW` + `CommandLineToArgvW` 取 UTF-16 命令行再转
  UTF-8 argv（窄 argv 走 ANSI 代码页会损坏中文提交说明与路径），并 `SetConsoleOutputCP(CP_UTF8)`；
  输出始终是 UTF-8 字节。
- 已本地化：info、merge 四种结果与冲突提示、gc 摘要、fsck 统计与错误、restore、checkpoint、
  tag 创建/删除、reset、passwd/rekey 的提示与结果、branch 创建、二进制 diff 提示、密码提示、
  status 的分支行、init/commit/log 等既有命令。对象内容、提交说明、分支/标签名等数据不翻译。
- e2e 证据：`--lang zh-CN` 与 `--lang en` 分别覆盖 init/add/commit/status/log/fsck/gc/tag/
  branch/switch/merge（干净合并产生 merge commit、冲突时中文提示并 exit 1）/reset/
  passwd/rekey；中文提交说明经 UTF-8 argv 修复后可正确写入与回显。

## 实现注记（M4 后续：口令策略、占位文件、diff/rev-parse/rekey 增强）

- 口令策略（`src/cli/cli.cpp`）：
  - 未提供任何口令时使用默认口令 `12345678`（仓库仍需密码才能打开，默认值只是省去首次输入）。
  - 设置口令的来源顺序：`--new-password` > `IAQS_NEW_PASSWORD` > 旧变量 `IAQS_PASSWORD` >
    交互式两次输入（空输入视为默认口令）。
  - 弱口令判定：长度 < 8 或命中常见弱口令表。交互式自行输入弱口令时已要求二次输入；
    显式来源（flag/env）的弱口令还需要 `--allow-weak-password`，否则退出码 2 并提示。
  - 旧口令只接受 `IAQS_PASSWORD` 或交互输入，不参与"设置新口令"的推断。
- 文件占位（placeholder）：用于"先登记一个待上传/待实现文件"的场景。
  - 表 `placeholders(path TEXT PRIMARY KEY, reason TEXT, created_ts INTEGER)`；
    命令：`iaqs placeholder list`、`add <path> [-m reason]`、`remove <path>`。
  - `status` 中尚未落地的占位显示为 `P  <path>`（porcelain）或 "Placeholders (pending)" 区块，
    并让工作区视为不干净；真实文件被 `add` 后自动兑现并移除占位。
  - 路径按仓库相对路径归一化（`\` → `/`），拒绝越界（`..`）与已存在的文件。
- `rev-parse --short[=N]`：默认 8 位（4..64 合法），其余参数交给普通解析。
- `diff`：`--stat` 输出每文件 `+/-` 计数与总计；`--color=auto|always|never`（Windows 上启用
  虚拟终端序列）；统计与着色都基于 `vcs::diff_changes`，不改动统一 diff 本身的字节输出。
- `rekey --data` 进度：`Pager::rekey_pages(new_key, progress)` 先统计总页数，再逐页
  `open_page(新钥)` 探测（已迁移则跳过）→ 旧钥解密 → 新钥重封并写回，每处理一页回调
  `(done, total)`；CLI 只在百分比变化时向 stderr 输出 `\r...`，结束后换行。
- 测试：`vcs_streaming.chunk_index_is_rebuilt_when_missing`、`placeholder.*` 5 用例、
  `btree.*` 9 用例；全量 199 个单元测试通过。

### export-git（导出到 git，实现注记）

iaqs 提交不记录作者，因此导出时必须显式给出身份：

```
iaqs export-git --author "Name <email>" [--format=fast-import] > history.fi
git fast-import < history.fi        # 在目标 git 仓库中执行
```

- 输出为 git fast-import 流：提交按 `parents-first` 迭代式后序排列；每个提交块的 blob
  命令必须**先于** `commit` 行发出（fast-import 的顶层对象），路径都用 C 风格引号转义。
- 提交：`commit refs/heads/iaqs-export` 作为代理分支，`author`/`committer` 都用
  `--author` 给出的身份与原提交的 `time tz`；`from`/`merge` 指向前序提交的 mark；
  相对第一父树缺失的路径发 `D "path"`；文件用 `M <octal mode> :mark "path"`。
- 引用：分支用 `reset refs/heads/<name>`、轻量标签用 `reset refs/tags/<name>`、
  annotated 标签用 `tag <name>`（含 `tagger` 与原 tag 消息）；结束后删除代理分支。
- blob 用 `ObjectStore::read_stream` 流式写出（大文件/分块对象不必整块入内存），并按
  `raw_size` 校验写入字节数。
- 关键坑：Windows 上 `std::cout` 默认文本模式会把 `\n` 翻成 `\r\n`，fast-import 会把
  CR 当成命令的一部分并报 `unsupported command: blob`；导出前必须
  `_setmode(_fileno(stdout), _O_BINARY)`，结束后恢复。
- 验证：真实 git 仓库 `git fast-import` 导入 iaqs 自身历史（2 提交 / 123 blob / 2 tag），
  以及含合并（2 父提交）、文件删除、300 KB 随机二进制（分块 storage=3，导入后
  SHA-256 与源文件一致）的仓库；`export_git.*` 3 个单测覆盖身份解析与流内容。

### export-git --format=pack 与 import-git（git pack 兼容，实现注记）

```
iaqs export-git --format=pack --out <dir> --author "Name <email>"
iaqs import-git <git-dir> [--force]
```

- 导出：`--out` 下生成 `pack-<checksum>.pack` + `.idx`（git idx v2）、`refs/heads|tags/*`
  与 `HEAD`，可直接拷进 git 仓库的 `.git/objects/pack`、`.git/refs`、`.git/HEAD`。
  pack 条目用 zlib stored 块（`src/git/zlib_stream.cpp` 自实现 inflate/deflate-stored，
  零第三方依赖）；按 `max_objects_per_pack`（默认 50000）切成多个 pack。
- **类型编号陷阱**：iaqs 的 `ObjType{Blob=1,Tree=2,Commit=3,Tag=4}` 与 git pack 的
  `{Commit=1,Tree=2,Blob=3,Tag=4}` 不同；对象 id 与 pack 条目 type 都必须用 git 编号
  （`src/git/convert.cpp` 的 `git_pack_type()`），否则 git 会把 commit 当 blob、
  `git fsck` 报 `refs/heads/main: not a commit`。
- git tree 对象是二进制（`<octal mode> <name>\0<20B id>`），排序规则与 iaqs tree
  （`<mode> <type> <oid> <escaped name>` 文本、按 name 字节序）不同：导出时需要重排，
  **目录名按 `name + "/"` 参与比较**（git 的 tree 排序规则），mode 写 40000/100644/
  100755/120000。导入时反向转换；git 的 160000（submodule）明确报错不支持。
- 提交转换：iaqs 无作者，导出时统一用 `--author` 身份、committer 与 author 相同；
  导入时取 git 的 `committer` 时间/时区作为 iaqs 提交时间（作者身份丢弃）。
- 导入：`import-git <git-dir>`（给 `.git` 目录本身）读取 `objects/pack/*.pack`（含
  OFS_DELTA/REF_DELTA）与松散对象、`packed-refs`、松散 refs、`HEAD`；转换后写
  objects 表并用一个事务更新 refs/HEAD，最后 `checkout_commit("HEAD", true)` 物化工作区，
  再恢复 symbolic HEAD（checkout 会把 HEAD 置为 detached）。目标仓库非空且无 `--force`
  时拒绝。
- 验证（真实 git）：
  - 导出 → `git fsck --full` 无输出、`git log --oneline --all --decorate` 显示提交/标签、
    `git ls-tree -r HEAD` 路径与 mode 正确、`git cat-file -p v1` 的 tag 对象正确；
  - `git gc --aggressive` 产生的含 delta 的 pack → `iaqs import-git .git` 成功导入
    （2 提交 / 3 tree / 3 blob / 1 tag），工作区文件内容与 git 一致；
  - iaqs→pack→iaqs 往返：提交数、树、blob、tag、分支与文件内容一致。
- 单测：`git_sha1.*`（3）、`git_zlib.*`（5）、`git_pack.*`（4）、`import_git.*`（3，
  含往返），共 15 个。

### 可安装语言包（实现注记，M6）

- 内置 `en`、`zh-CN` 两张表；语言包是 UTF-8 文本（`key=value`，元数据行
  `language=`、`name=`、`comment=`，值内 `\n` `\t` `\r` `\\` 转义），键名由
  `message_key(Msg)` 稳定导出（与 enum 一一对应，共 73 个）。
- 搜索路径：`IAQS_LANG_DIR`（Windows 用 `;`、POSIX 用 `:` 分隔的目录列表）里的各目录，
  再加 `$IAQS_HOME/lang`（默认 `%APPDATA%\iaqs` 或 `~/.config/iaqs`）。
- 覆盖规则：`tr()` 先查当前语言包的键值，缺失时逐条回退英文；内置 zh/en 始终可用、
  不可删除；未知语言代码保留代码但按英文回退，未安装的包在 `--lang` 下同样安全降级。
- `iaqs lang install <file.lang>`：校验 `language=` 代码（`[A-Za-z0-9_-]{1,32}`）、
  拒绝未知键与缺失 `language=`，原子复制为 `<home>/lang/<code>.lang`。
- `iaqs lang use <code>`：立即切换当前进程语言并把默认语言写入 `<home>/config` 的
  `ui.lang`；后继进程的探测顺序为 `--lang` > `IAQS_LANG` > 用户默认 > `LANG`（zh* 中文，
  其余英文）。
- `iaqs lang export [code]`：输出完整语言包模板（未覆盖的键用英文填充），便于翻译分发；
  `iaqs lang remove <code>` 删除已安装包。
- 测试：`i18n_lang.*` 5 个单测（导出内置包、安装/切换/删除、坏包拒绝、用户默认往返、
  `IAQS_LANG_DIR` 搜索路径与逐条回退）；e2e 覆盖 `lang list/install/use/export/remove`。

## 实现注记（M7 审计加固）

- **路径包含**：`add/rm/mv/restore/clean/checkout/merge` 的所有路径先归一化（weakly_canonical）
  再校验必须落在仓库根内；任何路径分量等于 `.iaqs` 一律拒绝（否则可提交/恢复加密库自身，
  例如恢复旧 MANIFEST 会把仓库永久锁死）。目录遍历遇到 junction/symlink/reparse point 跳过。
- **restore**：无路径参数必须显式 `--all`（避免习惯性整树回滚）；显式路径 0 匹配报错。
- **rm**：只允许删除已跟踪文件；未跟踪文件报错并提示使用 `clean`。
- **密码 UX**：TTY 下无回显读取；`--password-stdin` 供脚本；否则 `IAQS_PASSWORD`；
  再否则默认口令 `12345678`。设置新密码时弱口令需 `--allow-weak-password` 或二次确认；
  `passwd` 不再把旧 `IAQS_PASSWORD` 当作新密码来源（仅 `init` 接受它）。
- **UTF-8 路径**：CLI 的 UTF-8 参数经 `fs_path_from_utf8` 转宽字符；数据库/段文件打开
  统一走该路径，中文仓库名不再生成半截 MANIFEST。
- **参数解析**：支持 `--name=value`；未知选项仍被忽略（脚本请只使用文档化选项）。
- **构建**：Windows 目标静态链接 MinGW 运行库（`-static -static-libgcc -static-libstdc++`），
  分发不需要额外 DLL。