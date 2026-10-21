#include "crypto/chacha20poly1305.h"

#include <stdexcept>
#include <string>

#include "core/util.h"
#include "crypto/rand.h"
#include "harness.h"

using namespace iaqs;

namespace {

Bytes hex_bytes(const char* hex) {
  Bytes out;
  if (!from_hex(hex, out)) throw std::runtime_error("bad test hex");
  return out;
}

std::string hex(ByteSpan bytes) { return to_hex(bytes); }

const uint8_t* u8(const Bytes& b) {
  return reinterpret_cast<const uint8_t*>(b.data());
}

// RFC 7539/8439 section 2.3.2 block function test vector.
IAQS_TEST(chacha20, block_rfc_vector) {
  const Bytes key = hex_bytes(
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  const Bytes nonce = hex_bytes("000000090000004a00000000");
  uint8_t out[64];
  chacha20_block(u8(key), u8(nonce), 1, out);
  CHECK_EQ(hex(ByteSpan(out, sizeof out)),
           "10f1e7e4d13b5915500fdd1fa32071c4"
           "c7d1f4c733c068030422aa9ac3d46c4e"
           "d2826446079faa0914c2d705d98b02a2"
           "b5129cd1de164eb9cbd083e8a2503c4e");
}

// RFC 8439 section 2.8.2 AEAD test vector.
IAQS_TEST(chacha20, aead_rfc8439_vector) {
  const Bytes key = hex_bytes(
      "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
  const Bytes nonce = hex_bytes("070000004041424344454647");
  const Bytes aad = hex_bytes("50515253c0c1c2c3c4c5c6c7");
  const std::string plaintext =
      "Ladies and Gentlemen of the class of '99: If I could offer you only one "
      "tip for the future, sunscreen would be it.";
  const Bytes expected = hex_bytes(
      "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6"
      "3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b"
      "3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7"
      "bc3ff4def08e4b7a9de576d26586cec64b6116"
      "1ae10b594f09e26a7e902ecbd0600691");

  const Bytes sealed = aead_seal(u8(key), u8(nonce), bytes_span(plaintext),
                                 bytes_span(aad));
  CHECK_EQ(hex(bytes_span(sealed)), hex(bytes_span(expected)));

  Bytes opened;
  CHECK(aead_open(u8(key), u8(nonce), bytes_span(sealed), bytes_span(aad), opened));
  CHECK_EQ(opened, plaintext);
}

IAQS_TEST(chacha20, rejects_tampering) {
  Bytes key = hex_bytes(
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  Bytes nonce = hex_bytes("000000000000000000000000");
  Bytes aad = hex_bytes("aabbcc");
  const std::string plaintext = "tamper me";
  const Bytes sealed = aead_seal(u8(key), u8(nonce), bytes_span(plaintext),
                                 bytes_span(aad));

  Bytes opened;
  for (size_t i = 0; i < sealed.size(); ++i) {
    Bytes mutated = sealed;
    mutated[i] = static_cast<char>(mutated[i] ^ 0x01);
    CHECK(!aead_open(u8(key), u8(nonce), bytes_span(mutated), bytes_span(aad), opened));
  }
  // Wrong AAD must fail too.
  Bytes bad_aad = aad;
  bad_aad[0] = static_cast<char>(bad_aad[0] ^ 0xff);
  CHECK(!aead_open(u8(key), u8(nonce), bytes_span(sealed), bytes_span(bad_aad), opened));
  // Wrong nonce must fail.
  nonce[0] = 1;
  CHECK(!aead_open(u8(key), u8(nonce), bytes_span(sealed), bytes_span(aad), opened));
}

IAQS_TEST(chacha20, short_sealed_rejected) {
  Bytes key(32, 0);
  Bytes nonce(12, 0);
  Bytes opened;
  Bytes short_input(15, 0);
  CHECK(!aead_open(u8(key), u8(nonce), bytes_span(short_input), ByteSpan(), opened));
}

IAQS_TEST(chacha20, roundtrip_various_sizes) {
  for (size_t size = 0; size <= 300; size += 7) {
    const Bytes key = random_bytes(32);
    const Bytes nonce = random_bytes(12);
    Bytes plaintext;
    for (size_t i = 0; i < size; ++i) plaintext.push_back(static_cast<char>(i * 17));
    Bytes aad;
    for (size_t i = 0; i < size / 2; ++i) aad.push_back(static_cast<char>(i));
    const Bytes sealed = aead_seal(u8(key), u8(nonce), bytes_span(plaintext),
                                   bytes_span(aad));
    CHECK_EQ(sealed.size(), plaintext.size() + kAeadTagSize);
    Bytes opened;
    CHECK(aead_open(u8(key), u8(nonce), bytes_span(sealed), bytes_span(aad), opened));
    CHECK_EQ(opened, plaintext);
  }
}

}  // namespace
