# 01 · 对象模型、表结构与仓库布局

本文件定义「对象是什么、逻辑格式怎么表示、在自研数据库里怎么存」。逻辑格式是跨版本
契约；物理存储（页、加密、压缩）见 02/06/07 文档。

## 1. 对象 id 与帧

```
object_id = sha256_hex("<type> <payload_size>\0" + payload)
```

- type：`blob` / `tree` / `commit` / `tag`；`payload_size` 为十进制 ASCII（无前导 0）。
- 对象按内容寻址：同 type+payload 必然同 id；重复写入天然去重、幂等。
- 对象**逻辑帧**（`type size\0` + payload）用于哈希与测试；落库时 payload 被拆成
  「行内存储 / delta / LOB 分块」三种物理形态（见 02 文档），但 `oid` 永远按逻辑帧计算。
- 校验：读对象时按逻辑帧重算 oid 比较（fsck 全量；普通读取可选校验）。

## 2. blob

- 负载即文件原始字节，任意长、任意编码、可二进制。
- 二进制判定（仅影响 diff/合并展示）：前 8000 字节含 `\0` 视为二进制；二进制 diff
  输出 `Binary files a/x and b/x differ`，合并冲突时保留 ours 并标记冲突。
- 空文件是合法 blob（payload 为空）。

## 3. tree

一行一个条目，按 **name 的无符号字节序**升序：

```
<mode> <type> <oid> <escaped_name>\n
```

- mode：八进制文本，仅四种：`0100644`（普通文件）、`0100755`（可执行）、
  `0120000`（符号链接）、`0040000`（目录）。
- type：`blob` 或 `tree`，与 mode 对应（目录必须是 tree）。
- escaped_name：单段名字的转义：`\\`、`\n`、`\r`、`\t`；其余字节原样（含空格、非 ASCII、
  控制字符）。目录树不允许重名、`.`、`..`、空名。
- 排序必须用 `unsigned char` 比较（高位字节的中文名），有单测——排序错误会导致同一
  内容产生不同 oid，破坏去重与校验。
- 根 tree 由 index 表自底向上构建（按路径分段建目录节点）。

## 4. commit

```
tree <oid>\n
parent <oid>\n          ← 0..n 行；第一父提交在前
time <unix_ts> <tz>\n   ← tz 形如 "+0800"
\n
<message>               ← 原样保存；非空且结尾无 \n 时编码补一个
```

- **无作者/邮箱/签名**（D4）；也没有权限字段。
- 0 父 = 根提交；≥2 父 = 合并提交（parent[0] 是当前分支一侧）。
- message 不做格式化；允许空 message；`--allow-empty` 允许无改动提交。
- `time` 用于展示与 log 排序；并列时按 oid 兜底保证确定性。

## 5. tag

- 轻量标签：不建对象，`refs/tags/<name>` 直接指向 oid。
- 附注标签：tag 对象：

```
object <oid>\n
type <blob|tree|commit|tag>\n
tag <name>\n
time <unix_ts> <tz>\n
\n
<message>
```

- 标签名规则：非空；不含空格/控制字符/`~^:?*[\\`；不以 `/` 结尾；不含 `..`。
- `refs/tags/x` 与 `refs/heads/x` 可并存；`resolve` 优先分支（文档明示）。

## 6. 版本库表结构

所有表都在加密数据库内（schema 见 06 文档）；type/列名是逻辑契约：

