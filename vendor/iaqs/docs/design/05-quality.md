# 05 · 质量：测试、失败注入、性能与验收

## 1. 测试层次

| 层 | 内容 | 形式 |
| --- | --- | --- |
| 单元 | sha256/hmac/pbkdf2、crc32c、chacha20poly1305、LZ1、delta、hex/uvarint、escape、行级 diff、三方合并、tree/commit 编解码 | 纯函数，`tests/unit/*` |
| 组件 | 页信封加解密、页缓存、堆页、B+树、溢出页、chunks 去重、WAL 写入/恢复、对象层存储模式、refs CAS | 直接调内部 API，`tests/component/*` |
| 集成（CLI） | 场景脚本：init → add → commit → log/diff → branch → merge → reset → checkout → gc → fsck；含冲突与恢复 | 用 iaqs 可执行文件跑场景，`tests/cli/*` |
| 端到端 | 大型/极端输入：1 GB 文件分块提交与检出、10 万文件仓库、深层提交历史、多次合并、断电模拟 | 可选/夜间，`tests/e2e/*` |
| 基准 | commit/status/diff/gc/rekey 吞吐与延迟，对比目标值 | `iaqs_bench`，`tests/bench/*` |

- 框架：自研轻量 harness（`TEST_CASE`/`CHECK_EQ`/`CHECK_THROW`/`CHECK_NEAR`），
  `ctest` 统一入口；失败输出文件、行号与实际/期望值。
- 属性测试（无需外部库）：随机字节 roundtrip（LZ1、delta、页信封）、随机文件树
  （tree↔flatten 互逆）、随机 DAG（merge_base 性质校验）、随机操作序列（add/commit/reset
  后仓库不变式仍成立）。
- 每个 bug 修复必须带一个回归测试。

## 2. 失败注入（可靠性是加密库的核心风险）

- **断电/崩溃**：
  - WAL 尾部截断（写一半的记录）→ 打开时丢弃不完整尾部，恢复到最后一次完整提交；
  - 提交记录写入后、段文件回写前崩溃 → 恢复后数据完整可见；
  - 段文件页只写了一半（模拟写 4 KiB 后中断）→ 该页 CRC/AEAD 失败，属于已提交？——
    设计上已提交事务的页必须完整落盘：写页时先写 WAL（redo），恢复时重放；
    测试断言恢复后页完整。
- **磁盘满**：写入失败返回明确错误，事务回滚，不损坏既有数据。
- **只读/无权限文件**：报错并指出路径；不留下半写文件。
- **损坏**：翻转对象/页/索引/WAL 一个字节 → `fsck` 定位到 (seg,page)/对象；`open` 报错不崩溃。
- **锁**：两进程同时写 → 后者退出码 3；陈旧锁（超过 1h）自动清理并提示。
- **密码**：错误密码、空密码（拒绝建库）、密码含任意 UTF-8/控制字符、`--password-stdin`
  管道中断。
- **文件系统边角**：路径超长、文件名含空格/中文/emoji、大小写冲突、`\r\n` 文件、
  BOM 文件、空文件、不可读文件、目录与文件同名冲突。

## 3. 性能目标（参考硬件：本机 CPU，SSD/HDD 各测）

| 操作 | 目标 |
| --- | --- |
| `init`（空库） | < 200 ms（含 KDF 600k 约 100–300 ms，可配） |
| `status`（10k 文件工作区） | < 300 ms（stat 缓存命中） |
| `commit`（1000 小文件，无变化） | < 200 ms |
| `commit`（100 MB 文本，首次） | < 2 s |
| `commit`（1 GB 文件，分块） | 内存峰值 < 256 MB，流式；< 30 s（含加密） |
| `diff`（两个 10 MB 文本） | < 1 s |
| 页加解密吞吐 | ≥ 500 MB/s（ChaCha20-Poly1305 软件实现 + SSE2 加速） |
| `gc`（10k 提交、100k 对象） | < 60 s（可加 `--aggressive` 换空间） |
| `rekey --data`（1 GiB） | < 10 s（含断电恢复测试另计） |
| 存储开销 | 文本改一行 → delta 后 ≈ 该行 + 头；重复内容块只存一份 |

