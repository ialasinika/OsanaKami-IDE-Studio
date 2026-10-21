# 07 · 加密库设计

iaqs 的仓库是一个**加密数据库**（D11）：没有密码打不开；磁盘上不出现明文的对象内容、
索引、表名、提交信息。本文件定义密钥体系、加密格式、打开流程、改密码与威胁模型。

## 1. 威胁模型

**防御目标**：

- 硬盘/备份/回收站被拷走、电脑丢失 → 没有密码无法读取任何仓库内容；
- 数据库文件被篡改/翻页 → AEAD 校验失败，拒绝加载或报损坏，不返回错误数据；
- 密码不会出现在磁盘上的明文文件、日志、命令行参数中。

**不在 v1 防御范围**（文档明示）：

- 已控制进程/内存的攻击者（键盘记录、调试器、进程内存读取）；
- 冷启动/DRAM 残留、交换文件（Windows pagefile）中的密钥副本；
- 侧信道（缓存计时等）、物理拆解；
- 弱密码本身的强度（提供 KDF 迭代成本，但不做密码策略/锁定，单机无中心验证）。

**不做的事**：不加密工作区文件（用户自己的文件）；不隐藏「这里有一个 iaqs 仓库」
（MANIFEST/目录存在性可见，但内容不可读）。

## 2. 密钥层级

```
密码（UTF-8 字节）
   │ PBKDF2-HMAC-SHA256(salt, iters)          ← 可调，参数存 MANIFEST
   ▼
KEK (32B)  ──AEAD 解包──►  DEK (32B, 随机生成)
                              │ HMAC-SHA256 派生
                   ┌──────────┼───────────────┐
                   ▼          ▼               ▼
              页数据密钥    WAL 密钥       MANIFEST/系统页密钥
              (page-key)  (wal-key)      (meta-key)
```

- **DEK** 随机 32 字节，只在内存中存在；落盘形态是「被 KEK 包裹的密文」。
- **KEK** 由密码经 PBKDF2 派生，不落盘（只存 salt/参数/迭代次数）。
- **子密钥**：`subkey = HMAC-SHA256(DEK, "iaqs-<用途>-v1")` 截断 32 字节，
  分离页、WAL、元数据用途，避免同密钥跨用途 nonce 碰撞。
- **verifier**：`AEAD(DEK, nonce, "iaqs-verify-v1", aad="iaqs-db-v1")` 的 tag；
  打开时重算比较，用于「密码是否正确」的快速判定（同时校验 DEK 包裹完整性）。

## 3. 算法

| 用途 | 算法 | 参数 |
| --- | --- | --- |
| 密码派生 | PBKDF2-HMAC-SHA256 | salt 16B 随机；iters 默认 600,000（建库时写入 MANIFEST，可升） |
| 对称加密/认证 | ChaCha20-Poly1305（RFC 8439） | 32B key、12B nonce、16B tag；软件实现，可选 SSE2/AVX2 加速 |
| 完整性（非加密） | CRC32C | 页/WAL/信封快速校验，早于 AEAD 发现损坏 |
| 哈希（对象寻址） | SHA-256 | 对象 id、chunk id、HMAC 派生 |
| 随机数 | OS CSPRNG | Windows `BCryptGenRandom`；Linux `getrandom`；禁止 `rand()` |

为什么选 ChaCha20-Poly1305 而不是 AES-GCM：

- 纯软件实现快（大文件 1 TB 加密吞吐敏感），无 AES-NI 依赖；
- 结构简单，逐字节实现容易做 KAT 测试；AEAD 一次完成认证，无需额外 HMAC；
- 若将来要 AES-GCM，可加算法 ID 支持多算法，MANIFEST 已有 `kdf_type`，可扩展 `aead_type`。

## 4. 加密格式

### MANIFEST（明文只含公开参数）

```
magic "IAQSDB1" | format_version | page_size | segment_max | db_uuid
kdf_type | kdf_salt | kdf_iters
wrapped_dek: nonce 12B | ciphertext 32B | tag 16B      (AEAD(KEK, DEK))
verifier:    nonce 12B | tag 16B                        (AEAD(DEK, 固定串))
crc32c
```

无任何用户数据明文；即使不打开也能读到的是「这是一个 iaqs 库、参数是多少」。

### 页信封

- 明文页（页头 + 页体）→ 页体压缩（可选）→ 整个明文页 AEAD 加密 → 写入 8 KiB 槽位。
- 槽位信封头 16B = `env_version u16 || env_flags u16 || stored_len u32 || generation u32 ||
  slot_crc32c u32`；明文页容量 = 8192-32 = 8160 字节。
