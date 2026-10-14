/*
 * app.c - construction of the shared kernel state.
 *
 * Loading order matters: the board may be absent (first run) but a board
 * document that exists and does not parse is a hard error, because silently
 * discarding a user's layout would be worse than refusing to start.
 */
#include "seide_cfg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "board.h"
#include "exec.h"
#include "port.h"

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

    app->board = sde_board_new();
    if (app->board == NULL) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "out of memory");
        }
        sde_app_free(app);
        return -1;
    }
    if (sde_board_load(app->board, app->root) != 0) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "board document is not valid JSON");
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

    return 0;
}

void sde_app_free(sde_app *app)
{
    if (app == NULL) {
        return;
    }
    free(app->root);
    app->root = NULL;
    sde_board_free(app->board);
    app->board = NULL;
    sde_execset_free(app->execs);
    app->execs = NULL;
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
