/*
 * board.c - validation and atomic persistence of the board document.
 *
 * The rule this file follows: the kernel checks the shape a canvas needs
 * (unique ids, numeric geometry, links that point at something) and stores
 * everything else without looking at it.  Card kinds are the fork's business.
 */
#include "seide_cfg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "board.h"
#include "buf.h"
#include "json.h"
#include "port.h"
#include "wksp.h"

struct sde_board {
    char     *root;      /* workspace root, or NULL before load */
    char     *path;      /* <root>/.seide/board.json */
    char     *tmp_path;  /* <root>/.seide/board.json.tmp */
    sde_json *doc;       /* always a valid envelope */
};

/* ---------------------------------------------------------------------- */
/* small helpers                                                          */
/* ---------------------------------------------------------------------- */

static int is_obj(const sde_json *v)
{
    return v != NULL && v->type == SDE_JSON_OBJ;
}

static int is_arr(const sde_json *v)
{
    return v != NULL && v->type == SDE_JSON_ARR;
}

static int is_str(const sde_json *v)
{
    return v != NULL && v->type == SDE_JSON_STR;
}

static int is_num(const sde_json *v)
{
    return v != NULL && v->type == SDE_JSON_NUM;
}

static void set_err(char *err, size_t errcap, const char *msg)
{
    if (err != NULL && errcap > 0) {
        snprintf(err, errcap, "%s", msg);
    }
}

static void set_err_at(char *err, size_t errcap, const char *where,
                       const char *msg)
{
    if (err != NULL && errcap > 0) {
        snprintf(err, errcap, "%s: %s", where, msg);
    }
}

static sde_json *default_document(void)
{
    sde_json *doc = sde_json_obj();
    sde_json *vp;

    if (doc == NULL) {
        return NULL;
    }
    sde_json_set(doc, "version", sde_json_int(SDE_BOARD_VERSION));

    vp = sde_json_obj();
    if (vp != NULL) {
        sde_json_set(vp, "x", sde_json_num(0.0));
        sde_json_set(vp, "y", sde_json_num(0.0));
        sde_json_set(vp, "zoom", sde_json_num(1.0));
        sde_json_set(doc, "viewport", vp);
    }
    sde_json_set(doc, "cards", sde_json_arr());
    sde_json_set(doc, "links", sde_json_arr());
    return doc;
}

/*
 * Fills in the fields a document is allowed to omit.  Runs before
 * validation so that a hand-written board.json only has to be correct about
 * the parts that genuinely carry meaning.
 *
 * Two rules, and the second one is the important one:
 *
 *  1. A field that is *absent* may be defaulted.  A field that is *present
 *     but the wrong type* is never touched here, so that validate() can
 *     reject it.  Repairing it would hide the caller's bug.
 *
 *  2. `cards` and `links` are only ever synthesized when `make_arrays` is
 *     set, which happens for a file read off disk (a hand-written board may
 *     legitimately leave them out).  A document that arrives over the wire
 *     must carry both: defaulting them to empty turns "your client sent
 *     nonsense" into "your board is now empty", and the caller is told the
 *     save succeeded.  That is the one failure mode a board-first IDE must
 *     never have.
 */
static void fill_defaults(sde_json *doc, int make_arrays)
{
    sde_json *vp;
    sde_json *cards;
    size_t    i;

    if (!is_obj(doc)) {
        return;
    }

    if (sde_json_get(doc, "version") == NULL) {
        sde_json_set(doc, "version", sde_json_int(SDE_BOARD_VERSION));
    }

    vp = sde_json_get(doc, "viewport");
    if (vp == NULL) {
        vp = sde_json_obj();
        if (vp != NULL) {
            sde_json_set(vp, "x", sde_json_num(0.0));
            sde_json_set(vp, "y", sde_json_num(0.0));
            sde_json_set(vp, "zoom", sde_json_num(1.0));
            sde_json_set(doc, "viewport", vp);
        }
    } else if (is_obj(vp)) {
        if (!is_num(sde_json_get(vp, "x"))) {
            sde_json_set(vp, "x", sde_json_num(0.0));
        }
        if (!is_num(sde_json_get(vp, "y"))) {
            sde_json_set(vp, "y", sde_json_num(0.0));
        }
        if (!is_num(sde_json_get(vp, "zoom"))) {
            sde_json_set(vp, "zoom", sde_json_num(1.0));
        }
    }

    cards = sde_json_get(doc, "cards");
    if (cards == NULL && make_arrays) {
        sde_json_set(doc, "cards", sde_json_arr());
    } else if (is_arr(cards)) {
        for (i = 0; i < sde_json_count(cards); i++) {
            sde_json *c = sde_json_at(cards, i);
            if (is_obj(c) && !is_num(sde_json_get(c, "z"))) {
                sde_json_set(c, "z", sde_json_int(0));
            }
        }
    }

    if (sde_json_get(doc, "links") == NULL && make_arrays) {
        sde_json_set(doc, "links", sde_json_arr());
    }
}