- **nonce**（12B，小端）= `epoch u32 || generation u32 || page_no u16 || seg_id u16`；
  同一槽位每次覆写 generation+1，nonce 不复用；generation 达上限前触发数据重加密（§7）。
- **AAD**（16B，小端）= `env_version u16 || env_flags u16 || seg_id u32 || page_no u32 ||
  generation u32`，防止页被挪到别的槽位/代数重放，并绑定 epoch（epoch 在 nonce 里）。
- epoch 是「数据密钥代数」：`passwd` 只重包 DEK 不改 epoch；`rekey --data` 换新 DEK 时
  epoch+1，旧页按旧 epoch 密钥可读，写入时用新 epoch（在线渐进重加密），或离线一次重写。

### WAL 记录

- 每条记录用 `wal-key` 加密：`[u32 len][u32 crc32c][u64 lsn][u8 type][AEAD 密文]`，
  nonce = `epoch || wal_seg_id u32 || lsn u64`（取低 32 位组合，保证唯一），AAD 含 lsn。
- 恢复时先校验 CRC 再 AEAD 解密；失败 → WAL 损坏，停止恢复并报错（不猜测）。

### 系统页 / catalog / 表

- 都在加密页里，磁盘上不可见表名、列名、行内容；页类型也在密文内。

## 5. 打开流程

```
iaqs <cmd>
 └─ 向上找 .iaqs/ → 读 MANIFEST（CRC 校验）
 └─ 从 stdin 读密码（不回显；可 --password-stdin 供脚本/测试）
 └─ KEK = PBKDF2(password, salt, iters)
 └─ DEK = AEAD_open(KEK, wrapped_dek)          # 失败 → 「密码错误或数据库损坏」
 └─ 校验 verifier                                # 失败同上
 └─ 派生 page-key/wal-key/meta-key
 └─ 扫描 seg-*/wal-*，读头页（AEAD）→ WAL 恢复 → 执行命令
 └─ 进程退出：清空密码/密钥缓冲（best effort：volatile 写零）
```

- 密码**不出现在命令行参数/环境变量**中（会被进程列表/历史记录泄露）；
  `--password-stdin` 仅用于自动化与测试（明示不安全，帮助里标注）。
- 连续错误密码：不做账号锁定（单用户），但每次失败加固定延迟（如 200 ms）以降低暴力速度；
  错误信息统一为「密码错误或数据库损坏」，避免区分（也防止 oracle）。
- 只读命令同样需要密码（数据是加密的）。

## 6. 改密码与数据重加密

| 操作 | 命令 | 做法 | 成本 |
| --- | --- | --- | --- |
| 改密码（不改数据密钥） | `iaqs passwd` | 用新密码派生 KEK，重新包裹同一 DEK；更新 MANIFEST | 秒级 |
| 数据密钥轮换 | `iaqs rekey --data` | 生成新 DEK/epoch；离线逐页解密-重加密（或在线渐进：读旧写新） | 1 TiB 约 30–60 分钟 |
| 组合 | `iaqs rekey --data --password` | 先轮换数据密钥，再用新密码包裹 | 同上 |

- `passwd` 崩溃安全：MANIFEST 原子替换；旧 MANIFEST 保留到替换完成。
- `rekey --data` 崩溃安全：使用「双 epoch」：系统页记录当前 epoch 与旧 epoch 列表；
  新写入页用新 epoch；未重写页仍用旧 epoch 可读；全部重写后清理旧密钥。断电重启后继续。

## 7. 密钥与 nonce 的唯一性

- 页 nonce 含 generation：同槽位覆写必然换代，不会复用；页搬家（vacuum 重写）也用新段/页号。
- WAL nonce 含 lsn：单写者、lsn 单调，天然唯一。
- 子密钥按用途分离：即使某处 nonce 生成有缺陷，也不会跨用途碰撞。
- 测试断言（debug 构建）：页缓存记录 (key_id, nonce) 集合，重复即断言失败。
- 理论边界：generation 2^32 次覆写（页热点）≈ 不可达；文档化触发重加密的阈值。

## 8. 数据泄露面与对策

| 面 | 风险 | 对策 |
| --- | --- | --- |
| 临时文件 | 明文写入 tmp | 不存在明文临时文件；MANIFEST.tmp 只含公开参数/密文 |
| 崩溃转储/页文件 | 内存密钥落盘 | best effort 清零；文档声明不承诺（OS 页面文件无法控制） |
| 日志 | 打印对象内容/密码 | 日志只打印 oid/页号/计数；密码永不打印 |
| 命令行/历史 | 密码进 argv | 只从 stdin 交互读取；`--password-stdin` 明示风险 |
| 备份 | 明文备份 | 备份即 `.iaqs/` 目录副本（已加密）；热备需 `iaqs backup` |
| 删除残留 | 旧密文仍在磁盘空闲块 | 加密后旧密文无意义；`gc --vacuum` 整理段 |
| 内存交换 | 密码/密钥进 pagefile | 无法完全避免；best effort 清零 + 文档说明 |

