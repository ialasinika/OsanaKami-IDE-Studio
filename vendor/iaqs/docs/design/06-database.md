# 06 · 自研关系数据库（iaqs 内部引擎）

本文件是「库」的实现设计：一个嵌入式、加密、分页/分段、支持 1 TB 大对象的关系数据库。
按 D9/D14，它只作为 iaqs 的内部引擎（不对外做通用数据库产品），SQL 能力取最小集，
但表、行、主键/二级索引、事务、WAL、崩溃恢复、加密都是完整的。

## 1. 范围

**要做**：段文件管理、8 KiB 页、页信封（压缩 + AEAD）、页缓存、slotted 堆表、B+树索引、
行类型（INTEGER/REAL/TEXT/BLOB/NULL）、catalog、LOB/溢出页与流式 BLOB、WAL + 恢复、
单写事务、最小 SQL、页压缩、空闲页回收、完整性检查接口、加密与密钥生命周期。

**不做（v1）**：多写者/MVCC、JOIN/聚合/GROUP BY/子查询、网络协议、多客户端、触发器、
存储过程、在线 schema 变更（只支持建表/删表/建索引）、B+树删除再平衡（删除只做标记，
空间由 gc 回收）。

## 2. 磁盘布局

```
<repo>/.iaqs/
  MANIFEST                 # 明文公开头（不含任何明文用户数据）
  seg-000000.dat           # 数据段，页数组
  seg-000001.dat
  wal-000000.log           # WAL 段
  wal-000001.log
  locked
```

### MANIFEST（明文公开头）

```
magic           8B   "IAQSDB1"
format_version  u32  = 1
page_size       u32  = 8192
segment_max     u64  = 268435456        # 每段文件上限（256 MiB）
db_uuid         16B  随机
kdf_type        u8   = 1（PBKDF2-HMAC-SHA256）
kdf_salt        16B  随机
kdf_iters       u32  = 600000
wrapped_dek     12B nonce + 32B 密文 + 16B tag   # ChaCha20-Poly1305(KEK, DEK)
verifier        12B nonce + 16B tag              # AEAD(DEK, 固定串)
crc32c          u32  # 覆盖以上全部
```

- MANIFEST 不含 segment 列表、页数、表名、数据量等——这些都在加密后的库里。
- 打开时：读 MANIFEST → PBKDF2 得 KEK → 解包 DEK → 校验 verifier → 扫描
  `seg-*.dat` / `wal-*.log` 并读取各自的头页（加密）→ 恢复 → 就绪。
- 更新 MANIFEST（如改密码）用「写 `MANIFEST.tmp` + 原子替换」；文件很小。

### 段文件 seg-NNNNNN.dat

- 固定槽位数组：每页占 `page_size` 字节；页号 = 段内索引。
- 段文件按需增长到 `segment_max`，写满后新建下一段；文件头页（段第 0 页）记录段 id、
  页数、创建时间、段级密钥代数（见 07）。
- 段文件只增长不回缩；`gc --vacuum` 可把低利用率段重写到新段并删除旧段。
- 页地址 `PageRef = (seg_id u32, page_no u32, generation u32)`；generation 每次覆写 +1，
  用于区分同槽位新旧页与加密 nonce 唯一性。

### WAL wal-NNNNNN.log

- 记录格式：`[u32 len][u32 crc32c][u64 lsn][u8 type][payload]`；payload 为加密页镜像
  （或事务控制记录）。WAL 段满 16 MiB 轮转。
- 恢复：从最新 checkpoint 之后按 LSN 顺序重放已提交事务；未提交事务的记录丢弃。

## 3. 页格式

**逻辑页** = 8 KiB 明文空间，由页头 + 页体组成：

```
页头（明文，参与 CRC）:
  u8  page_type      0x01 段头, 0x10 系统页, 0x20 堆页, 0x30 B+树内部, 0x31 B+树叶,
                     0x40 溢出页, 0x50 空闲页
  u8  flags          bit0=页体已压缩
  u16 page_len       页体实际长度
  u32 generation     覆写代数
  u32 crc32c         覆盖页头其余字段 + 页体明文
页体:
  堆页：slotted 页（槽数组 + 行数据）
  溢出页：u32 next_page + 数据片段
  ...
```

**物理槽位** = 8 KiB 固定大小，内容为信封（16B 头 + AEAD 密文 + 槽内零填充）：

