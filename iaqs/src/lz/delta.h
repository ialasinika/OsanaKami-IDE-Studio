// IAQSD1 对象层 delta 格式的公共接口。
//
// 格式见 docs/design/02-storage.md §3：magic "IAQSD1" + uvarint(base_size) +
// uvarint(tgt_size) + 指令流（0x00 COPY off,len / 0x01 INSERT len,bytes）。
// 生成算法按行切分、行级匹配，不做字节级微调，保证简单、确定、线性时间。
#pragma once

#include "core/util.h"

namespace iaqs::delta {

// 生成 base → target 的 IAQSD1 指令流。任意输入都不会抛异常：
// 空 base/target、无换行长行、随机二进制等都由 INSERT/COPY 合法表达。
Bytes make_delta(ByteSpan base, ByteSpan target);

// 应用 delta 还原 target。base 长度与 base_size 不符、指令越界、
// 解出长度不等于 tgt_size、尾部有多余字节时抛 std::runtime_error。
Bytes apply_delta(ByteSpan base, ByteSpan delta);

// delta 的存储占比：delta.size() / target.size()；target 为空时返回 1.0。
double delta_ratio(ByteSpan delta, ByteSpan target);

// 只检查 magic 前缀，不校验后续内容；空输入返回 false。
bool is_delta(ByteSpan data);

}  // namespace iaqs::delta
