#include <stdexcept>
#include <string>

#include "core/util.h"
#include "db/envelope.h"
#include "db/page.h"
#include "harness.h"

using namespace iaqs;
using namespace iaqs::db;

namespace {

Bytes make_body(size_t size) {
  Bytes body;
  for (size_t i = 0; i < size; ++i) body.push_back(static_cast<char>((i * 29 + 11) & 0xff));
  return body;
}

}  // namespace

IAQS_TEST(page, encode_decode_roundtrip) {
  const Bytes body = make_body(1000);
  const Bytes plain = encode_page(PageType::Heap, 0x02, 7, bytes_span(body));
  PageHeader header;
  ByteSpan decoded_body;
  CHECK(decode_page(bytes_span(plain), header, decoded_body));
  CHECK_EQ(static_cast<int>(header.type), static_cast<int>(PageType::Heap));
  CHECK_EQ(header.flags, 0x02);
  CHECK_EQ(header.generation, 7u);
  CHECK_EQ(header.page_len, 1000u);
  CHECK(bytes_view(decoded_body) == bytes_view(bytes_span(body)));
}

IAQS_TEST(page, rejects_crc_corruption) {
  const Bytes body = make_body(64);
  const Bytes plain = encode_page(PageType::System, 0, 1, bytes_span(body));

  Bytes bad_header = plain;
  bad_header[0] = static_cast<char>(PageType::Free);
  PageHeader header;
  ByteSpan decoded_body;
  CHECK(!decode_page(bytes_span(bad_header), header, decoded_body));

  Bytes bad_body = plain;
  bad_body[kPageHeaderSize + 3] = static_cast<char>(bad_body[kPageHeaderSize + 3] ^ 0xff);
  CHECK(!decode_page(bytes_span(bad_body), header, decoded_body));

  Bytes truncated = plain.substr(0, kPageHeaderSize - 1);
  CHECK(!decode_page(bytes_span(truncated), header, decoded_body));
}

IAQS_TEST(envelope, seal_open_roundtrip) {
  const PageRef ref{2, 100, 5};
  const Bytes body = make_body(8000);
  const Bytes plain = encode_page(PageType::BTreeLeaf, 0, ref.generation,
                                  bytes_span(body));
  const uint32_t page_size = 8192;
  const Bytes slot = seal_page(ref, bytes_span(plain), page_size);
  CHECK_EQ(slot.size(), page_size);

  EnvelopeInfo info;
  CHECK(read_envelope_info(bytes_span(slot), info));
  CHECK_EQ(info.version, kEnvelopeVersion);
  CHECK_EQ(info.generation, ref.generation);

  const Bytes opened = open_page(ref, bytes_span(slot));
  CHECK(opened == plain);
}

IAQS_TEST(envelope, full_capacity_roundtrip) {
  const PageRef ref{0, 1, 1};
  const size_t body_size = max_plain_page_size(8192) - kPageHeaderSize;
  const Bytes body = make_body(body_size);
  const Bytes plain = encode_page(PageType::Heap, 0, ref.generation, bytes_span(body));
  CHECK_EQ(plain.size(), max_plain_page_size(8192));
  const Bytes slot = seal_page(ref, bytes_span(plain), 8192);
  CHECK_EQ(slot.size(), 8192u);
  CHECK(open_page(ref, bytes_span(slot)) == plain);
}

IAQS_TEST(envelope, oversized_plaintext_rejected) {
  const PageRef ref{0, 1, 1};
  const Bytes too_big(max_plain_page_size(8192) + 1, 'x');
  CHECK_THROW(seal_page(ref, bytes_span(too_big), 8192), std::runtime_error);
}

IAQS_TEST(envelope, tampering_rejected) {
  const PageRef ref{1, 2, 3};
  const Bytes body = make_body(4000);
  const Bytes plain = encode_page(PageType::Heap, 0, ref.generation, bytes_span(body));
  const Bytes slot = seal_page(ref, bytes_span(plain), 8192);

  // Flip every byte of the used envelope (header + payload); the unused zero
  // padding of the fixed-size slot is not checksummed.
  const size_t used = kEnvelopeHeaderSize + plain.size();
  for (size_t i = 0; i < used; ++i) {
    Bytes tampered = slot;
    tampered[i] = static_cast<char>(tampered[i] ^ 0x01);
    CHECK_THROW(open_page(ref, bytes_span(tampered)), std::runtime_error);
  }
}

IAQS_TEST(envelope, generation_binds_the_slot) {
  const PageRef ref{1, 2, 3};
  const Bytes plain =
      encode_page(PageType::Heap, 0, ref.generation, bytes_span(make_body(100)));
  const Bytes slot = seal_page(ref, bytes_span(plain), 8192);

  CHECK_THROW(open_page(PageRef{1, 2, 4}, bytes_span(slot)), std::runtime_error);
  CHECK(open_page(PageRef{1, 2, 3}, bytes_span(slot)) == plain);
}

IAQS_TEST(envelope, page_header_generation_must_match) {
  const PageRef ref{1, 2, 3};
  // The plaintext header says generation 1 while the envelope slot says 3.
  const Bytes plain = encode_page(PageType::Heap, 0, 1, bytes_span(make_body(64)));
  const Bytes slot = seal_page(ref, bytes_span(plain), 8192);
  CHECK_THROW(open_page(ref, bytes_span(slot)), std::runtime_error);
}

IAQS_TEST(envelope, short_slot_rejected) {
  Bytes empty_slot;
  CHECK_THROW(open_page(PageRef{}, bytes_span(empty_slot)), std::runtime_error);
}
