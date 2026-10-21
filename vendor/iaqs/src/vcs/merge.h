// Line-based three-way merge (design 03 §4). Encoding-agnostic: works on the
// bytes of both sides and only ever splits at '\n'.
#pragma once

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

#include "core/util.h"

namespace iaqs::vcs {

struct MergeResult {
  Bytes content;
  bool clean = true;
  size_t conflicts = 0;
};

// Merges two variants of `base`. When regions conflict the marker lines use the
// given labels (e.g. "HEAD" and "feature") exactly like git.
MergeResult merge3(std::string_view base, std::string_view ours,
                   std::string_view theirs, std::string_view ours_label,
                   std::string_view theirs_label);

}  // namespace iaqs::vcs
