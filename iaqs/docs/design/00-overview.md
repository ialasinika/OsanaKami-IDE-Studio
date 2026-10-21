# 00 · 目标、边界与总体架构

## 1. 问题与目标

iaqs 要解决的问题：**在一台机器上，给任意项目的任意文件做本地版本管理**，
不依赖服务器、不依赖第三方库；存储底座是**自研的加密关系数据库**，因此
元数据与文件内容都以表/行的形式落库，且没有密码无法读取。

v1.0 的成功标准（可演示、可验收）：

1. 任意目录 `iaqs init` 后即可跟踪文件；文本（UTF-8/GBK/UTF-16 BOM/CRLF/无换行结尾）
   与二进制文件都能正确存储、比较、还原。
2. 完整命令面：`init/open/add/rm/status/commit/log/diff/show/cat/ls/branch/switch/
   merge/tag/reset/gc/fsck/passwd/config`；一次提交只包含暂存区的修改。
3. 版本树：分支、标签、合并、冲突解决、`log --graph`、reflog 恢复。
4. 存储是增量的：对象层同路径历史版本做 delta 链；数据库层页压缩 + 大文件分块去重。
   同一批文本历史通常压到原体积的 1/3～1/10；1 GiB 的单文件可只追加增量分块。
5. 加密：仓库打开需密码；数据页、索引页、WAL、元数据全部加密；支持改密码与数据重加密。
6. 大文件：单文件目标 1 TB，流式提交/检出/读取，不要求全量载入内存；数据库由多个
   分段文件组成，单文件不会无限膨胀。
7. 崩溃安全：任何命令被强杀或断电后，重开时 WAL 恢复；`iaqs fsck` 能通过（或明确
   报告损坏页），不会产生半提交。
8. 规模目标：1 万个文件、100 MB 级工作区、1 万次提交以内，`commit`/`status`/`log`
   在秒级，`gc` 在分钟级；1 TB 单文件的提交是「流式 + 分块」路径（见 02 文档）。
9. i18n：至少中文/英文两套界面文案，可随系统语言或显式参数切换。

## 2. 非目标（v1 明确不做）

| 不做 | 原因/后续 |
| --- | --- |
| 远程、push/pull/clone | 单机版本管理；需要时复制目录或用备份命令 |
| 多用户、权限、签名 | 单人单机；身份无意义，访问控制靠密码 |
| 对外通用 SQL 数据库产品（独立 CLI、任意表、多客户端） | D9：数据库只作为 iaqs 内部引擎；SQL 仅内部/调试用 |
| 与 git 磁盘格式互通 | 自研格式更简单可检查；将来可加 export |
| GUI/TUI 面板、钩子、模板 | 先把 CLI 做好 |
| submodule、sparse checkout、LFS | 超出核心；大文件已由分块/流式覆盖 |
| 多进程并发写、MVCC、JOIN、聚合 | D14：单写者 + 最小 SQL 集；后续版本再评估 |
| 自动合并二进制 | 二进制冲突保留 ours 并报冲突，由用户决定 |
| 硬件加密卡/TPM | 纯软件实现；ChaCha20-Poly1305 软件性能足够 |

## 3. 设计原则

1. **字节优先**：文件内容就是字节；BLOB 存原始数据，不做编码/换行转换；行级 diff/合并按
   `\n` 切行并保留 `\r`。
2. **数据库即底座**：版本库对象、引用、暂存区、reflog 全部落在自研关系库里，用 SQL/表
   表达；一次 `commit` = 一个数据库事务（对象 + refs + reflog 原子生效）。
3. **默认加密**：建库即设定密码；页、WAL、元数据都加密；密钥不落盘明文；改密码便宜，
   数据重加密可离线做。
4. **逻辑格式可读**：tree/commit/tag 仍是文本行格式（存为 TEXT/BLOB），出问题能看懂、
   能手改；物理存储的加密/压缩对上层透明。
5. **大对象流式**：从读文件、压缩、分块、加密、写页到检出，全程流式，内存占用有上限
   （与文件大小无关）；分块内容寻址，天然去重。
6. **局部失败不扩散**：事务提交前不对外可见；崩溃后通过 WAL 前滚已提交、丢弃未提交。
7. **零依赖、可移植**：C++20 标准库 + 少量 OS API；Windows 优先，Linux/macOS 可编译。
8. **性能诚实**：给出基准与降级策略（如大文件压缩可关闭、delta 只对文本、gc 可限速）。

## 4. 术语

