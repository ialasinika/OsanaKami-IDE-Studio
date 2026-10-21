// IAQSLZ1 压缩/解压实现。
//
// 帧格式（docs/design/02-storage.md §2）：
//   magic    "IAQSLZ1"         （7 字节字符串；文档里的「6 字节」是笔误）
//   raw_len  uvarint           解压后长度（解压端据此校验，防炸弹）
//   token 流：
//     0x00        → 匹配：uvarint dist（1..65535）、uvarint len（>=3）
//     0x01..0xFF  → 字面量：len = token（1..255），随后 len 字节原文
//
// 编码器是确定性的「贪婪、不回溯」LZ77：64 KiB 窗口、3 字节哈希、
// 每个哈希槽只记最近一次出现的位置。对每个候选先验证真实匹配长度，
// 只有「匹配指令的编码开销 < 字面量字节数」时才输出匹配，否则按字面量
// 输出，从而保证不可压缩输入的最坏膨胀仅来自字面量分块头（约 0.4%）。
#include "lz/lz1.h"

#include <algorithm>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace iaqs::lz {
namespace {

// magic 字符串本身是 7 字节，按字面量严格匹配。
constexpr char kMagic[] = "IAQSLZ1";
constexpr size_t kMagicSize = sizeof(kMagic) - 1;

constexpr size_t kMinMatch = 3;  // 格式允许的最短匹配长度
constexpr size_t kLiteralMax = 255;  // 单条字面量指令最多携带 255 字节
constexpr size_t kNoPos = std::numeric_limits<size_t>::max();

// 解压长度上限（1 GiB）：逻辑帧远小于此值，超大 raw_len 视为损坏，
// 避免恶意帧把内存吃光。
constexpr uint64_t kMaxRawLen = 1ull << 30;

// 预留输出的上限，避免按伪造的 raw_len 一次性分配巨量内存。
constexpr uint64_t kReserveCap = 64ull << 20;

// uvarint 编码后的字节数，用于估算一条指令的编码代价。
size_t uvarint_size(uint64_t value) {
  size_t size = 1;
  while (value >= 0x80) {
    value >>= 7;
    ++size;
  }
  return size;
}

// 3 字节哈希映射到 bits 位槽位。结果只取决于输入内容，保证确定性。
uint32_t hash3(const uint8_t* p, unsigned bits) {
  const uint32_t value = static_cast<uint32_t>(p[0]) |
                         (static_cast<uint32_t>(p[1]) << 8) |
                         (static_cast<uint32_t>(p[2]) << 16);
  return (value * 2654435761u) >> (32 - bits);
}

// 依据输入规模选择哈希表位数：小对象不必分配 64K 槽位（页压缩调用频繁），
// 大对象保持 16 位以维持压缩率。只与输入长度有关，因此不影响确定性。
unsigned table_bits(size_t size) {
  unsigned bits = 10;
  while (bits < 16 && (size_t{1} << bits) < size / 2) {
    ++bits;
  }
  return bits;
}

}  // namespace

Bytes lz1_compress(ByteSpan data) {
  const size_t size = data.size();
  const uint8_t* base = data.data();
  const unsigned bits = table_bits(size);
  const size_t table_size = size_t{1} << bits;

  Bytes out;
  out.reserve(size + size / 256 + 16);
  out.append(kMagic, kMagicSize);
  append_uvarint(out, size);

  // 哈希表：3 字节序列 → 最近一次出现的位置。
  std::vector<size_t> table(table_size, kNoPos);

  size_t pos = 0;        // 当前扫描位置
  size_t lit_start = 0;  // 尚未输出的字面量起始位置

  // 把 [lit_start, end) 的字面量按 255 字节一段输出。
  auto flush_literals = [&](size_t end) {
    while (lit_start < end) {
      const size_t chunk = std::min<size_t>(kLiteralMax, end - lit_start);
      out.push_back(static_cast<char>(static_cast<uint8_t>(chunk)));
      out.append(reinterpret_cast<const char*>(base + lit_start), chunk);
      lit_start += chunk;
    }
  };

  while (pos + kMinMatch <= size) {
    const uint32_t hash = hash3(base + pos, bits);
    const size_t candidate = table[hash];
    table[hash] = pos;

    bool matched = false;
    size_t match_len = 0;
    size_t distance = 0;

    if (candidate != kNoPos) {
      const size_t dist = pos - candidate;
      if (dist >= 1 && dist <= kWindow) {
        // 贪心求最长匹配；允许重叠（dist 可以小于 match_len，
        // 解码端按字节复制即可还原）。
        const size_t max_len = size - pos;
        size_t len = 0;
        while (len < max_len && base[candidate + len] == base[pos + len]) {
          ++len;
        }
        if (len >= kMinMatch) {
          // 只有匹配指令比等长字面量更省时才采用，避免负压缩。
          const size_t cost = 1 + uvarint_size(dist) + uvarint_size(len);
          if (cost < len) {
            matched = true;
            match_len = len;
            distance = dist;
          }
        }
      }
    }

    if (matched) {
      flush_literals(pos);
      out.push_back(static_cast<char>(0x00));  // 匹配指令
      append_uvarint(out, distance);
      append_uvarint(out, match_len);

      // 被匹配跳过的位置也要登记到哈希表，后续匹配才能接上。
      const size_t end = pos + match_len;
      for (size_t q = pos + 1; q + kMinMatch <= end && q + kMinMatch <= size;
           ++q) {
        table[hash3(base + q, bits)] = q;
      }
      pos = end;
      lit_start = pos;
    } else {
      ++pos;  // 未命中：并入待输出的字面量区间
    }
  }

  flush_literals(size);  // 收尾：剩余不足 3 字节的部分按字面量输出
  return out;
}

