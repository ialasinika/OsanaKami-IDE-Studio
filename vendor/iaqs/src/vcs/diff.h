// Unified diff rendering for text files.
#pragma once

#include <cstddef>
#include <string>
#include <string_view>

namespace iaqs::vcs {

// Renders a git-style unified diff (three lines of context by default). Returns
// an empty string when both sides are identical. Binary detection is the
// caller's job (this only handles line-oriented text).
std::string unified_diff(std::string_view before, std::string_view after,
                         std::string_view path_before,
                         std::string_view path_after,
                         std::size_t context = 3);

// True when the payload looks like binary data (contains a NUL byte in the
// first 8000 bytes, matching common VCS heuristics).
bool looks_binary(std::string_view content);

}  // namespace iaqs::vcs
