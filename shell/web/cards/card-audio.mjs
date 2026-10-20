/**
 * cards/card-audio.mjs -- the audio card: a voice line or a song, played.
 *
 * Part of `cards.mjs`, which re-exports this file; see that file's header for
 * why the card layer is split the way it is.
 *
 * G2: the checks could tell an author that a `VoiceOverDefinition` pointed at a
 * `.wav` under the mod root, and the window could not play it. A recording is
 * not a document: `file.read` refuses binary files, so before this card the only
 * thing clicking one did was open an editor full of replacement characters.
 *
 * The bytes arrive through `file.read_bytes` -- the same capped, contained read
 * the pixel and rig cards use -- and are played from a data URL. That keeps one
 * rule: a card reads project files through the kernel, never through the shell's
 * HTTP routes, which serve the app itself.
 */
import { audioMime, audioSizeLabel, clockLabel, dataUrl } from "../audioinfo.mjs";
import { cardShell, h, makeStatus } from "./dom.mjs";

/** Cards of this kind carry one field: the file they play. */
export function createAudio() {
  return { file: "" };
}

export function renderAudio(card, ctx) {
  const { client } = ctx;
  const file = typeof card.file === "string" ? card.file : "";
  const mime = audioMime(file);

  const note = h("p", "audio-note", { text: "" });
  const status = makeStatus();
  const shell = cardShell(card, h("div", "card-body card-body-audio", {
    children: [note, status],
  }));
  shell.label.textContent = "a recording, not a document";

  function say(text, kind) {
    status.textContent = text;
    status.dataset.kind = kind || "info";
  }

  /** The player is created once and reused for the life of the card. */
  const player = document.createElement("audio");
  player.className = "audio-player";
  player.controls = true;
  player.preload = "metadata";
  player.hidden = true;
  shell.el.querySelector(".card-body").append(player);

  let destroyed = false;

  if (file === "") {
    say("this card has no file — open one from the files card or a problem row");
  } else if (mime === null) {
    say(`${file} is not a recording this card opens`);
  } else {
    note.textContent = file;
    say("reading the recording…");
    (async () => {
      try {
        const result = await client.call("file.read_bytes", { path: file });
        if (destroyed) {
          return;
        }
        const base64 = typeof result.base64 === "string" ? result.base64 : "";
        if (base64 === "") {
          throw new Error("the file is empty");
        }
        const size = typeof result.size === "number" ? result.size : null;
        note.textContent = size === null ? file : `${file} · ${audioSizeLabel(size)}`;
        player.src = dataUrl(base64, mime);
        player.hidden = false;
        player.addEventListener("loadedmetadata", () => {
          if (!destroyed) {
            say(`${clockLabel(player.duration)} of audio — press play`);
          }
        }, { once: true });
        player.addEventListener("error", () => {
          if (!destroyed) {
            say("the bytes are not a recording this browser can decode", "warn");
            player.hidden = true;
          }
        }, { once: true });
        say("loaded — press play");
      } catch (err) {
        if (!destroyed) {
          say(String(err && err.message ? err.message : err), "warn");
        }
      }
    })();
  }

  const handle = {
    kind: "audio",
    path: () => file,
    focus() {
      if (!player.hidden) {
        player.focus();
      }
    },
  };

  return {
    el: shell.el,
    handle,
    destroy() {
      destroyed = true;
      player.pause();
      player.removeAttribute("src");
      player.load();
    },
  };
}