Bytes lz1_decompress(ByteSpan compressed) {
  if (!lz1_is_compressed(compressed)) {
    throw std::runtime_error("IAQSLZ1 corrupt: bad magic");
  }

  ByteSpan in = compressed.subspan(kMagicSize);
  uint64_t raw_len = 0;
  if (!read_uvarint(in, raw_len)) {
    throw std::runtime_error("IAQSLZ1 corrupt: truncated raw_len");
  }
  if (raw_len > kMaxRawLen) {
    throw std::runtime_error("IAQSLZ1 corrupt: raw_len too large");
  }

  Bytes out;
  out.reserve(static_cast<size_t>(std::min<uint64_t>(raw_len, kReserveCap)));
  uint64_t produced = 0;  // 已解出的字节数

  while (produced < raw_len) {
    if (in.empty()) {
      throw std::runtime_error("IAQSLZ1 corrupt: truncated token stream");
    }
    const uint8_t token = in[0];
    in = in.subspan(1);

    if (token == 0x00) {
      // 匹配指令：dist 指向已输出区域，len 为复制长度。
      uint64_t dist = 0;
      uint64_t len = 0;
      if (!read_uvarint(in, dist) || !read_uvarint(in, len)) {
        throw std::runtime_error("IAQSLZ1 corrupt: truncated match");
      }
      if (dist == 0 || dist > kWindow) {
        throw std::runtime_error("IAQSLZ1 corrupt: bad match distance");
      }
      if (dist > produced) {
        throw std::runtime_error("IAQSLZ1 corrupt: distance before start");
      }
      if (len < kMinMatch) {
        throw std::runtime_error("IAQSLZ1 corrupt: match length too small");
      }
      if (len > raw_len - produced) {
        throw std::runtime_error("IAQSLZ1 corrupt: match overruns raw_len");
      }
      const size_t d = static_cast<size_t>(dist);
      const size_t l = static_cast<size_t>(len);
      const size_t start = out.size() - d;
      for (size_t i = 0; i < l; ++i) {
        // 先取到局部变量再 push_back，避免扩容导致引用失效。
        const char ch = out[start + i];
        out.push_back(ch);
      }
      produced += len;
    } else {
      // 字面量指令：token 即长度（1..255）。
      const size_t len = static_cast<size_t>(token);
      if (len > in.size()) {
        throw std::runtime_error("IAQSLZ1 corrupt: truncated literal");
      }
      if (len > raw_len - produced) {
        throw std::runtime_error("IAQSLZ1 corrupt: literal overruns raw_len");
      }
      out.append(reinterpret_cast<const char*>(in.data()), len);
      in = in.subspan(len);
      produced += len;
    }
  }

  if (!in.empty()) {
    throw std::runtime_error("IAQSLZ1 corrupt: trailing bytes");
  }
  return out;
}

bool lz1_is_compressed(ByteSpan data) {
  return data.size() >= kMagicSize &&
         std::memcmp(data.data(), kMagic, kMagicSize) == 0;
}

}  // namespace iaqs::lz
