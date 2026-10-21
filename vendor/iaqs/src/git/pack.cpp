#include "git/pack.h"

#include <algorithm>
#include <cstring>
#include <map>
#include <stdexcept>
#include <unordered_map>
#include <vector>

#include "git/sha1.h"
#include "git/zlib_stream.h"

namespace iaqs::git {
namespace {

[[noreturn]] void fail(const std::string& what) { throw std::runtime_error("pack: " + what); }

void append_be32(Bytes& out, uint32_t value) {
  out.push_back(static_cast<char>(value >> 24));
  out.push_back(static_cast<char>(value >> 16));
  out.push_back(static_cast<char>(value >> 8));
  out.push_back(static_cast<char>(value));
}

uint32_t read_be32(ByteSpan data, std::size_t& pos) {
  if (pos + 4 > data.size()) fail("truncated 32-bit value");
  const uint32_t value = (static_cast<uint32_t>(data[pos]) << 24) |
                         (static_cast<uint32_t>(data[pos + 1]) << 16) |
                         (static_cast<uint32_t>(data[pos + 2]) << 8) |
                         static_cast<uint32_t>(data[pos + 3]);
  pos += 4;
  return value;
}

uint64_t read_be64(ByteSpan data, std::size_t& pos) {
  const uint64_t high = read_be32(data, pos);
  const uint64_t low = read_be32(data, pos);
  return (high << 32) | low;
}

void append_pack_header(std::size_t size, uint8_t type, Bytes& out) {
  uint8_t byte = static_cast<uint8_t>((type << 4) | (size & 0x0F));
  size >>= 4;
  while (size != 0) {
    out.push_back(static_cast<char>(byte | 0x80));
    byte = static_cast<uint8_t>(size & 0x7F);
    size >>= 7;
  }
  out.push_back(static_cast<char>(byte));
}

struct ParsedHeader {
  uint8_t type = 0;
  uint64_t size = 0;
};

ParsedHeader read_pack_header(ByteSpan data, std::size_t& pos) {
  if (pos >= data.size()) fail("truncated entry header");
  uint8_t byte = data[pos++];
  ParsedHeader header;
  header.type = static_cast<uint8_t>((byte >> 4) & 0x07);
  header.size = byte & 0x0F;
  unsigned shift = 4;
  while ((byte & 0x80) != 0) {
    if (pos >= data.size()) fail("truncated entry size");
    byte = data[pos++];
    header.size |= static_cast<uint64_t>(byte & 0x7F) << shift;
    shift += 7;
    if (shift > 63) fail("entry size too large");
  }
  return header;
}

uint64_t read_ofs_delta_offset(ByteSpan data, std::size_t& pos) {
  if (pos >= data.size()) fail("truncated delta offset");
  uint8_t byte = data[pos++];
  uint64_t value = byte & 0x7F;
  while ((byte & 0x80) != 0) {
    if (pos >= data.size()) fail("truncated delta offset");
    byte = data[pos++];
    value = ((value + 1) << 7) | (byte & 0x7F);
  }
  return value;
}

uint64_t read_delta_varint(ByteSpan data, std::size_t& pos) {
  uint64_t value = 0;
  unsigned shift = 0;
  for (;;) {
    if (pos >= data.size()) fail("truncated delta header");
    const uint8_t byte = data[pos++];
    value |= static_cast<uint64_t>(byte & 0x7F) << shift;
    shift += 7;
    if ((byte & 0x80) == 0) break;
    if (shift > 63) fail("delta size too large");
  }
  return value;
}

}  // namespace

const char* pack_type_name(uint8_t type) {
  switch (type) {
    case 1: return "commit";
    case 2: return "tree";
    case 3: return "blob";
    case 4: return "tag";
    default: fail("unknown pack object type " + std::to_string(type));
  }
}

uint8_t pack_type_from_name(std::string_view name) {
  if (name == "commit") return 1;
  if (name == "tree") return 2;
  if (name == "blob") return 3;
  if (name == "tag") return 4;
  fail("unknown object type '" + std::string(name) + "'");
}

Bytes apply_git_delta(ByteSpan base, ByteSpan delta) {
  std::size_t pos = 0;
  const uint64_t base_size = read_delta_varint(delta, pos);
  const uint64_t result_size = read_delta_varint(delta, pos);
  if (base_size != base.size()) fail("delta base size mismatch");
  Bytes out;
  out.reserve(static_cast<std::size_t>(result_size));
  while (pos < delta.size()) {
    const uint8_t op = delta[pos++];
    if ((op & 0x80) != 0) {
      uint32_t offset = 0;
      uint32_t size = 0;
      if ((op & 0x01) != 0) offset |= static_cast<uint32_t>(delta[pos++]);
      if ((op & 0x02) != 0) offset |= static_cast<uint32_t>(delta[pos++]) << 8;
      if ((op & 0x04) != 0) offset |= static_cast<uint32_t>(delta[pos++]) << 16;
      if ((op & 0x08) != 0) offset |= static_cast<uint32_t>(delta[pos++]) << 24;
      if ((op & 0x10) != 0) size |= static_cast<uint32_t>(delta[pos++]);
      if ((op & 0x20) != 0) size |= static_cast<uint32_t>(delta[pos++]) << 8;
      if ((op & 0x40) != 0) size |= static_cast<uint32_t>(delta[pos++]) << 16;
      if (size == 0) size = 0x10000;
      if (static_cast<uint64_t>(offset) + size > base.size()) fail("delta copy out of range");
      out.append(reinterpret_cast<const char*>(base.data() + offset), size);
    } else if (op != 0) {
      const std::size_t length = op;
      if (pos + length > delta.size()) fail("delta insert out of range");
      out.append(reinterpret_cast<const char*>(delta.data() + pos), length);
      pos += length;
    } else {
      fail("delta opcode 0");
    }
  }
  if (out.size() != result_size) fail("delta result size mismatch");
  return out;
}

std::string write_pack(const std::filesystem::path& prefix,
                       const std::vector<PackObject>& objects) {
  if (objects.size() > 0xFFFFFFFFu) fail("too many objects");
  Bytes pack;
  pack.reserve(1 << 16);
  pack.append("PACK", 4);
  append_be32(pack, 2);
  append_be32(pack, static_cast<uint32_t>(objects.size()));

  struct Entry {
    std::array<uint8_t, 20> id{};
    uint32_t crc = 0;
    uint64_t offset = 0;
  };
  std::vector<Entry> entries;
  entries.reserve(objects.size());

  for (const PackObject& object : objects) {
    Entry entry;
    entry.id = object.id;
    entry.offset = pack.size();
    const std::size_t start = pack.size();
    if (object.type < 1 || object.type > 4) fail("invalid object type");
    append_pack_header(object.payload.size(), static_cast<uint8_t>(object.type), pack);
    const Bytes compressed = zlib_compress_stored(ByteSpan(
        reinterpret_cast<const uint8_t*>(object.payload.data()), object.payload.size()));
    pack.append(compressed);
    entry.crc = crc32_zlib(ByteSpan(reinterpret_cast<const uint8_t*>(pack.data() + start),
                                     pack.size() - start));
    entries.push_back(entry);
  }
  const ByteSpan pack_span(reinterpret_cast<const uint8_t*>(pack.data()), pack.size());
  const std::array<uint8_t, 20> checksum = sha1(pack_span);
  pack.append(reinterpret_cast<const char*>(checksum.data()), checksum.size());

  std::vector<Entry> sorted = entries;
  std::sort(sorted.begin(), sorted.end(), [](const Entry& a, const Entry& b) {
    return a.id < b.id;
  });

  Bytes idx;
  idx.reserve(1024 + sorted.size() * 28);
  append_be32(idx, static_cast<uint32_t>(kPackIdxMagic));
  append_be32(idx, 2);
  std::array<uint32_t, 256> fanout{};
  for (const Entry& entry : sorted) ++fanout[entry.id[0]];
  uint32_t cumulative = 0;
  for (const uint32_t count : fanout) {
    cumulative += count;
    append_be32(idx, cumulative);
  }
  for (const Entry& entry : sorted) {
    idx.append(reinterpret_cast<const char*>(entry.id.data()), entry.id.size());
  }
  for (const Entry& entry : sorted) append_be32(idx, entry.crc);
  for (const Entry& entry : sorted) {
    if (entry.offset > 0x7FFFFFFFULL) fail("pack larger than 2 GiB is unsupported");
    append_be32(idx, static_cast<uint32_t>(entry.offset));
  }
  idx.append(reinterpret_cast<const char*>(checksum.data()), checksum.size());
  const ByteSpan idx_span(reinterpret_cast<const uint8_t*>(idx.data()), idx.size());
  const std::array<uint8_t, 20> idx_checksum = sha1(idx_span);
  idx.append(reinterpret_cast<const char*>(idx_checksum.data()), idx_checksum.size());

  write_file(prefix.string() + ".pack", bytes_span(pack));
  write_file(prefix.string() + ".idx", bytes_span(idx));
  return sha1_hex(checksum);
}

PackIndex read_pack_index(const std::filesystem::path& idx_path) {
  const Bytes raw = read_file(idx_path.string());
  const ByteSpan data(reinterpret_cast<const uint8_t*>(raw.data()), raw.size());
  std::size_t pos = 0;
  if (read_be32(data, pos) != static_cast<uint32_t>(kPackIdxMagic)) fail("bad idx magic");
  if (read_be32(data, pos) != 2) fail("unsupported idx version");
  std::array<uint32_t, 256> fanout{};
  for (uint32_t& value : fanout) value = read_be32(data, pos);
  const uint32_t count = fanout[255];
  PackIndex index;
  index.ids.resize(count);
  index.crcs.resize(count);
  index.offsets.assign(count, 0);
  for (auto& id : index.ids) {
    if (pos + 20 > data.size()) fail("truncated idx ids");
    std::copy(data.begin() + static_cast<std::ptrdiff_t>(pos),
              data.begin() + static_cast<std::ptrdiff_t>(pos + 20), id.begin());
    pos += 20;
  }
  for (uint32_t& crc : index.crcs) crc = read_be32(data, pos);
  std::vector<uint32_t> raw_offsets(count);
  for (uint32_t& offset : raw_offsets) offset = read_be32(data, pos);
  // idx v2 stores 8-byte large offsets (in entry order) for the entries whose
  // 4-byte offset has the high bit set.
  const std::size_t large_start = pos;
  std::size_t large_cursor = large_start;
  for (uint32_t i = 0; i < count; ++i) {
    if ((raw_offsets[i] & 0x80000000u) == 0) {
      index.offsets[i] = raw_offsets[i];
    } else {
      index.offsets[i] = read_be64(data, large_cursor);
    }
  }
  pos = large_cursor;
  if (pos + 20 > data.size()) fail("truncated pack checksum");
  std::copy(data.begin() + static_cast<std::ptrdiff_t>(pos),
            data.begin() + static_cast<std::ptrdiff_t>(pos + 20),
            index.pack_checksum.begin());
  return index;
}

PackFile read_pack(const std::filesystem::path& pack_path,
                   const std::filesystem::path& idx_path) {
  const Bytes raw = read_file(pack_path.string());
  const ByteSpan data(reinterpret_cast<const uint8_t*>(raw.data()), raw.size());
  if (data.size() < 12 + 20) fail("pack too small");
  if (std::memcmp(data.data(), "PACK", 4) != 0) fail("bad pack signature");
  std::size_t pos = 4;
  const uint32_t version = read_be32(data, pos);
  if (version != 2) fail("unsupported pack version " + std::to_string(version));
  const uint32_t count = read_be32(data, pos);

  PackFile file;
  struct Pending {
    uint64_t offset = 0;
    uint8_t type = 0;
    uint8_t base_type = 0;
    uint64_t base_offset = 0;
    std::array<uint8_t, 20> base_id{};
    Bytes payload;   // delta instructions until resolved
    bool resolved = false;
  };
  std::vector<Pending> pending;
  pending.reserve(count);
  std::unordered_map<uint64_t, std::size_t> by_offset;
  std::unordered_map<std::string, std::size_t> by_id;

  for (uint32_t i = 0; i < count; ++i) {
    const uint64_t entry_offset = pos;
    const ParsedHeader header = read_pack_header(data, pos);
    Pending item;
    item.offset = entry_offset;
    item.type = header.type;
    if (header.type >= 1 && header.type <= 4) {
      std::size_t consumed = 0;
      item.payload = zlib_decompress(data.subspan(pos), header.size, &consumed);
      pos += consumed;
      item.resolved = true;
      item.base_type = header.type;
    } else if (header.type == 6) {
      const uint64_t delta_offset = read_ofs_delta_offset(data, pos);
      if (delta_offset == 0 || delta_offset > entry_offset) fail("bad OFS_DELTA base");
      item.base_offset = entry_offset - delta_offset;
      std::size_t consumed = 0;
      item.payload = zlib_decompress(data.subspan(pos), header.size, &consumed);
      pos += consumed;
    } else if (header.type == 7) {
      if (pos + 20 > data.size()) fail("truncated REF_DELTA base id");
      std::copy(data.begin() + static_cast<std::ptrdiff_t>(pos),
                data.begin() + static_cast<std::ptrdiff_t>(pos + 20), item.base_id.begin());
      pos += 20;
      std::size_t consumed = 0;
      item.payload = zlib_decompress(data.subspan(pos), header.size, &consumed);
      pos += consumed;
    } else {
      fail("unsupported pack entry type " + std::to_string(header.type));
    }
    by_offset[entry_offset] = pending.size();
    pending.push_back(std::move(item));
  }

  if (pos + 20 > data.size()) fail("missing pack trailer");
  file.checksum = sha1(data.first(pos));
  if (std::memcmp(file.checksum.data(), data.data() + pos, 20) != 0) fail("pack checksum mismatch");

  // Resolve entries. OFS_DELTA bases must appear earlier in the pack; REF_DELTA
  // bases may appear anywhere, so iterate until no progress is possible.
  bool progressed = true;
  while (progressed) {
    progressed = false;
    for (Pending& item : pending) {
      if (item.resolved) continue;
      const Pending* base = nullptr;
      if (item.type == 6) {
        const auto found = by_offset.find(item.base_offset);
        if (found == by_offset.end()) fail("missing OFS_DELTA base");
        const Pending& candidate = pending[found->second];
        if (candidate.resolved) base = &candidate;
      } else if (item.type == 7) {
        const auto found = by_id.find(std::string(
            reinterpret_cast<const char*>(item.base_id.data()), item.base_id.size()));
        if (found != by_id.end()) base = &pending[found->second];
      }
      if (base == nullptr) continue;
      const Bytes resolved = apply_git_delta(
          ByteSpan(reinterpret_cast<const uint8_t*>(base->payload.data()), base->payload.size()),
          ByteSpan(reinterpret_cast<const uint8_t*>(item.payload.data()), item.payload.size()));
      item.base_type = base->base_type;
      item.payload = resolved;
      item.resolved = true;
      progressed = true;
      const std::array<uint8_t, 20> id = git_object_id(
          pack_type_name(item.base_type),
          ByteSpan(reinterpret_cast<const uint8_t*>(item.payload.data()), item.payload.size()));
      by_id.emplace(std::string(reinterpret_cast<const char*>(id.data()), id.size()),
                    static_cast<std::size_t>(&item - pending.data()));
    }
  }

  for (std::size_t i = 0; i < pending.size(); ++i) {
    Pending& item = pending[i];
    if (!item.resolved) fail("unresolvable delta entry");
    const std::array<uint8_t, 20> id = git_object_id(
        pack_type_name(item.base_type),
        ByteSpan(reinterpret_cast<const uint8_t*>(item.payload.data()), item.payload.size()));
    PackObject object;
    object.type = item.base_type;
    object.id = id;
    object.payload = std::move(item.payload);
    file.objects.push_back(std::move(object));
    PackEntryInfo info;
    info.offset = item.offset;
    info.type = item.base_type;
    info.size = file.objects.back().payload.size();
    info.id = id;
    file.entries.push_back(info);
  }

  if (!idx_path.empty()) {
    const PackIndex index = read_pack_index(idx_path);
    if (index.ids.size() != file.objects.size()) fail("idx object count mismatch");
    std::vector<std::array<uint8_t, 20>> expected = index.ids;
    std::vector<std::array<uint8_t, 20>> actual;
    actual.reserve(file.objects.size());
    for (const PackObject& object : file.objects) actual.push_back(object.id);
    std::sort(expected.begin(), expected.end());
    std::sort(actual.begin(), actual.end());
    if (expected != actual) fail("idx does not match pack contents");
  }
  return file;
}

}  // namespace iaqs::git
