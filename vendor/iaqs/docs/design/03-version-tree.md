# 03 · 版本树管理

仓库的版本结构是一棵**有向无环图**（commit DAG）：每个提交指向一个 tree（完整快照）、
零个或多个父提交、提交时间与说明。分支和标签都是指向提交的引用。单机单人没有协作，
但「版本树」要求支持并行开发线（分支）与汇合（合并），因此本设计按完整 DAG 实现。

## 1. 提交与引用

### 提交对象（逻辑格式见 01）

```
tree <tree oid>
parent <commit oid>        # 0、1 或多行
time <unix ts> <tz ±HHMM>
<空行>
<message>
```

- 根提交无 parent；普通提交 1 个 parent；合并提交 2 个（v1 不再支持 octopus >2 父，
  读到 >2 父按全部父保留、按第一父显示/遍历，文档化）。
- 提交**不记录作者**（D4），reflog 也只记时间与说明。

### 引用

| 引用 | 位置 | 语义 |
| --- | --- | --- |
| `HEAD` | `meta('HEAD')` | 符号引用 `ref: refs/heads/main` 或分离 `commit <oid>` |
| 分支 | `refs('refs/heads/<name>')` | 指向提交；名字规则见下 |
| 标签 | `refs('refs/tags/<name>')` | 轻量（直接指向提交）或 annotated（指向 tag 对象） |
| reflog | `reflog` 表 | `(ref, old_oid, new_oid, time, tz, message)` |

- 引用名规则：UTF-8 字节；不能以 `-` 开头；不能含 `..`、`~`、`^`、`:`、`?`、`*`、`[`、
  `\`、空白、控制字符；分支名可含 `/` 但不可有连续 `//` 或以 `/` 结尾；大小写敏感。
- 更新引用必须**比较并交换**：事务内读旧值，与命令持有的期望值一致才写，否则报错
  （防止同一仓库的两个进程/两个窗口互相覆盖）。HEAD 符号引用只改指向，不改分支本身。
- 删除当前分支被拒绝；删除引用写 reflog。

## 2. 分支

| 命令 | 行为 |
| --- | --- |
| `iaqs branch` | 列出分支（当前分支前加 `*`） |
| `iaqs branch <name> [<start>]` | 创建分支（默认 HEAD）；名字已存在则报错 |
| `iaqs branch -d <name>` | 删除已合并分支；`-D` 强制删除未合并分支 |
| `iaqs branch -m <old> <new>` | 重命名 |
| `iaqs branch --list <pattern>` | 按前缀/通配过滤 |

- 创建分支不切工作区；`switch` 才切。
- 分支删除不删对象（对象由 gc 按可达性回收）。
- 当前分支在 detached HEAD 状态时 `branch` 输出提示「当前处于分离 HEAD」。

## 3. 切换（switch / checkout）

`iaqs switch <branch>` 与 `iaqs checkout <branch|commit>` 语义相同（`checkout` 还接受
路径形式，保持 git 用户的直觉；`switch` 只切分支，避免误用）。

**两路更新**（目标提交是当前提交的祖先或后代，或工作区干净）：

1. 计算目标 tree 与当前 HEAD tree 的差异；
2. 检出目录中，与目标相同者不动；目标新增/修改者写入；目标删除者删除（仅跟踪文件；
   未跟踪文件保留并提示）；
3. 更新 index 为目标的完整树，更新 HEAD。

**保护规则**：

- 若工作区/暂存区存在会被覆盖的本地改动，拒绝切换并列出文件（`--force` 可强制丢弃，
  需二次确认；`--merge` 尝试三路带过去，冲突则中止）。
- 切换前校验目标 tree 中所有对象存在（fsck 级别），防止切到一半失败；切换过程用
  「先建临时目录再原子替换」不可行（工作区是用户的目录），因此按「预检 → 逐文件写
  → 失败回滚已写文件」实现，并在失败时保留 `merge_state` 供 `switch --abort` 恢复。
- detached HEAD：允许（`switch <commit>`），提示「你处于分离 HEAD，提交不会更新任何分支」，
  reflog 记录。

## 4. 合并（merge）

### 4.1 基本流程

