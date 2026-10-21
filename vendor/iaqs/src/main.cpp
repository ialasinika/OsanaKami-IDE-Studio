#include <iostream>
#include <string>
#include <vector>

#include "cli/cli.h"
#include "core/util.h"

#if defined(_WIN32)
#include <windows.h>
#include <shellapi.h>
#endif

#if defined(_WIN32)
namespace {

// Converts a wide command-line argument to UTF-8. Narrow argv on Windows is
// decoded with the ANSI code page, which corrupts non-ASCII commit messages,
// tag names and paths, so the CLI always reads the UTF-16 command line.
std::string to_utf8(const wchar_t* text) {
  if (text == nullptr) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) return {};
  std::string out(static_cast<size_t>(size - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), size, nullptr, nullptr);
  return out;
}

}  // namespace
#endif

int main(int argc, char** argv) {
#if defined(_WIN32)
  // Byte-oriented UTF-8 in and out on the Windows console (design 07).
  SetConsoleOutputCP(CP_UTF8);
  int wide_argc = 0;
  wchar_t** wide_argv = CommandLineToArgvW(GetCommandLineW(), &wide_argc);
  std::vector<std::string> storage;
  std::vector<char*> utf8_argv;
  if (wide_argv != nullptr) {
    storage.reserve(static_cast<size_t>(wide_argc));
    for (int i = 0; i < wide_argc; ++i) {
      storage.push_back(to_utf8(wide_argv[i]));
    }
    utf8_argv.reserve(storage.size());
    for (std::string& argument : storage) utf8_argv.push_back(argument.data());
    LocalFree(wide_argv);
    argc = static_cast<int>(utf8_argv.size());
    argv = utf8_argv.data();
  }
#endif
  try {
    return iaqs::cli::run(argc, argv);
  } catch (const std::exception& error) {
    std::cerr << "iaqs: " << error.what() << "\n";
    return 1;
  }
}
