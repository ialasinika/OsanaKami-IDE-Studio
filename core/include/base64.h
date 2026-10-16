/*
 * base64.h - the one spelling of base64 this kernel speaks.
 *
 * Base64 is how bytes travel through a JSON string, which cannot carry a NUL
 * and is terminated by one on the wire.  Both directions are here rather than
 * beside their callers because two spellings of an encoder is how a payload
 * round-trips through one verb and not the other.
 *
 * The rules are RFC 4648 and nothing else: the standard alphabet, `=` padding
 * to a multiple of four, no line breaks, no whitespace, and the bits a short
 * group cannot carry must be zero.  A decoder that skipped whitespace, or
 * stopped at the first character it did not like, would "succeed" on a string
 * that is not base64 and write bytes nobody asked for -- and a PNG written
 * from a mis-encoded string is worse than a refusal, because it looks right
 * until the game loads it.
 */
#ifndef INFANTGOD_BASE64_H
#define INFANTGOD_BASE64_H

#include <stddef.h>

/* malloc'd and NUL-terminated; NULL only when out of memory. */
char *sde_base64_encode(const char *data, size_t len);

/*
 * Decodes `len` bytes of `s`.
 *
 *   0  success; `*out` is malloc'd and `*outlen` is its length
 *  -1  out of memory
 *  -2  not base64 (the caller's request cannot mean anything)
 *
 * `*out` is always NULL and `*outlen` 0 unless the return is 0.
 */
int sde_base64_decode(const char *s, size_t len, char **out, size_t *outlen);

#endif /* INFANTGOD_BASE64_H */
