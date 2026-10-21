#include "db/keys.h"

#include <cstring>
#include <stdexcept>

#include "crypto/chacha20poly1305.h"
#include "crypto/hmac.h"
#include "crypto/rand.h"

namespace iaqs::db {
namespace {

constexpr char kVerifierPlaintext[] = "iaqs-verify-v1";
constexpr char kVerifierAad[] = "iaqs-db-v1";

bool constant_time_equal(const uint8_t* a, const uint8_t* b, size_t size) {
  uint8_t diff = 0;
  for (size_t i = 0; i < size; ++i) diff |= static_cast<uint8_t>(a[i] ^ b[i]);
  return diff == 0;
}

Key32 derive_kek(std::string_view password, const Manifest& manifest) {
  const Bytes kek = pbkdf2_hmac_sha256(password, ByteSpan(manifest.kdf_salt.data(),
                                                          manifest.kdf_salt.size()),
                                       manifest.kdf_iters, 32);
  Key32 out{};
  std::memcpy(out.data(), kek.data(), out.size());
  return out;
}

// AEAD-seals the 32-byte DEK; returns ciphertext (32) and tag (16).
void wrap_dek(const Key32& kek, const Manifest& manifest, const Key32& dek,
              Manifest& out) {
  const Bytes sealed = aead_seal(
      kek.data(), manifest.wrapped_dek_nonce.data(), ByteSpan(dek.data(), dek.size()),
      ByteSpan());
  if (sealed.size() != dek.size() + kAeadTagSize) {
    throw std::runtime_error("wrap_dek: unexpected sealed size");
  }
  std::memcpy(out.wrapped_dek_ciphertext.data(), sealed.data(), dek.size());
  std::memcpy(out.wrapped_dek_tag.data(), sealed.data() + dek.size(),
              kAeadTagSize);
}

void compute_verifier(const Key32& dek, const Manifest& manifest,
                      Manifest& out) {
  const Bytes sealed = aead_seal(
      dek.data(), manifest.verifier_nonce.data(),
      bytes_span(std::string_view(kVerifierPlaintext)),
      bytes_span(std::string_view(kVerifierAad)));
  std::memcpy(out.verifier_tag.data(), sealed.data() + sealed.size() - kAeadTagSize,
              kAeadTagSize);
}

void derive_all(const Key32& dek, DbKeys& keys) {
  keys.dek = dek;
  keys.page_key = derive_subkey(dek, "iaqs-page-key-v1");
  keys.wal_key = derive_subkey(dek, "iaqs-wal-key-v1");
  keys.meta_key = derive_subkey(dek, "iaqs-meta-key-v1");
}

}  // namespace

void DbKeys::wipe() {
  secure_wipe(dek.data(), dek.size());
  secure_wipe(page_key.data(), page_key.size());
  secure_wipe(wal_key.data(), wal_key.size());
  secure_wipe(meta_key.data(), meta_key.size());
}

Key32 derive_subkey(const Key32& dek, std::string_view label) {
  const Sha256Digest digest = hmac_sha256(ByteSpan(dek.data(), dek.size()),
                                          bytes_span(label));
  Key32 out{};
  std::memcpy(out.data(), digest.data(), out.size());
  return out;
}

Keyring::~Keyring() { wipe(); }

DbKeys Keyring::initialize(Manifest& manifest, std::string_view password) {
  const Key32 kek = derive_kek(password, manifest);
  const Bytes dek_bytes = random_bytes(32);
  Key32 dek{};
  std::memcpy(dek.data(), dek_bytes.data(), dek.size());

  wrap_dek(kek, manifest, dek, manifest);
  compute_verifier(dek, manifest, manifest);

  // Return the purpose subkeys so the freshly created database can drive its
  // pager and WAL immediately (the caller wipes them via DbKeys::wipe()).
  DbKeys keys;
  derive_all(dek, keys);
  secure_wipe(dek.data(), dek.size());
  return keys;
}

void Keyring::rewrap(Manifest& manifest, const Key32& dek,
                     std::string_view new_password) {
  const Bytes salt = random_bytes(manifest.kdf_salt.size());
  std::memcpy(manifest.kdf_salt.data(), salt.data(), salt.size());
  const Bytes nonce = random_bytes(manifest.wrapped_dek_nonce.size());
  std::memcpy(manifest.wrapped_dek_nonce.data(), nonce.data(), nonce.size());

  Key32 kek = derive_kek(new_password, manifest);
  wrap_dek(kek, manifest, dek, manifest);
  secure_wipe(kek.data(), kek.size());

  const Bytes verifier_nonce = random_bytes(manifest.verifier_nonce.size());
  std::memcpy(manifest.verifier_nonce.data(), verifier_nonce.data(),
              verifier_nonce.size());
  compute_verifier(dek, manifest, manifest);
}

DbKeys Keyring::keys_for_dek(const Key32& dek) {
  DbKeys keys;
  derive_all(dek, keys);
  return keys;
}

DbKeys Keyring::create_and_adopt(Manifest& manifest, std::string_view password) {
  kek_ = derive_kek(password, manifest);
  const Bytes dek_bytes = random_bytes(32);
  Key32 dek{};
  std::memcpy(dek.data(), dek_bytes.data(), dek.size());

  wrap_dek(kek_, manifest, dek, manifest);
  compute_verifier(dek, manifest, manifest);
  derive_all(dek, keys_);
  secure_wipe(dek.data(), dek.size());
  unlocked_ = true;
  return keys_;
}

void Keyring::wrap_under_kek(const Key32& dek, std::array<uint8_t, 12>& nonce,
                             std::array<uint8_t, 32>& ciphertext,
                             std::array<uint8_t, 16>& tag) const {
  if (!unlocked_) throw std::runtime_error("keyring is locked");
  const Bytes nonce_bytes = random_bytes(nonce.size());
  std::memcpy(nonce.data(), nonce_bytes.data(), nonce.size());
  const Bytes sealed = aead_seal(
      kek_.data(), nonce.data(), ByteSpan(dek.data(), dek.size()),
      bytes_span(std::string_view("iaqs-rekey-v1")));
  if (sealed.size() != dek.size() + kAeadTagSize) {
    throw std::runtime_error("wrap_under_kek: unexpected sealed size");
  }
  std::memcpy(ciphertext.data(), sealed.data(), dek.size());
  std::memcpy(tag.data(), sealed.data() + dek.size(), kAeadTagSize);
}

bool Keyring::unwrap_under_kek(const std::array<uint8_t, 12>& nonce,
                               const std::array<uint8_t, 32>& ciphertext,
                               const std::array<uint8_t, 16>& tag,
                               Key32& dek) const {
  if (!unlocked_) return false;
  Bytes sealed;
  sealed.append(reinterpret_cast<const char*>(ciphertext.data()),
                ciphertext.size());
  sealed.append(reinterpret_cast<const char*>(tag.data()), tag.size());
  Bytes plain;
  if (!aead_open(kek_.data(), nonce.data(), bytes_span(sealed),
                 bytes_span(std::string_view("iaqs-rekey-v1")), plain) ||
      plain.size() != dek.size()) {
    return false;
  }
  std::memcpy(dek.data(), plain.data(), dek.size());
  secure_wipe(plain.data(), plain.size());
  return true;
}

void Keyring::install_dek(Manifest& manifest, const Key32& dek) {
  if (!unlocked_) throw std::runtime_error("keyring is locked");
  const Bytes nonce = random_bytes(manifest.wrapped_dek_nonce.size());
  std::memcpy(manifest.wrapped_dek_nonce.data(), nonce.data(), nonce.size());
  wrap_dek(kek_, manifest, dek, manifest);
  const Bytes verifier_nonce = random_bytes(manifest.verifier_nonce.size());
  std::memcpy(manifest.verifier_nonce.data(), verifier_nonce.data(),
              verifier_nonce.size());
  compute_verifier(dek, manifest, manifest);
}

void Keyring::adopt(const Key32& dek) {
  derive_all(dek, keys_);
  unlocked_ = true;
}

bool Keyring::unlock(const Manifest& manifest, std::string_view password) {
  wipe();
  kek_ = derive_kek(password, manifest);

  Bytes sealed;
  sealed.append(reinterpret_cast<const char*>(manifest.wrapped_dek_ciphertext.data()),
                manifest.wrapped_dek_ciphertext.size());
  sealed.append(reinterpret_cast<const char*>(manifest.wrapped_dek_tag.data()),
                manifest.wrapped_dek_tag.size());

  Bytes dek_bytes;
  if (!aead_open(kek_.data(), manifest.wrapped_dek_nonce.data(),
                 bytes_span(sealed), ByteSpan(), dek_bytes) ||
      dek_bytes.size() != 32) {
    wipe();
    return false;
  }
  Key32 dek{};
  std::memcpy(dek.data(), dek_bytes.data(), dek.size());

  const Bytes verifier = aead_seal(
      dek.data(), manifest.verifier_nonce.data(),
      bytes_span(std::string_view(kVerifierPlaintext)),
      bytes_span(std::string_view(kVerifierAad)));
  const bool ok = constant_time_equal(
      reinterpret_cast<const uint8_t*>(verifier.data()) + verifier.size() -
          kAeadTagSize,
      manifest.verifier_tag.data(), kAeadTagSize);
  secure_wipe(dek_bytes.data(), dek_bytes.size());
  if (!ok) {
    secure_wipe(dek.data(), dek.size());
    wipe();
    return false;
  }

  derive_all(dek, keys_);
  secure_wipe(dek.data(), dek.size());
  unlocked_ = true;
  return true;
}

void Keyring::wipe() {
  secure_wipe(kek_.data(), kek_.size());
  keys_.wipe();
  unlocked_ = false;
}

}  // namespace iaqs::db
