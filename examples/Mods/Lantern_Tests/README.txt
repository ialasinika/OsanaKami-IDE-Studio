Lantern_Tests -- a deliberately broken Yarn fixture
===================================================

This folder is a package only so that the IDE can open it like any other mod;
it is deliberately broken and it is NOT the default example.  examples/Mods/
Lantern is the worked example; this is the negative fixture that the
diagnostic rules are tested against.

Every name in here is invented.  No game text, no game asset names, no copied
Schema.  Each file exercises one family of the rules described in
docs/MODS.md ("诊断码表", the CR-* column):

  Yarn/broken_tags.yarn    CR-105 / CR-106 / CR-107 / CR-113 / CR-109 / CR-501
  Yarn/broken_groups.yarn  CR-115 / CR-116 (needs its sibling to make a group)
  Yarn/broken_flow.yarn    CR-102 (plus CR-104 with its sibling, CR-201/CR-203)

The clean file is Yarn/clean.yarn: it must produce zero diagnostics, so the
rules are only useful if it stays quiet.

shell/mods/selftest.mjs writes the same cases into a temp directory (so no
result depends on this folder being present) and checks both the broken file
(reports exactly one diagnostic of the rule) and a clean file (reports none).