```
u16 env_version (1)
u16 env_flags
u32 stored_len        # 密文长度（含 16B tag）
u32 generation        # 槽内代数值，必须与明文页头 generation 一致
u32 slot_crc32c       # 覆盖信封头前 12B + 密文
ciphertext: AEAD(页密钥, nonce, 页明文, AAD=PageRef)
```

- 明文页容量 = page_size - 16（信封头）- 16（tag）= **8160 字节**（page_size=8192），
  即页体最多 8160-12=8148 字节。信封头里的 generation 是读取时构造 nonce/AAD 所必需，
  也是「旧引用被拒绝」的依据。
- 页体先 LZ1 压缩（节省 ≥ 5%，config 可关），再 AEAD 加密；页头也一起加密，所以磁盘上
  看不出页类型。
- 若密文 > 槽位容量（压缩后仍接近满页）：放弃压缩（env_flags 清 bit0），原样加密。
- 加密 nonce/AAD 由 (epoch, seg, page, generation) 构造（见 07 §4），保证同槽位每次覆写
  nonce 不重复；generation 回绕（2^32 次）前触发数据重加密（理论边界，文档化）。

## 4. 行与表

### 行编码

```
u16 行总长
varint 非空列位图（或 1 字节 NULL 位图 + 变长）
每列按类型：
  INTEGER: varint（zigzag 编码，省空间）
  REAL:    8 字节 IEEE754 小端
  TEXT:    varint 长度 + UTF-8 字节（引擎不校验编码）
  BLOB:    varint 长度 + 字节；超过阈值（≈ 页体/2）→ 溢出页链，行内存 PageRef
```

### 堆页（slotted page）

- 槽数组从页头向下增长，行数据从页尾向上增长；槽项 = (offset u16, len u16)。
- 插入：找足够空间的页（空闲页链表 / 最近页），若放不下走溢出页或新页。
- 删除：槽标记删除（len=0），空间由页内压缩/段回收处理；行迁移（VACUUM）可选。
- 行标识 RID = (PageRef)。

### B+树

- 主键索引：隐式 `_pk_<table>`；二级索引：`CREATE [UNIQUE] INDEX`。
- 键类型：INTEGER（i64 比较）或 TEXT（字节序比较）。
- 内部页：`[child_idx u32]*N + [key, child PageRef]*`；叶子页：`[key, RID]*` + next 指针。
- v1：插入时分裂（中间键上提）；删除只从叶子移除，**不做合并/再平衡**（空页保留，gc 回收）。
  唯一索引冲突在插入/更新时报错。

### catalog

```
_tables  (table_id INTEGER PK, name TEXT UNIQUE, root_page ..., pk_col INTEGER)
_columns (table_id INTEGER, col_no INTEGER, name TEXT, type TEXT, not_null, default_val,
          PRIMARY KEY(table_id, col_no))
_indexes (index_id INTEGER PK, table_id INTEGER, name TEXT, unique INTEGER, root_page ...,
          cols TEXT)
```

- 系统页（seg 0, page 0 之后的固定页）保存 catalog 根指针、checkpoint LSN、空闲页链表头、
  页代数等；系统页也加密。

## 5. LOB 与流式大对象

- 通用溢出页：任意 BLOB 值 > 阈值时拆成「页体大小的片段」，串成溢出页链；行里存首 PageRef。
- **内容寻址分块**（iaqs 的对象层用它实现 1 TB 文件）：chunk 表存在本库中：

```sql
CREATE TABLE chunks (
  chunk_id BLOB PRIMARY KEY,   -- sha256
  raw_size INTEGER NOT NULL,
  storage  INTEGER NOT NULL,
  data     BLOB                -- 小则行内，大则溢出页链
);
```

- 写入：`blob_writer` 按 1 MiB 追加块、逐块算 sha256、查表去重（命中只加引用计数）；
  提交后 `lob_id` 为一个 `lob_chunks(lob_id, chunk_no, chunk_id)` 列表（按 chunk_no 排序）。
- 读取：`blob_reader(lob_id, offset, len)` 按块定位，支持跨块读、随机读；内存占用 ~ 若干块。
- 安全性：块与引用计数在同一事务内更新；崩溃后未提交写入的块成为孤儿，由 gc 清理。
- 上限：1 TiB 文件 = 1,048,576 块，块表约 60–80 MB，可接受。

## 6. SQL 子集

### 语法（递归下降解析）

