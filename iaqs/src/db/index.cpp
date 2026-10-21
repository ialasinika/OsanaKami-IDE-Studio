#include "db/index.h"

#include <algorithm>
#include <cstring>
#include <stdexcept>
#include <utility>

namespace iaqs::db {
namespace {

constexpr std::size_t kKeySize = FixedBTree::kKeySize;

void store_u16_be(uint8_t* out, uint16_t value) {
  out[0] = static_cast<uint8_t>(value >> 8);
  out[1] = static_cast<uint8_t>(value);
}

void store_u32_be(uint8_t* out, uint32_t value) {
  out[0] = static_cast<uint8_t>(value >> 24);
  out[1] = static_cast<uint8_t>(value >> 16);
  out[2] = static_cast<uint8_t>(value >> 8);
  out[3] = static_cast<uint8_t>(value);
}

void store_u64_be(uint8_t* out, uint64_t value) {
  for (int i = 7; i >= 0; --i) {
    out[7 - i] = static_cast<uint8_t>(value >> (8 * i));
  }
}

uint16_t load_u16_be(const uint8_t* in) {
  return static_cast<uint16_t>((static_cast<uint16_t>(in[0]) << 8) |
                               static_cast<uint16_t>(in[1]));
}

uint32_t load_u32_be(const uint8_t* in) {
  return (static_cast<uint32_t>(in[0]) << 24) |
         (static_cast<uint32_t>(in[1]) << 16) |
         (static_cast<uint32_t>(in[2]) << 8) | static_cast<uint32_t>(in[3]);
}

// Compares the 22-byte value prefix of `a` against the raw prefix bytes `b`.
int compare_prefix(const Bytes& a, const uint8_t* b) {
  return std::memcmp(a.data(), b, kIndexValuePrefixSize);
}

}  // namespace

void encode_index_value_prefix(const Value& value, uint8_t* out) {
  std::memset(out, 0, kIndexValuePrefixSize);
  switch (value.type) {
    case ValueType::Integer: {
      const uint64_t raw = static_cast<uint64_t>(value.int_value);
      store_u64_be(out, raw ^ 0x8000000000000000ull);
      return;
    }
    case ValueType::Real: {
      uint64_t bits = 0;
      std::memcpy(&bits, &value.real_value, sizeof(bits));
      // SQL compares -0.0 == +0.0, so both zeros must share one key prefix;
      // the zero key sits exactly between the negative and positive ranges.
      if (value.real_value == 0.0) {
        bits = 0x8000000000000000ull;
      } else if ((bits & 0x8000000000000000ull) != 0) {
        bits = ~bits;
      } else {
        bits |= 0x8000000000000000ull;
      }
      store_u64_be(out, bits);
      return;
    }
    case ValueType::Text:
    case ValueType::Blob: {
      const std::size_t n = std::min(value.bytes.size(), kIndexValuePrefixSize);
      if (n != 0) {
        std::memcpy(out, value.bytes.data(), n);
      }
      return;
    }
    case ValueType::Null:
      throw std::runtime_error("cannot index a NULL value");
  }
}

IndexKey encode_index_key(const Value& value, const Rid& rid) {
  IndexKey key{};
  encode_index_value_prefix(value, key.data());
  uint8_t* suffix = key.data() + kIndexValuePrefixSize;
  store_u32_be(suffix, rid.ref.seg);
  store_u32_be(suffix + 4, rid.ref.page);
  store_u16_be(suffix + 8, rid.slot);
  return key;
}

Rid index_key_rid(const uint8_t* key) {
  const uint8_t* suffix = key + kIndexValuePrefixSize;
  Rid rid;
  rid.ref = PageRef{load_u32_be(suffix), load_u32_be(suffix + 4), 0};
  rid.slot = load_u16_be(suffix + 8);
  return rid;
}

std::vector<Rid> probe_index(const FixedBTree& tree, const Value& value,
                             IndexOp op) {
  uint8_t prefix[kIndexValuePrefixSize] = {};
  encode_index_value_prefix(value, prefix);

  const std::vector<std::pair<Bytes, Rid>> entries = tree.scan();
  const std::size_t n = entries.size();

  // lower: first entry whose value prefix is >= `prefix`.
  std::size_t lower = 0;
  {
    std::size_t lo = 0;
    std::size_t hi = n;
    while (lo < hi) {
      const std::size_t mid = lo + (hi - lo) / 2;
      if (compare_prefix(entries[mid].first, prefix) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    lower = lo;
  }
  // upper: first entry whose value prefix is > `prefix`.
  std::size_t upper = 0;
  {
    std::size_t lo = 0;
    std::size_t hi = n;
    while (lo < hi) {
      const std::size_t mid = lo + (hi - lo) / 2;
      if (compare_prefix(entries[mid].first, prefix) <= 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    upper = lo;
  }

  std::size_t begin = 0;
  std::size_t end = 0;
  switch (op) {
    case IndexOp::Equal:
      begin = lower;
      end = upper;
      break;
    case IndexOp::Less:
    case IndexOp::LessEq:
      // A prefix-ordered range candidate set: every entry with prefix
      // < literal prefix plus (for the equal prefix) possibly-truncated long
      // values; the caller rechecks the real comparison.
      begin = 0;
      end = upper;
      break;
    case IndexOp::Greater:
    case IndexOp::GreaterEq:
      begin = lower;
      end = n;
      break;
  }

  std::vector<Rid> rids;
  rids.reserve(end - begin);
  for (std::size_t i = begin; i < end; ++i) {
    rids.push_back(index_key_rid(
        reinterpret_cast<const uint8_t*>(entries[i].first.data())));
  }
  return rids;
}

}  // namespace iaqs::db
