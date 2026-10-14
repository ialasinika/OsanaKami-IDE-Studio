/*
 * exec.c - child process bookkeeping and the notification pump.
 *
 * One pump thread serves every run.  It polls each live process with the
 * non-blocking sde_proc_read() offered by the port layer and turns what it
 * finds into notifications.  Polling (15 ms) rather than blocking readers
 * keeps the kernel single-writer: nothing but this thread and the RPC loop
 * writes to stdout, and both go through the same emit callback, which the
 * shell layer serialises behind one mutex.
 */
#include "seide_cfg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "exec.h"
#include "json.h"
#include "port.h"

#define SDE_EXEC_MAX_RUNS    64
#define SDE_EXEC_IDLE_MS     15
#define SDE_EXEC_READ_MAX    8192

typedef struct sde_run {
    long          id;
    char         *card_id;
    char         *cmd;
    char         *cwd;
    sde_proc     *proc;
    int           running;
    int           code;
    unsigned long started;
} sde_run;

struct sde_execset {
    sde_run    *runs;
    size_t      count;
    size_t      cap;
    long        next_id;
    sde_mutex  *lock;
    sde_thread *pump;
    volatile int pump_stop;
    int          pump_started;
    sde_app    *app;
};

/* ---------------------------------------------------------------------- */
/* helpers                                                                */
/* ---------------------------------------------------------------------- */

static void set_err(char *err, size_t errcap, const char *msg)
{
    if (err != NULL && errcap > 0) {
        snprintf(err, errcap, "%s", msg);
    }
}

static sde_json *notification(const char *event, long run_id)
{
    sde_json *n = sde_json_obj();

    if (n == NULL) {
        return NULL;
    }
    sde_json_set(n, "event", sde_json_str(event));
    sde_json_set(n, "run_id", sde_json_int(run_id));
    return n;
}

/*
 * Drops the oldest finished runs so a long session cannot grow without
 * bound.  Called with `lock` held and at least one free slot available.
 */
static void prune_locked(sde_execset *s)
{
    size_t i;

    while (s->count >= SDE_EXEC_MAX_RUNS) {
        size_t victim = s->count; /* none found yet */

        for (i = 0; i < s->count; i++) {
            if (!s->runs[i].running) {
                victim = i;
                break;
            }
        }
        if (victim == s->count) {
            break; /* every run is still alive; let the table grow instead */
        }
        sde_proc_free(s->runs[victim].proc);
        free(s->runs[victim].card_id);
        free(s->runs[victim].cmd);
        free(s->runs[victim].cwd);
        memmove(&s->runs[victim], &s->runs[victim + 1],
                (s->count - victim - 1) * sizeof(sde_run));
        s->count--;
    }
}

/* ---------------------------------------------------------------------- */
/* lifecycle                                                              */
/* ---------------------------------------------------------------------- */

sde_execset *sde_execset_new(void)
{
    sde_execset *s = (sde_execset *) malloc(sizeof(sde_execset));

    if (s == NULL) {
        return NULL;
    }
    s->runs = NULL;
    s->count = 0;
    s->cap = 0;
    s->next_id = 1;
    s->pump = NULL;
    s->pump_stop = 0;
    s->pump_started = 0;
    s->app = NULL;
    s->lock = sde_mutex_new();
    if (s->lock == NULL) {
        free(s);
        return NULL;
    }
    return s;
}

void sde_exec_bind(sde_execset *s, sde_app *app)
{
    if (s != NULL) {
        s->app = app;
    }
}

static void pump_main(void *ud)
{
    sde_execset *s = (sde_execset *) ud;

    while (!s->pump_stop) {
        if (sde_exec_pump(s) == 0) {
            sde_port_sleep_ms(SDE_EXEC_IDLE_MS);
        }
    }
}

static void ensure_pump(sde_execset *s)
{
    if (s->pump_started) {
        return;
    }
    s->pump_started = 1;
    s->pump_stop = 0;
    s->pump = sde_thread_start(pump_main, s);
}

void sde_execset_free(sde_execset *s)
{
    size_t i;

    if (s == NULL) {
        return;
    }
    s->pump_stop = 1;
    if (s->pump != NULL) {
        sde_thread_join(s->pump);
        s->pump = NULL;
    }

    for (i = 0; i < s->count; i++) {
        if (s->runs[i].running) {
            sde_proc_kill(s->runs[i].proc);
        }
        sde_proc_free(s->runs[i].proc);
        free(s->runs[i].card_id);
        free(s->runs[i].cmd);
        free(s->runs[i].cwd);
    }
    free(s->runs);
    sde_mutex_free(s->lock);
    free(s);
}

/* ---------------------------------------------------------------------- */
/* starting and stopping                                                  */
/* ---------------------------------------------------------------------- */

