#include "i18n/i18n.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>
#include <optional>
#include <sstream>
#include <unordered_map>
#include <vector>

#include "core/util.h"

namespace iaqs::i18n {
namespace {

// Keep the two tables in the same order as enum Msg (Count is the length).
const char* kZh[] = {
    "用法: iaqs <命令> [选项]\n命令: init add status commit log show cat-file ls-tree branch switch merge diff\n      tag reset info gc fsck rm mv restore clean rev-parse checkpoint\n      placeholder export-git import-git lang version help\n全局: --repo <路径> --lang <zh-CN|en>\n",
    "iaqs 0.1.0 (格式版本 2)",
    "已创建仓库: {0}",
    "已经是一个 iaqs 仓库: {0}",
    "仓库: {0}",
    "已提交 {0}",
    "没有需要提交的改动（可用 --allow-empty）",
    "分支:",
    "已暂存:",
    "未暂存:",
    "未跟踪:",
    "工作区干净",
    "提交历史:",
    "当前目录不在 iaqs 仓库内（未找到 .iaqs）",
    "用法错误: {0}",
    "提交说明不能为空",
    "已切换到 {0}",
    "已经是最新。",
    "快进到 {0}",
    "合并提交 {0}",
    "合并停止，存在 {0} 个冲突：",
    "解决冲突标记后执行 'iaqs add <路径>'，再执行 'iaqs commit -m ...'。",
    "HEAD: {0}",
    "提交: {0}",
    "页大小: {0}",
    "表: {0}",
    "已检查 {0} 个对象（{1} 次提交、{2} 棵树、{3} 个 blob、{4} 个标签）",
    "未发现问题。",
    "发现 {0} 个问题。",
    "错误: {0}",
    "已恢复全部跟踪路径（{0} 个）",
    "已恢复 {0} 个路径",
    "检查点完成。",
    "已创建标签 {0}（{1}）",
    "已删除标签 {0}",
    "HEAD 现在位于 {0} {1}",
    "二进制文件 a/{0} 与 b/{0} 不同",
    "分支 {0} -> {1}",
    "将重新打包: ",
    "已重新打包: ",
    "{0} 个可达对象，{1} 个 delta 对象，移除 {2} 个对象，{3} -> {4} 字节（节省 {5}）",
    "已保留 {0} 个既有 delta（本轮候选 {1} 个对象）",
    "当前分支 {0}",
    "(游离 HEAD)",
    "{0} 个文件变更，{1} 行新增(+)，{2} 行删除(-)",
    "占位（待实现/未获得）:",
    "已登记占位 {0}",
    "已移除占位 {0}",
    "占位清单:",
    "（没有占位）",
    "已导出 {0} 个提交、{1} 个 blob、{2} 个标签、{3} 个分支（fast-import 流已写入标准输出）",
    "已导出 {0} 个 pack 文件、{1} 个对象、{2} 个引用（含 refs/ 与 HEAD）",
    "已导入 {0} 个提交、{1} 棵树、{2} 个 blob、{3} 个标签、{4} 个引用",
    "已安装的语言:",
    "已安装语言 {0}（{1}）",
    "已删除语言 {0}",
    "默认语言已设置为 {0}",
    "没有找到语言 {0}",
    "语言包无效: {0}",
    "用法: iaqs lang [list|install <文件>|remove <代码>|use <代码>|export [代码]]",
};

const char* kEn[] = {
    "Usage: iaqs <command> [options]\n"
    "Commands: init add status commit log show cat-file ls-tree branch switch merge diff\n"
    "          tag reset info gc fsck rm mv restore clean rev-parse\n"
    "          checkpoint placeholder export-git import-git lang version help\n"
    "Global: --repo <path> --lang <zh-CN|en>\n",
    "iaqs 0.1.0 (format version 2)",
    "Initialized repository: {0}",
    "Already an iaqs repository: {0}",
    "Repository: {0}",
    "Committed {0}",
    "Nothing to commit (use --allow-empty)",
    "Branches:",
    "Staged:",
    "Unstaged:",
    "Untracked:",
    "Working tree clean",
    "History:",
    "Not inside an iaqs repository (no .iaqs found)",
    "Usage error: {0}",
    "Commit message must not be empty",
    "Switched to {0}",
    "Already up to date.",
    "Fast-forward to {0}",
    "Merge commit {0}",
    "Merge stopped with {0} conflict(s):",
    "Resolve the markers, run 'iaqs add <path>' and then 'iaqs commit -m ...'.",
    "HEAD: {0}",
    "Commit: {0}",
    "Page size: {0}",
    "Tables: {0}",
    "Checked {0} objects ({1} commits, {2} trees, {3} blobs, {4} tags)",
    "No problems found.",
    "{0} problem(s) found.",
    "error: {0}",
    "Restored all tracked paths ({0} paths)",
    "Restored {0} path(s)",
    "Checkpoint complete.",
    "Created tag {0} ({1})",
    "Deleted tag {0}",
    "HEAD is now at {0} {1}",
    "Binary files a/{0} and b/{0} differ",
    "Branch {0} -> {1}",
    "Would repack: ",
    "Repacked: ",
    "{0} reachable objects, {1} delta objects, {2} objects removed, {3} -> {4} bytes (saved {5})",
    "Kept {0} existing delta(s) ({1} candidate objects in this run)",
    "On branch {0}",
    "(detached HEAD)",
    "{0} file(s) changed, {1} insertion(s) (+), {2} deletion(s) (-)",
    "Placeholders (pending):",
    "Declared placeholder {0}",
    "Removed placeholder {0}",
    "Placeholders:",
    "(no placeholders)",
    "Exported {0} commit(s), {1} blob(s), {2} tag(s), {3} branch ref(s) as a fast-import stream on stdout",
    "Exported {0} pack file(s), {1} object(s), {2} ref(s) (refs/ and HEAD included)",
    "Imported {0} commit(s), {1} tree(s), {2} blob(s), {3} tag(s), {4} ref(s)",
    "Installed languages:",
    "Installed language {0} ({1})",
    "Removed language {0}",
    "Default language set to {0}",
    "Language {0} not found",
    "Invalid language pack: {0}",
    "Usage: iaqs lang [list|install <file>|remove <code>|use <code>|export [code]]",
};

const char* kKeys[] = {
    "usage",
    "version",
    "init_created",
    "already_repo",
    "repo_info",
    "committed",
    "nothing_to_commit",
    "branch_header",
    "status_staged",
    "status_unstaged",
    "status_untracked",
    "status_clean",
    "log_header",
    "error_not_repo",
    "error_usage",
    "error_commit_empty_message",
    "checkout_done",
    "merge_up_to_date",
    "merge_fast_forward",
    "merge_commit",
    "merge_conflicts",
    "merge_resolve_hint",
    "info_head",
    "info_commit",
    "info_page_size",
    "info_tables",
    "fsck_checked",
    "fsck_ok",
    "fsck_problems",
    "fsck_error",
    "restore_all",
    "restore_paths",
    "checkpoint_done",
    "tag_created",
    "tag_deleted",
    "reset_done",
    "diff_binary",
    "branch_created",
    "gc_would_repack",
    "gc_repacked",
    "gc_summary",
    "gc_kept_deltas",
    "on_branch",
    "on_detached",
    "diff_stat_summary",
    "status_placeholders",
    "placeholder_added",
    "placeholder_removed",
    "placeholder_list_header",
    "placeholder_none",
    "export_git_done",
    "export_pack_done",
    "import_git_done",
    "lang_list_header",
    "lang_installed",
    "lang_removed",
    "lang_default_set",
    "lang_not_found",
    "lang_invalid_pack",
    "lang_usage",
};

constexpr size_t kMessageCount = static_cast<size_t>(Msg::Count);
static_assert(sizeof(kKeys) / sizeof(kKeys[0]) == kMessageCount,
              "kKeys must match enum Msg");

struct Pack {
  std::string code;
  std::string name;
  std::string path;
  bool builtin = false;
  std::unordered_map<std::string, std::string> messages;
};

std::string g_code = "zh-CN";
std::string g_name = "简体中文";
std::unordered_map<std::string, std::string> g_pack;
bool g_zh = true;

void replace_all(std::string& out, std::string_view from, std::string_view to) {
  size_t pos = 0;
  while ((pos = out.find(from, pos)) != std::string::npos) {
    out.replace(pos, from.size(), to);
    pos += to.size();
  }
}

bool known_key(const std::string& key) {
  for (size_t i = 0; i < kMessageCount; ++i) {
    if (key == kKeys[i]) return true;
  }
  return false;
}

std::string home_dir_impl() {
  if (const char* home = std::getenv("IAQS_HOME"); home && *home) return home;
#ifdef _WIN32
  if (const char* appdata = std::getenv("APPDATA"); appdata && *appdata) {
    return std::string(appdata) + "/iaqs";
  }
#else
  if (const char* home = std::getenv("HOME"); home && *home) {
    return std::string(home) + "/.config/iaqs";
  }
#endif
  return ".";
}

std::vector<std::string> search_paths_impl() {
  std::vector<std::string> dirs;
  if (const char* env = std::getenv("IAQS_LANG_DIR"); env && *env) {
#ifdef _WIN32
    const char separator = ';';
#else
    const char separator = ':';
#endif
    for (std::string_view item : split(env, separator)) {
      const std::string dir = trim(item);
      if (!dir.empty()) dirs.push_back(dir);
    }
  }
  dirs.push_back(home_dir_impl() + "/lang");
  return dirs;
}

std::string unescape_value(std::string_view raw) {
  std::string out;
  for (size_t i = 0; i < raw.size(); ++i) {
    if (raw[i] == '\\' && i + 1 < raw.size()) {
      const char next = raw[++i];
      switch (next) {
        case 'n': out.push_back('\n'); break;
        case 't': out.push_back('\t'); break;
        case 'r': out.push_back('\r'); break;
        case '\\': out.push_back('\\'); break;
        default: out.push_back(next); break;
      }
    } else {
      out.push_back(raw[i]);
    }
  }
  return out;
}

std::string escape_value(std::string_view text) {
  std::string out;
  for (const char c : text) {
    switch (c) {
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out.push_back(c); break;
    }
  }
  return out;
}

bool valid_code(std::string_view code) {
  if (code.empty() || code.size() > 32) return false;
  for (const char c : code) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                    (c >= '0' && c <= '9') || c == '-' || c == '_';
    if (!ok) return false;
  }
  return true;
}

bool parse_pack_text(std::string_view text, Pack& pack, std::string& error) {
  size_t line_no = 0;
  size_t start = 0;
  while (start <= text.size()) {
    size_t end = text.find('\n', start);
    if (end == std::string_view::npos) end = text.size();
    std::string line(text.substr(start, end - start));
    if (!line.empty() && line.back() == '\r') line.pop_back();
    start = end + 1;
    ++line_no;
    const std::string entry = trim(line);
    if (entry.empty() || entry[0] == '#') continue;
    const size_t eq = entry.find('=');
    if (eq == std::string::npos) {
      error = "line " + std::to_string(line_no) + ": expected key=value";
      return false;
    }
    const std::string key = trim(entry.substr(0, eq));
    const std::string value = unescape_value(trim(entry.substr(eq + 1)));
    if (key == "language") {
      pack.code = value;
    } else if (key == "name") {
      pack.name = value;
    } else if (key == "comment") {
      continue;
    } else if (!known_key(key)) {
      error = "line " + std::to_string(line_no) + ": unknown message key '" +
              key + "'";
      return false;
    } else {
      pack.messages[key] = value;
    }
  }
  if (pack.code.empty()) {
    error = "missing language=<code>";
    return false;
  }
  return true;
}

bool read_pack_file(const std::filesystem::path& path, Pack& pack,
                    std::string& error) {
  const Bytes data = read_file(path.string());
  if (data.empty()) {
    error = "cannot read " + path.string();
    return false;
  }
  pack.path = path.string();
  return parse_pack_text(std::string_view(data.data(), data.size()), pack,
                         error);
}

std::optional<Pack> load_pack(std::string_view code) {
  if (!valid_code(code)) return std::nullopt;
  const std::vector<std::string> dirs = search_paths_impl();
  for (const std::string& dir : dirs) {
    const std::filesystem::path path =
        std::filesystem::path(dir) / (std::string(code) + ".lang");
    std::error_code ec;
    if (!std::filesystem::exists(path, ec)) continue;
    Pack pack;
    std::string error;
    if (read_pack_file(path, pack, error) &&
        to_lower_ascii(pack.code) == to_lower_ascii(code)) {
      return pack;
    }
  }
  // Case-insensitive fallback: scan directory entries.
  for (const std::string& dir : dirs) {
    std::error_code ec;
    std::filesystem::directory_iterator it(std::filesystem::path(dir), ec);
    if (ec) continue;
    for (; it != std::filesystem::directory_iterator(); it.increment(ec)) {
      if (ec) break;
      if (it->path().extension() != ".lang") continue;
      Pack pack;
      std::string error;
      if (!read_pack_file(it->path(), pack, error)) continue;
      if (to_lower_ascii(pack.code) == to_lower_ascii(code)) return pack;
    }
  }
  return std::nullopt;
}

bool is_english_tag(std::string_view tag) {
  const std::string norm = to_lower_ascii(tag);
  return norm == "en" || starts_with(norm, "en-") || starts_with(norm, "en_");
}

bool is_chinese_tag(std::string_view tag) {
  const std::string norm = to_lower_ascii(tag);
  return norm == "zh" || norm == "zh-cn" || norm == "zh_cn" ||
         norm == "zh-hans" || starts_with(norm, "zh-") ||
         starts_with(norm, "zh_");
}

}  // namespace

