# 02 · 增量存储：对象层 delta + 数据库层压缩/去重

本文件定义 iaqs 的「增量存储」：同一份数据只多存一次，历史版本之间只存差异。
按 D13 分两层：

- **对象层（语义增量）**：同路径的历史文本 blob 用 delta 链表示；
- **数据库层（物理增量）**：页压缩、1 MiB 内容寻址分块去重、空闲页/段回收。

两层独立工作、可分别关闭；加密在最外层透明加（见 07）。

## 1. 数据形态与选择规则

对象写入时按以下顺序决定物理形态（阈值来自 config）：

| 条件 | storage | 说明 |
| --- | --- | --- |
| payload > `blob.inline_max`（默认 64 KiB） | 3 = LOB | 拆 1 MiB 内容寻址分块，块可去重 |
| 有同路径历史 blob，且 size ≤ 8 MiB，且非二进制，且 delta 估算节省 ≥ `gc.min_saving` | 2 = delta | IAQSD1 指令流，base 为历史 blob |
| LZ1(逻辑帧) 比原样小 ≥ 5% | 1 = inline lz1 | 默认对文本 tree/commit/tag 与中小 blob 生效 |
| 其它 | 0 = inline raw | 压缩不划算的小二进制等 |

- 判定「二进制」：payload 前 8000 字节含 `\0`（与 diff 一致）。
- delta 是**提交时即时计算**（`add`/`commit` 写对象时就能找到同路径前版本），
  不是只靠 gc；`gc` 负责重排链、合并过长链、把不再划算的 delta 还原为独立对象。
- 大文件（LOB）**不做对象层 delta**：1 TB 文件生成 delta 代价不可控；改 1 行时靠
  **分块去重**让新版本只多存少量块（见 §4）。

## 2. LZ1 压缩格式

无第三方压缩库，自研 LZ77 变体，确定性、流式、最坏膨胀 ≤ 约 0.4%。

```
magic   "IAQSLZ1"          6 字节
raw_len uvarint            解压后长度（解压端据此校验，防炸弹）
token 流：
  0x00        → 匹配：uvarint dist（1..65535）、uvarint len（3..）
  0x01..0xFF  → 字面量：len = token（1..255），随后 len 字节原文
```

- 窗口 64 KiB；哈希表 3 字节（16 位值）；贪婪匹配、不回溯；同一输入输出字节完全确定。
- 编码器对「无法压缩」的输入仍输出字面量流，保证任意输入可编码。
- 压缩对象 = LZ1(逻辑帧 `type size\0payload`)；读时先解 LZ1 再解析帧。
- 页压缩、LOB 分块压缩复用同一实现（独立 magic 可有可无，页内用帧头标记）。

## 3. delta 格式（IAQSD1）

```
magic     "IAQSD1"         6 字节
base_size uvarint          base 逻辑帧长度（校验）
tgt_size  uvarint          目标逻辑帧长度（校验）
指令流：
  0x00 COPY   uvarint off, uvarint len   从 base 的 [off, off+len) 拷贝
  0x01 INSERT uvarint len, len 字节       插入新字节
```

- 解码满 `tgt_size` 字节即结束；越界/不足/多余 → 损坏。
- 生成算法：
  1. 把 base 与 target 按行切分（保留 `\r`），对 base 行建「行内容 → 位置列表」的哈希表；
  2. 逐行扫描 target：命中且节省（COPY 指令开销 < INSERT）则 COPY，连续命中合并为一个
     COPY 区间；未命中则 INSERT；行内部分相同不做字节级微调（v1 保持简单可预测）；
  3. 产生指令流后若 `存储成本 ≥ target 原样 × (1 - min_saving)` 则放弃 delta。
- `delta_ratio = stored_size / target_size`，用于 gc 报表与链长控制。
- 链：`object.delta → base → base.delta → …`；最大深度 `gc.max_chain`（16）；
  读取时递归展开并缓存最近结果；链超深/成环（数据损坏）由 fsck 报告。
- 基准选择：`path_blob_chains`（每路径按提交时间升序的 blob 序列）中取**前 8 个版本**，
  逐个试 delta 取节省最大者；base 必须已存在且不是 LOB；同一对象只做一次选择（存表）。
- delta 只对 **blob** 做；tree/commit/tag 体积小，用 LZ1 即可。

## 4. 分块存储与去重（大文件、DB 层增量）

**分块**：文件内容按 1 MiB 固定大小切块（最后一块可短），块 `chunk_id = sha256(chunk)`。

- 块表（数据库内部表）：

