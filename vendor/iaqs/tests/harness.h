// Minimal self-contained test harness: zero third-party dependencies.
#pragma once

#include <cstddef>
#include <cstdint>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace iaqs::test {

struct TestFailure : std::runtime_error {
  using std::runtime_error::runtime_error;
};

struct TestCase {
  const char* suite;
  const char* name;
  void (*fn)();
};

struct Registrar {
  Registrar(const char* suite, const char* name, void (*fn)());
};

// Reports a failure immediately and aborts the current test case.
void fail_now(const char* file, int line, const std::string& message);

// Runs every registered test case whose "suite.name" contains `filter`
// (empty = all); returns process exit code (0 = all passed).
int run_all(const std::string& filter = std::string());

// Human-readable, unambiguous rendering of a value for failure messages.
std::string repr(std::string_view v);
inline std::string repr(const std::string& v) { return repr(std::string_view(v)); }
inline std::string repr(const char* v) { return repr(std::string_view(v)); }

std::string repr(bool v);
std::string repr(char v);
std::string repr(unsigned char v);
std::string repr(long long v);
std::string repr(unsigned long long v);
std::string repr(double v);

template <typename T>
std::string repr(const T& v) {
  if constexpr (std::is_same_v<T, bool>) {
    return repr(static_cast<bool>(v));
  } else if constexpr (std::is_integral_v<T> && std::is_signed_v<T>) {
    return repr(static_cast<long long>(v));
  } else if constexpr (std::is_integral_v<T> && std::is_unsigned_v<T>) {
    return repr(static_cast<unsigned long long>(v));
  } else if constexpr (std::is_floating_point_v<T>) {
    return repr(static_cast<double>(v));
  } else {
    std::ostringstream os;
    os << "<value>";
    return os.str();
  }
}

}  // namespace iaqs::test

#define IAQS_TEST(suite, name)                                        \
  static void suite##_##name();                                       \
  static ::iaqs::test::Registrar registrar_##suite##_##name(          \
      #suite, #name, &suite##_##name);                                \
  static void suite##_##name()

#define CHECK(cond)                                                          \
  do {                                                                       \
    if (!(cond)) {                                                           \
      ::iaqs::test::fail_now(__FILE__, __LINE__, "CHECK(" #cond ") failed"); \
    }                                                                        \
  } while (0)

#define CHECK_EQ(a, b)                                                       \
  do {                                                                       \
    auto iaqs_t_a = (a);                                                     \
    auto iaqs_t_b = (b);                                                     \
    if (!(iaqs_t_a == iaqs_t_b)) {                                           \
      std::ostringstream iaqs_t_os;                                          \
      iaqs_t_os << "CHECK_EQ(" #a ", " #b ") failed\n  actual:   "           \
                << ::iaqs::test::repr(iaqs_t_a) << "\n  expected: "          \
                << ::iaqs::test::repr(iaqs_t_b);                             \
      ::iaqs::test::fail_now(__FILE__, __LINE__, iaqs_t_os.str());           \
    }                                                                        \
  } while (0)

#define CHECK_THROW(expr, extype)                                            \
  do {                                                                       \
    bool iaqs_t_caught = false;                                              \
    try {                                                                    \
      (void)(expr);                                                          \
    } catch (const extype&) {                                                \
      iaqs_t_caught = true;                                                  \
    } catch (...) {                                                          \
      ::iaqs::test::fail_now(__FILE__, __LINE__,                             \
                             "CHECK_THROW: wrong exception type from " #expr);\
    }                                                                        \
    if (!iaqs_t_caught) {                                                    \
      ::iaqs::test::fail_now(__FILE__, __LINE__,                             \
                             "CHECK_THROW: expected " #extype                \
                             " from " #expr);                                \
    }                                                                        \
  } while (0)