```sql
CREATE TABLE name (col TYPE [PRIMARY KEY] [NOT NULL] [DEFAULT lit], ...);
DROP TABLE name;
CREATE [UNIQUE] INDEX name ON table (col [, col]*);
DROP INDEX name;
INSERT INTO table [(cols)] VALUES (lit|?, ...);
SELECT cols FROM table [WHERE expr] [ORDER BY col [ASC|DESC] [, ...]] [LIMIT n];
UPDATE table SET col = expr [, ...] [WHERE expr];
DELETE FROM table [WHERE expr];
BEGIN [IMMEDIATE]; COMMIT; ROLLBACK;
```

- 类型：`INTEGER`、`REAL`、`TEXT`、`BLOB`。
- 表达式：字面量、列引用、`=`/`<>`/`<`/`<=`/`>`/`>=`、`AND`/`OR`/`NOT`、`IS [NOT] NULL`、
  算术 `+ - * /`、参数 `?`（预编译）。
- 不支持 JOIN、聚合、GROUP BY、子查询、外键、视图、ALTER（v1 文档化）。
- `SELECT` 列支持 `*`；`WHERE` 必须能用主键/索引下推（否则全表扫，允许）。

### 执行

- 解析 → 简单 AST → 规划：有可用索引（等值/范围）则索引扫描，否则堆扫描；过滤、投影、
  排序（内存排序，数据量小）、LIMIT。
- 写路径：INSERT → 找表 → 编码行 → 堆插入 + 所有索引插入；UPDATE = 删除旧行 + 插入新行
  （行迁移）；DELETE → 标记删除 + 索引删除。
- iaqs 内部**不走 SQL 热路径**：使用 C++ 表 API（`get(pk)`、`put`、`del`、`scan`、
  `index_scan`），SQL 仅用于内部测试与存储引擎自身的调试，**不向用户提供 SQL 命令**
  （M6 起已从 CLI 移除 `sql`；用户只通过版本管理命令操作）。

## 7. 事务与 WAL

- 单写者：进程内一把事务互斥量；只读事务可与写事务并行（读到已提交的页版本即可，
  v1 不做 MVCC，读事务期间写事务提交可能让读到新页——文档化「只读命令尽量在写事务
  之间执行」，单机单人可接受）。
- 事务模型：**redo-only + 提交时 WAL 落盘**。
  - 普通行/索引/系统页：写操作先改页缓存中的页版本（不落盘），提交时把脏页镜像写入 WAL
    （含事务开始标记、页记录、提交标记 + CRC），`fsync` WAL 后返回成功；脏页之后异步写回
    段文件；checkpoint 时更新系统页的 checkpoint LSN 并轮转 WAL。
  - 大对象块：允许**边写边落盘**（append-only 分配，WAL 记录页镜像），但块在事务提交前
    不可见（引用只存在于未提交的内存状态；崩溃后孤儿块由 gc 回收）。这样 1 TB 文件不需要
    在内存缓冲整份数据。
  - 回滚：未提交事务丢弃内存脏页即可（大对象块成为孤儿）。
- 恢复：打开时读系统页 checkpoint → 从 WAL 中该 LSN 之后重放**已提交**事务的页镜像
  （未提交事务的记录跳过）；完成后再 checkpoint。
- 崩溃语义：已提交事务可见且完整；未提交事务不可见；孤儿块/孤儿页由 gc 清理。
- 检查点：脏页 ≤ 阈值或 WAL 段满时自动；也可 `iaqs checkpoint`（内部命令）。

## 8. 压缩与加密的接入点

- 压缩：页明文页体 LZ1（§3）；`chunks.storage` 标记块内压缩；对象层 delta 也是压缩的一种。
- 加密：页信封 AEAD（07 文档）；WAL 记录用 WAL 子密钥加密；MANIFEST 只需公开参数。
- 两者顺序固定：**先压缩后加密**；读取反之。测试可只开压缩不开加密（debug 构建）以定位
  压缩/delta 问题。

> **实现状态（M6）**：页级压缩**尚未启用**。页槽是定长的（`page_size` 字节），页体压缩
> 只减小信封里的 `stored_len`，不减少段文件占用，因此当前压缩收益全部来自对象层：
> 对象载荷 LZ1、delta 链、4 KiB 分块的逐块 LZ1 与内容寻址去重。页信封已预留 `flags`
> 位（AAD 已绑定），若将来改为变长槽布局可再启用页级压缩。空间回收的下一步是
> `compact`/`vacuum`（逻辑重写库以删除空闲/碎片页，见 02 §5）。

## 9. 完整性检查