```sql
CREATE TABLE chunks (
  chunk_id BLOB PRIMARY KEY,   -- sha256 原始字节（加密存储无妨）
  raw_size INTEGER NOT NULL,
  storage  INTEGER NOT NULL,   -- 0 raw, 1 lz1
  lob_bytes BLOB               -- 压缩后的块内容（或页引用，见 06）
);
```

- 逻辑 LOB：`lob_id → [chunk_id, …]`（有序列表，存在对象行或 lob 表）。
  对象行 `storage=3` 时，`lob_id` 指向块列表；块列表本身很小。
- 去重：写块前查 `chunks.chunk_id`；命中则**引用计数 +1**，不写新数据。
  因此「1 TiB 文件改 1 行」：只有少数块变化，提交新增约「变化块数 × 1 MiB」。
- 引用计数：`chunks.refcount`；对象写入时对每块 +1；对象被删除（gc 判定不可达）时 -1；
  计数为 0 的块可回收。计数更新与对象写入在同一数据库事务内，保证崩溃一致。
- 流式：提交/检出/`cat` 按块流式处理，内存占用 = 块大小 × 少量缓冲（约几 MiB），
  与文件大小无关；`blob_stream(obj, offset, len)` 内部按块定位，支持随机区间读。
- 完整性：每块读取时校验 `sha256(chunk)`；发现不一致 → fsck 报告「块损坏」并保留引用。
- 固定切块的局限：插入/删除字节会导致后续块全部错位、去重率下降。v1 用固定切块
  （简单、可预测、单文件读友好）；内容定义切块（CDC）列为 v2 优化点（见 05 风险）。

## 5. 数据库层页压缩与空间回收

- 页 8 KiB；页体先 LZ1 压缩（节省 ≥ 5% 才压），再 AEAD 加密（07）。
- 大 BLOB 一律走 chunk 表，避免「一个超大页」；行内只放小块。
- 空闲页链表 + 段内空洞复用；段文件只增长不回缩（除非 `gc --vacuum` 重写段）。
- `gc --vacuum` 可选：把低利用率段重写到新段，腾出的段文件删除（离线、需锁、耗时）。
- 压缩开关 `db.compress_pages`；关闭后页按原样加密存储（性能/兼容调试用）。

> **实现状态（M6）**：页体压缩**未启用**——页槽定长，压缩只减小信封 `stored_len`，
> 不减少文件占用，因此没有收益；压缩实际发生在对象层（LZ1、delta 链、分块逐块 LZ1 与去重）。
> 空闲页链表/`gc --vacuum` 也未实现：段文件目前只追加。实测（自举仓库，单提交）段文件
> 852 KB / 逻辑对象 927 KB，说明**写入放大在当前规模很小**；真正的空间风险来自长期
> update/delete/gc 造成的空闲页堆积，对应方案是 `compact`（逻辑 dump→新库→目录交换），
> 而不是页级压缩。

## 6. gc：流程与策略

`iaqs gc [--prune] [--vacuum] [--dry-run]`，自动触发：`gc.auto=true` 且 loose 对象数
（对象表新增行数）超过 `gc.auto_threshold` 时，在 commit 成功后提示或后台执行。

1. **可达性**：从所有 refs + HEAD + reflog 指向的提交出发，遍历 commit → tree → blob/tag，
   得到 `sha → type` 集合（不读内容，只读对象表元数据 + tree 负载）。
2. **对象层重排**：
   - 对每个路径的 blob 版本链（按时间升序）重新选基准：窗口 8、链深 ≤16、节省率 ≥ 阈值；
   - 超链深的链压平（把过老 delta 还原为独立对象；这是体积与读取延迟的取舍）；
   - 不再被任何版本引用的旧 delta 条目在提交对象删除后自然消失。
3. **块回收**：对象删除时已惰性减引用；gc 扫描 `chunks` 中 `refcount=0` 的行删除，
   并统计释放字节数。
4. **页/段回收**：重建空闲页链表；可选 `--vacuum` 整理段文件。
5. **不可达对象**：默认**不删除**（保留 `gc.prune_days` 天，防误删分支后找不回）；
   `--prune` 才删除不可达对象及其块引用。
6. **统计输出**：对象数、总逻辑字节、物理字节、压缩率、delta 条目数与平均节省、
   chunk 命中率、释放页数。`--dry-run` 只打印不落库。
7. **事务性**：gc 的修改按批提交（每批 N 个对象一个事务），中途崩溃时已提交批次有效，
   剩余对象下次 gc 继续（幂等）。

## 7. fsck：完整性检查

`iaqs fsck [--full] [--fix-loose]`（`--full` 校验所有对象负载与块内容；默认快速模式只查
表结构与引用关系）：