```sql
-- 对象表：逻辑帧的负载 + 物理形态
CREATE TABLE objects (
  oid       TEXT PRIMARY KEY,   -- 64 hex
  type      INTEGER NOT NULL,   -- 1=blob 2=tree 3=commit 4=tag
  raw_size  INTEGER NOT NULL,   -- 逻辑 payload 字节数
  storage   INTEGER NOT NULL,   -- 0=inline raw, 1=inline lz1, 2=delta, 3=LOB 分块
  base_oid  TEXT,               -- storage=2 时的基准对象
  payload   BLOB,               -- storage=0/1/2 时非空（delta 时为 IAQSD1 指令流）
  lob_id    INTEGER,            -- storage=3 时 LOB 句柄（分块链）
  created_ts INTEGER NOT NULL
);

-- 引用：refs/heads/*、refs/tags/*；HEAD 特殊存 meta
CREATE TABLE refs (
  name TEXT PRIMARY KEY,        -- "refs/heads/main" / "refs/tags/v1"
  oid  TEXT NOT NULL
);

-- HEAD 与仓库级状态（meta 是通用 KV，value 为 BLOB 以便二进制）
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,       -- "HEAD" = "ref:refs/heads/main" 或 "<oid>"
  value BLOB NOT NULL           -- 还有 "merge_head"、"merge_msg"、"format_version" 等
);

-- reflog：引用移动历史（append-only；按 ref 保留最近 RECENT_MAX=1000 条）
CREATE TABLE reflog (
  ref     TEXT NOT NULL,
  seq     INTEGER NOT NULL,     -- 单调递增，从 1 开始
  old_oid TEXT NOT NULL,        -- 全 0 表示新建
  new_oid TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  tz      TEXT NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (ref, seq)
);

-- 暂存区：下一次提交的文件清单（同时充当 stat 缓存）
CREATE TABLE index_entries (
  path     TEXT PRIMARY KEY,    -- 相对工作区根、'/' 分隔
  mode     INTEGER NOT NULL,
  oid      TEXT NOT NULL,
  size     INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL
);

-- 合并进行中的逐路径三方状态（冲突解决用；正常情况为空）
CREATE TABLE merge_state (
  path      TEXT PRIMARY KEY,
  base_oid  TEXT,
  ours_oid  TEXT,
  theirs_oid TEXT
);

-- 配置（key=value；见 §11）
CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### 为什么这样设计

- **一个事务提交**：`commit` 在单个数据库事务内写 objects/refs/reflog，要么全成要么全无。
- **stat 缓存与暂存同表**：index 表既描述「将提交什么」，也记录上次文件状态，status 一次性
  读表即可，无需额外文件。
- **objects 只增不改**：对象写入后永不更新；delta 是「新对象引用旧对象」，旧对象仍可独立解析。
- **无冲突 stage 字段**：v1 冲突用 `merge_state` + 工作区标记文件表达，保持表简单。

对象逻辑帧与物理形态的映射：

| storage | 物理内容 | 适用 |
| --- | --- | --- |
| 0 inline raw | payload 直接存 BLOB | 压缩不划算的小对象（如随机二进制） |
| 1 inline lz1 | payload = LZ1(逻辑帧) | 文本 tree/commit/tag、中小 blob |
| 2 delta | payload = IAQSD1 指令流（对 base 的逻辑帧做 delta） | 同路径历史文本 blob（≤8 MiB 且非二进制） |
| 3 LOB | payload 拆成 1 MiB 内容寻址 chunk，`lob_id` 指向块链 | 大文件（>64 KiB 或含二进制） |

选择规则由 02 文档给出（阈值可配）。

## 7. 仓库布局

```
<workdir>/
  .iaqsignore                 # 忽略规则（可选，gitignore 子集，见 04）
  .iaqs/
    MANIFEST                  # 明文头：magic "IAQSDB1"、版本、页/段大小、KDF 盐与参数、
                              # 被包裹的 DEK、verifier、段文件表、CRC
    seg-000000.dat            # 数据段文件（默认上限 256 MiB，页在其中）
    seg-000001.dat            # 段满后自动新建，避免单库文件过大被文件系统卡住
    wal-000000.log            # WAL 段（默认 16 MiB 轮转）
    wal-000001.log
    locked                    # 跨进程写锁（pid/时间/主机/命令）
