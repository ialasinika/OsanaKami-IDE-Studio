// ChaCha20-Poly1305 AEAD (RFC 8439).
#pragma once

#include <cstddef>
#include <cstdint>

#include "core/util.h"

namespace iaqs {

inline constexpr size_t kChaCha20KeySize = 32;
inline constexpr size_t kChaCha20NonceSize = 12;
inline constexpr size_t kAeadTagSize = 16;

// Raw ChaCha20 keystream block with the given 32-bit block counter.
void chacha20_block(const uint8_t key[kChaCha20KeySize],
                    const uint8_t nonce[kChaCha20NonceSize], uint32_t counter,
                    uint8_t out[64]);

// XOR `input` with the ChaCha20 keystream starting at `counter`.
void chacha20_xor(const uint8_t key[kChaCha20KeySize],
                  const uint8_t nonce[kChaCha20NonceSize], uint32_t counter,
                  ByteSpan input, uint8_t* output);

// Encrypts `plaintext` and authenticates `aad`. Returns ciphertext || tag.
Bytes aead_seal(const uint8_t key[kChaCha20KeySize],
                const uint8_t nonce[kChaCha20NonceSize], ByteSpan plaintext,
                ByteSpan aad);

// Verifies and decrypts `sealed` (ciphertext || tag). On failure returns false
// and leaves `plaintext` untouched.
bool aead_open(const uint8_t key[kChaCha20KeySize],
               const uint8_t nonce[kChaCha20NonceSize], ByteSpan sealed,
               ByteSpan aad, Bytes& plaintext);

}  // namespace iaqs