- 打开时：MANIFEST CRC、verifier、WAL CRC、每个段的头页 AEAD/CRC。
- `fsck` 调用数据库的 `integrity_check(level)`：
  - 快速：所有段头页、系统页、catalog 行、B+树父子指针区间、空闲页链表、页 CRC/AEAD。
  - 全量：逐页解密校验 CRC；逐行解码；索引键与行一致性；溢出页链完整。
- 损坏页：报告 (seg, page)，建议从备份恢复；v1 不做自动页修复（无冗余页）。
- 扩展点（v2）：双写页/镜像页、校验页。

## 10. 并发、锁与只读打开

- 进程内：事务互斥 + 页缓存锁（细粒度可后置）。
- 跨进程：写事务通过仓库级写锁（`.iaqs/locked`）串行化；读打开不持锁，看到打开时已提交状态。
  （M6 已实现多进程并发写，见文末实现注记。）
- 只读打开：`OPEN_READONLY` 时拒绝任何写操作，允许并发读者（只读同一文件）。
- 单进程崩溃锁：由上层锁的陈旧判定处理。

## 11. 版本与升级

- MANIFEST `format_version`；页信封 `env_version`；两者不匹配 → 报错要求升级 iaqs。
- 升级策略（未来）：新增页类型可向前兼容；破坏性变更需 `iaqs upgrade` 离线迁移。
- 数据库只由 iaqs 使用（D9），不承诺通用 SQL 兼容性。

## 12. 实现顺序（供 M1 拆任务）

1. 文件层：MANIFEST 读写、段文件创建/扩展、页槽读写、页缓存。
2. 加密/校验：CRC32C、页信封 AEAD、WAL 记录格式（可先明文调试）。
3. 行/堆页/表 API、catalog、简单 CREATE/INSERT/SELECT。
4. B+树索引、WHERE 下推、UPDATE/DELETE。
5. WAL + 提交 + checkpoint + 恢复（断电注入测试）。
6. 溢出页、chunks/blobs 表、流式读写。
7. 页压缩、空闲页回收、gc/vacuum 接口。
8. 完整 SQL 子集、内部测试入口（**不对外提供 SQL 命令**）。

## 13. 容量与性能估算

- 页 8 KiB、段 256 MiB → 每段 32,768 页；1 TiB ≈ 4,096 段（+WAL/索引开销）。
- 1 TiB 文件按 1 MiB 分块：1,048,576 块；去重表 ~64–96 MB；随机读 = 读块表页 + 块页。
- 页加密（ChaCha20-Poly1305 软件实现，可选 SSE2/AVX2 加速）目标 ≥ 500 MB/s；
  1 TiB 全量重加密约 30–60 分钟（`rekey --data` 离线）。

## 14. 实现注记（M1–M3 已落地）

- **单写者锁**：`Database::create/open` 在打开 MANIFEST 后获取 `<dir>/locked` 独占文件锁
  （内容 `pid <n>` + `time <unix>`；pid 不存在、内容不可解析或超过 1 小时视为陈旧锁）。
  锁与数据库生命周期同生共死，`close()` 释放；第二个进程打开报
  `repository is locked by another process ...`。
- **事务与回滚基线**：Pager 维护写事务基线（`begin_write_txn/commit_write_txn/rollback_write_txn`）。
  页在事务内首次被修改时保存修改前的内存镜像；`rollback` 恢复这些镜像，而不是丢弃整个
  页缓存——后者会丢掉"已提交但尚未 checkpoint（页未落盘）"的数据。
- **提交语义**：`commit` 只把脏页封装成 WAL Page 记录（含代数）+ Commit 记录并 sync WAL，
  不写段文件；`checkpoint` 才 flush 段文件、递增 `wal_gen`、写 catalog、删除 WAL。
  因此崩溃恢复 = 重放 WAL 中未 checkpoint 的部分；WAL nonce 依赖 `wal_gen` 单调递增，避免复用。
- **catalog 地址固定** 为段 0 页 1；表根页地址只存页号，代数由 `Pager::current_ref` 解析。
- 实测：`page_size=8192` 时每页明文容量 8160 字节；Debug(-O0) 下 PBKDF2 600k 每次建库约 12.6 s，
  测试与 CI 用 Release 构建。
## 实现注记（B+树索引已接入对象层）

- 设计 §7 预留的固定键长 B+树已实现为 `src/db/btree.h/.cpp`（`FixedBTree`）：
  键 32 字节（`memcmp` 无符号序）、值 = `Rid{seg,page,slot}`（不持久化代数，读取时用
  `Pager::current_ref` 解析最新代）；叶子 42B/条 + next-leaf 链，内部 40B/分隔键；
  `remove` 只删叶子项、不合并/不回收页（留给 gc）。
