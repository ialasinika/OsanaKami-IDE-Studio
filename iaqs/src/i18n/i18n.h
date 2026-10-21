// i18n layer (design 04 §6): built-in English + Simplified Chinese plus
// installable language packs. A pack is a UTF-8 text file of `key=value`
// lines; keys are the stable names returned by message_key(). Packs live in
// `$IAQS_HOME/lang/<code>.lang` (or any directory listed in IAQS_LANG_DIR).
#pragma once

#include <initializer_list>
#include <string>
#include <string_view>
#include <vector>

namespace iaqs::i18n {

enum class Msg {
  Usage,
  Version,
  InitCreated,
  AlreadyRepo,
  RepoInfo,
  Committed,
  NothingToCommit,
  BranchHeader,
  StatusStaged,
  StatusUnstaged,
  StatusUntracked,
  StatusClean,
  LogHeader,
  ErrorNotRepo,
  ErrorUsage,
  ErrCommitEmptyMessage,
  CheckoutDone,
  MergeUpToDate,
  MergeFastForward,
  MergeCommit,
  MergeConflicts,
  MergeResolveHint,
  InfoHead,
  InfoCommit,
  InfoPageSize,
  InfoTables,
  FsckChecked,
  FsckOk,
  FsckProblems,
  FsckError,
  RestoreAll,
  RestorePaths,
  CheckpointDone,
  TagCreated,
  TagDeleted,
  ResetDone,
  DiffBinary,
  BranchCreated,
  GcWouldRepack,
  GcRepacked,
  GcSummary,
  GcKeptDeltas,
  OnBranch,
  OnDetached,
  DiffStatSummary,
  StatusPlaceholders,
  PlaceholderAdded,
  PlaceholderRemoved,
  PlaceholderListHeader,
  PlaceholderNone,
  ExportGitDone,
  ExportPackDone,
  ImportGitDone,
  LangListHeader,
  LangInstalled,
  LangRemoved,
  LangDefaultSet,
  LangNotFound,
  LangInvalidPack,
  LangUsage,
  Count
};

// Stable identifiers of the messages (used as pack keys).
const char* message_key(Msg msg);

std::string tr(Msg msg, std::initializer_list<std::string> args = {});

// An available language: built-in or an installed pack.
struct LanguageInfo {
  std::string code;      // e.g. "en", "zh-CN", "eo"
  std::string name;      // display name, may be empty for built-ins
  std::string path;      // empty for built-ins
  bool builtin = false;
};

// "zh-CN"/"en" or any installed pack code; prefix matching for zh*/en*.
// Unknown codes fall back to English message by message.
void set_language(std::string_view tag);
std::string language();
std::string language_name();

// Picks the language from --lang > IAQS_LANG > config_lang > user default >
// environment (LANG/LC_ALL). Empty or "auto" config_lang is ignored.
void detect_language(std::string_view cli_lang, std::string_view config_lang);

// ------------------------------------------------------------ language packs
std::vector<std::string> language_search_paths();
std::vector<LanguageInfo> available_languages();
bool language_exists(std::string_view code);

// Validates and copies `pack_file` into the first writable search path.
// On failure returns false and fills `error`. On success optionally reports
// the installed language code and display name.
bool install_language(std::string_view pack_file, std::string& error,
                      std::string* installed_code = nullptr,
                      std::string* installed_name = nullptr);
// Removes an installed pack (built-ins cannot be removed).
bool remove_language(std::string_view code, std::string& error);
// Complete pack for `code` (installed messages, English for the rest).
std::string export_language(std::string_view code);

// User-level default language stored in `<IAQS_HOME>/config`.
std::string home_dir();
std::string user_language();
bool set_user_language(std::string_view code, std::string& error);

}  // namespace iaqs::i18n