/*
 * Identity lookups used to be a linear scan per card and per link, which made
 * validating an N-card board O(N^2): a 20 000-card save took 72 seconds and
 * outlived every client's patience.  Collecting the ids once and sorting them
 * makes the same checks O(N log N).
 */
typedef struct board_id {
    const char *id;
    size_t      index;
} board_id;

static int cmp_board_id(const void *a, const void *b)
{
    const board_id *x = (const board_id *) a;
    const board_id *y = (const board_id *) b;

    return strcmp(x->id, y->id);
}

/*
 * Fill *out with the ids of `items` sorted by id.  Items that are not objects,
 * or that carry no string id, are skipped: their shape is check_card's or
 * check_links' business, not this function's.
 */
static int build_ids(const sde_json *items, board_id **out, size_t *out_count,
                     char *err, size_t errcap)
{
    size_t    n = sde_json_count(items);
    board_id *ids;
    size_t    count = 0;
    size_t    i;

    *out = NULL;
    *out_count = 0;
    if (n == 0) {
        return 0;
    }
    ids = (board_id *) malloc(n * sizeof(board_id));
    if (ids == NULL) {
        set_err(err, errcap, "out of memory");
        return -1;
    }
    for (i = 0; i < n; i++) {
        const char *id =
            sde_json_as_str(sde_json_get(sde_json_at(items, i), "id"));

        if (id != NULL) {
            ids[count].id = id;
            ids[count].index = i;
            count++;
        }
    }
    qsort(ids, count, sizeof(board_id), cmp_board_id);
    *out = ids;
    *out_count = count;
    return 0;
}

static const board_id *lookup_id(const board_id *ids, size_t count,
                                 const char *id)
{
    size_t lo = 0;
    size_t hi = count;

    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        int    cmp = strcmp(ids[mid].id, id);

        if (cmp == 0) {
            return &ids[mid];
        }
        if (cmp < 0) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return NULL;
}

/* Report the first duplicate in an already-sorted id array, if any. */
static int first_duplicate(const board_id *ids, size_t count, const char *label,
                           char *err, size_t errcap)
{
    size_t i;

    for (i = 1; i < count; i++) {
        if (strcmp(ids[i - 1].id, ids[i].id) == 0) {
            char where[48];

            snprintf(where, sizeof(where), "%s[%lu]", label,
                     (unsigned long) ids[i].index);
            set_err_at(err, errcap, where, "duplicate `id`");
            return -1;
        }
    }
    return 0;
}

static int check_card(const sde_json *card, size_t index,
                      char *err, size_t errcap)
{
    char            where[48];
    const sde_json *v;
    size_t          j;

    snprintf(where, sizeof(where), "cards[%lu]", (unsigned long) index);

    if (!is_obj(card)) {
        set_err_at(err, errcap, where, "card must be a JSON object");
        return -1;
    }
    if (!is_str(sde_json_get(card, "id"))
        || sde_json_as_str(sde_json_get(card, "id"))[0] == '\0') {
        set_err_at(err, errcap, where, "missing non-empty string `id`");
        return -1;
    }
    if (!is_str(sde_json_get(card, "kind"))
        || sde_json_as_str(sde_json_get(card, "kind"))[0] == '\0') {
        set_err_at(err, errcap, where, "missing non-empty string `kind`");
        return -1;
    }
    {
        static const char *geom[] = { "x", "y", "w", "h" };
        for (j = 0; j < 4; j++) {
            v = sde_json_get(card, geom[j]);
            if (!is_num(v)) {
                char msg[64];
                snprintf(msg, sizeof(msg),
                         "missing numeric `%s`", geom[j]);
                set_err_at(err, errcap, where, msg);
                return -1;
            }
        }
    }

    /* Ids must be unique: two cards sharing one identity is unrenderable. */
    return 0;
}

