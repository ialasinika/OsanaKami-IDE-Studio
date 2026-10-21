#include "harness.h"

#include <cstdio>
#include <exception>
#include <sstream>
#include <vector>

#include "core/util.h"

namespace iaqs::test {
namespace {

std::vector<TestCase>& registry() {
  static std::vector<TestCase> cases;
  return cases;
}

std::string escape_bytes(std::string_view v) {
  std::string out;
  out.reserve(v.size() + 8);
  for (unsigned char c : v) {
    switch (c) {
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\\': out += "\\\\"; break;
      default:
        if (c >= 0x20 && c < 0x7f) {
          out.push_back(static_cast<char>(c));
        } else {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\x%02x", c);
          out += buf;
        }
    }
  }
  return out;
}

}  // namespace

Registrar::Registrar(const char* suite, const char* name, void (*fn)()) {
  registry().push_back(TestCase{suite, name, fn});
}

std::string repr(std::string_view v) {
  return "string(\"" + escape_bytes(v) + "\", len=" +
         std::to_string(v.size()) + ")";
}

std::string repr(bool v) { return v ? "true" : "false"; }

std::string repr(char v) {
  return "char('" + escape_bytes(std::string_view(&v, 1)) + "')";
}

std::string repr(unsigned char v) {
  return "byte(0x" + to_hex(iaqs::ByteSpan(&v, 1)) + ")";
}

std::string repr(long long v) { return std::to_string(v); }
std::string repr(unsigned long long v) { return std::to_string(v); }

std::string repr(double v) {
  std::ostringstream os;
  os.precision(17);
  os << v;
  return os.str();
}

void fail_now(const char* file, int line, const std::string& message) {
  std::ostringstream os;
  os << file << ":" << line << ": " << message;
  throw TestFailure(os.str());
}

int run_all(const std::string& filter) {
  int failed = 0;
  int total = 0;
  int skipped = 0;
  for (const auto& tc : registry()) {
    const std::string full = std::string(tc.suite) + "." + tc.name;
    if (!filter.empty() && full.find(filter) == std::string::npos) {
      ++skipped;
      continue;
    }
    ++total;
    try {
      tc.fn();
      std::printf("[  ok  ] %s.%s\n", tc.suite, tc.name);
    } catch (const TestFailure& e) {
      ++failed;
      std::printf("[ FAIL ] %s.%s\n         %s\n", tc.suite, tc.name,
                  e.what());
    } catch (const std::exception& e) {
      ++failed;
      std::printf("[ FAIL ] %s.%s\n         unexpected exception: %s\n",
                  tc.suite, tc.name, e.what());
    } catch (...) {
      ++failed;
      std::printf("[ FAIL ] %s.%s\n         unexpected non-std exception\n",
                  tc.suite, tc.name);
    }
    std::fflush(stdout);
  }
  if (!filter.empty()) {
    std::printf("\nfilter: \"%s\" (skipped %d)\n", filter.c_str(), skipped);
  }
  std::printf("\n%d/%d tests passed\n", total - failed, total);
  std::fflush(stdout);
  return failed == 0 ? 0 : 1;
}

}  // namespace iaqs::test
