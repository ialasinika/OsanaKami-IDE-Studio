// Installable language packs: install/list/use/remove/export and fallbacks.
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <random>
#include <string>
#include <vector>

#include "core/util.h"
#include "harness.h"
#include "i18n/i18n.h"

using namespace iaqs;

namespace {

namespace fs = std::filesystem;

struct TempDir {
  fs::path path;
  TempDir() {
    std::random_device rd;
    char suffix[32];
    std::snprintf(suffix, sizeof(suffix), "iaqs-i18n-%08x", rd());
    path = fs::temp_directory_path() / suffix;
    fs::create_directories(path);
  }
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(path, ec);
  }
};

// Sets an environment variable for the duration of the test.
struct EnvGuard {
  std::string name;
  std::string previous;
  bool had_previous = false;
  EnvGuard(std::string key, const std::string& value) : name(std::move(key)) {
    const char* old = std::getenv(name.c_str());
    if (old != nullptr) {
      previous = old;
      had_previous = true;
    }
#ifdef _WIN32
    _putenv_s(name.c_str(), value.c_str());
#else
    setenv(name.c_str(), value.c_str(), 1);
#endif
  }
  ~EnvGuard() {
#ifdef _WIN32
    _putenv_s(name.c_str(), had_previous ? previous.c_str() : "");
#else
    if (had_previous) {
      setenv(name.c_str(), previous.c_str(), 1);
    } else {
      unsetenv(name.c_str());
    }
#endif
  }
};

void write_text(const fs::path& file, std::string_view text) {
  fs::create_directories(file.parent_path());
  write_file(file.string(), bytes_span(text));
}

// Replaces the first line starting with `prefix` in a text blob.
std::string replace_line(const std::string& text, std::string_view prefix,
                         std::string_view replacement) {
  std::vector<std::string> lines;
  size_t start = 0;
  while (start <= text.size()) {
    size_t end = text.find('\n', start);
    if (end == std::string::npos) end = text.size();
    lines.push_back(text.substr(start, end - start));
    start = end + 1;
  }
  for (std::string& line : lines) {
    if (line.rfind(prefix, 0) == 0) {
      line = std::string(replacement);
    }
  }
  std::string out;
  for (const std::string& line : lines) out += line + "\n";
  return out;
}

bool contains(const std::vector<i18n::LanguageInfo>& langs,
              std::string_view code) {
  for (const auto& info : langs) {
    if (info.code == code) return true;
  }
  return false;
}

}  // namespace

IAQS_TEST(i18n_lang, builtin_packs_export) {
  i18n::set_language("en");
  const std::string en = i18n::export_language("en");
  CHECK(en.find("language=en\n") != std::string::npos);
  CHECK(en.find("version=") != std::string::npos);
  CHECK(en.find("usage=") != std::string::npos);

  const std::string zh = i18n::export_language("zh-CN");
  CHECK(zh.find("language=zh-CN\n") != std::string::npos);
  CHECK(i18n::language_exists("zh-CN"));
  CHECK(i18n::language_exists("en"));
  CHECK(!i18n::language_exists("does-not-exist"));
}

IAQS_TEST(i18n_lang, install_use_and_remove_pack) {
  TempDir tmp;
  EnvGuard home("IAQS_HOME", tmp.path.string());
  EnvGuard dir("IAQS_LANG_DIR", (tmp.path / "extra").string());
  i18n::set_language("en");

  std::string template_text = i18n::export_language("en");
  template_text = replace_line(template_text, "language=", "language=eo");
  template_text = replace_line(template_text, "name=", "name=Esperanto");
  template_text = replace_line(template_text, "version=", "version=Esperanto 1.0");
  const fs::path pack = tmp.path / "eo.lang";
  write_text(pack, template_text);

  std::string error;
  std::string code;
  std::string name;
  CHECK(i18n::install_language(pack.string(), error, &code, &name));
  CHECK_EQ(code, std::string("eo"));
  CHECK_EQ(name, std::string("Esperanto"));
  CHECK(i18n::language_exists("eo"));
  CHECK(contains(i18n::available_languages(), "eo"));

  i18n::set_language("eo");
  CHECK_EQ(i18n::language(), std::string("eo"));
  CHECK_EQ(i18n::tr(i18n::Msg::Version), std::string("Esperanto 1.0"));
  // Keys not overridden by the pack stay in English.
  CHECK(i18n::tr(i18n::Msg::StatusClean).find("clean") != std::string::npos);

  std::string remove_error;
  CHECK(i18n::remove_language("eo", remove_error));
  CHECK(!i18n::language_exists("eo"));
  i18n::set_language("en");
}

