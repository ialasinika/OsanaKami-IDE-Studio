/*
 * wksp.h - the workspace: files under `root`, plus the read-only roots.
 *
 * Every path the kernel touches goes through one of the three resolve doors
 * declared below.  Writes only ever land under the workspace root; reads may
 * also land under the extra roots the application registered explicitly
 * (`--read-root`), which is how a game's Mods folder can be opened without
 * being made writable.  A fork that wants a sandbox with different rules
 * changes those functions, not every caller.
 *
 * The kernel reports facts about files (text, size, end-of-line style, a
 * content revision).  It deliberately does not guess a file's language: that
 * is the language layer's job, and it lives outside `core/`.
 */
#ifndef INFANTGOD_WKSP_H
#define INFANTGOD_WKSP_H

#include <stddef.h>
#include "json.h"

#ifndef INFANTGOD_APP_TYPEDEF
#define INFANTGOD_APP_TYPEDEF
typedef struct sde_app sde_app;
#endif

/* A file bigger than this is refused rather than pasted into a JSON string. */
#define SDE_WKSP_MAX_READ (4u * 1024u * 1024u)

/* A generous ceiling so a pathological tree cannot stall the kernel. */
#define SDE_WKSP_MAX_LIST 20000L
#define SDE_WKSP_MAX_DEPTH 24

/* Status codes shared by the mutating calls. */
#define SDE_WKSP_OK        0
#define SDE_WKSP_FAIL     -1
#define SDE_WKSP_STALE    -2
/* A request that is not a workspace problem: the base64 would not decode. */
#define SDE_WKSP_BAD_B64  -3

/*
 * The optimistic-concurrency token for a file's contents.  Callers treat it
 * as opaque: compare it, never interpret it.  FNV-1a, 32 bits; the RPC layer
 * carries it as a JSON number.
 *
 * `sde_rev_update()` and `sde_rev_final()` are the same hash in two steps, so a
 * caller that never holds a whole file -- the binary sessions, which can stream
 * a file larger than memory -- hashes it a chunk at a time and still reports
 * the number `sde_rev_of()` would report for the same bytes.  One revision
 * means one thing whichever verb produced it.
 */
#define SDE_REV_SEED 2166136261UL

unsigned long sde_rev_update(unsigned long h, const char *data, size_t len);
unsigned long sde_rev_final(unsigned long h);
unsigned long sde_rev_of(const char *data, size_t len);

/*
 * Resolves a path for a write.  Absolute paths are accepted when they land
 * inside `root`; a path that normalises outside it is refused.  For a path
 * under a registered read-only root the message names that fact
 * ("read-only root"), because "escapes the workspace" would be true but would
 * not tell the user the one thing they can act on.  `*out_abs` is malloc'd.
 */
int sde_wksp_resolve(const sde_app *app, const char *rel, char **out_abs,
                     char *err, size_t errcap);

/*
 * Resolves a path for a read: the workspace root or any root registered with
 * `sde_app_add_read_root()`.  `*out_extra` (when not NULL) is 0 for a path
 * inside the workspace and 1 for a path inside an extra root, which is the
 * provenance a caller needs to know whether a save could ever be allowed
 * there.  `*out_abs` is malloc'd.
 *
 * A path inside none of the roots fails with the workspace message every
 * caller and test already knows: "path escapes the workspace: <rel>".
 */
int sde_wksp_resolve_read(const sde_app *app, const char *rel, char **out_abs,
                          int *out_extra, char *err, size_t errcap);

/*
 * The write-side door: exactly `sde_wksp_resolve()`, except that a path under
 * a read-only root fails with "read-only root" instead of the generic
 * containment message.  Write verbs use this; read verbs use the read door.
 */
int sde_wksp_resolve_write(const sde_app *app, const char *rel, char **out_abs,
                           char *err, size_t errcap);

/* {"root","name","file_count"} -- the shell adds anything it alone knows. */
sde_json *sde_wksp_info(const sde_app *app, char *err, size_t errcap);

/*
 * The directory names `sde_wksp_list()` skips while it walks, in the order the
 * table declares them.  `*count` receives how many.  Callers report these; they
 * must not filter by them, because the listing never contains them.
 */