| 检查 | 内容 |
| --- | --- |
| 数据库 | MANIFEST CRC、页校验和、AEAD 校验、B+树指针区间、catalog 一致 |
| refs/meta | ref 指向的 oid 存在且为 commit；HEAD 指向合法 ref 或 oid |
| 对象图 | commit.tree/parent 存在；tree 条目 oid 存在且类型匹配（目录=tree，文件=blob） |
| 对象内容 | blob 重算 oid 匹配；delta 链可完整展开、深度 ≤ max_chain、无环 |
| LOB | 块列表非空、每块存在、块 sha256 匹配、refcount 与反向引用一致 |
| index | 行字段合法、oid 存在、path 合法且唯一 |
| reflog | seq 连续、old/new 可解析（允许对象已回收的旧记录？v1 要求存在） |

- 发现问题：默认只报告（退出码 1），列出可操作建议；`--fix-loose` 仅做安全修复
  （删除临时/未引用块、重建 index、修复 refcount），不重写损坏页。
- 页损坏无法解密/校验失败 → 报告页号与所属段，建议从备份恢复。

## 8. 崩溃安全

- 所有修改走数据库事务；提交时 WAL 记录页修改并 `fsync`，然后返回成功；
  崩溃后打开数据库先恢复（前滚已提交事务、丢弃未提交）。
- 加密与压缩都在页写入前完成，WAL 记录的是**加密后的页镜像**（07 文档），恢复路径不解密
  也能前滚。
- 中途崩溃的 `gc`/`vacuum`：批次事务已提交的部分有效；临时段文件（未写 MANIFEST 的）
  启动时清理。
- 备份/移动仓库：关闭后复制 `.iaqs/` 整个目录即可；热备份用 `iaqs backup`（先 checkpoint
  再复制）。

## 9. 性能预期与上限

| 操作 | 预期（本机，1k 文件/100 MB） | 说明 |
| --- | --- | --- |
| 提交（无大文件） | 0.2–1 s | 对象写入 + 事务提交 |
| status（热缓存） | < 0.3 s | 只读 index 表 + fs 扫描 |
| log -n 50 | < 0.2 s | 只读 commit 对象 |
| gc（1 万对象） | 1–5 min | 取决于 delta 试算量 |
| 页面压缩率 | 文本 2–4× | LZ1 页内 |
| 对象 delta 节省 | 文本历史平均 70–95% | 同路径相邻版本 |
| 大文件提交 | 流式，约 100–300 MB/s（压缩+加密+IO） | 1 TB 约 1–3 小时，取决于磁盘 |
| 大文件改 1 行再提交 | 仅新增变化块 | 分块去重 |

上限与降级：单文件 1 TB 设计目标（50 万块，块表可控）；极端情况下 `blob.compress=false`
提升大文件吞吐；`db.compress_pages=false` 降低 CPU；`gc` 可分批/限速。

## 10. 处理顺序（写路径）

```
文件字节 → [分块] → (块压缩 LZ1) → (块加密 AEAD) → 写页/段
        ↘ [对象逻辑帧] → (LZ1 或 delta) → (对象加密/页内) → 写行
```

读路径反之：解页 → 解 LZ1/delta（对象层）→ 拼接块（LOB）→ 校验 oid/sha → 交付。
**先压缩/去重，后加密**；加密不改变明文格式，测试可绕过加密层直接验证压缩/delta。

## 实现注记（M4：对象层 delta + gc/fsck 已落地）

- `objects.storage=2`：`objects.payload` 存 IAQSD1 delta，`objects.base_oid` 指向基准对象；
  读取时递归还原（链深上限 64），并照常校验 `raw_size` 与 oid。
- `Repo::gc(options)`：从 refs/HEAD 做可达闭包（commit → tree → blob/tag），按提交时间排序后
  逐路径收集 blob 版本链；对每个新版本在最近 `window` 个旧版本中选 delta 最小者，
  只有节省率 ≥ `min_saving`（默认 0.5）且链深 ≤ `max_chain` 才重写为 delta；
  最后删除不可达对象与无引用分块。`--dry-run` 只估算不写入。
- `Repo::fsck()`：逐个对象解压/还原并核对 oid，检查 commit 的 tree/parents、tree 的条目类型、
  tag 目标、refs/HEAD/index 引用的对象是否存在；只读不修。
- 实测：5 个版本、每版改一行的 300 行文本，gc 后 9516 → 3018 字节（-68%），
  `iaqs gc` / `iaqs fsck` 均有 e2e 覆盖。
## 实现注记（M4 第二段：大文件流式 + 分层分块目录）

