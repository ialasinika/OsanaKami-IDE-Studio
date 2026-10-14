/*
 * board.h - the board document: the thing that replaces tabs and file trees.
 *
 * seIDE's window is one persistent space of cards, not a stack of documents.
 * The kernel's job is small and deliberately blind:
 *
 *   - validate the envelope (ids are unique strings, geometry is numeric)
 *   - persist it to <root>/.seide/board.json, atomically
 *   - hand out card ids that cannot collide
 *
 * The kernel does **not** interpret card kinds.  `editor`, `runner`, `note`,
 * `files`, `project` and `sheet` are conventions the shell implements; a fork
 * that invents `timeline` or `terminal` changes the shell and nothing else.
 * Anything a card carries beyond `id` and the geometry is stored verbatim.
 */
#ifndef SEIDE_BOARD_H
#define SEIDE_BOARD_H

#include <stddef.h>
#include "json.h"

#ifndef SEIDE_APP_TYPEDEF
#define SEIDE_APP_TYPEDEF
typedef struct sde_app sde_app;
#endif

#define SDE_BOARD_VERSION 1
/* Relative to the workspace root; the leading dot keeps it out of listings. */
#define SDE_BOARD_RELPATH ".seide/board.json"

/* C89 has no repeated typedef, so every module that needs the forward
 * declaration guards it the same way app.h does. */
#ifndef SEIDE_BOARD_TYPEDEF
#define SEIDE_BOARD_TYPEDEF
typedef struct sde_board sde_board;
#endif

sde_board *sde_board_new(void);
void       sde_board_free(sde_board *b);

/*
 * Reads <root>/.seide/board.json.  Returns 0 when the file is absent (a
 * first run) or when it parses and validates, and -1 only when the file
 * exists but is unusable -- discarding a user's layout silently would be
 * worse than refusing to start.
 */
int  sde_board_load(sde_board *b, const char *root);

/* Borrowed view of the current document.  Never free it. */
sde_json *sde_board_document(const sde_board *b);

/* Revision of the document as it would be written; the save token. */
unsigned long sde_board_revision(const sde_board *b);

/* Absolute path of the board file (empty string before sde_board_load). */
const char *sde_board_path(const sde_board *b);

/*
 * Validates `doc` (after filling in optional fields) and, on success, adopts
 * it: the board takes ownership and the previous document is freed.
 * On failure `doc` is untouched and the caller keeps ownership.
 */
int  sde_board_adopt(sde_board *b, sde_json *doc, char *err, size_t errcap);

/* Writes the document atomically.  Assumes sde_board_load() has run. */
int  sde_board_save(sde_board *b, char *err, size_t errcap);

/* A fresh "cN" id that no card currently uses.  Malloc'd. */
char *sde_board_next_id(const sde_board *b);

#endif /* SEIDE_BOARD_H */
