// CRC32C (Castagnoli, reflected polynomial 0x82F63B78).
#pragma once

#include <cstddef>
#include <cstdint>

#include "core/util.h"

namespace iaqs {

uint32_t crc32c(const uint8_t* data, size_t size, uint32_t seed = 0);
uint32_t crc32c(ByteSpan data, uint32_t seed = 0);
uint32_t crc32c(std::string_view data, uint32_t seed = 0);

}  // namespace iaqs