- 数据块固定 4 KiB（压缩后通常更小），块 id = SHA-256(明文块)。
- 分块对象写盘（storage=3，新格式）：`objects.payload = [u8 levels][32B root_dir]`，
  目录节点存 `chunk_dirs(dir_oid, payload)`，payload = 连续 32B 子 id；叶子层指向
  `chunks`，更高层指向目录节点。单节点扇出 128，1 TiB 约 4 层，写/读/检出都不需要把
  整个对象或整张块表放进内存（写：一次一个块 + 树节点；读/检出：逐层遍历、按块回调）。
- 旧版平铺块列表（payload 长度为 32 的倍数）保留只读兼容。
- `ObjectStore::write_stream(type, size, reader)` / `read_stream(oid, sink)` /
  `write_to_file(oid, path)`；`Repo` 的 add/status/checkout/restore 对超大文件走流式
  hash 与流式落盘。
- 已知限制：`chunks`/`chunk_dirs` 没有二级索引，单块读取要扫描平表；换更大的库时需要
  给块表接 B+树索引（设计 06 §7 已预留）。因此"1 TiB 结构就绪"指格式与内存模型，
  真实 1 TiB 仓库的吞吐仍待索引层补齐。
- gc 对超过 inline_limit 的分块对象不做 delta（保持块级去重），delta 只作用于小对象。

## 实现注记（M4 后续：分块表 B+树索引）

- 上述"已知限制"已消除：`ObjectStore` 维护两棵 `db::FixedBTree`（键 = chunk id 的
  32 字节原始 SHA-256，值 = `Rid`），分别索引 `chunks` 与 `chunk_dirs`。
- 根页地址持久化在表 `chunk_index(kind TEXT PRIMARY KEY, root_seg INTEGER, root_page INTEGER)`，
  `kind` 取 `"data"` / `"dir"`；每次插入/删除后 upsert 根页（B+树根分裂时地址会变）。
- 读取路径 `load_data_chunk` / `load_dir_node` 先查索引（`Pager::current_ref` 解析最新代数），
  命中后 `db_.get_row`；索引缺行时回退 `scan_for_id` 扫描并回填，保证旧库/陈旧索引仍可读。
- 索引缺失（例如迁移旧库或索引表被清空）时，`ensure_indexes()` 会扫描 `chunks`/`chunk_dirs`
  重建两棵树并重写 `chunk_index`；写入去重仍用内存 id 集合，删除对象时同步删除索引项。
- B+树删除不合并/不回收页（设计 06 §7），空页由 gc 处理；树高 3 可容纳约 10 万块，
  1 TiB（约 2.7 亿个 4 KiB 块）时树高约 5，单块定位 O(log n) 次页读。
- 测试：`btree.*` 9 用例；`vcs_streaming.chunk_index_is_rebuilt_when_missing` 验证
  `DELETE FROM chunk_index` 后新实例自动重建索引、数据仍可读。

### 增量 gc（实现注记，M6）

- `gc` 默认**增量**模式：只处理 `created_ts >= meta.gc.last_ts` 的对象（上一轮 gc 之后新增的
  对象），已在 delta 链中的对象（storage=2）不重新编码；删除也只限于本轮候选内不可达、
  且不破坏 `base_oid` 链的引用保护。
- 全量重打包用 `iaqs gc --full`（`GcOptions::full`），语义与旧版一致：遍历全部可达对象、
  按路径 blob 版本链重选 delta 基准；`--dry-run` 不写对象、不更新 `meta.gc.*`。
- 每轮结束更新 `meta.gc.last_ts`、`meta.gc.generation`；GcStats 增加 `incremental`、
  `candidate_objects`、`deltas_kept`，CLI 在增量模式额外打印保留的既有 delta 数。
- 历史链排序改为 DAG 拓扑序（Kahn，按 `(time, oid)` 破平），修复同秒提交导致的链序抖动。
- 测试：`gc.*` 7 用例（增量复用/全量重打包/dry-run 不落盘/清理不可达/delta 链深/fsck 报告
  损坏/meta 轮转）。
## 实现注记（M7 审计加固）

- `ObjectStore::write_to_file` 改为「临时文件 + 原子替换」：检出/restore 不再原地截断目标文件，
  顺带断开硬链接（旧实现会穿透硬链接改写仓库外文件）。
- `SegmentFile::sync()` 在 flush 之后再做真实落盘（Windows `FlushFileBuffers`、POSIX `fsync`），
  崩溃后段文件尾部不会出现半写槽位。
- 页级压缩仍未启用（页槽定长，压缩页体不减少占用）；压缩收益在对象层（LZ1/delta/分块去重）。
- 已知性能限制：`persist_index_roots()` 每次重写目录索引根时全表扫 `chunk_index`，
  大仓库首次 add（如 60 MB）会达到分钟级；后续可用固定 catalog 行或缓存根地址优化。