- 内存：所有大文件路径必须流式（chunk 级），禁止整文件读入；页缓存上限可配
  （`db.cache_pages`，默认 8192 页 = 64 MiB）。
- 基准结果写入 `docs/perf.md`（M4 后维护）。

## 4. 验收清单（Definition of Done）

- [ ] 功能：00-overview 的 9 条目标全部可用；01/02/03/04 的命令面全部实现并通过集成测试。
- [ ] 库：初始化/打开/改密码/rekey 正常；磁盘上无明文对象（用 strings 扫描验证）；
      1 GB 与 1 TB 级（稀疏/模拟）文件可提交与检出，内存不随文件大小线性增长。
- [ ] 增量：同样的 100 次单行修改，库体积 < 全量存储的 10%；gc 后更小；
      delta 链可解压还原且校验一致。
- [ ] 版本树：分支/合并/冲突/abort/continue/reset/reflog 全部场景测试通过。
- [ ] 可靠性：断电注入（WAL 截断/半页写）后能恢复到最后一次完整提交；fsck 能定位人为损坏。
- [ ] i18n：`--lang zh-CN` 与 `--lang en` 关键输出正确；`--porcelain` 双语一致。
- [ ] 无第三方运行时依赖；`cmake -S . -B build -G Ninja && cmake --build build` 干净通过；
      `-Wall -Wextra -Werror` 无警告。
- [ ] 文档与实现一致（决策变更先改 docs/design/README.md 决策表）。

## 5. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 自研数据库 bug（B+树/WAL/恢复） | 数据损坏 | 组件级测试 + 属性测试 + 断电注入；页 CRC/AEAD 双重校验；v1 限制 SQL 面 |
| 软件加密性能不足 | 1 TB 文件慢 | LZ1 先压缩、按块并行、SSE2/AVX2 内联 intrinsic；基准先行 |
| 1 TB 流式路径内存失控 | OOM | 强制 chunk 流式 API；harness 测内存峰值；代码审查禁止整块 read |
| B+树删除不合并碎片 | 长期库膨胀 | gc/vacuum 重建；文档化；v2 再做树合并 |
| Windows 文件系统语义差异 | 路径/大小写/锁行为不一致 | 字节路径比较；专项测试；文档明确限制 |
| 断电测试难模拟 | 恢复逻辑未被验证 | 用「写一半即 kill」的注入文件系统层（测试桩），在 io 抽象处注入故障 |
| 单人单机无备份 | 硬盘损坏丢历史 | `iaqs backup` 热备 + 文档建议异地备份；fsck 可检测 |
| rekey 中断 | 库不可读 | 双 epoch 设计，未完成时可继续；断电注入测试覆盖 |
| 编码显示问题 | 输出乱码/无法解析 | 显示层 `\xNN` 转义 + UTF-8 控制台；内容按字节不转换 |

## 6. 发布与工程实践

- 版本：`MAJOR.MINOR.PATCH`；磁盘格式版本单独（MANIFEST/页信封/delta），不兼容时明确报错。
- 提交规范：每个功能/修复带测试；`docs/design` 决策变更同步更新。
- 静态检查：`-Wall -Wextra -Wpedantic -Werror`；Linux 下可选 ASan/UBSan 跑测试。
- CI（本地脚本，无远程）：`scripts/test.ps1` 编译 + 全部测试 + 快速基准冒烟。
- 代码风格：C++20、`std::string` 存字节、错误用 `Result<T>`/异常边界（CLI 层捕获）、
  不 `using namespace std`；文件按模块划分（见 00 模块表）。
