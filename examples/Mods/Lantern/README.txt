Lantern -- a worked example mod
===============================

This package exists so the tools have a mod of our own to open, and so that
every file the editor knows how to read appears somewhere in the repository.
It is written for this repository, not copied from the game's own mods: every
byte here was typed, drawn or synthesised for the example.  (The game's own
data is not part of this checkout -- see docs/EDITOR_GAPS.md G26 -- so this is
the package the smoke suite and the installer fall back to.)

Layout: everything a mod can contain
------------------------------------

  mod.json                                 the manifest: name, version and
                                           loadOrder 5 (the game loads higher
                                           numbers later)
  Lantern.yarnproject                      the yarn project: source files, the
                                           language map and the base language
                                           (`zh-CN`), with `en` mapped to
                                           Lantern_en.csv
  Yarn/Lantern.yarn                        the story: two nodes, five spoken
                                           lines, one <<AdvanceTime 1>>, one
                                           <<jump>>
  Yarn/Lantern.csv                         the base table (zh-CN).  The base
                                           language's table carries no language
                                           suffix, exactly as the game ships
                                           it: MyMod's base table is
                                           NewProject.csv
  Yarn/Lantern_en.csv                      the en localisation (one row short
                                           on purpose, see below)

  Sprites/Lantern.png                      32x32, 8-bit RGBA -- the item sprite
  Sprites/Lantern_Glow.png                 32x32, 8-bit RGBA
  Sprites/Warden.png                       32x32, 8-bit RGBA -- the character
  Sprites/Lantern_Rgb.png                  32x32, 8-bit RGB (colour type 2):
                                           the other PNG shape a pixel card can
                                           open.  Read it and the card is
                                           ordinary; save it and the bytes come
                                           back as 8-bit RGBA, because the
                                           reader takes both shapes while the
                                           writer emits one (G20)

  Defines/Character/Warden.json            a character: portrait and
                                           emailPortrait are Sprites/Warden.png,
                                           initialCharacterStates is Calm, and
                                           spineAssetPath names
                                           Spine/Warden_Rig.json
  Defines/CharacterState/Calm.json         a character state: it skins the body
                                           and switches on the pixel animation
                                           below
  Defines/PixelAnimation/Lantern_Idle.json a pixel animation: an onEndBehave, a
                                           bone track with keyframes, a physics
                                           track, and `audioEvent` naming the
                                           audio event below
  Defines/AudioEvent/Audio_Lantern_Hum.json an audio event: its TechName is what
                                           the animation and the voice-over
                                           definition refer to
  Defines/Song/Song_Lantern.json           a song: image Sprites/Lantern.png,
                                           externalAudioFile
                                           Audio/Lantern_Hum.wav
  Defines/VoiceOverDefinition/Vo_Lantern.json a voice-over definition:
                                           mainAudioEvents names the AudioEvent,
                                           programmerEventPath and
                                           voiceOverFiles point at
                                           Audio/Lantern_Voice.wav
  Defines/Attachment/Lantern_On.json       an attachment backed by
                                           Sprites/Lantern.png
  Defines/Attachment/Lantern_Off.json      an attachment backed by
                                           Sprites/Lantern_Glow.png
  Defines/Attachment/Lantern_Broken.json   an attachment whose sprite is missing
                                           on purpose (see below)
  Audio/Lantern_Hum.wav                    8 kHz mono 16-bit PCM, 0.20 s
  Audio/Lantern_Voice.wav                  8 kHz mono 16-bit PCM, 0.15 s.
                                           Synthesised by
                                           build/scratch_make_audio.py: a real
                                           sample would be megabytes, so the
                                           test that needs a big file generates
                                           one at run time instead of committing
                                           it
  Spine/Warden_Rig.json                    a stand-in named by spineAssetPath.
                                           It is not a real Spine asset, and
                                           nothing in the tools opens it (G22)
  README.txt                               this file

The story's tags
----------------

The five spoken lines carry six different tags between them:

  #line:<id>        on all five -- the id the CSV table matches a row by
  #state:Calm       on the first line
  #vo:Vo_Lantern    on the first line, naming the voice-over define
  #Modify:$lantern_lit=false   on the third
  #Topic:Lantern_Awake         on the third
  #Check:$lantern_lit          on the fourth

What the tools make of them is not assumed here, it is measured by
tools/input_smoke.py:

  #line:   known.  Every story row shows its `#line:<id>` badge, and that id is
           what the CSV's `id` column matches.
  #state:  known as a tag name, then judged against the game's own list of
           emotion states.  `Calm` is *this* package's CharacterState, not one
           of the game's states, so the story card warns Y104 for it
           ("unknown #state:Calm") -- useful to see, because it is the warning
           a real mod's invented state would earn too.
  #vo:, #Check:, #Topic:, #Modify:
           not known at all.  The story card keeps them as text and says
           nothing about them: shell/mods/index.js knows exactly three tag
           names (line, state, vo).  Half of the tag surface a mod is likely to
           use therefore reaches the card as an unexplained string, and the
           suite records that rather than pretending otherwise.

Two things are broken on purpose
--------------------------------

An example that validates perfectly proves nothing about the diagnostics, so
two flaws are left in and documented here:

  1. Defines/Attachment/Lantern_Broken.json names Sprites/Missing.png, which is
     not in the package.  `problems Lantern` reports it as D006 ("sprite file
     not found"), and clicking that row opens the pixel card for the missing
     sprite -- not for the define JSON that declared it.

  2. Yarn/Lantern_en.csv is one row short of the story: the last line
     (line:9c0d1e2) has no English row, and the row it does have for
     line:5d6e7f8 carries a lock that does not match the source line.  With the
     story card on Yarn/Lantern.yarn and that table, one line reads "missing"
     and one reads "stale" while the first reads "ok"; the missing row is also
     what the package-level row-count check (M008) reports.

Opening it
----------

From the repository root:

  node shell/main.mjs serve --workspace . --mods-root examples/Mods --no-open

then, in the window:

  problems Lantern
  story examples/Mods/Lantern/Yarn/Lantern.yarn examples/Mods/Lantern/Yarn/Lantern_en.csv
  pixel examples/Mods/Lantern/Sprites/Lantern_Rgb.png

`problems Lantern` should list exactly those two rows and nothing else: the
package is otherwise clean, and every TechName it references resolves inside
the package itself.

What nothing checks (yet)
-------------------------

Three files above name audio -- the song, the voice-over definition and the
pixel animation -- and no part of the tools looks for the .wav files at all:
delete one and `problems` still reports the same two rows (G21).  The same goes
for spineAssetPath, which is why Spine/Warden_Rig.json can be a stub (G22).
And the RGB sprite's saved bytes come back as RGBA (G20).  Those three gaps are
open editor gaps, written up in docs/EDITOR_GAPS.md; the package is shaped so
that whoever closes them has a case to test against.

Copying it into the game
------------------------

The game loads a mod from its own mods folder (on Windows usually
`…\StreamingAssets\Mods\`).  To try this package there, copy the whole `Lantern`
directory into that folder -- `Mods/Lantern` -- and restart the game.  Nothing
in it points outside itself: drop the sprites, the yarn, the tables, the
defines or the audio into a package of your own and it keeps working.  Do not
ship the two deliberate flaws above in a real mod; they are here so the editor
has something to diagnose.

Everything in this package was written for this repository: the sprites were
drawn pixel by pixel by `build/scratch_make_sprites.py`, the two WAVs were
synthesised by `build/scratch_make_audio.py`, the tables were written by
`build/scratch_make_tables.py`, and no file comes from the game's own mods.
