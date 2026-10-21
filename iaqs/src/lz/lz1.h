// IAQSLZ1 压缩格式的公共接口。
//
// 自研 LZ77 变体（零第三方依赖），用于对象/页的透明压缩。
// 格式见 docs/design/02-storage.md §2：magic "IAQSLZ1" + uvarint(raw_len) + token 流。
#pragma once

#include "core/util.h"

namespace iaqs::lz {

// 匹配窗口大小：64 KiB，因此令牌中的 dist 上限为 65535。
inline constexpr size_t kWindow = 65536;

// 压缩为 IAQSLZ1 帧。对任意输入都可编码（不可压缩输入退化为字面量流，
// 最坏膨胀约 0.4%）；同一输入两次调用输出逐字节相同。
Bytes lz1_compress(ByteSpan data);

// 解压 IAQSLZ1 帧。magic/varint/token 损坏、dist 或 len 非法、
// 解出长度与 raw_len 不符、或尾部有多余字节时抛 std::runtime_error。
Bytes lz1_decompress(ByteSpan compressed);

// 只检查 6/7 字节 magic 前缀，不校验后续内容；空输入返回 false。
bool lz1_is_compressed(ByteSpan data);

}  // namespace iaqs::lz
