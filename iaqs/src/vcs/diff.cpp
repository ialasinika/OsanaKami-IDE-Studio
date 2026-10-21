#include "vcs/diff.h"

#include <algorithm>
#include <cstdint>

#include "vcs/linediff.h"

namespace iaqs::vcs {
namespace {

void emit_line(std::string& out, char prefix, const std::string& text) {
  out += prefix;
  out += text;
  if (text.empty() || text.back() != '\n') {
    out += "\n\\ No newline at end of file\n";
  }
}

}  // namespace

bool looks_binary(std::string_view content) {
  const std::size_t probe = std::min<std::size_t>(content.size(), 8000);
  return content.substr(0, probe).find('\0') != std::string_view::npos;
}

std::string unified_diff(std::string_view before, std::string_view after,
                         std::string_view path_before,
                         std::string_view path_after, std::size_t context) {
  const std::vector<std::string> a = split_lines(before);
  const std::vector<std::string> b = split_lines(after);
  if (a == b) return {};

  const std::vector<LineChange> changes = diff_changes(a, b);
  const std::size_t n = a.size();

  std::string out;
  out += "--- ";
  out += path_before;
  out += "\n+++ ";
  out += path_after;
  out += "\n";

  std::int64_t delta = 0;  // inserted - deleted lines so far
  std::size_t index = 0;
  while (index < changes.size()) {
    std::size_t last = index;
    while (last + 1 < changes.size() &&
           changes[last + 1].start - changes[last].end <= 2 * context) {
      ++last;
    }

    const std::size_t base_begin =
        changes[index].start > context ? changes[index].start - context : 0;
    const std::size_t base_end = std::min(n, changes[last].end + context);

    std::size_t deleted = 0;
    std::size_t inserted = 0;
    for (std::size_t i = index; i <= last; ++i) {
      deleted += changes[i].end - changes[i].start;
      inserted += changes[i].lines.size();
    }
    const std::size_t old_count = base_end - base_begin;
    const std::size_t new_count = old_count - deleted + inserted;

    const std::size_t old_start = base_begin + (old_count > 0 ? 1 : 0);
    const std::size_t new_start = static_cast<std::size_t>(
        static_cast<std::int64_t>(base_begin) + delta +
        (new_count > 0 ? 1 : 0));

    out += "@@ -";
    out += std::to_string(old_start);
    out += ',';
    out += std::to_string(old_count);
    out += " +";
    out += std::to_string(new_start);
    out += ',';
    out += std::to_string(new_count);
    out += " @@\n";

    std::size_t base = base_begin;
    for (std::size_t i = index; i <= last; ++i) {
      const LineChange& change = changes[i];
      for (; base < change.start; ++base) emit_line(out, ' ', a[base]);
      for (; base < change.end; ++base) emit_line(out, '-', a[base]);
      for (const std::string& line : change.lines) emit_line(out, '+', line);
      delta += static_cast<std::int64_t>(change.lines.size()) -
               static_cast<std::int64_t>(change.end - change.start);
    }
    for (; base < base_end; ++base) emit_line(out, ' ', a[base]);

    index = last + 1;
  }
  return out;
}

}  // namespace iaqs::vcs