const char* message_key(Msg msg) {
  const size_t index = static_cast<size_t>(msg);
  if (index >= kMessageCount) return "?";
  return kKeys[index];
}

std::string tr(Msg msg, std::initializer_list<std::string> args) {
  const size_t index = static_cast<size_t>(msg);
  std::string text;
  if (index < kMessageCount) {
    const auto it = g_pack.find(kKeys[index]);
    if (it != g_pack.end()) {
      text = it->second;
    } else {
      text = g_zh ? kZh[index] : kEn[index];
    }
  } else {
    text = "?";
  }
  size_t arg_index = 0;
  for (const auto& arg : args) {
    replace_all(text, "{" + std::to_string(arg_index) + "}", arg);
    ++arg_index;
  }
  return text;
}

void set_language(std::string_view tag) {
  if (tag.empty() || is_english_tag(tag)) {
    g_code = "en";
    g_name = "English";
    g_pack.clear();
    g_zh = false;
    return;
  }
  if (is_chinese_tag(tag)) {
    g_code = "zh-CN";
    g_name = "简体中文";
    g_pack.clear();
    g_zh = true;
    return;
  }
  if (const std::optional<Pack> pack = load_pack(tag)) {
    g_code = pack->code;
    g_name = pack->name.empty() ? pack->code : pack->name;
    g_pack = pack->messages;
    g_zh = false;
    return;
  }
  // Unknown code: keep it as the requested language but fall back to English
  // messages one by one (never fail over a missing translation).
  g_code = std::string(tag);
  g_name = std::string(tag);
  g_pack.clear();
  g_zh = false;
}