| 术语 | 含义 |
| --- | --- |
| 工作区 worktree | 用户编辑的普通目录（`.iaqs/` 之外） |
| 仓库 repo | `.iaqs/` 目录：数据库文件 + 锁 + 忽略规则 |
| 数据库 DB | 自研关系数据库（加密），版本库的一切都存其中 |
| 页 page | 8 KiB 的逻辑存储单元，加密/压缩的基本单位 |
| segment | 数据库的分段文件（默认 256 MiB），页通过 (seg, page) 定位 |
| WAL | 预写日志，崩溃恢复用；同样加密 |
| 对象 object | blob/tree/commit/tag，不可变，按内容寻址 |
| oid | `sha256("<type> <size>\0" + payload)` 的 64 位小写 hex |
| 暂存区 index | DB 中的表，记录下一次提交的文件清单 |
| 版本树 / 提交 DAG | commit 由 parent 连成的无环图，分支是移动指针 |
| delta 链 | 用「从基准拷贝 + 插入」指令表示相似对象（对象层增量） |
| chunk | 1 MiB 内容寻址数据块，用于大文件存储与去重（DB 层增量） |
| gc | 回收：对象 delta 重排、chunk 引用计数清理、页/文件空间回收 |
| reflog | DB 中的引用移动历史，用于恢复 |
| 快进 / 三方合并 | 合并两种路径：移动指针 / 基于 merge-base 合并内容 |

## 5. 总体架构

```
                   ┌───────────────────────────────────────────────┐
  iaqs.exe ────────│ CLI 命令层（i18n 消息）                        │
                   │ init open add rm status commit log diff show  │
                   │ ls branch switch merge tag reset gc fsck       │
                   │ passwd config                                  │
                   └───────────────┬───────────────────────────────┘
                                   │
                   ┌───────────────▼───────────────────────────────┐
                   │ 仓库层 Repo                                    │
                   │  workdir、.iaqs、config、HEAD/refs/reflog      │
                   │  resolve_commit（HEAD/分支/tag/缩写/^~）       │
                   │  Lock、可达性、path_blob_chains                │
                   └───────┬───────────────────────┬───────────────┘
                           │                       │
          ┌────────────────▼──────────┐   ┌────────▼──────────────────┐
          │ 工作区层                   │   │ 版本树层                   │
          │ Index 表（暂存+stat 缓存） │   │ DAG（parents/LCA/遍历）    │
          │ Worktree：扫描/检出/状态   │   │ Merge：三方行合并 + 冲突    │
          │ Ignore：.iaqsignore        │   │ Graph：log --graph         │
          └────────────┬──────────────┘   └────────────┬──────────────┘
                       │                               │
          ┌────────────▼───────────────────────────────▼──────────────┐
          │ 对象/版本库访问层（对象表、引用表、索引表、reflog 表）        │
          │  blob/tree/commit/tag 编解码；对象层 delta 链；大对象 LOB 流 │
          └────────────┬──────────────────────────────────────────────┘
                       │
          ┌────────────▼──────────────────────────────────────────────┐
          │ 自研关系数据库（06 文档）                                  │
          │  SQL 子集 / 表 / B+树索引 / slotted 页 / LOB / WAL / 恢复    │
          │  页压缩（LZ1）+ 分块去重（chunk 表）                         │
          └────────────┬──────────────────────────────────────────────┘
                       │
          ┌────────────▼──────────────────────────────────────────────┐
          │ 存储与加密底座（07 文档）                                   │
          │  segment 文件管理、页缓存、校验和、AEAD 页加密、KDF、rekey    │
          └───────────────────────────────────────────────────────────┘
```

分层规则：只能向下依赖。CLI 不直接碰数据库页；工作区层不直接改 refs；版本树层只通过
对象访问层读写；数据库层不知道「git 对象」的存在。每层可独立单测。

## 6. 模块职责

| 模块 | 职责 | 关键契约 |
| --- | --- | --- |
| util | 字节、hex、varint、路径规范化、时间/时区、名称转义、i18n 文本输出 | `normalize_rel_path`、`escape_name`、`tr()` |
| sha256 | 纯 C++ SHA-256 / HMAC-SHA256 / PBKDF2-HMAC-SHA256 | `sha256_hex`、`pbkdf2_sha256` |
| chacha20poly1305 | RFC 8439 AEAD，供数据库加密 | `aead_seal/aead_open` |
| crc32c | 页/WAL 快速校验（非加密） | `crc32c` |
| i18n | 消息目录（zh-CN/en）、语言选择、格式化 | `I18n::t(id, args...)` |
| db | 自研关系数据库：文件/页/行/B+树/LOB/WAL/事务/SQL/压缩/加密 | `Database::open/exec/blob_stream` |
| object | 对象逻辑模型与文本序列化 | `encode_commit/decode_commit` 等 |
| objectstore | 对象表读写、对象层 delta 链、大对象 LOB 流 | `ObjectStore::write/read/stream` |
| refs | refs/HEAD/reflog 表操作 | `read/write/list`、`set_head_*` |
| dag | 提交 DAG 遍历、LCA、图渲染 | `merge_base/date_order/render_graph` |
| merge | 行级三方合并、冲突标记 | `merge3(base, ours, theirs)` |
| index | 暂存表加载/保存/增删查 | `load/save/put/remove/find` |
| worktree | 扫描、树构建/展开、检出、状态、还原 | `build_tree_from_index/compute_status` |
| ignore | `.iaqsignore` 规则解析与匹配 | `IgnoreRules::load/ignored` |
| linediff | Myers 行级差异 | `diff_lines` |
| diff | unified diff 与 --stat | `unified_diff/diff_stat` |
| repo | 打开/初始化、配置、解析、锁、可达性 | `Repo::init/open`、`resolve_commit` |
| cli | 子命令分发、参数校验、密码输入、i18n 输出、退出码 | `run_cli` |

