/*
 * exec.h - running commands on behalf of `runner` cards.
 *
 * The kernel owns child processes so that the shell does not have to.  A
 * process is identified by a `run_id`; its output arrives as
 * `exec.output` notifications and its end as `exec.exit`, which means the
 * shell can be a pure view with no process bookkeeping of its own.
 *
 * Deleting this module costs the IDE exactly one thing: cards can no longer
 * run anything.  Nothing else references it.
 */
#ifndef INFANTGOD_EXEC_H
#define INFANTGOD_EXEC_H

#include <stddef.h>
#include "json.h"

#ifndef INFANTGOD_APP_TYPEDEF
#define INFANTGOD_APP_TYPEDEF
typedef struct sde_app sde_app;
#endif

#ifndef INFANTGOD_EXECSET_TYPEDEF
#define INFANTGOD_EXECSET_TYPEDEF
typedef struct sde_execset sde_execset;
#endif

sde_execset *sde_execset_new(void);
void         sde_execset_free(sde_execset *s);

/*
 * The set needs an app so that the pump thread can publish notifications.
 * Without a bind, runs still work and output is silently dropped.
 */
void sde_exec_bind(sde_execset *s, sde_app *app);

/*
 * Starts `cmd` through the shell, in `cwd` (absolute; NULL means inherit).
 * Returns the new run id (> 0) or -1 with `err` filled in.
 */
long sde_exec_start(sde_execset *s, const char *card_id, const char *cmd,
                    const char *cwd, char *err, size_t errcap);

/* Kills the run.  Returns 0 if it was known, whether or not it was alive. */
int  sde_exec_stop(sde_execset *s, long run_id);

/* Owned JSON: {"runs":[{run_id,card_id,cmd,pid,running,code,started}]} */
sde_json *sde_exec_list(const sde_execset *s);

/*
 * One polling pass over every live run.  The pump thread calls this; tests
 * call it directly instead of waiting for the thread to wake up.
 * Returns the number of runs that produced output or ended.
 */
int  sde_exec_pump(sde_execset *s);

/* Number of runs that still have a live child. */
int  sde_exec_live_count(const sde_execset *s);

#endif /* INFANTGOD_EXEC_H */
