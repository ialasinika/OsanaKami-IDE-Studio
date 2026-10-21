# iaqs

iaqs 是一个**单机、单人**的版本管理器：对任意项目、任意文本与文件做本地版本管理，
可以理解为「不需要协作、不需要联网的 git」。它在自己的**加密数据库**里保存完整历史，
核心能力对应三件套：

- **库**（自研嵌入式关系数据库：加密、分页/分段、事务/WAL、B+树索引、支持 1 TB 级大对象）；
- **增量存储**（对象层 delta 链 + LZ1 压缩 + 数据库层分块去重与 B+树索引）；
- **版本树管理**（提交 DAG、分支、标签、三方合并、reflog、reset）。

> 当前状态：**M1–M7 核心已可运行**（数据库、SQL、对象存储、工作区、分支/切换/合并、
> tag/reset/diff/passwd/rekey、对象层 delta 链 + gc/fsck、rm/mv/restore/clean/rev-parse/checkpoint、
> 大文件流式分块写入/读取/检出、rekey --data 原地重加密、zh-CN/en 双语输出 +
> **可安装语言包**、`export-git` 导出 fast-import 流与 **git pack 兼容的导入/导出**/
> `import-git`、内部二级索引、增量 gc、**多进程并发写** 全部有 e2e 验证；
> 248 个单元测试全绿）。M7 完成了一轮**安全与鲁棒性审计加固**：仓库内路径包含校验
> （拒绝 `..`/绝对路径/junction/.iaqs 内部路径）、merge 脏工作区保护、status 不再被
> stat 缓存误判、ref/tag 名与导出路径校验、WAL nonce 防复用与崩溃尾部容错、段文件
> fsync、`restore` 需 `--all`、`rm` 仅限已跟踪文件、UTF-8 仓库路径、静态链接无 DLL 依赖。
> 另有：分块表 B+树索引（读取不再全文扫描）、文件占位 placeholder、`rev-parse --short`、
> `diff --stat` 与彩色输出、`rekey --data` 进度显示、无密码时默认口令 `12345678`（弱口令需确认）。

## 关键决策

- 提交**不记录作者**（单机单人无身份），只有 tree、父提交、时间、说明。
- 仓库是一个**加密库**：没有密码打不开；磁盘上不出现明文对象、索引、表名
  （PBKDF2-HMAC-SHA256 600k 派生 KEK，ChaCha20-Poly1305 页级加密）。
- 数据存在自研数据库里：8 KiB 页、256 MiB 分段文件（避免单文件过大被文件系统卡住）、
  B+树索引（含内部二级索引）、WAL 崩溃恢复。**数据库完全内部使用**：SQL 只作为存储引擎的
  实现细节（负责表/行/索引/事务），不向用户提供 SQL 语句接口，用户只通过版本管理命令操作。
- 写事务由 `<repo>/.iaqs/locked` 串行化，多个 iaqs 进程可同时打开同一仓库：写入者提交后立刻
  对其他进程可见，读进程看到打开时已提交的状态；每个事务使用独立 WAL 文件，崩溃后重放恢复。
- 大文件按**内容寻址分块**流式存储，重复块去重，单文件目标 **1 TB**。
- 任意文本/文件按**字节**存取与比较，不做编码转换（UTF-8/GBK/BOM/CRLF/二进制都安全）；
  diff/合并按行，行尾 `\r` 保留。
- 人类可读输出支持 **i18n**（内置 zh-CN / en），并支持**安装语言包**：
  `iaqs lang install <file.lang>` 安装、`iaqs lang use <code>` 设为默认；
  语言包是 UTF-8 的 `key=value` 文本，用 `iaqs lang export [code]` 导出完整模板。
  机器输出（`--porcelain`/`--json`）固定不翻译。
- C++20 + CMake + MinGW-w64，**零第三方依赖**：SHA-256、PBKDF2、ChaCha20-Poly1305、
  LZ1、delta、测试框架均自研。
- 打开仓库时只在初始化/恢复/升级期间短暂持有 `<repo>/.iaqs/locked`；写事务从
  `begin` 到 `commit`/`rollback` 通过该锁串行化。锁文件内容为 `pid` + `time`：
  进程已退出、或内容不是合法锁（如崩溃留下的半截文件）会被回收；空锁文件在创建后
  2 秒内视为"正在写入"而不抢占，未来时间戳按垃圾处理。读操作不持锁。数据库是
  **内部实现**，不对外暴露 SQL 查询接口。
