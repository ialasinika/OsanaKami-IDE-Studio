/**
 * selftest/i18n.mjs -- the words the interface shows, and the hints for codes.
 *
 * Two promises: the two catalogs say the same things (a key added to one and
 * forgotten in the other would render as its key name), and a lookup falls back
 * predictably -- English first, then the key itself.  The hints are pinned by
 * count and by one real code, not by wording: the words are allowed to change.
 */
import assert from "node:assert/strict";
import { test } from "./harness.mjs";
import {
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  getLocale,
  hasMessage,
  kindLabel,
  messageKeys,
  normalizeLocale,
  setLocale,
  t,
  translate,
} from "../i18n.mjs";
import { hintedCodes, hintFor } from "../diagnostic-hints.mjs";
import { CARD_KINDS } from "../board.mjs";

test("i18n: both catalogs name the same keys, and no message is empty", () => {
  const en = messageKeys("en");
  const zh = messageKeys("zh");
  assert.equal(en.length > 80, true, `the catalog is not a stub -- ${en.length} keys`);
  assert.deepEqual([...zh].sort(), [...en].sort(), "a key in one locale is a key in both");
  for (const key of en) {
    const one = translate("en", key);
    const two = translate("zh", key);
    assert.equal(typeof one === "string" && one !== "" && one !== key, true, `${key} has English text`);
    assert.equal(typeof two === "string" && two !== "" && two !== key, true, `${key} has Chinese text`);
  }
  assert.deepEqual([...SUPPORTED_LOCALES].sort(), ["en", "zh"]);
  assert.equal(LOCALE_LABELS.zh, "中文");
  assert.equal(DEFAULT_LOCALE, "en");
});

test("i18n: a browser tag is narrowed to a locale it can honour", () => {
  assert.equal(normalizeLocale("zh"), "zh");
  assert.equal(normalizeLocale("zh-CN"), "zh");
  assert.equal(normalizeLocale("zh-Hans-CN"), "zh");
  assert.equal(normalizeLocale("zh_TW"), "zh");
  assert.equal(normalizeLocale("ZH-cn"), "zh");
  assert.equal(normalizeLocale("en-GB"), "en");
  // Anything the table cannot honour lands on English rather than failing to
  // boot: a French browser sees English, not a half-translated interface.
  assert.equal(normalizeLocale("fr"), "en");
  assert.equal(normalizeLocale(""), "en");
  assert.equal(normalizeLocale(null), "en");
  assert.equal(normalizeLocale(7), "en");
});

test("i18n: the current locale changes the words, and the English one is the fallback", () => {
  setLocale("en");
  assert.equal(getLocale(), "en");
  assert.equal(t("kind.mod"), "Mod");
  setLocale("zh");
  assert.equal(t("kind.mod"), "模组");
  assert.equal(kindLabel("audio"), "音频");
  assert.equal(kindLabel("no-such-kind"), "no-such-kind", "an unknown kind is its own name");
  assert.equal(translate("en", "no.such.key"), "no.such.key", "a missing key is the key");
  assert.equal(hasMessage("en", "kind.mod"), true);
  assert.equal(hasMessage("en", "no.such.key"), false);
  setLocale("en");
  assert.equal(hasMessage("zh", "settings.save"), true);
});

test("i18n: every card kind has a name in both locales", () => {
  for (const kind of CARD_KINDS) {
    for (const locale of SUPPORTED_LOCALES) {
      assert.equal(hasMessage(locale, `kind.${kind}`), true, `${kind} is named in ${locale}`);
    }
    assert.equal(kindLabel(kind) !== kind, true, `${kind} does not fall back to its id`);
  }
});

test("hints: every documented code has a hint, and an unknown code gets none", () => {
  const en = hintedCodes("en");
  assert.equal(en.length >= 30, true, `the hint table is not a stub -- ${en.length} codes`);
  assert.deepEqual([...hintedCodes("zh")].sort(), [...en].sort(), "the hints exist in both locales");
  setLocale("en");
  assert.equal(hintFor("D011").length > 20, true, "D011 explains what to copy from where");
  assert.equal(hintFor("D006").length > 10, true);
  assert.equal(hintFor("NO-SUCH-CODE"), "", "an unknown code is silence, not invented advice");
  setLocale("zh");
  assert.equal(hintFor("D011").length > 20, true, "the same hint exists in Chinese");
  assert.equal(hintFor("NO-SUCH-CODE"), "");
  setLocale("en");
});