IAQS_TEST(i18n_lang, invalid_packs_are_rejected) {
  TempDir tmp;
  EnvGuard home("IAQS_HOME", tmp.path.string());
  i18n::set_language("en");

  std::string error;
  CHECK(!i18n::install_language((tmp.path / "missing.lang").string(), error));
  CHECK(!error.empty());

  const fs::path no_code = tmp.path / "no-code.lang";
  write_text(no_code, "version=No code\n");
  std::string code_error;
  CHECK(!i18n::install_language(no_code.string(), code_error));
  CHECK(code_error.find("language") != std::string::npos);

  const fs::path unknown_key = tmp.path / "unknown-key.lang";
  write_text(unknown_key, "language=xx\nnot_a_real_key=nope\n");
  std::string key_error;
  CHECK(!i18n::install_language(unknown_key.string(), key_error));
  CHECK(key_error.find("not_a_real_key") != std::string::npos);

  const fs::path bad_code = tmp.path / "bad-code.lang";
  write_text(bad_code, "language=bad code!\n");
  std::string bad_code_error;
  CHECK(!i18n::install_language(bad_code.string(), bad_code_error));
}

IAQS_TEST(i18n_lang, user_default_language_roundtrip) {
  TempDir tmp;
  EnvGuard home("IAQS_HOME", tmp.path.string());
  EnvGuard dir("IAQS_LANG_DIR", (tmp.path / "extra").string());
  i18n::set_language("en");

  CHECK_EQ(i18n::user_language(), std::string());
  std::string error;
  CHECK(i18n::set_user_language("zh-CN", error));
  CHECK_EQ(i18n::user_language(), std::string("zh-CN"));

  // The user default is picked up by detect_language when nothing else is set.
  i18n::set_language("en");
  i18n::detect_language("", "");
  CHECK_EQ(i18n::language(), std::string("zh-CN"));

  CHECK(i18n::set_user_language("en", error));
  i18n::set_language("zh-CN");
  i18n::detect_language("", "");
  CHECK_EQ(i18n::language(), std::string("en"));

  // Explicit CLI language wins over the stored default.
  i18n::set_language("en");
  i18n::detect_language("zh-CN", "");
  CHECK_EQ(i18n::language(), std::string("zh-CN"));
  i18n::set_language("en");
}

IAQS_TEST(i18n_lang, installed_pack_appears_in_search_paths) {
  TempDir tmp;
  const fs::path extra = tmp.path / "extra";
  fs::create_directories(extra);
  EnvGuard home("IAQS_HOME", (tmp.path / "home").string());
  EnvGuard dir("IAQS_LANG_DIR", extra.string());
  i18n::set_language("en");

  i18n::set_language("en");
  const std::string english_clean = i18n::tr(i18n::Msg::StatusClean);

  const fs::path pack = extra / "xx.lang";
  write_text(pack, "language=xx\nname=Test\nversion=Version XX\n");
  CHECK(i18n::language_exists("xx"));
  CHECK(contains(i18n::available_languages(), "xx"));

  i18n::set_language("xx");
  CHECK_EQ(i18n::tr(i18n::Msg::Version), std::string("Version XX"));
  // Missing keys fall back to English.
  CHECK_EQ(i18n::tr(i18n::Msg::StatusClean), english_clean);
  i18n::set_language("en");
}
