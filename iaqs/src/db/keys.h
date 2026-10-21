// Password-based key hierarchy: password -> KEK -> DEK -> purpose subkeys.
#pragma once

#include <array>
#include <cstdint>
#include <string_view>

#include "core/util.h"
#include "db/manifest.h"

namespace iaqs::db {

using Key32 = std::array<uint8_t, 32>;

struct DbKeys {
  Key32 dek{};
  Key32 page_key{};
  Key32 wal_key{};
  Key32 meta_key{};
  void wipe();
};

// Holds the KEK/DEK only while the database is open. Copying is disabled so
// secrets are not duplicated accidentally.
class Keyring {
 public:
  Keyring() = default;
  ~Keyring();
  Keyring(const Keyring&) = delete;
  Keyring& operator=(const Keyring&) = delete;

  // Creates a fresh random DEK for `manifest` (db_uuid/salt/nonces already
  // filled by Manifest::create_public) and wraps it with the password-derived
  // KEK. The verifier tag is stored in `manifest` too. Returns the derived
  // purpose subkeys so the caller can drive the pager/WAL right away.
  static DbKeys initialize(Manifest& manifest, std::string_view password);

  // Re-wraps an existing DEK under a fresh salt/nonces derived from
  // `new_password`. The database contents stay readable (same DEK); only the
  // password gate changes.
  static void rewrap(Manifest& manifest, const Key32& dek,
                    std::string_view new_password);

  // Derives all purpose subkeys from a DEK without any password material.
  static DbKeys keys_for_dek(const Key32& dek);

  // Creates a fresh DEK for a new database and adopts it (the KEK derived from
  // `password` is kept in memory so a later rekey --data can wrap new DEKs
  // without asking for the password again).
  DbKeys create_and_adopt(Manifest& manifest, std::string_view password);

  // Wraps `dek` directly under the in-memory KEK (must be unlocked). This is
  // used for the crash-recovery sidecar during rekey --data.
  void wrap_under_kek(const Key32& dek, std::array<uint8_t, 12>& nonce,
                      std::array<uint8_t, 32>& ciphertext,
                      std::array<uint8_t, 16>& tag) const;
  bool unwrap_under_kek(const std::array<uint8_t, 12>& nonce,
                        const std::array<uint8_t, 32>& ciphertext,
                        const std::array<uint8_t, 16>& tag,
                        Key32& dek) const;

  // Re-wraps `dek` into the manifest with the current KEK (salt unchanged),
  // refreshing the wrapped-DEK nonce and the verifier. Used on the final step
  // of rekey --data.
  void install_dek(Manifest& manifest, const Key32& dek);

  // Adopts a DEK as the current unlock state (subkeys re-derived).
  void adopt(const Key32& dek);

  // Derives the KEK from the password, unwraps the DEK and checks the
  // verifier. Returns false for a wrong password or a corrupt manifest.
  bool unlock(const Manifest& manifest, std::string_view password);

  bool unlocked() const { return unlocked_; }
  const DbKeys& keys() const { return keys_; }

  void wipe();

 private:
  Key32 kek_{};
  DbKeys keys_{};
  bool unlocked_ = false;
};

// Derives a purpose-bound subkey: HMAC-SHA256(dek, label).
Key32 derive_subkey(const Key32& dek, std::string_view label);

}  // namespace iaqs::db
