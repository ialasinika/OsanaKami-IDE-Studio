/*
 * app.h - the shared state every kernel module is handed.
 *
 * There is exactly one of these per kernel process.  Modules receive it as
 * an opaque pointer plus the accessors they need, which is what lets a fork
 * delete a module (and its fields) without rewriting the others.
 *
 * The `emit` callback is how any module pushes an unsolicited notification
 * to the shell.  In `serve.c` it writes one JSON line to stdout; in tests it
 * can be a recorder.  Nothing else in the kernel writes to stdout.
 *
 * The kernel deliberately knows nothing about programming languages.  There
 * is no tokenizer, no keyword table and no shipped grammar here: language
 * support is a separate, optional layer outside `core/` (see `langs/`), so a
 * fork can delete it, replace it, or never build it at all.
 */
#ifndef INFANTGOD_APP_H
#define INFANTGOD_APP_H

#include <stddef.h>
#include "json.h"

/*
 * The typedef is guarded because C89 has no notion of a repeated typedef, and
 * a module header that wants the forward declaration must not fight app.h
 * over who declares it first.
 */
#ifndef INFANTGOD_APP_TYPEDEF
#define INFANTGOD_APP_TYPEDEF
typedef struct sde_app sde_app;
#endif

#ifndef INFANTGOD_VIEW_TYPEDEF
#define INFANTGOD_VIEW_TYPEDEF
typedef struct sde_view sde_view;
#endif

#ifndef INFANTGOD_EXECSET_TYPEDEF
#define INFANTGOD_EXECSET_TYPEDEF
typedef struct sde_execset sde_execset;
#endif

/*
 * The binary / large-file sessions.  Declared here rather than only in blob.h
 * because every module that is handed `app` can see the field, and because a
 * fork that deletes blob.c deletes this one line with it.
 */
#ifndef INFANTGOD_BLOBSET_TYPEDEF
#define INFANTGOD_BLOBSET_TYPEDEF
typedef struct sde_blobset sde_blobset;
#endif

/* Takes ownership of `payload`.  Returns 0 on success. */
typedef int (*sde_emit_fn)(void *ud, sde_json *payload);

/*
 * How many extra read-only roots the kernel will hold.  A fixed table, not a
 * growable vector: the roots come from the command line once at startup, and a
 * bound makes "how many directories may this process read outside its
 * workspace?" a number a reader can find, not a property of an attacker's
 * argument list.  Eight is enough for a game install plus a handful of
 * satellite folders; a ninth is a refusal with a message, never a realloc.
 */
#define SDE_APP_MAX_READ_ROOTS 8

struct sde_app {
    char        *root;      /* absolute, '/'-separated workspace root */
    /*
     * Reads may also land here; writes may not.  The workspace root is the
     * only writable root, which is what makes `--read-root` a containment pin
     * rather than a second workspace.
     */
    char        *read_roots[SDE_APP_MAX_READ_ROOTS];
    size_t       read_root_count;
    sde_view    *view;      /* the client's view document: opaque JSON */
    sde_execset *execs;     /* running child processes */
    sde_blobset *blobs;     /* open binary / large-file sessions */
    sde_emit_fn  emit;
    void        *emit_ud;
    int          verbose;
};

/*
 * `root` is made absolute and normalised.  `exe_dir` is accepted for
 * forward compatibility and may be NULL.
 */
int  sde_app_init(sde_app *app, const char *root, const char *exe_dir,
                  sde_emit_fn emit, void *ud, char *err, size_t errcap);
void sde_app_free(sde_app *app);

/*
 * Registers one extra directory that the read verbs may resolve under, and
 * that the write verbs must refuse.  `dir` is made absolute and normalised the
 * same way as the workspace root.
 *
 * It refuses a duplicate of the workspace root or of a root already added, a
 * path that exists but is not a directory, and a ninth root.  It deliberately
 * does *not* require the directory to exist yet: a game may be installed after
 * the editor starts, and a root registered for a folder that is not there
 * simply makes reads fail with "no such file" until it appears.  Registration
 * is by path, not by inode: if the directory is deleted and something else is
 * later created at the same path, reads follow that name, exactly as they
 * would for any other file.  Re-registering a game that moved is the user's
 * decision, made again on the command line.
 */
int  sde_app_add_read_root(sde_app *app, const char *dir, char *err, size_t errcap);

/* Sends one notification; the payload must contain an "event" member. */
int  sde_app_notify(sde_app *app, sde_json *payload);

/* Convenience: build {"event":name,key1:val1} and send it. */
void sde_app_emit_simple(sde_app *app, const char *event, const char *key1,
                         const char *val1);

#endif /* INFANTGOD_APP_H */