```

- `.iaqs/` 永远被忽略（不进 index、status 不显示）。
- 工作区可以是任意目录；命令可在子目录执行（向上查找 `.iaqs/`，文件路径相对工作区根）。
- 数据库文件名与段大小在 MANIFEST 中固定；**版本迁移时 MANIFEST 版本号递增**。
- 没有 loose 对象文件、没有 pack 文件、没有 refs/index 文本文件——它们都在数据库里。

## 8. refs 与 HEAD

- 引用表 `refs(name, oid)`；`HEAD` 存 `meta["HEAD"]`：
  - 符号头：`ref: refs/heads/main`（引用不存在 = 未出生仓库）；
  - detached：`<oid 64hex>`。
- 更新引用 = 数据库事务内 `UPDATE/INSERT refs` + `INSERT reflog`；
  分支删除 = 删 refs 行（reflog 保留，可恢复——`branch -d` 后仍能用 reflog oid 找回）。
- reflog：每个 ref 最多保留最近 1000 条（超了在事务里删最旧的行，保留最近的大半）。
- `resolve` 支持 `HEAD`、分支、标签、`refs/...`、完整/前缀 oid、`rev^`、`rev^N`、`rev~N`；
  `rev@{n}` 从 reflog 取第 n 次之前（v1 支持 `HEAD@{n}` 与 `refs/...@{n}`）。

## 9. index（暂存区）

index 表见 §6。语义：

- `add`：读工作区文件 → 写 blob → `INSERT OR REPLACE index_entries`。
- `rm`：从 index 表删除（`rm --cached`）或同时删工作区文件。
- `commit`：只把 index 表当前内容写进 tree；提交成功后 index 表保持不变（作为新 HEAD 的
  stat 缓存基线）。
- 冲突解决：`merge` 写 `merge_state` 与工作区冲突标记；用户编辑后 `add` 该路径 →
  删除对应 `merge_state` 行；全部解决后 `commit` 收尾（`commit` 前若 `merge_state` 非空
  且仍有未 add 路径 → 报错）。
- stat 缓存：`size + mtime_ns` 相同才跳过读文件；不同则读文件算 oid 再定论（正确性优先，
  见 05 基准）。
- 损坏：表是数据库的一部分，页校验和/WAL 保证不会半写；逻辑损坏由 fsck 报「index 行
  非法」，可 `iaqs reset`（重建 index 自 HEAD）或删除行后重新 add。

## 10. 路径规则

- 相对工作区根、`/` 分隔、无 `.`/`..`/空段、非绝对；`normalize_rel_path` 校验并拒绝越界。
- 路径按字节比较（大小写敏感）。**Windows 注意**：NTFS 大小写不敏感，若 index 中同时
  存在只差大小写的两个路径，检出/登记时直接报错并中止，绝不静默覆盖。
- Windows 非法文件名（`CON`、`aux`、结尾空格/点、`<>:"|?*`）检出时检测并报错中止。
- 名称/路径的转义规则见 §3；index 表的 path 列同样是「相对路径字符串」（`/` 不转义）。

## 11. config

config 表：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `default_branch` | `main` | init 创建的分支名 |
| `gc.auto` | `true` | loose 对象超阈值时自动 gc |
| `gc.auto_threshold` | `1000` | 触发阈值（对象数） |
| `gc.max_chain` | `16` | delta 链最大深度 |
| `gc.window` | `8` | 同路径候选基准窗口 |
| `gc.min_saving` | `0.5` | delta 估算节省率下限 |
| `gc.prune_days` | `30` | 不可达对象保留天数（`gc --prune`） |
| `db.page_size` | `8192` | 建库时固定（页大小） |
| `db.segment_size` | `268435456` | 段文件上限（256 MiB） |
| `db.compress_pages` | `true` | 页压缩开关 |
| `blob.inline_max` | `65536` | 超过则走 LOB 分块 |
| `blob.chunk_size` | `1048576` | 分块大小（1 MiB） |
| `blob.compress` | `true` | LOB 分块压缩开关 |
| `diff.context` | `3` | unified diff 上下文 |
| `ui.color` | `auto` | auto/always/never |
| `ui.lang` | `auto` | auto/zh-CN/en（可被 `--lang`/`IAQS_LANG` 覆盖） |

写入 config = 数据库事务；未知键保留（向前兼容）；`config --get/--set` 读写。

## 12. 锁、事务与原子性

- **跨进程写锁**：写命令先创建 `.iaqs/locked`（`CREATE_NEW`），内容：
  `pid`、`start`（unix 秒）、`host`、`cmd`。已占用且 `start` 距今 < 3600 秒 → 报「仓库被
  pid=…（命令=…）占用」；超过 3600 秒视为陈旧锁，删除并警告后重试（`--force` 立即清理）。
- **进程内**：数据库为单写者；CLI 进程内用互斥量保护缓存；只读命令可用只读事务并行。
- **原子性来源**：数据库事务 + WAL（07 文档），不再需要「写临时文件再 rename」这一套
  仓库级协议；唯一例外是 MANIFEST（数据库引擎自己用小文件原子替换维护）。
- 只读命令（status/log/diff/show/cat/ls/fsck 只读模式）不取写锁，但仍需打开数据库
  （密码 + 只读事务）。

## 13. 编码与换行

- 存储与哈希层只认字节；BLOB 原样存。
- 行级操作按 `\n` 切行，行内容含行尾 `\r`（若有）；最后一行无 `\n` 时保留「无行尾」，
  不擅自补。
- 终端输出 UTF-8（Windows 设 `SetConsoleOutputCP(CP_UTF8)`）；`--raw`/`--color=never`
  可关闭装饰；i18n 只影响人类可读文案（见 04）。
- 不特殊处理 BOM：BOM 属于字节内容，diff 时自然出现在第一行开头。
