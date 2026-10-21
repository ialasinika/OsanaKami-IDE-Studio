// IAQSD1 对象层 delta 的生成/应用实现。
//
// 生成算法（docs/design/02-storage.md §3）：
//   1. 把 base 与 target 按行切分（'\n' 连同其前面的 '\r' 都留在行内）；
//   2. 对 base 行建立「行内容 → 位置列表」的哈希表；
//   3. 逐行扫描 target：命中且 COPY 比 INSERT 更省则复制，连续命中且
//      在 base 中地址连续时合并为一个 COPY 区间；未命中的连续行合并为
//      一条 INSERT；行内部分相同不做字节级微调（v1 保持简单可预测）。
//   全程 O(base + target log lines) 时间，不存在 O(n²) 的行间比较。
#include "lz/delta.h"

#include <algorithm>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace iaqs::delta {
namespace {

// magic 字符串是 6 字节。
constexpr char kMagic[] = "IAQSD1";
constexpr size_t kMagicSize = sizeof(kMagic) - 1;

constexpr uint8_t kCopy = 0x00;    // COPY：uvarint off, uvarint len
constexpr uint8_t kInsert = 0x01;  // INSERT：uvarint len, len 字节原文

constexpr size_t kNoPos = std::numeric_limits<size_t>::max();

// 解压目标长度上限（1 GiB）：逻辑帧远小于此值，超大 tgt_size 视为损坏。
constexpr uint64_t kMaxTargetLen = 1ull << 30;

// 预留输出的上限，避免按伪造的 tgt_size 一次性分配巨量内存。
constexpr uint64_t kReserveCap = 64ull << 20;

// 一行在所属缓冲区中的字节区间。行尾始终包含 '\n'（最后一行除外），
// 因此 '\r' 天然保留在行内。
struct Line {
  size_t off;
  size_t len;
};

// 按 '\n' 切行，保留 '\n'；空输入返回空列表。
std::vector<Line> split_lines(ByteSpan data) {
  std::vector<Line> lines;
  const size_t size = data.size();
  size_t start = 0;
  for (size_t i = 0; i < size; ++i) {
    if (data[i] == '\n') {
      lines.push_back(Line{start, i + 1 - start});
      start = i + 1;
    }
  }
  if (start < size) {
    lines.push_back(Line{start, size - start});
  }
  return lines;
}

// 取一行的内容视图（零拷贝，指向原缓冲区）。
std::string_view line_view(ByteSpan data, const Line& line) {
  return std::string_view(
      reinterpret_cast<const char*>(data.data()) + line.off, line.len);
}

// uvarint 编码后的字节数，用于比较 COPY 与 INSERT 的指令开销。
size_t uvarint_size(uint64_t value) {
  size_t size = 1;
  while (value >= 0x80) {
    value >>= 7;
    ++size;
  }
  return size;
}

[[noreturn]] void corrupt(const char* what) {
  throw std::runtime_error(std::string("IAQSD1 corrupt: ") + what);
}

// 输出一条 COPY 指令。
void emit_copy(Bytes& out, size_t off, size_t len) {
  out.push_back(static_cast<char>(kCopy));
  append_uvarint(out, off);
  append_uvarint(out, len);
}

// 输出一条 INSERT 指令，内容取自 target 的 [start, start+len)。
void emit_insert(Bytes& out, ByteSpan target, size_t start, size_t len) {
  out.push_back(static_cast<char>(kInsert));
  append_uvarint(out, len);
  out.append(reinterpret_cast<const char*>(target.data()) + start, len);
}

}  // namespace

