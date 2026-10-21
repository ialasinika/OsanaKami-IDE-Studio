#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "core/util.h"
#include "crypto/crc32c.h"
#include "db/keys.h"
#include "db/wal.h"
#include "harness.h"

using namespace iaqs;
using namespace iaqs::db;

namespace {

Key32 test_key() {
  Key32 key{};
  for (size_t i = 0; i < key.size(); ++i) {
    key[i] = static_cast<uint8_t>(i * 7 + 3);
  }
  return key;
}

Bytes make_bytes(size_t size, uint8_t seed = 0x5a) {
  Bytes out;
  out.resize(size);
  for (size_t i = 0; i < size; ++i) {
    out[i] = static_cast<char>((i * 31 + seed) & 0xff);
  }
  return out;
}

// Temporary directory unique to a test case; removed on destruction.
class TempDir {
 public:
  explicit TempDir(std::string_view name) {
    path_ = std::filesystem::temp_directory_path() /
            ("iaqs_test_wal_" + std::string(name));
    std::error_code ec;
    std::filesystem::remove_all(path_, ec);
  }
  ~TempDir() {
    std::error_code ec;
    std::filesystem::remove_all(path_, ec);
  }
  TempDir(const TempDir&) = delete;
  TempDir& operator=(const TempDir&) = delete;

  std::string str() const { return path_.string(); }

  std::filesystem::path segment_path(uint32_t wal_seg_id) const {
    char name[32];
    std::snprintf(name, sizeof name, "wal-%06u.log", wal_seg_id);
    return path_ / name;
  }

 private:
  std::filesystem::path path_;
};

}  // namespace

IAQS_TEST(wal, write_read_roundtrip) {
  TempDir dir("roundtrip");
  const Key32 key = test_key();
  const Bytes begin_payload = make_bytes(64, 1);
  const Bytes page_payload = make_bytes(1000, 2);
  const Bytes commit_payload = make_bytes(17, 3);
  {
    WalWriter writer(dir.str(), 0, key, /*epoch=*/3, /*first_lsn=*/100);
    CHECK_EQ(writer.append(WalRecordType::Begin, bytes_span(begin_payload)),
             static_cast<uint64_t>(100));
    CHECK_EQ(writer.append(WalRecordType::Page, bytes_span(page_payload)),
             static_cast<uint64_t>(101));
    CHECK_EQ(writer.append(WalRecordType::Commit, bytes_span(commit_payload)),
             static_cast<uint64_t>(102));
    CHECK_EQ(writer.next_lsn(), static_cast<uint64_t>(103));
    writer.sync();
  }
  CHECK(file_exists(dir.segment_path(0).string()));

  const std::vector<WalRecord> records = WalReader::read_all(dir.str(), key, 3);
  CHECK_EQ(records.size(), static_cast<size_t>(3));
  CHECK_EQ(records[0].lsn, static_cast<uint64_t>(100));
  CHECK(records[0].type == WalRecordType::Begin);
  CHECK(records[0].payload == begin_payload);
  CHECK_EQ(records[1].lsn, static_cast<uint64_t>(101));
  CHECK(records[1].type == WalRecordType::Page);
  CHECK(records[1].payload == page_payload);
  CHECK_EQ(records[2].lsn, static_cast<uint64_t>(102));
  CHECK(records[2].type == WalRecordType::Commit);
  CHECK(records[2].payload == commit_payload);
}

IAQS_TEST(wal, empty_and_large_payload) {
  TempDir dir("sizes");
  const Key32 key = test_key();
  const Bytes large = make_bytes(1024 * 1024, 0x11);
  {
    WalWriter writer(dir.str(), 0, key, 0, 0);
    CHECK_EQ(writer.append(WalRecordType::Page, ByteSpan{}),
             static_cast<uint64_t>(0));
    CHECK_EQ(writer.append(WalRecordType::Rollback, bytes_span(large)),
             static_cast<uint64_t>(1));
    writer.sync();
  }
  const std::vector<WalRecord> records = WalReader::read_all(dir.str(), key, 0);
  CHECK_EQ(records.size(), static_cast<size_t>(2));
  CHECK_EQ(records[0].type, WalRecordType::Page);
  CHECK_EQ(records[0].payload.size(), static_cast<size_t>(0));
  CHECK_EQ(records[1].type, WalRecordType::Rollback);
  CHECK_EQ(records[1].payload.size(), large.size());
  CHECK(records[1].payload == large);
}