long sde_exec_start(sde_execset *s, const char *card_id, const char *cmd,
                    const char *cwd, char *err, size_t errcap)
{
    sde_proc *proc;
    long      id;

    if (s == NULL || cmd == NULL || cmd[0] == '\0') {
        set_err(err, errcap, "exec.start needs a non-empty `cmd`");
        return -1;
    }

    proc = sde_proc_start(cmd, cwd, err, errcap);
    if (proc == NULL) {
        if (err != NULL && errcap > 0 && err[0] == '\0') {
            set_err(err, errcap, "cannot start process");
        }
        return -1;
    }

    sde_mutex_lock(s->lock);
    prune_locked(s); /* keeps the table bounded; never drops a live run */
    if (s->count == s->cap) {
        size_t   want = (s->cap == 0) ? 8 : s->cap * 2;
        sde_run *grown;

        grown = (sde_run *) realloc(s->runs, want * sizeof(sde_run));
        if (grown == NULL) {
            sde_mutex_unlock(s->lock);
            sde_proc_free(proc);
            set_err(err, errcap, "out of memory");
            return -1;
        }
        s->runs = grown;
        s->cap = want;
    }

    id = s->next_id++;
    s->runs[s->count].id = id;
    s->runs[s->count].card_id = sde_port_strdup(card_id == NULL ? "" : card_id);
    s->runs[s->count].cmd = sde_port_strdup(cmd);
    s->runs[s->count].cwd = sde_port_strdup(cwd == NULL ? "" : cwd);
    s->runs[s->count].proc = proc;
    s->runs[s->count].running = 1;
    s->runs[s->count].code = -1;
    s->runs[s->count].started = sde_port_now_ms();
    s->count++;
    sde_mutex_unlock(s->lock);

    ensure_pump(s);
    return id;
}

int sde_exec_stop(sde_execset *s, long run_id)
{
    size_t i;
    int    found = 0;

    if (s == NULL) {
        return -1;
    }
    sde_mutex_lock(s->lock);
    for (i = 0; i < s->count; i++) {
        if (s->runs[i].id == run_id) {
            found = 1;
            if (s->runs[i].running) {
                sde_proc_kill(s->runs[i].proc);
                s->runs[i].running = 0;
                s->runs[i].code = -1;
            }
            break;
        }
    }
    sde_mutex_unlock(s->lock);
    return found ? 0 : -1;
}

int sde_exec_live_count(const sde_execset *s)
{
    size_t i;
    int    n = 0;

    if (s == NULL) {
        return 0;
    }
    sde_mutex_lock(s->lock);
    for (i = 0; i < s->count; i++) {
        if (s->runs[i].running) {
            n++;
        }
    }
    sde_mutex_unlock(s->lock);
    return n;
}

sde_json *sde_exec_list(const sde_execset *s)
{
    sde_json *out = sde_json_obj();
    sde_json *arr = sde_json_arr();
    size_t    i;

    if (out == NULL || arr == NULL) {
        sde_json_free(out);
        sde_json_free(arr);
        return NULL;
    }

    sde_mutex_lock(s->lock);
    for (i = 0; i < s->count; i++) {
        sde_json *r = sde_json_obj();

        if (r == NULL) {
            continue;
        }
        sde_json_set(r, "run_id", sde_json_int(s->runs[i].id));
        sde_json_set(r, "card_id", sde_json_str(s->runs[i].card_id));
        sde_json_set(r, "cmd", sde_json_str(s->runs[i].cmd));
        sde_json_set(r, "running", sde_json_bool(s->runs[i].running));
        sde_json_set(r, "code", sde_json_int(s->runs[i].code));
        sde_json_set(r, "started", sde_json_int((long) s->runs[i].started));
        sde_json_push(arr, r);
    }
    sde_mutex_unlock(s->lock);

    sde_json_set(out, "runs", arr);
    return out;
}

/* ---------------------------------------------------------------------- */
/* the pump                                                               */
/* ---------------------------------------------------------------------- */

static int pump_one(sde_execset *s, size_t i)
{
    sde_buf   out;
    int       stream = 0;
    long      n;
    int       exited = 0;
    int       code = -1;
    long      run_id;
    sde_json *notif;

    sde_mutex_lock(s->lock);
    if (i >= s->count || s->runs[i].proc == NULL || !s->runs[i].running) {
        sde_mutex_unlock(s->lock);
        return 0;
    }
    run_id = s->runs[i].id;
    sde_buf_init(&out);
    n = sde_proc_read(s->runs[i].proc, &stream, &out, SDE_EXEC_READ_MAX);
    if (n < 0) {
        exited = 1;
        code = sde_proc_exit_code(s->runs[i].proc);
        s->runs[i].running = 0;
        s->runs[i].code = code;
    }
    sde_mutex_unlock(s->lock);

    if (n > 0) {
        notif = notification("exec.output", run_id);
        if (notif != NULL) {
            sde_json_set(notif, "stream",
                         sde_json_str(stream == 'e' ? "stderr" : "stdout"));
            sde_json_set(notif, "data",
                         sde_json_str_n(out.data == NULL ? "" : out.data,
                                        out.len));
            (void) sde_app_notify(s->app, notif);
        }
    }
    sde_buf_free(&out);

    if (exited) {
        notif = notification("exec.exit", run_id);
        if (notif != NULL) {
            sde_json_set(notif, "code", sde_json_int((long) code));
            (void) sde_app_notify(s->app, notif);
        }
    }

    return (n > 0 || exited) ? 1 : 0;
}

int sde_exec_pump(sde_execset *s)
{
    size_t i;
    int    busy = 0;

    if (s == NULL) {
        return 0;
    }
    for (i = 0; i < s->count; i++) {
        /*
         * One read per run per pass keeps output from a chatty process from
         * starving the others, and keeps each notification small enough that
         * the shell never has to buffer a burst.
         */
        busy += pump_one(s, i);
    }
    return busy;
}