- 首个使用者是对象层的分块索引：`chunk_index(kind, root_seg, root_page)` 保存两棵树根页，
  `ObjectStore` 用它们把 chunk id 定位到 `chunks`/`chunk_dirs` 行，避免全表扫描；
  索引缺失时从平表重建（见 docs/design/02-storage.md 的实现注记）。
- 性能（Release，page_size=1024）：5000 次插入约 86–94 ms，5000 次查找约 46–59 ms，
  树高 3、322 页；测试 9 用例覆盖空树/大量键/覆盖/删除/scan/重开/非法键长。

### SQL 二级索引（实现注记，M6）

- catalog 在每张表表项后追加索引段：`[u32 index_count]` + 每条
  `[u16 name][name][u16 table][table][u16 column][column][u8 type][u32 root_seg][u32 root_page]`；
  旧 catalog 无该段时按 0 处理（`c.done() ? 0 : c.u32()`），打开旧库后
  `reset_wal_after_checkpoint()` 重写 catalog 完成升级（新格式旧二进制不可读，属预期）。
- 索引键 32 字节 = 值前缀（22 B）+ rid（10 B：seg u32、page u32、slot u16）；
  INTEGER 用符号位翻转的 BE 排序、REAL 用保序位模式、TEXT/BLOB 取前 22 字节、NULL 不入索引。
- 计划器只对 `AND` 中形如 `ColumnRef OP Literal` 的条件走索引（等值优先，否则一个范围），
  结果逐行复核；无可用索引或混合类型比较回退全表扫描；每列取字典序最小的索引。
  限制：TEXT > 22 B 时选择性下降；`!=`/`OR`/`NOT`/`IS NULL` 不走索引。
- `ExecResult` 增加 `used_index`/`index_name`；测试 `sql_index.*` 13 用例。

### 多进程并发写（实现注记，M6）

- 打开仓库不再终身持锁：`create/open` 只在初始化/恢复/升级期间短暂持有 `<dir>/locked`，
  随后释放；读操作看到打开时已提交的状态。
- 写事务从 `begin()` 到 `commit()`/`rollback()` 通过 `FileLock::acquire_wait` 轮询持有
  `<dir>/locked`；`begin()` 先 `pager.refresh_from_disk()`（发布非事务 dirty 页、清缓存）
  再 `load_catalog()`，从而看到其他进程已提交的数据。
- 每个事务使用独立的 `wal-<seg>.log`（扫描现有文件取 max+1，避免 nonce 复用）：
  `commit` 顺序为 WAL 页记录 + Commit + fsync → pager flush+fsync（对其他进程立即可见）→
  提交缓存的写事务基线 → 关闭 WAL → 锁内按需自动 checkpoint → 释放锁；
  `rollback` 写 Rollback 记录、回滚缓存基线、flush 恢复后的镜像、释放锁。
- `checkpoint()` 未持锁时先获取写锁；`rekey_data()`/`change_password()` 全程独占。
- 测试：`concurrency.*` 4 用例（两连接交错提交互见、建表跨连接可见、写锁互斥、
  交错事务后重开数据一致）。
## 实现注记（M7 审计加固）

- **WAL nonce 防复用**：新增 `<dir>/WAL.SEQ` 旁车文件记录下一个 WAL 段编号。
  `begin()` 取 `max(seq, 现有 wal-*.log 最大编号)+1` 作为本事务 WAL 段，并原子更新 sidecar；
  这样即使 checkpoint 删除了全部 WAL 文件，重开后的 Begin/Page 记录也不会与前一次同字节
  （旧实现段号回到 0，nonce 重用）。
- **崩溃尾部容错**：`WalReader::read_all(..., tolerate_tail)` 仅对最后一个 WAL 段的记录解析/
  CRC/AEAD 失败静默结束（重放到最后一条完好记录）；非末段或显式关闭该参数时仍然报错。
- **锁判定**：`<dir>/locked` 内容无法解析时看 mtime（空文件 2 秒内视为"创建中"，
  非空垃圾立即回收）；可解析时 `pid<=0`、`time<=0`、`time>now+300`、进程不存在均视为陈旧；
  长事务不再因固定 1 小时规则被误抢。
- **已知限制**：`open()` 期间仍会持有写锁直到恢复/升级结束，因此"读者"与长写事务
  （如 rekey）互斥；页回收/compact 尚未实现，段文件只追加。