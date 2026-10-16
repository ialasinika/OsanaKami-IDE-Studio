/*
 * view.h - the client's view document: the kernel persists it, and that is all.
 *
 * An InfantGod Studio window is whatever shape its client decided on.  `board` was the
 * shape this project shipped first, and the kernel used to know it: cards,
 * geometry, ids, a validator, and a `.infantgod/board.json` path of its own.  That
 * turned one client's document into the protocol.
 *
 * This module keeps the part that is genuinely the kernel's business -- a JSON
 * document that *exists*:
 *
 *   - read it from a workspace-relative path the client names
 *   - write it back through a temp file and an atomic replace
 *   - hand out a revision a client can compare before overwriting
 *
 * and nothing else.  The document is opaque: the kernel parses it, because a
 * view document is JSON, and never looks inside.  It does not know it is a
 * board, that it has cards, what an id is, or what "x" means.  Any JSON value
 * round-trips verbatim.
 *
 * The schema -- what a *good* board document is -- belongs to the client that
 * uses it.  The reference client's schema lives in `shell/web/board.mjs`;
 * another client would have its own, or none at all.
 */
#ifndef INFANTGOD_VIEW_H
#define INFANTGOD_VIEW_H

#include <stddef.h>
#include "json.h"

#ifndef INFANTGOD_APP_TYPEDEF
#define INFANTGOD_APP_TYPEDEF
typedef struct sde_app sde_app;
#endif

#ifndef INFANTGOD_VIEW_TYPEDEF
#define INFANTGOD_VIEW_TYPEDEF
typedef struct sde_view sde_view;
#endif

/* A document bigger than this is refused instead of parsed into memory. */
#define SDE_VIEW_MAX_READ (4u * 1024u * 1024u)

sde_view *sde_view_new(void);
void      sde_view_free(sde_view *v);

/*
 * Reads `rel` inside the workspace and makes it the view document.  A file
 * that is not there is not an error: the document becomes NULL with revision
 * 0, because a client's first run has no document yet.  Returns 0 on success
 * and -1 with `err` set when the path escapes the workspace, the file cannot
 * be read, is larger than SDE_VIEW_MAX_READ, or does not parse as JSON.  A
 * leading UTF-8 BOM is skipped: Windows editors add one readily, and a
 * document is a document.
 *
 * Nothing is validated beyond "it is JSON", and the kernel has no opinion
 * about the shape.
 */
int sde_view_load(sde_view *v, const sde_app *app, const char *rel,
                  char *err, size_t errcap);

/*
 * Writes `doc` to `rel` inside the workspace and, on success, makes it the
 * view document, taking ownership of `doc`.  Parent directories are created,
 * the bytes go to a `.tmp` neighbour first, and the replace is atomic, so a
 * crash leaves either the old document or the new one.
 *
 * On failure the caller still owns `doc` and the view is unchanged: the file
 * and the kernel's memory agree, or nothing happened.  No revision is checked
 * here -- the caller compares revisions before calling, because only the
 * caller knows which revision it read.
 */
int sde_view_store(sde_view *v, const sde_app *app, const char *rel,
                   sde_json *doc, char *err, size_t errcap);

/* Borrowed, and NULL when no document has been loaded or stored yet. */
sde_json *sde_view_document(const sde_view *v);

/* The canonical hash of the document, or 0 when there is none to hash. */
unsigned long sde_view_revision(const sde_view *v);

/* The path this document was last loaded from or stored to; "" before both. */
const char *sde_view_path(const sde_view *v);

#endif /* INFANTGOD_VIEW_H */