IAQS_TEST(wal, lsn_is_monotonic) {
  TempDir dir("lsn");
  const Key32 key = test_key();
  const uint64_t first_lsn = 1ull << 40;
  std::vector<uint64_t> lsns;
  {
    WalWriter writer(dir.str(), 0, key, /*epoch=*/1, first_lsn);
    for (int i = 0; i < 5; ++i) {
      lsns.push_back(writer.append(
          WalRecordType::Page,
          bytes_span(make_bytes(8, static_cast<uint8_t>(i)))));
    }
    CHECK_EQ(writer.next_lsn(), first_lsn + 5);
    writer.sync();
  }
  for (size_t i = 0; i < lsns.size(); ++i) {
    CHECK_EQ(lsns[i], first_lsn + i);
  }
  const std::vector<WalRecord> records = WalReader::read_all(dir.str(), key, 1);
  CHECK_EQ(records.size(), lsns.size());
  for (size_t i = 0; i < records.size(); ++i) {
    CHECK_EQ(records[i].lsn, lsns[i]);
  }
}

IAQS_TEST(wal, tampering_rejected) {
  TempDir dir("tamper");
  const Key32 key = test_key();
  const Bytes payload = make_bytes(120, 9);
  {
    WalWriter writer(dir.str(), 0, key, /*epoch=*/2, /*first_lsn=*/7);
    writer.append(WalRecordType::Page, bytes_span(payload));
    writer.sync();
  }
  const std::string path = dir.segment_path(0).string();
  const Bytes original = read_file(path);
  CHECK(original.size() > 17);

  // Every one of these offsets is inside the CRC-covered region or the CRC
  // itself: crc(4), lsn(8,9), type(16), ciphertext(17), tag(last).
  const size_t offsets[] = {4, 8, 9, 16, 17, original.size() - 1};
  for (size_t off : offsets) {
    Bytes tampered = original;
    tampered[off] = static_cast<char>(tampered[off] ^ 0x01);
    write_file(path, bytes_span(tampered));
    CHECK_THROW(WalReader::read_all(dir.str(), key, 2), std::runtime_error);
  }
  write_file(path, bytes_span(original));
}

IAQS_TEST(wal, aead_rejects_ciphertext_with_recomputed_crc) {
  TempDir dir("aead");
  const Key32 key = test_key();
  const Bytes payload = make_bytes(256, 4);
  {
    WalWriter writer(dir.str(), 0, key, /*epoch=*/5, /*first_lsn=*/1);
    writer.append(WalRecordType::Page, bytes_span(payload));
    writer.sync();
  }
  const std::string path = dir.segment_path(0).string();
  Bytes bytes = read_file(path);
  const uint8_t* raw = reinterpret_cast<const uint8_t*>(bytes.data());
  const uint32_t total_len = load_u32_le(raw);

  // Flip a ciphertext byte, then repair the CRC so only AEAD authentication can
  // catch the tampering (CRC covers lsn || type || ciphertext).
  bytes[17] = static_cast<char>(bytes[17] ^ 0xff);
  const uint32_t crc = crc32c(ByteSpan(raw + 8, total_len));
  store_u32_le(reinterpret_cast<uint8_t*>(bytes.data()) + 4, crc);
  write_file(path, bytes_span(bytes));

  CHECK_THROW(WalReader::read_all(dir.str(), key, 5), std::runtime_error);
}