std::string language() { return g_code; }
std::string language_name() { return g_name; }

void detect_language(std::string_view cli_lang, std::string_view config_lang) {
  if (!cli_lang.empty()) {
    set_language(cli_lang);
    return;
  }
  if (const char* env = std::getenv("IAQS_LANG"); env && *env) {
    set_language(env);
    return;
  }
  if (!config_lang.empty() && config_lang != "auto") {
    set_language(config_lang);
    return;
  }
  if (const std::string saved = user_language(); !saved.empty()) {
    set_language(saved);
    return;
  }
  // Fall back to the process locale: Chinese UI locale -> zh-CN.
  const char* lang = std::getenv("LANG");
  if (lang != nullptr && std::strstr(lang, "zh") != nullptr) {
    set_language("zh-CN");
    return;
  }
  set_language("en");
}

// ------------------------------------------------------------ language packs

std::string home_dir() { return home_dir_impl(); }

std::vector<std::string> language_search_paths() { return search_paths_impl(); }

std::vector<LanguageInfo> available_languages() {
  std::vector<LanguageInfo> out;
  out.push_back(LanguageInfo{"en", "English", "", true});
  out.push_back(LanguageInfo{"zh-CN", "简体中文", "", true});
  std::map<std::string, LanguageInfo> installed;  // ordered by code
  for (const std::string& dir : search_paths_impl()) {
    std::error_code ec;
    std::filesystem::directory_iterator it(std::filesystem::path(dir), ec);
    if (ec) continue;
    for (; it != std::filesystem::directory_iterator(); it.increment(ec)) {
      if (ec) break;
      if (it->path().extension() != ".lang") continue;
      Pack pack;
      std::string error;
      if (!read_pack_file(it->path(), pack, error)) continue;
      const std::string norm = to_lower_ascii(pack.code);
      if (norm.empty() || norm == "en" || norm == "zh-cn" || norm == "zh") {
        continue;
      }
      if (installed.count(pack.code) != 0) continue;
      installed.emplace(pack.code, LanguageInfo{pack.code, pack.name,
                                                it->path().string(), false});
    }
  }
  for (auto& [code, info] : installed) out.push_back(std::move(info));
  return out;
}

