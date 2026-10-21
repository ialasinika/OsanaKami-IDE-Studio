#include "vcs/linediff.h"

#include <algorithm>

namespace iaqs::vcs {

std::vector<std::string> split_lines(std::string_view text) {
  std::vector<std::string> lines;
  std::size_t start = 0;
  while (start < text.size()) {
    const std::size_t eol = text.find('\n', start);
    if (eol == std::string_view::npos) {
      lines.emplace_back(text.substr(start));
      break;
    }
    lines.emplace_back(text.substr(start, eol - start + 1));
    start = eol + 1;
  }
  return lines;
}

std::vector<LineChange> diff_changes(const std::vector<std::string>& a,
                                     const std::vector<std::string>& b) {
  const int n = static_cast<int>(a.size());
  const int m = static_cast<int>(b.size());
  const int max = n + m;
  if (max == 0) return {};

  const int offset = max + 1;
  std::vector<std::vector<int>> trace;
  std::vector<int> v(static_cast<std::size_t>(2 * max + 3), 0);

  for (int d = 0; d <= max; ++d) {
    trace.push_back(v);
    for (int k = -d; k <= d; k += 2) {
      int x;
      if (k == -d ||
          (k != d && v[static_cast<std::size_t>(offset + k - 1)] <
                         v[static_cast<std::size_t>(offset + k + 1)])) {
        x = v[static_cast<std::size_t>(offset + k + 1)];
      } else {
        x = v[static_cast<std::size_t>(offset + k - 1)] + 1;
      }
      int y = x - k;
      while (x < n && y < m &&
             a[static_cast<std::size_t>(x)] == b[static_cast<std::size_t>(y)]) {
        ++x;
        ++y;
      }
      v[static_cast<std::size_t>(offset + k)] = x;
      if (x >= n && y >= m) goto found;
    }
  }
found:
  // Backtrack from (n,m) to (0,0), collecting the edit script in reverse.
  struct Op {
    int type;  // 0 equal, 1 delete from a, 2 insert from b
    int index;
  };
  std::vector<Op> ops;
  int x = n;
  int y = m;
  for (int d = static_cast<int>(trace.size()) - 1; d >= 0; --d) {
    const std::vector<int>& pv = trace[static_cast<std::size_t>(d)];
    const int k = x - y;
    const int prev_k =
        (k == -d || (k != d && pv[static_cast<std::size_t>(offset + k - 1)] <
                                  pv[static_cast<std::size_t>(offset + k + 1)]))
            ? k + 1
            : k - 1;
    const int prev_x = pv[static_cast<std::size_t>(offset + prev_k)];
    const int prev_y = prev_x - prev_k;
    while (x > prev_x && y > prev_y) {
      ops.push_back({0, x - 1});
      --x;
      --y;
    }
    if (d > 0) {
      if (x == prev_x) {
        ops.push_back({2, y - 1});
        --y;
      } else {
        ops.push_back({1, x - 1});
        --x;
      }
    }
  }
  std::reverse(ops.begin(), ops.end());

  std::vector<LineChange> changes;
  int ai = 0;
  std::size_t i = 0;
  while (i < ops.size()) {
    if (ops[i].type == 0) {
      ++ai;
      ++i;
      continue;
    }
    LineChange change;
    change.start = static_cast<std::size_t>(ai);
    while (i < ops.size() && ops[i].type != 0) {
      if (ops[i].type == 1) {
        ++ai;
      } else {
        change.lines.push_back(b[static_cast<std::size_t>(ops[i].index)]);
      }
      ++i;
    }
    change.end = static_cast<std::size_t>(ai);
    changes.push_back(std::move(change));
  }
  return changes;
}

}  // namespace iaqs::vcs