1. 读 HEAD 提交 H 与目标提交 T（分支/标签/commit）；
2. 若 T 是 H 的祖先 → `Already up to date`；
3. 若 H 是 T 的祖先 → **fast-forward**（H 前移到 T，写 reflog；`--no-ff` 则仍造合并提交）；
4. 否则求**合并基** B（见 4.2），做三方合并，若干净则生成合并提交（2 父：H、T），
   否则写入冲突文件与 `merge_state`，命令返回退出码 1 并提示 `merge --continue/--abort`。

配置：`merge.auto_commit = true`（默认）时干净合并自动提交；`merge.message` 模板
`Merge <target>`，可 `-m` 覆盖。合并提交的 `time` 取合并完成时刻。

### 4.2 合并基

- 单父历史：B = 最近公共祖先（LCA）。
- 多条候选（criss-cross 合并历史）：v1 取「所有 LCA 中提交时间最新者」作为唯一合并基，
  并在日志中输出全部 LCA（文档化此简化，不实现递归合并基）。
- 求法：从 H 和 T 各自向上 BFS，标记可达集合，取 H 可达且 T 可达的提交里「不是其他候选
  祖先」的集合（LCA），再按时间取最大；复杂度 O(提交数)。

### 4.3 三方合并算法（文件级）

对 B、H、T 三棵树的路径并集，逐路径决策：

| 情况 | 结果 |
| --- | --- |
| H 与 B 相同（我们没改） | 取 T |
| T 与 B 相同（他们没改） | 取 H |
| H 与 T 相同 | 取该内容 |
| 三方 mode 变化不同 | 冲突（保留 H 的 mode 并报告） |
| H 删、T 改（或反之） | 冲突（保留存在的一方，标记冲突） |
| 两边都删 | 删除 |
| 新增/模式/内容都不同 | 进入内容合并 |

**内容合并**（文本）：

- 二进制判定：内容含 NUL 字节 → 二进制；二进制两边都改 → 冲突（保留 H 的内容与 mode，
  报告路径，不写冲突标记）。
- 文本：按行（保留 `\r`）做**行级三方合并**：
  - 把 B 的行与 H、T 分别对齐，得到 H/T 相对 B 的编辑区间；
  - 区间不重叠 → 全部应用；
  - 区间重叠（两边都改同一区域）→ 输出冲突块：

    ```
    <<<<<<< ours
    H 的行
    =======
    T 的行
    >>>>>>> theirs
    ```

  - 冲突块前后仍套用非冲突编辑；行尾风格按 H 优先（不自动转换）。
- 冲突结果：文件按上面规则写入工作区，**不更新 index、不自动提交**；
  `merge_state` 表记录：正在合并的目标、合并基、冲突路径列表、操作类型（merge/switch）。
- `merge --abort`：恢复 HEAD tree 的 index 与工作区（丢弃冲突文件内容，恢复合并前状态）；
  `merge --continue`：校验冲突已解决（文件可暂存），用暂存内容生成合并提交；
  未解决冲突时继续被拒绝。

### 4.4 合并提交

- 父：`[H, T]`（顺序固定：ours 在前，便于日志）。
- 说明：`<message>`（默认 `Merge <T 的短 oid 或分支名>`），可追加 `merge_state` 摘要。
- 合并完成后删除 `merge_state`，写 reflog。合并提交不改工作区（冲突已解决的情况下）。

## 5. 标签

- 轻量标签：`refs/tags/<name>` 直接指向提交（不产生对象）。
- annotated 标签：tag 对象（object/type/tag/time/message，无 tagger 身份），ref 指向 tag 对象；
  `iaqs show <tag>` 自动解引用。
- `iaqs tag <name> [<commit>]`、`-a -m` 创建 annotated、`-d` 删除、`-l` 列出、`-n` 显示说明。
- 标签默认不进 reflog（git 亦然）；删除标签只删引用，对象由 gc 回收。
- 不签名（无身份，无 GPG 依赖）。

## 6. 日志与图