## 9. 测试

- **KAT**：RFC 8439 ChaCha20-Poly1305 向量；RFC 6070 PBKDF2-HMAC-SHA256 向量；
  SHA-256/HMAC 标准向量；CRC32C 向量。
- **篡改**：翻转密文/信封/AAD/页号/generation 任一字节 → 解密失败；换页位置 → 失败；
  重放旧页 → 失败（AAD 含 generation）。
- **密码**：错误密码 → 拒绝且不泄露细节；`passwd` 后旧密码立即失效；`rekey --data`
  后旧密钥无法解密新页；断电注入后重开可继续。
- **性能**：1 GiB 页数据加解密吞吐；`rekey` 1 GiB 计时。

## 10. 实现清单（M1 开始）

1. `sha256`（含 HMAC、PBKDF2）、`crc32c`、`chacha20poly1305` 及 KAT 单测。
2. MANIFEST 读写 + 原子替换；CSPRNG 封装。
3. 页信封加解密（与 06 的页格式联调，可先明文模式）。
4. WAL 记录加解密；打开流程与密码输入（无回显）。
5. `passwd`；`rekey --data`（双 epoch）。
6. 篡改/断电注入测试；内存清零工具。

## 11. 实现注记（M1–M3 已落地）

- 已实现 `Keyring::initialize(Manifest&, password) -> DbKeys`、`Keyring::unlock`、
  `Keyring::rewrap(Manifest&, const Key32& dek, new_password)`：改密码只重新封装 DEK
  （新 salt/nonce、PBKDF2-600k KEK、重算 verifier），页/WAL 数据密钥不变，因此无需重写数据。
- `Database::change_password`：先 checkpoint（保证 WAL 已并入段文件），再改写 MANIFEST
  并原子替换；CLI `iaqs passwd --new-password ...` 走此路径。
- 尚缺 `rekey --data`（换数据密钥 + 双 epoch 重加密段文件）；当前密码变更不改变数据密钥。
- 密钥/子密钥（page/wal/meta）均为内存对象，`DbKeys::wipe` 与 `secure_wipe` 在关闭时清零。
## 实现注记（M4 第三段：rekey --data 已落地）

- 命令：`iaqs rekey --data`（当前密码解锁）；换的是数据加密密钥 DEK，密码不变。
- 流程：checkpoint（WAL 清空、页落盘）→ 生成新 DEK → 把新 DEK 用当前 KEK 封装后写入
  `.iaqs/REKEY.PENDING`（durable intent，格式 8B magic + 12B nonce + 32B ct + 16B tag +
  crc32c）→ Pager 逐段逐页用旧页密钥解封、新页密钥重封（epoch 不变：换了密钥，nonce
  重用是安全的；页地址 AAD 不变）→ `Keyring::install_dek` 重写 MANIFEST 的 wrapped DEK
  与 verifier → adopt 新子密钥 → 删除 sidecar → 轮转 WAL。
- 崩溃安全：MANIFEST 只在全部页重加密并 fsync 之后才改写，所以中途崩溃时旧 DEK 仍是
  权威；`Database::open` 发现 REKEY.PENDING 就会用解锁后的 KEK 解出 pending DEK，
  逐页尝试新钥（已迁移的跳过）/旧钥（未迁移的重封），完成后 promote 再删除 sidecar。
- 页重封逻辑在 `Pager::rekey_pages(new_key)`：先 flush 旧钥下的 dirty 页，再逐槽处理，
  已用新钥可解封的槽直接跳过，最后切换 page_key_ 并清空写事务基线。
- 限制：重加密是原地、单线程的，1 TiB 库耗时会很长（但可中断续做）；`rekey` 不支持
  同时改密码，需先 `passwd` 再 `rekey --data`。
## 实现注记（M7 审计加固）

- 审计未发现明文落盘、nonce 复用导致的密钥流重用或 AEAD 绕过；页/WAL/REKEY.PENDING
  均绑定地址与代数（AAD/nonce 见 §4）。
- 密码来源变更（默认口令/TTY/--password-stdin）不影响密钥派生：KEK 仍由实际口令
  PBKDF2 600k 派生，默认口令只是"口令值"，不会绕过加密。
- 已知遗留（低/中风险）：内存中的子密钥副本未显式擦除（进程退出即释放）；
  若 REKEY.PENDING 遗留期间又改了密码，需要手工恢复旧密码才能完成 rekey 收尾。