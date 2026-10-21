#include <cstdio>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "core/util.h"
#include "db/wal.h"
#include "harness.h"

using namespace iaqs;
using namespace iaqs::db;

namespace {

class TempDir {
 public:
  explicit TempDir(const std::string& name)
      : path_((std::filesystem::temp_directory_path() /
               ("iaqs_test_wal_" + name))
                  .string()) {
    std::error_code ignored;
    std::filesystem::remove_all(path_, ignored);
    std::filesystem::create_directories(path_);
  }
  ~TempDir() {
    std::error_code ignored;
    std::filesystem::remove_all(path_, ignored);
  }
  TempDir(const TempDir&) = delete;
  TempDir& operator=(const TempDir&) = delete;
  const std::string& str() const { return path_; }

 private:
  std::string path_;
};

std::string segment_path(const std::string& dir, uint32_t seg) {
  char name[32];
  std::snprintf(name, sizeof name, "wal-%06u.log", seg);
  return (std::filesystem::path(dir) / name).string();
}

Bytes payload_of(size_t size, char base) {
  Bytes out(size, '\0');
  for (size_t i = 0; i < size; ++i) out[i] = static_cast<char>(base + (i % 23));
  return out;
}

void flip_byte(const std::string& path, uint64_t offset) {
  Bytes data = read_file(path);
  CHECK(offset < data.size());
  data[offset] = static_cast<char>(data[offset] ^ 0x01);
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  out.write(data.data(), static_cast<std::streamsize>(data.size()));
}

void truncate_by(const std::string& path, uint64_t bytes) {
  const Bytes data = read_file(path);
  CHECK(bytes <= data.size());
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  out.write(data.data(), static_cast<std::streamsize>(data.size() - bytes));
}

}  // namespace

IAQS_TEST(wal, write_read_roundtrip) {
  TempDir dir("roundtrip");
  {
    WalWriter writer(dir.str(), 0, 100);
    CHECK_EQ(writer.append(WalRecordType::Begin, bytes_span(Bytes("payload"))), 100ull);
    CHECK_EQ(writer.append(WalRecordType::Commit, bytes_span(Bytes())), 101ull);
    writer.sync();
  }
  const auto records = WalReader::read_all(dir.str());
  CHECK_EQ(records.size(), 2u);
  CHECK_EQ(records[0].lsn, 100ull);
  CHECK(records[0].type == WalRecordType::Begin);
  CHECK(records[0].payload == "payload");
  CHECK_EQ(records[1].lsn, 101ull);
  CHECK(records[1].type == WalRecordType::Commit);
  CHECK(records[1].payload.empty());
}

IAQS_TEST(wal, empty_and_large_payload) {
  TempDir dir("payloads");
  const Bytes large = payload_of(4096, 'l');
  {
    WalWriter writer(dir.str(), 0, 0);
    writer.append(WalRecordType::Page, bytes_span(Bytes()));
    writer.append(WalRecordType::Page, bytes_span(large));
    writer.sync();
  }
  const auto records = WalReader::read_all(dir.str());
  CHECK_EQ(records.size(), 2u);
  CHECK(records[0].payload.empty());
  CHECK(records[1].payload == large);
}

IAQS_TEST(wal, lsn_is_monotonic) {
  TempDir dir("lsn");
  WalWriter writer(dir.str(), 0, 7);
  CHECK_EQ(writer.next_lsn(), 7ull);
  CHECK_EQ(writer.append(WalRecordType::Begin, bytes_span(Bytes())), 7ull);
  CHECK_EQ(writer.append(WalRecordType::Page, bytes_span(Bytes("p"))), 8ull);
  CHECK_EQ(writer.next_lsn(), 9ull);
}

IAQS_TEST(wal, tampering_rejected) {
  TempDir dir("tamper");
  {
    WalWriter writer(dir.str(), 0, 0);
    writer.append(WalRecordType::Begin, bytes_span(payload_of(64, 'a')));
    writer.append(WalRecordType::Commit, bytes_span(Bytes()));
    writer.sync();
  }
  const std::string path = segment_path(dir.str(), 0);

  // Flip a payload byte of the first record: the CRC no longer covers it.
  flip_byte(path, 8 + 9 + 3);
  CHECK_THROW(WalReader::read_all(dir.str()), std::runtime_error);

  // Flip a stored CRC byte: same verdict.
  flip_byte(path, 8 + 9 + 3);
  flip_byte(path, 4 + 1);
  CHECK_THROW(WalReader::read_all(dir.str()), std::runtime_error);
}

IAQS_TEST(wal, truncated_tail_is_ignored) {
  TempDir dir("truncated");
  {
    WalWriter writer(dir.str(), 0, 0);
    writer.append(WalRecordType::Begin, bytes_span(payload_of(300, 'a')));
    writer.append(WalRecordType::Commit, bytes_span(payload_of(300, 'b')));
    writer.sync();
  }
  truncate_by(segment_path(dir.str(), 0), 7);
  const auto records = WalReader::read_all(dir.str());
  CHECK_EQ(records.size(), 1u);
  CHECK(records[0].type == WalRecordType::Begin);
}

IAQS_TEST(wal, tolerate_tail_keeps_the_committed_prefix) {
  TempDir dir("tolerate");
  {
    WalWriter writer(dir.str(), 0, 0);
    writer.append(WalRecordType::Begin, bytes_span(payload_of(64, 'a')));
    writer.append(WalRecordType::Commit, bytes_span(payload_of(64, 'b')));
    writer.sync();
  }
  // Corrupt the payload of the last (newest) record.
  const std::string path = segment_path(dir.str(), 0);
  const uint64_t last_record_start =
      8 + 9 + 64 + 8 + 9;  // prefix+meta+payload of the first record
  flip_byte(path, last_record_start + 8 + 9 + 5);

  CHECK_THROW(WalReader::read_all(dir.str()), std::runtime_error);
  const auto tolerated = WalReader::read_all(dir.str(), /*tolerate_tail=*/true);
  CHECK_EQ(tolerated.size(), 1u);
}

IAQS_TEST(wal, empty_directory_returns_no_records) {
  TempDir dir("empty");
  CHECK(WalReader::read_all(dir.str()).empty());
}

IAQS_TEST(wal, multiple_segments_merged_in_order) {
  TempDir dir("segments");
  {
    WalWriter first(dir.str(), 0, 0);
    first.append(WalRecordType::Begin, bytes_span(Bytes("one")));
    first.append(WalRecordType::Commit, bytes_span(Bytes()));
    first.sync();
  }
  {
    WalWriter second(dir.str(), 1, 10);
    second.append(WalRecordType::Begin, bytes_span(Bytes("two")));
    second.sync();
  }
  const auto records = WalReader::read_all(dir.str());
  CHECK_EQ(records.size(), 3u);
  CHECK_EQ(records[0].lsn, 0ull);
  CHECK_EQ(records[1].lsn, 1ull);
  CHECK_EQ(records[2].lsn, 10ull);
  CHECK(records[2].payload == "two");
}
