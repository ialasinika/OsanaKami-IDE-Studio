/*
 * app.c - construction of the shared kernel state.
 *
 * The kernel starts with an empty view: it reads no document until a client
 * asks for one (`view.load`) and it has no opinion about what a document
 * contains.  A client's file is therefore never a reason for the kernel to
 * refuse to start, which is what a board that did not parse used to be.
 */
#include "infantgod_cfg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "blob.h"
#include "exec.h"
#include "port.h"
#include "view.h"

/*
 * Case-insensitive path equality: both arguments are already absolute and
 * normalised, so "the same directory" is what `within` says in both
 * directions.  The port layer owns the Windows case folding, exactly as it
 * does for containment.
 */
static int same_dir(const char *a, const char *b)
{
    return sde_port_path_within(a, b) && sde_port_path_within(b, a);
}

int sde_app_init(sde_app *app, const char *root, const char *exe_dir,
                 sde_emit_fn emit, void *ud, char *err, size_t errcap)
{
    char *abs_root;

    (void) exe_dir; /* reserved: forks may use it to locate their own assets */

    if (app == NULL) {
        return -1;
    }
    memset(app, 0, sizeof(*app));
    app->emit = emit;
    app->emit_ud = ud;

    abs_root = sde_port_path_abs(root == NULL ? "." : root);
    if (abs_root == NULL) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "cannot resolve workspace root");
        }
        return -1;
    }
    if (!sde_port_is_dir(abs_root)) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "not a directory: %s", abs_root);
        }
        free(abs_root);
        return -1;
    }
    app->root = abs_root;

    app->view = sde_view_new();
    if (app->view == NULL) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "out of memory");
        }
        sde_app_free(app);
        return -1;
    }

    app->execs = sde_execset_new();
    if (app->execs == NULL) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "out of memory");
        }
        sde_app_free(app);
        return -1;
    }
    /* Lets the exec pump thread publish notifications through app->emit. */
    sde_exec_bind(app->execs, app);

    app->blobs = sde_blobset_new();
    if (app->blobs == NULL) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "out of memory");
        }
        sde_app_free(app);
        return -1;
    }

    return 0;
}

int sde_app_add_read_root(sde_app *app, const char *dir, char *err, size_t errcap)
{
    char  *abs;
    size_t i;

    if (app == NULL || app->root == NULL) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "no workspace root");
        }
        return -1;
    }

    /* An empty name would make `path_within()` compare against "": refuse it
     * here rather than turning it into the working directory. */
    if (dir == NULL || dir[0] == '\0') {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "empty read root");
        }
        return -1;
    }

    abs = sde_port_path_abs(dir);
    if (abs == NULL) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "cannot resolve read root");
        }
        return -1;
    }

    /*
     * A path that is there but is a file can never be a root, so it is a
     * mistake worth naming now.  A path that is not there yet is accepted on
     * purpose: the game may be installed after this process starts.
     */
    if (!sde_port_is_dir(abs) && sde_port_file_exists(abs)) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "not a directory: %s", abs);
        }
        free(abs);
        return -1;
    }

    if (same_dir(app->root, abs)) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "duplicate read root: %s", abs);
        }
        free(abs);
        return -1;
    }
    for (i = 0; i < app->read_root_count; i++) {
        if (same_dir(app->read_roots[i], abs)) {
            if (err != NULL && errcap > 0) {
                snprintf(err, errcap, "duplicate read root: %s", abs);
            }
            free(abs);
            return -1;
        }
    }
    if (app->read_root_count >= (size_t) SDE_APP_MAX_READ_ROOTS) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "too many read roots (max %d)",
                     SDE_APP_MAX_READ_ROOTS);
        }
        free(abs);
        return -1;
    }

    app->read_roots[app->read_root_count] = abs;
    app->read_root_count++;
    return 0;
}

void sde_app_free(sde_app *app)
{
    size_t i;

    if (app == NULL) {
        return;
    }
    free(app->root);
    app->root = NULL;
    for (i = 0; i < app->read_root_count; i++) {
        free(app->read_roots[i]);
        app->read_roots[i] = NULL;
    }
    app->read_root_count = 0;
    sde_view_free(app->view);
    app->view = NULL;
    sde_execset_free(app->execs);
    app->execs = NULL;
    sde_blobset_free(app->blobs);
    app->blobs = NULL;
}

int sde_app_notify(sde_app *app, sde_json *payload)
{
    if (app == NULL || app->emit == NULL) {
        sde_json_free(payload);
        return -1;
    }
    return app->emit(app->emit_ud, payload);
}

void sde_app_emit_simple(sde_app *app, const char *event, const char *key1,
                         const char *val1)
{
    sde_json *n = sde_json_obj();

    if (n == NULL) {
        return;
    }
    sde_json_set(n, "event", sde_json_str(event));
    if (key1 != NULL) {
        sde_json_set(n, key1, sde_json_str(val1 == NULL ? "" : val1));
    }
    (void) sde_app_notify(app, n);
}