- 工作区路径一律做**包含校验**：`add`/`rm`/`mv`/`restore`/`clean` 不能越出仓库根目录，
  也不能触碰 `.iaqs/` 内部文件；仓库路径支持中文等非 ANSI 字符（UTF-8 → 宽字符）。

## 构建与测试

本机环境用 MinGW-w64 + `MinGW Makefiles`（Ninja 在部分沙箱环境会卡在编译器探测）：

```powershell
$env:PATH = 'C:\mingw64\mingw64\bin;' + $env:PATH
cmake -S . -B build -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
.\build\iaqs.exe --version
.\build\iaqs_tests.exe            # 全量单元测试（可用 IAQS_TEST_FILTER=suite. 过滤）
```

或直接运行 `scripts/build.ps1` / `scripts/test.ps1`。

## 快速上手

```powershell
$env:IAQS_PASSWORD = 'pw123'
cd C:\work\myproject
iaqs init                      # 创建 .iaqs/（加密库）
iaqs add -A
iaqs commit -m "first commit"
iaqs status
iaqs log --oneline
iaqs branch feature
iaqs switch feature
# ...编辑文件...
iaqs add -A; iaqs commit -m "feature work"
iaqs switch main
iaqs merge feature             # 干净合并自动提交；冲突时留下标记并返回 1
iaqs add <resolved>; iaqs commit -m "merge"
iaqs tag v1.0 -m "release"
iaqs diff                      # 工作区 vs HEAD 的统一 diff
iaqs diff --stat HEAD~2 HEAD   # 统计摘要（--color=always/never 控制颜色）
iaqs diff HEAD~2 HEAD          # 两次提交之间
iaqs reset --hard HEAD^        # 回退分支与工作区
iaqs passwd --new-password newpw
iaqs gc --dry-run              # 预演：把同一路径的历史 blob 重打包成 delta 链
iaqs gc                        # 执行重打包并回收不可达对象
iaqs fsck                      # 校验对象哈希、提交/树/refs 链完整性
iaqs mv old.txt new.txt        # 改名并暂存
iaqs rm obsolete.txt           # 删除并暂存删除（--cached 只从索引移除）
iaqs restore broken.txt        # 从 HEAD 恢复工作区文件
iaqs clean -n                  # 列出将被删除的未跟踪文件（去掉 -n 即真删）
iaqs rev-parse HEAD            # 打印完整 oid
iaqs rev-parse --short HEAD    # 打印短 oid（--short=N 指定 4..64 位）
iaqs placeholder add logo.png -m "design pending"  # 先登记还没上传的文件
iaqs placeholder list          # 列出占位；status 中以 "P" 显示待兑现
iaqs placeholder remove logo.png
iaqs checkpoint                # 手动把 WAL 合并进段文件
iaqs lang list                 # 列出可用语言（内置 + 已安装语言包）
iaqs lang export zh-CN > zh.lang   # 导出完整语言包模板，可翻译后分享
iaqs lang install ./eo.lang    # 安装语言包（复制到 $IAQS_HOME/lang）
iaqs lang use eo               # 设为默认语言（写入 $IAQS_HOME/config）
iaqs lang remove eo            # 删除已安装语言包（内置语言不可删）
iaqs export-git --author "Your Name <you@example.com>" > history.fi
                               # 导出完整历史为 git fast-import 流（iaqs 提交无作者，需显式给出）
# 在目标 git 仓库里：git fast-import < history.fi
iaqs export-git --author "Your Name <you@example.com>" --format=pack --out ./gitpacks
                               # 导出 git 原生 pack + idx（可直接放进 .git/objects/pack）
iaqs import-git /path/to/repo/.git   # 从真实 git 仓库（pack/松散对象、refs、HEAD）导入
```

> iaqs 的加密数据库是**内部存储引擎**，不提供面向用户的 SQL 查询接口；需要查看历史内容请用
> `iaqs log/show/cat-file/ls-tree/diff` 等版本管理命令。

密码来源优先级（打开仓库）：`--password-stdin`（从标准输入读一行，适合脚本）→
`IAQS_PASSWORD` → 交互式终端无回显输入 → 默认口令 `12345678`。
设置新密码（`init` / `passwd`）：`--new-password` / `IAQS_NEW_PASSWORD`（`init` 还接受
`IAQS_PASSWORD`）→ 交互式输入两次；显式设置弱口令需 `--allow-weak-password`，
非交互式下不建议依赖默认口令。退出码：0 成功、1 运行时错误、
2 用法错误、4 密码错误/数据损坏。