- `iaqs log [--oneline|-p|--stat|--graph|--all] [-n N] [<range>]`：
  - 默认从 HEAD 沿父提交遍历，按**提交时间**降序（时间相同按 oid 字节序），输出
    `commit <oid>`、`time`、message（首行缩进）。
  - `--topo`：拓扑序（子先于父；多个就绪节点按时间优先）——图渲染默认用拓扑序，避免
    时间交错产生视觉交叉。
  - `--graph`：ASCII 图：每个提交一行，左侧泳道字符（`*`、`|`、`/`、`\`、`_`），
    多分支并行显示；终端宽或 `--graph=full` 显示完整，窄终端降级为 `*` + 缩进。
  - `--all`：全部分支/标签作为起点；`<range>` 支持 `A..B`（B 可达但 A 不可达）、
    `A...B`（对称差）。
  - `-p`：提交 diff（父到本提交）；`--stat`：变更行数统计。
- `iaqs show <rev>`：提交（头信息 + diff）、tag、tree、blob 均支持。
- `iaqs rev-parse <rev>`：解析为 oid，便于脚本。
- 修订语法：`<oid 前缀>`、分支名、标签名、`HEAD`、`HEAD~n`（沿第一父）、`HEAD^`、`HEAD^2`
  （合并第二父）、`@`（=HEAD）、`@{n}` reflog 第 n 条。

## 7. Reset 与恢复

| 形式 | 行为 |
| --- | --- |
| `reset --soft <rev>` | 只移动 HEAD/分支，工作区与 index 不动 |
| `reset --mixed <rev>`（默认） | 移动 HEAD，index 重置为目标树，工作区不动 |
| `reset --hard <rev>` | 移动 HEAD，index 与工作区都重置（**丢弃本地改动**，`--hard` 需确认或 `--yes`；工作区被覆盖文件先备份到 `.iaqs/lost+found/<timestamp>/` 以防误操作） |

- 所有 HEAD/分支移动都写 reflog（`reset: moving to <rev>` 等）。
- `iaqs reflog [<ref>]` 列出；`iaqs reset --hard <ref>@{n}` 恢复；reflog 保留 90 天/最多
  1000 条（配置 `reflog.max_entries`），超出裁剪。
- `refs` 的 reflog 是误删分支/错误 reset 的主要恢复手段，gc 的保留期默认 30 天
  （`gc.reflog_expire`）——期间不可达对象不删。

## 8. 不变式与一致性

- 任何时刻：HEAD 指向的提交必须存在；符号 HEAD 指向的分支存在（否则视为 unborn，
  首次提交时创建）。
- 引用更新在**同一数据库事务**内完成（CAS + reflog 追加）；中途崩溃则全部回滚。
- 提交写入顺序：先写 blob/tree（对象幂等）→ 再写 commit 对象 → 再 CAS 更新 ref；
  崩溃只会留下不可达对象（gc 清理），不会产生半提交。
- 合并/切换的中间状态 `merge_state` 也是加密库中的一张表，崩溃后重新打开可继续或中止。

## 9. 实现注记（合并分类）

- 三方合并按路径做九态判定（base/ours/theirs 是否存在、是否等于 base），比较 oid：
  仅一侧新增（base 与另一侧都没有该路径）视为干净新增并保留；仅一侧修改/删除按“改动侧”
  直接采用；两侧都改同一路径时若 oid 相同直接合并，否则按行级 `merge3`（`src/vcs/merge.h`）。
- 双方都删除同一路径视为干净；删除 vs 修改、add/add 内容不同、二进制内容变化记为冲突，
  冲突路径写入 `merge_state`（base/ours/theirs oid），`MERGE_HEAD` 记入 meta 表，
  `commit` 在冲突未解决（`merge_state` 非空）时拒绝，`add <path>` 解决一条后删除对应行。
- 回归测试：`tests/unit/test_vcs_repo.cpp` 的 `merge_keeps_one_sided_additions`
  覆盖“main 与 feature 各自新增一个不同文件”应为干净合并（对应修复：曾把单侧新增误判为冲突）。

## 实现注记（M7 审计加固）

- **合并前置校验**：工作区有未提交改动（staged/modified/deleted）时拒绝 merge；
  目标树会覆盖未跟踪文件时拒绝并提示 `--force`；清理旧索引时跳过 staged-only 路径
  （不再误删只看得到 index 的文件）。
- **冲突区域**：同一侧出现多段相邻改动时，按「并集区间」整体应用并输出到同一个冲突块，
  避免第二段改动逃到 `>>>>>>>` 之后。
- **status 不再信任 stat 缓存**：始终计算工作区文件哈希（大小+恢复 mtime 曾可伪造 clean，
  并绕过 checkout/merge 的保护）。
- **ref/tag 名校验**：拒绝空名、前导 `-`、`..`、`@{`、`.lock` 后缀、控制字符、空格与
  `~^:?*[\\` 等；标签重名不再静默覆盖。