bool language_exists(std::string_view code) {
  if (code.empty()) return false;
  if (is_english_tag(code) || is_chinese_tag(code)) return true;
  return load_pack(code).has_value();
}

bool install_language(std::string_view pack_file, std::string& error,
                      std::string* installed_code,
                      std::string* installed_name) {
  Pack pack;
  try {
    if (!read_pack_file(std::filesystem::path(std::string(pack_file)), pack,
                        error)) {
      return false;
    }
  } catch (const std::exception& e) {
    error = e.what();
    return false;
  }
  if (!valid_code(pack.code)) {
    error = "invalid language code '" + pack.code + "'";
    return false;
  }
  const std::string target_dir = home_dir_impl() + "/lang";
  std::error_code ec;
  std::filesystem::create_directories(std::filesystem::path(target_dir), ec);
  if (ec) {
    error = "cannot create " + target_dir;
    return false;
  }
  try {
    const Bytes raw = read_file(std::string(pack_file));
    const std::filesystem::path target =
        std::filesystem::path(target_dir) / (pack.code + ".lang");
    write_file_atomic(target.string(), bytes_span(raw));
  } catch (const std::exception& e) {
    error = e.what();
    return false;
  }
  if (installed_code != nullptr) *installed_code = pack.code;
  if (installed_name != nullptr) *installed_name = pack.name;
  return true;
}