Bytes make_delta(ByteSpan base, ByteSpan target) {
  const std::vector<Line> base_lines = split_lines(base);
  const std::vector<Line> target_lines = split_lines(target);

  // 「行内容 → base 中的字节偏移列表」；列表按偏移升序自然生成，
  // 因此可用 binary_search 判断某个偏移是否是一行内容的起点（用于连续合并）。
  std::unordered_map<std::string_view, std::vector<size_t>> index;
  index.reserve(base_lines.size() * 2 + 1);
  for (const Line& line : base_lines) {
    index[line_view(base, line)].push_back(line.off);
  }

  Bytes out;
  out.reserve(16 + target.size() / 2);
  out.append(kMagic, kMagicSize);
  append_uvarint(out, base.size());
  append_uvarint(out, target.size());

  // 待输出的 INSERT 区间（target 字节偏移）；kNoPos 表示当前没有。
  size_t insert_start = kNoPos;
  size_t insert_end = 0;
  auto flush_insert = [&]() {
    if (insert_start == kNoPos) {
      return;
    }
    emit_insert(out, target, insert_start, insert_end - insert_start);
    insert_start = kNoPos;
  };

  // 当前累积的 COPY 区间：target 字节 [run_tgt_start, run_tgt_end)
  // 对应 base 从 run_base_start 开始的等长区间。
  bool run_active = false;
  size_t run_tgt_start = 0;
  size_t run_tgt_end = 0;
  size_t run_base_start = 0;

  // 结束当前 COPY 区间：只有 COPY 的编码开销确实小于 INSERT 才复制，
  // 否则把这批行按 INSERT 输出，避免「复制 1 个字节反而更大」。
  auto close_run = [&]() {
    if (!run_active) {
      return;
    }
    const size_t len = run_tgt_end - run_tgt_start;
    const size_t copy_cost =
        1 + uvarint_size(run_base_start) + uvarint_size(len);
    const size_t insert_cost = 1 + uvarint_size(len) + len;
    if (copy_cost < insert_cost) {
      emit_copy(out, run_base_start, len);
    } else {
      emit_insert(out, target, run_tgt_start, len);
    }
    run_active = false;
  };

  for (const Line& target_line : target_lines) {
    const std::string_view content = line_view(target, target_line);
    const auto it = index.find(content);
    const bool found = it != index.end();

    // 优先尝试与当前 COPY 区间在 base 中地址连续的行，以便合并指令。
    bool can_extend = false;
    size_t candidate = 0;
    if (found) {
      if (run_active) {
        const size_t want = run_base_start + (run_tgt_end - run_tgt_start);
        const std::vector<size_t>& positions = it->second;
        if (std::binary_search(positions.begin(), positions.end(), want)) {
          can_extend = true;
          candidate = want;
        }
      }
      if (!can_extend) {
        candidate = it->second.front();  // 首次出现的位置，确定性选择
      }
    }

    if (can_extend) {
      run_tgt_end = target_line.off + target_line.len;
    } else if (found) {
      close_run();
      flush_insert();
      run_active = true;
      run_base_start = candidate;
      run_tgt_start = target_line.off;
      run_tgt_end = target_line.off + target_line.len;
    } else {
      close_run();
      if (insert_start == kNoPos) {
        insert_start = target_line.off;
      }
      insert_end = target_line.off + target_line.len;
    }
  }

  close_run();
  flush_insert();
  return out;
}

Bytes apply_delta(ByteSpan base, ByteSpan delta) {
  if (!is_delta(delta)) {
    corrupt("bad magic");
  }

  ByteSpan in = delta.subspan(kMagicSize);
  uint64_t base_size = 0;
  uint64_t tgt_size = 0;
  if (!read_uvarint(in, base_size) || !read_uvarint(in, tgt_size)) {
    corrupt("truncated header");
  }
  if (base_size != base.size()) {
    corrupt("base size mismatch");
  }
  if (tgt_size > kMaxTargetLen) {
    corrupt("tgt_size too large");
  }

  Bytes out;
  out.reserve(static_cast<size_t>(std::min<uint64_t>(tgt_size, kReserveCap)));
  while (out.size() < tgt_size) {
    if (in.empty()) {
      corrupt("truncated instruction stream");
    }
    const uint8_t token = in[0];
    in = in.subspan(1);

    if (token == kCopy) {
      uint64_t off = 0;
      uint64_t len = 0;
      if (!read_uvarint(in, off) || !read_uvarint(in, len)) {
        corrupt("truncated copy");
      }
      if (off > base.size() || len > base_size - off) {
        corrupt("copy out of range");
      }
      if (len > tgt_size - out.size()) {
        corrupt("copy overruns target");
      }
      out.append(reinterpret_cast<const char*>(base.data()) +
                     static_cast<size_t>(off),
                 static_cast<size_t>(len));
    } else if (token == kInsert) {
      uint64_t len = 0;
      if (!read_uvarint(in, len)) {
        corrupt("truncated insert");
      }
      if (len > static_cast<uint64_t>(in.size())) {
        corrupt("truncated insert payload");
      }
      if (len > tgt_size - out.size()) {
        corrupt("insert overruns target");
      }
      out.append(reinterpret_cast<const char*>(in.data()),
                 static_cast<size_t>(len));
      in = in.subspan(static_cast<size_t>(len));
    } else {
      corrupt("unknown instruction");
    }
  }

  if (!in.empty()) {
    corrupt("trailing bytes");
  }
  return out;
}

double delta_ratio(ByteSpan delta, ByteSpan target) {
  if (target.empty()) {
    return 1.0;
  }
  return static_cast<double>(delta.size()) /
         static_cast<double>(target.size());
}

bool is_delta(ByteSpan data) {
  return data.size() >= kMagicSize &&
         std::memcmp(data.data(), kMagic, kMagicSize) == 0;
}

}  // namespace iaqs::delta