static int check_links(const sde_json *links, const board_id *card_ids,
                       size_t card_count, char *err, size_t errcap)
{
    board_id *link_ids;
    size_t    link_count;
    size_t    i;

    for (i = 0; i < sde_json_count(links); i++) {
        const sde_json *l = sde_json_at(links, i);
        const char     *from;
        const char     *to;
        char            where[48];

        snprintf(where, sizeof(where), "links[%lu]", (unsigned long) i);

        if (!is_obj(l)) {
            set_err_at(err, errcap, where, "link must be a JSON object");
            return -1;
        }
        from = sde_json_as_str(sde_json_get(l, "from"));
        to = sde_json_as_str(sde_json_get(l, "to"));
        if (from == NULL || to == NULL) {
            set_err_at(err, errcap, where,
                       "missing string `from` and `to`");
            return -1;
        }
        if (lookup_id(card_ids, card_count, from) == NULL) {
            set_err_at(err, errcap, where, "`from` names no card");
            return -1;
        }
        if (lookup_id(card_ids, card_count, to) == NULL) {
            set_err_at(err, errcap, where, "`to` names no card");
            return -1;
        }
    }

    /*
     * A link id is how a client names one edge -- `unlink`, a selection, a
     * highlight.  Two edges sharing one identity makes that ambiguous, in
     * exactly the way two cards sharing an id would.  A link with no id at all
     * is left alone: it has no identity to collide with.
     */
    if (build_ids(links, &link_ids, &link_count, err, errcap) != 0) {
        return -1;
    }
    i = (size_t) first_duplicate(link_ids, link_count, "links", err, errcap);
    free(link_ids);
    return (int) i;
}

static int validate(const sde_json *doc, char *err, size_t errcap)
{
    const sde_json *cards;
    const sde_json *links;
    board_id       *card_ids;
    size_t          card_count;
    size_t          i;
    int             rc;

    if (!is_obj(doc)) {
        set_err(err, errcap, "board document must be a JSON object");
        return -1;
    }
    if (!is_num(sde_json_get(doc, "version"))) {
        set_err(err, errcap, "board `version` must be a number");
        return -1;
    }
    if (!is_obj(sde_json_get(doc, "viewport"))) {
        set_err(err, errcap, "board `viewport` must be an object");
        return -1;
    }

    cards = sde_json_get(doc, "cards");
    if (!is_arr(cards)) {
        set_err(err, errcap, "board `cards` must be an array");
        return -1;
    }
    for (i = 0; i < sde_json_count(cards); i++) {
        if (check_card(sde_json_at(cards, i), i, err, errcap) != 0) {
            return -1;
        }
    }
    if (build_ids(cards, &card_ids, &card_count, err, errcap) != 0) {
        return -1;
    }
    if (first_duplicate(card_ids, card_count, "cards", err, errcap) != 0) {
        free(card_ids);
        return -1;
    }

    links = sde_json_get(doc, "links");
    if (!is_arr(links)) {
        free(card_ids);
        set_err(err, errcap, "board `links` must be an array");
        return -1;
    }
    rc = check_links(links, card_ids, card_count, err, errcap);
    free(card_ids);
    return rc;
}

/* ---------------------------------------------------------------------- */
/* lifecycle                                                              */
/* ---------------------------------------------------------------------- */

sde_board *sde_board_new(void)
{
    sde_board *b = (sde_board *) malloc(sizeof(sde_board));

    if (b == NULL) {
        return NULL;
    }
    b->root = NULL;
    b->path = NULL;
    b->tmp_path = NULL;
    b->doc = default_document();
    if (b->doc == NULL) {
        free(b);
        return NULL;
    }
    return b;
}

void sde_board_free(sde_board *b)
{
    if (b == NULL) {
        return;
    }
    free(b->root);
    free(b->path);
    free(b->tmp_path);
    sde_json_free(b->doc);
    free(b);
}

int sde_board_load(sde_board *b, const char *root)
{
    char      err[256];
    sde_buf   buf;
    sde_json *doc;

    if (b == NULL) {
        return -1;
    }
    err[0] = '\0';

    free(b->root);
    free(b->path);
    free(b->tmp_path);
    b->root = (root == NULL) ? NULL : sde_port_strdup(root);

    if (b->root == NULL) {
        return 0;
    }
    b->path = sde_port_path_join(b->root, SDE_BOARD_RELPATH);
    b->tmp_path = sde_port_path_join(b->root, SDE_BOARD_RELPATH ".tmp");

    if (b->path == NULL || !sde_port_file_exists(b->path)) {
        return 0; /* first run: the default document stands */
    }

    sde_buf_init(&buf);
    if (sde_port_read_file(b->path, &buf, err, sizeof(err)) != 0) {
        sde_buf_free(&buf);
        return -1;
    }

    {
        /*
         * A board.json that has been through Notepad, or through PowerShell's
         * `Set-Content -Encoding utf8`, starts with a UTF-8 BOM.  JSON does not
         * allow one, so refusing the file would brick the editor over three
         * invisible bytes that the writer added on its own.
         */
        const char *text = (buf.data == NULL) ? "" : buf.data;
        size_t      len = buf.len;

        if (len >= 3 && (unsigned char) text[0] == 0xEF
            && (unsigned char) text[1] == 0xBB
            && (unsigned char) text[2] == 0xBF) {
            text += 3;
            len -= 3;
        }
        doc = sde_json_parse(text, len, err, sizeof(err));
    }
    sde_buf_free(&buf);
    if (doc == NULL) {
        return -1;
    }

    fill_defaults(doc, 1);
    if (validate(doc, err, sizeof(err)) != 0) {
        sde_json_free(doc);
        return -1;
    }

    sde_json_free(b->doc);
    b->doc = doc;
    return 0;
}