const char *const *sde_wksp_ignored_dirs(size_t *count);

/*
 * Walks the tree and returns
 * {"files":[{"path","dir","size","mtime"}, ...],"truncated":bool}.
 * `glob` may be NULL (means "**|*"), and matches workspace-relative paths.
 */
sde_json *sde_wksp_list(const sde_app *app, const char *glob, long limit,
                        char *err, size_t errcap);

/* {"path","text","revision","eol","size"} */
sde_json *sde_wksp_read(const sde_app *app, const char *rel,
                        char *err, size_t errcap);

/*
 * {"path","base64","revision","size","mtime"} -- the same file as
 * `sde_wksp_read()` reads, for the files that are not text.
 *
 * The bytes travel base64'd, and that is the only spelling of arbitrary bytes
 * that survives the trip: the protocol carries a string, and `sde_wksp_read()`
 * refuses a NUL byte precisely because a JSON string holding one cannot be
 * round-tripped by every client.  Base64 has no such byte, so this is the verb
 * an image goes through.  The spelling is fixed: the standard alphabet, `=`
 * padding to a multiple of four, and nothing else -- no line breaks, no URL
 * alphabet, no unpadded form.  A client that sends anything else is told so.
 *
 * `revision` is the same FNV-1a number over the same bytes that `sde_wksp_read()`
 * reports for a text file and `sde_wksp_stat()` reports for any file, so a
 * client holds one token whichever verb it read with, and a token from one can
 * be sent to `sde_wksp_write_bytes()` as its `base`.
 */
sde_json *sde_wksp_read_bytes(const sde_app *app, const char *rel,
                              char *err, size_t errcap);

/*
 * {"path","exists","dir","size","mtime","revision"} -- facts about a file
 * without its text, for a client that wants to notice a change made behind its
 * back.  `revision` is the hash `sde_wksp_read()` would report, and 0 when
 * there is nothing to hash (absent, a directory, or larger than the read cap):
 * a caller must read 0 as "cannot compare", not as "empty", because a file that
 * exists and is empty hashes to a real revision.
 *
 * A file holding a NUL byte is hashed like any other.  It was once reported as
 * "no revision to compare" -- on the argument that the number had to be the one
 * `file.read` hands out, and `file.read` refuses such a file.  `file.read_bytes`
 * hands one out for it now, so the argument is gone and the refusal with it: an
 * image that changes behind the client's back is exactly the case this method
 * exists for, and a client cannot watch a file it is told it cannot compare.
 */
sde_json *sde_wksp_stat(const sde_app *app, const char *rel,
                        char *err, size_t errcap);

/*
 * Writes `len` bytes of `text`.  When `has_base` is set, the write fails with
 * SDE_WKSP_STALE unless the file's current revision equals `base`; `*cur_rev`
 * then reports what the file actually holds.
 */
int sde_wksp_write(const sde_app *app, const char *rel, const char *text,
                   size_t len, int has_base, unsigned long base,
                   sde_json **out, unsigned long *cur_rev,
                   char *err, size_t errcap);

/*
 * Writes the bytes `base64` decodes to.  Every rule of `sde_wksp_write()` holds
 * unchanged -- the same resolve, the same cap, the same stale check, the same
 * parent creation, the same `{path, revision, size}` result -- and the only
 * difference is what the bytes mean: nothing.  There is no `text`, so there is
 * no `eol` to report either.
 *
 * The cap applies to the *decoded* bytes, and a payload over it is refused
 * before anything is allocated, so a request cannot ask the kernel to build a
 * 48 MB buffer only to throw it away.
 *
 * A string that is not base64 is a malformed request, not a workspace problem:
 * it returns SDE_WKSP_BAD_B64 with `err` holding the reason, and the RPC layer
 * turns that into INVALID_PARAMS rather than IO.
 */
int sde_wksp_write_bytes(const sde_app *app, const char *rel, const char *base64,
                         int has_base, unsigned long base,
                         sde_json **out, unsigned long *cur_rev,
                         char *err, size_t errcap);

#endif /* INFANTGOD_WKSP_H */