bool remove_language(std::string_view code, std::string& error) {
  if (is_english_tag(code) || is_chinese_tag(code)) {
    error = "built-in languages cannot be removed";
    return false;
  }
  for (const std::string& dir : search_paths_impl()) {
    const std::filesystem::path path =
        std::filesystem::path(dir) / (std::string(code) + ".lang");
    std::error_code ec;
    if (!std::filesystem::exists(path, ec)) continue;
    if (!std::filesystem::remove(path, ec) || ec) {
      error = "cannot remove " + path.string();
      return false;
    }
    return true;
  }
  error = "language pack not found";
  return false;
}

std::string export_language(std::string_view code) {
  Pack pack;
  if (is_chinese_tag(code)) {
    pack.code = "zh-CN";
    pack.name = "简体中文";
    for (size_t i = 0; i < kMessageCount; ++i) pack.messages[kKeys[i]] = kZh[i];
  } else if (is_english_tag(code) || code.empty()) {
    pack.code = "en";
    pack.name = "English";
    for (size_t i = 0; i < kMessageCount; ++i) pack.messages[kKeys[i]] = kEn[i];
  } else if (const std::optional<Pack> loaded = load_pack(code)) {
    pack = *loaded;
  } else {
    pack.code = std::string(code);
  }
  std::ostringstream out;
  out << "language=" << pack.code << "\n";
  if (!pack.name.empty()) out << "name=" << pack.name << "\n";
  out << "\n";
  for (size_t i = 0; i < kMessageCount; ++i) {
    const auto it = pack.messages.find(kKeys[i]);
    const std::string value = it != pack.messages.end() ? it->second : kEn[i];
    out << kKeys[i] << "=" << escape_value(value) << "\n";
  }
  return out.str();
}

std::string user_language() {
  const std::filesystem::path path =
      std::filesystem::path(home_dir_impl()) / "config";
  std::error_code ec;
  if (!std::filesystem::exists(path, ec)) return {};
  std::string data;
  try {
    data = read_file(path.string());
  } catch (const std::exception&) {
    return {};
  }
  size_t start = 0;
  while (start < data.size()) {
    size_t end = data.find('\n', start);
    if (end == std::string::npos) end = data.size();
    std::string line = data.substr(start, end - start);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    start = end + 1;
    const std::string entry = trim(line);
    if (entry.empty() || entry[0] == '#') continue;
    const size_t eq = entry.find('=');
    if (eq == std::string::npos) continue;
    if (trim(entry.substr(0, eq)) == "ui.lang") {
      return trim(entry.substr(eq + 1));
    }
  }
  return {};
}

bool set_user_language(std::string_view code, std::string& error) {
  if (!language_exists(code)) {
    error = "unknown language '" + std::string(code) + "'";
    return false;
  }
  const std::string dir = home_dir_impl();
  std::filesystem::path path = std::filesystem::path(dir) / "config";
  std::string data;
  std::error_code ec;
  std::filesystem::create_directories(std::filesystem::path(dir), ec);
  if (ec) {
    error = "cannot create " + dir;
    return false;
  }
  if (std::filesystem::exists(path, ec)) {
    try {
      data = read_file(path.string());
    } catch (const std::exception&) {
      data.clear();
    }
  }
  std::string updated;
  bool replaced = false;
  size_t start = 0;
  while (start < data.size()) {
    size_t end = data.find('\n', start);
    if (end == std::string::npos) end = data.size();
    std::string line = data.substr(start, end - start);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    start = end + 1;
    const std::string entry = trim(line);
    if (!entry.empty() && entry[0] != '=' &&
        trim(entry.substr(0, entry.find('='))) == "ui.lang") {
      updated += "ui.lang=" + std::string(code) + "\n";
      replaced = true;
    } else {
      updated += line + "\n";
    }
  }
  if (!replaced) updated += "ui.lang=" + std::string(code) + "\n";
  try {
    write_file_atomic(path.string(), bytes_span(updated));
  } catch (const std::exception& e) {
    error = e.what();
    return false;
  }
  return true;
}

}  // namespace iaqs::i18n
