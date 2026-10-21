#include <cstdlib>
#include <string>

#include "harness.h"

int main() {
  const char* filter = std::getenv("IAQS_TEST_FILTER");
  return iaqs::test::run_all(filter ? filter : "");
}
