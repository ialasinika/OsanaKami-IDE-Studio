#include <cstdio>
#include <cstring>
#include <filesystem>
#include <random>
#include <string>

#include "core/util.h"
#include "crypto/crc32c.h"
#include "crypto/rand.h"
#include "db/envelope.h"
#include "db/keys.h"
#include "db/manifest.h"
#include "db/segment.h"
#include "harness.h"
#include "vcs/repo.h"

using namespace iaqs;

namespace {

namespace fs = std::filesystem;

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    char suffix[32];
    std::snprintf(suffix, sizeof(suffix), "iaqs-rekey-%08x", rd());
    path = fs::temp_directory_path() / suffix;
    fs::create_directories(path);
  }
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
};

void write_text(const fs::path& file, std::string_view text) {
  write_file(file.string(), bytes_span(text));
}

std::string repo_file(vcs::Repo& repo, const std::string& path) {
  const std::string commit = repo.peel(repo.resolve("HEAD"));
  const std::string tree = repo.read_commit(commit).tree;
  for (const auto& entry : repo.flatten_tree(tree)) {
    if (entry.path == path) return repo.objects().read(entry.oid);
  }
  return {};
}

// Concatenates every segment file so tests can prove the bytes changed.
Bytes segment_bytes(const fs::path& dir) {
  Bytes all;
  std::error_code ec;
  for (fs::directory_iterator it(dir, ec);
       !ec && it != fs::directory_iterator(); it.increment(ec)) {
    const std::string name = it->path().filename().string();
    if (!starts_with(name, "seg-")) continue;
    const Bytes data = read_file(it->path().string());
    all.append(data);
  }
  return all;
}

// Test-side copy of the REKEY.PENDING layout (database.cpp keeps it private).
// [8B magic][12B nonce][32B ct][16B tag][u32 crc32c over the first 68 bytes]
Bytes encode_sidecar(const std::array<uint8_t, 12>& nonce,
                     const std::array<uint8_t, 32>& ciphertext,
                     const std::array<uint8_t, 16>& tag) {
  Bytes out(72, '\0');
  uint8_t* p = reinterpret_cast<uint8_t*>(out.data());
  const uint8_t magic[8] = {'I', 'A', 'Q', 'S', 'R', 'K', '1', '\0'};
  std::memcpy(p, magic, sizeof magic);
  std::memcpy(p + 8, nonce.data(), nonce.size());
  std::memcpy(p + 20, ciphertext.data(), ciphertext.size());
  std::memcpy(p + 52, tag.data(), tag.size());
  store_u32_le(p + 68, crc32c(p, 68));
  return out;
}

}  // namespace

IAQS_TEST(rekey, rotates_data_key_and_keeps_history) {
  TempDir tmp;
  {
    vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
    write_text(tmp.path / "a.txt", "hello rekey\n");
    repo.add_paths({"a.txt"}, false);
    repo.commit("first", false, false);
    const Bytes before = segment_bytes(tmp.path / ".iaqs");
    CHECK(!before.empty());

    repo.database().rekey_data();
    const Bytes after = segment_bytes(tmp.path / ".iaqs");
    CHECK_EQ(after.size(), before.size());
    CHECK(before != after);
    repo.database().close();
  }

  // Same password, same data, new DEK.
  {
    vcs::Repo repo = vcs::Repo::open(tmp.path, "pw");
    CHECK_EQ(repo_file(repo, "a.txt"), std::string("hello rekey\n"));
    CHECK_EQ(repo.read_commit(repo.peel(repo.resolve("HEAD"))).message,
             std::string("first\n"));
    repo.database().close();
  }

  // The old password never worked (rekey does not touch the password gate).
  CHECK_THROW(vcs::Repo::open(tmp.path, "wrong"), std::runtime_error);

  // A second rotation still round-trips.
  {
    vcs::Repo repo = vcs::Repo::open(tmp.path, "pw");
    repo.database().rekey_data();
    repo.database().close();
  }
  {
    vcs::Repo repo = vcs::Repo::open(tmp.path, "pw");
    CHECK_EQ(repo_file(repo, "a.txt"), std::string("hello rekey\n"));
    repo.database().close();
  }
}

IAQS_TEST(rekey, resumes_after_crash_before_manifest_promotion) {
  TempDir tmp;
  {
    vcs::Repo repo = vcs::Repo::init(tmp.path, "pw");
    write_text(tmp.path / "a.txt", "interrupted rekey\n");
    repo.add_paths({"a.txt"}, false);
    repo.commit("base", false, false);
    repo.database().close();
  }

  const fs::path db_dir = tmp.path / ".iaqs";
  const db::Manifest manifest = db::load_manifest((db_dir / "MANIFEST").string());
  db::Keyring keyring;
  CHECK(keyring.unlock(manifest, "pw"));

  const Bytes dek_bytes = random_bytes(32);
  db::Key32 next_dek{};
  std::memcpy(next_dek.data(), dek_bytes.data(), next_dek.size());
  const db::DbKeys next = db::Keyring::keys_for_dek(next_dek);

  // Simulate a crash right after the first page was re-encrypted: page 1 of
  // segment 0 is already under the new key, the rest (and MANIFEST) are old.
  {
    db::SegmentFile seg = db::SegmentFile::open(
        db_dir.string(), 0, manifest.page_size);
    const Bytes slot = seg.read_slot(1);
    db::EnvelopeInfo info;
    CHECK(db::read_envelope_info(bytes_span(slot), info));
    const db::PageRef ref{0, 1, info.generation};
    const Bytes plain =
        db::open_page(keyring.keys().page_key, 0, ref, bytes_span(slot));
    const Bytes resealed = db::seal_page(next.page_key, 0, ref,
                                         bytes_span(plain), manifest.page_size);
    seg.write_slot(1, bytes_span(resealed));
    seg.sync();
  }

  std::array<uint8_t, 12> nonce{};
  std::array<uint8_t, 32> ciphertext{};
  std::array<uint8_t, 16> tag{};
  keyring.wrap_under_kek(next_dek, nonce, ciphertext, tag);
  const Bytes sidecar = encode_sidecar(nonce, ciphertext, tag);
  write_file_atomic((db_dir / "REKEY.PENDING").string(), bytes_span(sidecar));

  // Opening the database must finish the interrupted migration.
  {
    vcs::Repo repo = vcs::Repo::open(tmp.path, "pw");
    CHECK_EQ(repo_file(repo, "a.txt"), std::string("interrupted rekey\n"));
    CHECK(!fs::exists(db_dir / "REKEY.PENDING"));
    repo.database().close();
  }
  {
    vcs::Repo repo = vcs::Repo::open(tmp.path, "pw");
    CHECK_EQ(repo_file(repo, "a.txt"), std::string("interrupted rekey\n"));
    repo.database().close();
  }
}
