// OS CSPRNG wrapper and best-effort secret wiping.
#pragma once

#include <cstddef>
#include <cstdint>

#include "core/util.h"

namespace iaqs {

// Fills `out` with cryptographically secure random bytes (OS CSPRNG).
void random_fill(uint8_t* out, size_t size);
Bytes random_bytes(size_t size);

// Best-effort wipe that the optimizer is not allowed to elide.
void secure_wipe(void* data, size_t size);
inline void secure_wipe(Bytes& bytes) {
  secure_wipe(bytes.data(), bytes.size());
}

}  // namespace iaqs