sde_json *sde_board_document(const sde_board *b)
{
    return (b == NULL) ? NULL : b->doc;
}

const char *sde_board_path(const sde_board *b)
{
    if (b == NULL || b->path == NULL) {
        return "";
    }
    return b->path;
}

int sde_board_adopt(sde_board *b, sde_json *doc, char *err, size_t errcap)
{
    if (b == NULL || doc == NULL) {
        set_err(err, errcap, "no document");
        return -1;
    }
    fill_defaults(doc, 0);
    if (validate(doc, err, errcap) != 0) {
        return -1;
    }
    sde_json_free(b->doc);
    b->doc = doc;
    return 0;
}

unsigned long sde_board_revision(const sde_board *b)
{
    sde_buf       out;
    unsigned long rev;

    if (b == NULL || b->doc == NULL) {
        return 0;
    }
    sde_buf_init(&out);
    /*
     * The canonical form, not the wire order: two clients holding the same
     * board must agree on its revision even if they listed its members
     * differently, or every hand-off between them looks like a lost update.
     */
    if (sde_json_write_canonical(&out, b->doc) != 0) {
        sde_buf_free(&out);
        return 0;
    }
    rev = sde_rev_of(out.data == NULL ? "" : out.data, out.len);
    sde_buf_free(&out);
    return rev;
}

int sde_board_save(sde_board *b, char *err, size_t errcap)
{
    sde_buf out;
    char   *dir;
    int    rc;

    if (b == NULL || b->doc == NULL) {
        set_err(err, errcap, "no board document");
        return -1;
    }
    if (b->path == NULL || b->tmp_path == NULL) {
        set_err(err, errcap, "board has no workspace root");
        return -1;
    }

    dir = sde_port_path_join(b->root, ".seide");
    if (dir != NULL) {
        if (sde_port_mkdirs(dir, err, errcap) != 0) {
            free(dir);
            return -1;
        }
        free(dir);
    }

    sde_buf_init(&out);
    /* Pretty-printed because a board file is something a human diffs. */
    if (sde_json_write_pretty(&out, b->doc, 2) != 0
        || sde_buf_addc(&out, '\n') != 0) {
        sde_buf_free(&out);
        set_err(err, errcap, "cannot serialise board");
        return -1;
    }

    rc = sde_port_write_file(b->tmp_path, out.data, out.len, err, errcap);
    sde_buf_free(&out);
    if (rc != 0) {
        return -1;
    }
    return sde_port_replace_file(b->tmp_path, b->path);
}

char *sde_board_next_id(const sde_board *b)
{
    const sde_json *cards;
    char           *out;
    unsigned long   best = 0;
    size_t          i;
    size_t          n;

    if (b == NULL || b->doc == NULL) {
        return sde_port_strdup("c1");
    }
    cards = sde_json_get(b->doc, "cards");

    for (i = 0; i < sde_json_count(cards); i++) {
        const char *id = sde_json_as_str(
            sde_json_get(sde_json_at(cards, i), "id"));
        const char *p;
        unsigned long v = 0;
        int seen = 1;

        if (id == NULL || id[0] != 'c') {
            continue;
        }
        for (p = id + 1; *p != '\0'; p++) {
            if (*p < '0' || *p > '9') {
                seen = 0;
                break;
            }
            v = v * 10UL + (unsigned long) (*p - '0');
        }
        if (seen && p != id + 1 && v > best) {
            best = v;
        }
    }

    out = (char *) malloc(32);
    if (out == NULL) {
        return NULL;
    }
    n = (size_t) snprintf(out, 32, "c%lu", best + 1UL);
    (void) n;
    return out;
}