## 7. 典型数据流

**打开仓库**：`iaqs <cmd>` → 向上找 `.iaqs/` → 读 MANIFEST（明文头：KDF 参数 + 包裹的
数据密钥）→ 交互式输入密码 → PBKDF2 派生 KEK → 解包 DEK → 校验 verifier → 打开数据库
（只读命令可只读打开）→ 执行命令。

**提交**：`add` → 读工作区文件（大文件流式）→ 写 blob（小对象直接存，大对象分块入 LOB、
块内容寻址去重）→ 更新 index 表 → `commit` → 由 index 写 tree → 写 commit → **一个数据库
事务**内更新 refs + reflog + objects → 提交（WAL 落盘）→ 返回。
（index 保留全部已跟踪条目用于 status。）

**状态**：读 HEAD 的 tree 展开 `path→oid` → 与 index 表比较得「已暂存」→ 用 index 的
stat 缓存扫工作区得「未暂存/未跟踪」。

**历史**：`log` → refs+HEAD 取 tips → DAG 排序 → 输出；`--graph` 复用排序做 lane 渲染。

**检出**：解析目标 commit/tree → 比较树 → 校验脏文件 → 流式写文件（原子替换）、删多余
文件、更新 index 与 HEAD（事务）。

**合并**：`merge_base` → 快进或三方合并 → 写 tree/commit → 事务更新 ref；冲突则写冲突
标记 + 记录合并状态表，不移动 ref。

**打包**：`gc` → 可达对象 + 路径版本链 → 选 delta 基准重排（对象层）→ 清理无用 chunk
（引用计数）→ 回收页/合并 segment（DB 层）→ 事务提交。

## 8. 里程碑（v1.0 内全部完成）

| 里程碑 | 内容 | 验收 |
| --- | --- | --- |
| **M1 加密数据库与地基** | chacha20poly1305/sha256/pbkdf2/crc32c、数据库核心（分段文件、8K 页、AEAD、slotted 页、表、单表 CRUD、B+树、WAL、恢复、LOB 分块）、`init/open/passwd`、密码打开流程 | 建库/改密码/断电注入后恢复；SQL 冒烟通过 |
| **M2 核心版本库** | 对象逻辑格式、objects/refs/index/reflog 表、blob/tree/commit、`add/status/commit/log/diff/show/cat/ls`、i18n 框架 | 真实文本目录可提交、看历史、看 diff |
| **M3 版本树** | `branch/switch/merge/tag/reset`、冲突、`log --graph`、reflog、合并状态表 | 两分支并行修改后合并；冲突可解决；图正确 |
| **M4 增量存储与打磨** | 对象层 delta 链、DB 层页压缩与分块去重、`gc`/`fsck`、大文件流式、i18n 文案补全、性能基准、e2e | 体积下降；1 GiB/10 GiB 文件流式通过；fsck 通过 |

每个里程碑结束：`-Wall -Wextra` 零警告、单测全绿、文档同步、可复现演示命令。

## 9. 验收标准（Definition of Done）

1. **正确性**：文本（CRLF/无结尾换行/BOM/GBK/UTF-16）与二进制提交 → 切旧版 → 切回，
   字节一致；`cat/show` 与工作区一致。
2. **版本树**：分支/切换/合并/删除、标签、`log --graph`、冲突标记、`merge --abort`、
   reflog 恢复可用；合并结果与手工预期一致。
3. **数据库**：断电/强杀后重开自动恢复、`fsck` 通过；页校验和/加密标签校验能发现坏页；
   `passwd` 改密码后旧密码立即失效。
4. **增量与去重**：`gc` 后对象体积显著下降；1 GiB 文件改 1 行再提交，新增分块远小于
   1 GiB；chunk 引用计数正确，不误删被引用块。
5. **大文件**：单文件 1 GiB 提交/检出/`cat` 流式完成且内存占用有界；数据库多 segment
   文件正常增长；设计支持 1 TB（见 05 的验证方法）。
6. **i18n**：`--lang en` 与 `--lang zh-CN` 下命令帮助与提示正确切换；`--porcelain`
   输出不随语言变化。
7. **性能**：见 05 文档基准表；1k 文件 `status` 热缓存 < 1 s。
8. **可维护性**：零第三方依赖；`cmake --build` 产出 `iaqs` 与 `iaqs_tests`；文档与实现一致。
