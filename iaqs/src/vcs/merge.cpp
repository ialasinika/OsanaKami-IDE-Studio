#include "vcs/merge.h"
#include "vcs/linediff.h"

#include <algorithm>
#include <stdexcept>

namespace iaqs::vcs {
namespace {
using Change = LineChange;


void append_lines(std::string& out, const std::vector<std::string>& lines) {
  for (const auto& line : lines) out += line;
}

void append_base(std::string& out, const std::vector<std::string>& base, size_t begin,
                 size_t end) {
  for (size_t i = begin; i < end; ++i) out += base[i];
}

void ensure_trailing_newline(std::string& text) {
  if (!text.empty() && text.back() != '\n') text.push_back('\n');
}

}  // namespace

MergeResult merge3(std::string_view base_text, std::string_view ours_text,
                   std::string_view theirs_text, std::string_view ours_label,
                   std::string_view theirs_label) {
  const std::vector<std::string> base = split_lines(base_text);
  const std::vector<std::string> ours = split_lines(ours_text);
  const std::vector<std::string> theirs = split_lines(theirs_text);

  const std::vector<Change> ours_changes = diff_changes(base, ours);
  const std::vector<Change> theirs_changes = diff_changes(base, theirs);

  MergeResult result;
  std::string out;
  size_t pos = 0;
  size_t oi = 0;
  size_t ti = 0;

  while (oi < ours_changes.size() || ti < theirs_changes.size()) {
    const bool have_ours = oi < ours_changes.size();
    const bool have_theirs = ti < theirs_changes.size();
    if (have_ours && !have_theirs) {
      append_base(out, base, pos, ours_changes[oi].start);
      append_lines(out, ours_changes[oi].lines);
      pos = ours_changes[oi].end;
      ++oi;
      continue;
    }
    if (have_theirs && !have_ours) {
      append_base(out, base, pos, theirs_changes[ti].start);
      append_lines(out, theirs_changes[ti].lines);
      pos = theirs_changes[ti].end;
      ++ti;
      continue;
    }

    const Change& change_ours = ours_changes[oi];
    const Change& change_theirs = theirs_changes[ti];

    // Identical edits (or both sides deleting the same lines) merge cleanly.
    if (change_ours.start == change_theirs.start && change_ours.end == change_theirs.end &&
        change_ours.lines == change_theirs.lines) {
      append_base(out, base, pos, change_ours.start);
      append_lines(out, change_ours.lines);
      pos = change_ours.end;
      ++oi;
      ++ti;
      continue;
    }

    const bool disjoint =
        change_ours.end <= change_theirs.start || change_theirs.end <= change_ours.start;
    if (disjoint) {
      if (change_ours.start <= change_theirs.start) {
        append_base(out, base, pos, change_ours.start);
        append_lines(out, change_ours.lines);
        pos = change_ours.end;
        ++oi;
      } else {
        append_base(out, base, pos, change_theirs.start);
        append_lines(out, change_theirs.lines);
        pos = change_theirs.end;
        ++ti;
      }
      continue;
    }

    // Overlapping edits: emit a conflict block covering every change of either
    // side that touches the region. Only applying the first change would leave
    // the second one to be emitted *after* the conflict markers.
    const size_t oi_first = oi;
    const size_t ti_first = ti;
    size_t start = std::min(change_ours.start, change_theirs.start);
    size_t end = std::max(change_ours.end, change_theirs.end);
    auto overlaps = [](const Change& change, size_t region_start, size_t region_end) {
      return change.start < region_end && region_start < change.end;
    };
    // The two changes that triggered the conflict are part of the region even
    // when they are pure insertions (start == end).
    ++oi;
    ++ti;
    bool grew = true;
    while (grew) {
      grew = false;
      while (oi < ours_changes.size() && overlaps(ours_changes[oi], start, end)) {
        start = std::min(start, ours_changes[oi].start);
        end = std::max(end, ours_changes[oi].end);
        ++oi;
        grew = true;
      }
      while (ti < theirs_changes.size() && overlaps(theirs_changes[ti], start, end)) {
        start = std::min(start, theirs_changes[ti].start);
        end = std::max(end, theirs_changes[ti].end);
        ++ti;
        grew = true;
      }
    }
    append_base(out, base, pos, start);

    auto apply_side = [&](const std::vector<Change>& changes, size_t first, size_t last) {
      std::string text;
      size_t cursor = start;
      for (size_t k = first; k < last; ++k) {
        const Change& change = changes[k];
        const size_t change_start = std::max(start, change.start);
        const size_t change_end = std::min(end, change.end);
        if (change_start > cursor) append_base(text, base, cursor, change_start);
        append_lines(text, change.lines);
        cursor = std::max(cursor, change_end);
      }
      if (cursor < end) append_base(text, base, cursor, end);
      return text;
    };
    std::string ours_region = apply_side(ours_changes, oi_first, oi);
    std::string theirs_region = apply_side(theirs_changes, ti_first, ti);
    ensure_trailing_newline(ours_region);
    ensure_trailing_newline(theirs_region);

    out += "<<<<<<< ";
    out += std::string(ours_label);
    out += "\n";
    out += ours_region;
    out += "=======\n";
    out += theirs_region;
    out += ">>>>>>> ";
    out += std::string(theirs_label);
    out += "\n";

    ++result.conflicts;
    result.clean = false;
    pos = end;
  }
  append_base(out, base, pos, base.size());
  result.content = std::move(out);
  return result;
}

}  // namespace iaqs::vcs