IAQS_TEST(wal, wrong_key_or_epoch_rejected) {
  TempDir dir("wrongkey");
  const Key32 key = test_key();
  {
    WalWriter writer(dir.str(), 0, key, /*epoch=*/6, /*first_lsn=*/0);
    writer.append(WalRecordType::Page, bytes_span(make_bytes(32, 7)));
    writer.sync();
  }
  Key32 wrong_key = key;
  wrong_key[0] = static_cast<uint8_t>(wrong_key[0] ^ 0xff);
  CHECK_THROW(WalReader::read_all(dir.str(), wrong_key, 6), std::runtime_error);
  CHECK_THROW(WalReader::read_all(dir.str(), key, 7), std::runtime_error);
}

IAQS_TEST(wal, truncated_tail_is_ignored) {
  TempDir dir("truncated");
  const Key32 key = test_key();
  {
    WalWriter writer(dir.str(), 0, key, 0, 0);
    for (int i = 0; i < 3; ++i) {
      writer.append(WalRecordType::Page,
                    bytes_span(make_bytes(100, static_cast<uint8_t>(i))));
    }
    writer.sync();
  }
  const std::filesystem::path path = dir.segment_path(0);
  // Each record: 8-byte header + 8 lsn + 1 type + (100 payload + 16 tag) = 133.
  const uint64_t full_size = std::filesystem::file_size(path);
  CHECK_EQ(full_size, static_cast<uint64_t>(3 * 133));

  // Cut 5 bytes out of the last record: it must be silently dropped.
  std::filesystem::resize_file(path, full_size - 5);
  CHECK_EQ(WalReader::read_all(dir.str(), key, 0).size(),
           static_cast<size_t>(2));

  // Cut the whole last record: exactly the first two remain.
  std::filesystem::resize_file(path, static_cast<uint64_t>(2 * 133));
  CHECK_EQ(WalReader::read_all(dir.str(), key, 0).size(),
           static_cast<size_t>(2));

  // Empty file: no records, no exception.
  std::filesystem::resize_file(path, 0);
  CHECK_EQ(WalReader::read_all(dir.str(), key, 0).size(),
           static_cast<size_t>(0));
}

IAQS_TEST(wal, empty_directory_returns_no_records) {
  TempDir empty_dir("empty");
  make_dirs(empty_dir.str());
  const Key32 key = test_key();
  CHECK(WalReader::read_all(empty_dir.str(), key, 0).empty());

  TempDir missing_dir("missing");
  CHECK(WalReader::read_all(missing_dir.str(), key, 0).empty());
}

IAQS_TEST(wal, multiple_segments_merged_in_order) {
  TempDir dir("segments");
  const Key32 key = test_key();
  const Bytes a = make_bytes(10, 1);
  const Bytes b = make_bytes(20, 2);
  const Bytes c = make_bytes(30, 3);
  const Bytes d = make_bytes(40, 4);
  {
    WalWriter writer(dir.str(), /*wal_seg_id=*/0, key, /*epoch=*/1,
                     /*first_lsn=*/10);
    writer.append(WalRecordType::Begin, bytes_span(a));
    writer.append(WalRecordType::Commit, bytes_span(b));
    writer.sync();
  }
  {
    WalWriter writer(dir.str(), /*wal_seg_id=*/1, key, /*epoch=*/1,
                     /*first_lsn=*/12);
    writer.append(WalRecordType::Begin, bytes_span(c));
    writer.append(WalRecordType::Commit, bytes_span(d));
    writer.sync();
  }
  CHECK(file_exists(dir.segment_path(0).string()));
  CHECK(file_exists(dir.segment_path(1).string()));

  const std::vector<WalRecord> records = WalReader::read_all(dir.str(), key, 1);
  CHECK_EQ(records.size(), static_cast<size_t>(4));
  CHECK_EQ(records[0].lsn, static_cast<uint64_t>(10));
  CHECK(records[0].payload == a);
  CHECK_EQ(records[1].lsn, static_cast<uint64_t>(11));
  CHECK(records[1].payload == b);
  CHECK_EQ(records[2].lsn, static_cast<uint64_t>(12));
  CHECK(records[2].payload == c);
  CHECK_EQ(records[3].lsn, static_cast<uint64_t>(13));
  CHECK(records[3].payload == d);
}