## 许可证

本项目采用 **0BSD（BSD Zero Clause License）**，全文见 [LICENSE](LICENSE)。

0BSD 是极宽松的许可证：允许任意使用、复制、修改和再分发（含闭源商用），
**不要求保留版权声明**，也不提供任何担保。选择它是因为 iaqs 是自研本地工具、
零第三方依赖，希望尽可能降低采用与嵌入的门槛。

> 如需在企业法务场景下获得显式的专利授权条款，可考虑改为 `MIT OR Apache-2.0`
> 双许可；如需保证衍生版本开源，可改为 `MPL-2.0` 或 `GPL-3.0`。
> 改变许可证需要版权持有人同意（当前版权行为 `iaqs contributors`）。

## 设计文档

| 文档 | 内容 |
| --- | --- |
| [docs/design/README.md](docs/design/README.md) | 索引与已确认决策（D1–D14） |
| [00-overview.md](docs/design/00-overview.md) | 目标、非目标、架构、模块、里程碑、验收 |
| [01-object-model.md](docs/design/01-object-model.md) | 对象逻辑格式、数据库表结构、refs/HEAD/reflog、锁 |
| [02-storage.md](docs/design/02-storage.md) | 两层增量存储：delta 链、分块去重、页压缩、gc、fsck |
| [03-version-tree.md](docs/design/03-version-tree.md) | 提交 DAG、分支/标签、切换、合并/冲突、log/graph、reset |
| [04-worktree-cli.md](docs/design/04-worktree-cli.md) | 工作区、暂存区、status/diff、命令面、i18n、退出码 |
| [05-quality.md](docs/design/05-quality.md) | 测试策略、失败注入、性能目标、验收清单、风险 |
| [06-database.md](docs/design/06-database.md) | 自研关系数据库：页/段/WAL/B+树/LOB/SQL/恢复 |
| [07-encryption.md](docs/design/07-encryption.md) | 密钥层级、页/WAL 加密、passwd/rekey、威胁模型 |

## 里程碑

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M1 | 加密数据库地基（页/段/WAL/恢复、密钥、最小表 API） | ✅ 完成 |
| M2 | 核心版本库（init/add/commit/status/log/diff/对象层存储） | ✅ 完成 |
| M3 | 版本树（分支/切换/合并/冲突/tag/reflog/reset） | ✅ 完成 |
| M4 | 对象层 delta 链、gc/fsck、rm/mv/restore/clean/rev-parse/checkpoint、大文件流式分块、rekey --data、i18n 完善 | ✅ 完成（delta/gc/fsck/命令/流式/rekey/i18n 均有测试与 e2e） |
| M5 | 与 git 互通：export-git 生成 fast-import 流（提交/作者/标签/分支/合并/删除/二进制） | ✅ 完成（真实 git fast-import 导入验证） |
| M6 | 生产化：SQL 二级索引、增量 gc、多进程并发写、git pack 导入/导出（`--format=pack` + `import-git`）、可安装语言包 | ✅ 完成（240 单元测试，含并发/索引/增量 gc/真实 git pack 校验） |
| M7 | 审计加固：路径包含与 `.iaqs` 保护、merge/status 数据安全、ref/tag 名与导出路径校验、WAL/fsync/锁崩溃安全、密码与 UTF-8 路径 UX、静态链接 | ✅ 完成（两份审计报告 blocker/high 全部修复，新增回归测试，248 单元测试全绿） |

## 目录

```
src/core/        基础工具、SHA/HMAC/PBKDF2/ChaCha20-Poly1305、CRC32C、随机数、文件锁
src/db/          自研加密关系数据库（MANIFEST、密钥、页/段、页缓存、WAL、堆表、目录、事务、B+树、二级索引）
src/sql/         词法/语法分析 + 最小 SQL 执行器（含索引计划）
src/vcs/         对象模型（blob/tree/commit/tag）、对象库（含流式分块）、Repo、合并、diff、gc
src/git/         git 互通：SHA-1、zlib(inflate/deflate stored)、pack v2 读写、对象转换
src/i18n/        内置 zh-CN / en、语言包安装与语言探测
src/cli/         命令行
tests/           自研测试框架 + 248 个单元测试
docs/design/     设计文档（00–07）
scripts/         构建/测试脚本
```
