#include "crypto/rand.h"

#include <cstring>
#include <stdexcept>

#ifdef _WIN32
#include <windows.h>
#include <bcrypt.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#endif

namespace iaqs {

void random_fill(uint8_t* out, size_t size) {
  if (size == 0) return;
#ifdef _WIN32
  const NTSTATUS status = BCryptGenRandom(
      nullptr, reinterpret_cast<PUCHAR>(out), static_cast<ULONG>(size),
      BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  if (status < 0) {
    throw std::runtime_error("random_fill: BCryptGenRandom failed");
  }
#else
  size_t offset = 0;
  int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    throw std::runtime_error("random_fill: cannot open /dev/urandom");
  }
  while (offset < size) {
    const ssize_t got = read(fd, out + offset, size - offset);
    if (got <= 0) {
      if (got < 0 && errno == EINTR) continue;
      close(fd);
      throw std::runtime_error("random_fill: read /dev/urandom failed");
    }
    offset += static_cast<size_t>(got);
  }
  close(fd);
#endif
}

Bytes random_bytes(size_t size) {
  Bytes out;
  out.resize(size);
  random_fill(reinterpret_cast<uint8_t*>(out.data()), out.size());
  return out;
}

void secure_wipe(void* data, size_t size) {
  if (data == nullptr || size == 0) return;
#ifdef _WIN32
  SecureZeroMemory(data, size);
#else
  volatile uint8_t* p = static_cast<volatile uint8_t*>(data);
  while (size-- > 0) *p++ = 0;
#endif
}

}  // namespace iaqs
