/*
 * proc_win32.c - child processes with streamed output (port.h).
 *
 * Each child gets three pipes:
 *
 *   stdin   <- the NUL device, so a runner can never eat the shell's
 *              protocol stream by accident
 *   stdout  -> a reader thread
 *   stderr  -> a reader thread
 *
 * Reader threads append tagged chunks to a small mutex-guarded queue.  The
 * kernel polls that queue from its single main loop, so no part of the IDE
 * outside this file has to know about threads, handles or blocking reads.
 */
#include "infantgod_cfg.h"

#if defined(SDE_PLATFORM_WIN32)

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "port.h"

#define PROC_READ_BUF 4096

typedef struct pchunk {
    struct pchunk *next;
    int            stream;   /* 'o' or 'e' */
    char          *data;
    size_t         len;
    size_t         off;
} pchunk;

struct sde_proc;

typedef struct sde_reader {
    struct sde_proc *proc;
    HANDLE           h;
    int              stream;
} sde_reader;

struct sde_proc {
    HANDLE      process;
    HANDLE      out_read;
    HANDLE      err_read;
    HANDLE      nul;
    sde_thread *t_out;
    sde_thread *t_err;
    sde_reader  readers[2];
    sde_mutex  *lock;
    pchunk     *head;
    pchunk     *tail;
    int         exited;
    int         exit_code;
    volatile LONG readers_done;
};

static void set_err(char *err, size_t cap, const char *msg, const char *detail)
{
    if (err == NULL || cap == 0) {
        return;
    }
    if (detail != NULL) {
        snprintf(err, cap, "%s: %s", msg, detail);
    } else {
        snprintf(err, cap, "%s", msg);
    }
    err[cap - 1] = '\0';
}

static void queue_push(struct sde_proc *p, int stream, char *data, size_t len)
{
    pchunk *c = (pchunk *) malloc(sizeof(pchunk));

    if (c == NULL) {
        free(data);
        return;
    }
    c->next = NULL;
    c->stream = stream;
    c->data = data;
    c->len = len;
    c->off = 0;

    sde_mutex_lock(p->lock);
    if (p->tail == NULL) {
        p->head = c;
        p->tail = c;
    } else {
        p->tail->next = c;
        p->tail = c;
    }
    sde_mutex_unlock(p->lock);
}

static void reader_main(void *ud)
{
    sde_reader     *r = (sde_reader *) ud;
    struct sde_proc *p = r->proc;

    for (;;) {
        char  *buf;
        DWORD  got = 0;

        buf = (char *) malloc(PROC_READ_BUF);
        if (buf == NULL) {
            break;
        }
        if (!ReadFile(r->h, buf, (DWORD) PROC_READ_BUF, &got, NULL)
            || got == 0) {
            free(buf);
            break;
        }
        queue_push(p, r->stream, buf, (size_t) got);
    }
    (void) InterlockedIncrement(&p->readers_done);
}

static int make_pipe(HANDLE *rd, HANDLE *wr)
{
    SECURITY_ATTRIBUTES sa;

    sa.nLength = (DWORD) sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;

    if (!CreatePipe(rd, wr, &sa, 0)) {
        return -1;
    }
    /* The reading end stays ours alone; only the writer is inherited. */
    if (!SetHandleInformation(*rd, HANDLE_FLAG_INHERIT, 0)) {
        CloseHandle(*rd);
        CloseHandle(*wr);
        return -1;
    }
    return 0;
}

sde_proc *sde_proc_start(const char *cmd, const char *cwd,
                         char *err, size_t errcap)
{
    struct sde_proc *p;
    STARTUPINFOA     si;
    PROCESS_INFORMATION pi;
    HANDLE           out_write = NULL;
    HANDLE           err_write = NULL;
    char            *mutable_cmd;
    size_t           n;

    if (cmd == NULL || cmd[0] == '\0') {
        set_err(err, errcap, "empty command line", NULL);
        return NULL;
    }

    p = (struct sde_proc *) malloc(sizeof(struct sde_proc));
    if (p == NULL) {
        set_err(err, errcap, "out of memory", NULL);
        return NULL;
    }
    memset(p, 0, sizeof(*p));
    p->process = NULL;
    p->lock = sde_mutex_new();
    if (p->lock == NULL) {
        free(p);
        set_err(err, errcap, "out of memory", NULL);
        return NULL;
    }

    if (make_pipe(&p->out_read, &out_write) != 0
        || make_pipe(&p->err_read, &err_write) != 0) {
        set_err(err, errcap, "cannot create pipes for", cmd);
        sde_proc_free(p);
        return NULL;
    }

    p->nul = CreateFileA("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         NULL, OPEN_EXISTING, 0, NULL);

    memset(&si, 0, sizeof(si));
    si.cb = (DWORD) sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = (p->nul == INVALID_HANDLE_VALUE) ? NULL : p->nul;
    si.hStdOutput = out_write;
    si.hStdError = err_write;

    n = strlen(cmd);
    mutable_cmd = (char *) malloc(n + 1);
    if (mutable_cmd == NULL) {
        set_err(err, errcap, "out of memory", NULL);
        CloseHandle(out_write);
        CloseHandle(err_write);
        sde_proc_free(p);
        return NULL;
    }
    memcpy(mutable_cmd, cmd, n + 1);

    memset(&pi, 0, sizeof(pi));
    if (!CreateProcessA(NULL, mutable_cmd, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW, NULL,
                        (cwd != NULL && cwd[0] != '\0') ? cwd : NULL,
                        &si, &pi)) {
        DWORD e = GetLastError();
        char  num[32];

        snprintf(num, sizeof(num), "%lu", (unsigned long) e);
        set_err(err, errcap, "cannot start process (win32 error)", num);
        free(mutable_cmd);
        CloseHandle(out_write);
        CloseHandle(err_write);
        sde_proc_free(p);
        return NULL;
    }
    free(mutable_cmd);

    /* Our copies of the write ends must go, or the readers never see EOF. */
    CloseHandle(out_write);
    CloseHandle(err_write);
    CloseHandle(pi.hThread);

    p->process = pi.hProcess;
    p->readers[0].proc = p;
    p->readers[0].h = p->out_read;
    p->readers[0].stream = 'o';
    p->readers[1].proc = p;
    p->readers[1].h = p->err_read;
    p->readers[1].stream = 'e';

    p->t_out = sde_thread_start(reader_main, &p->readers[0]);
    p->t_err = sde_thread_start(reader_main, &p->readers[1]);
    if (p->t_out == NULL || p->t_err == NULL) {
        set_err(err, errcap, "cannot start reader threads", NULL);
        sde_proc_free(p);
        return NULL;
    }
    return p;
}

static void reap(struct sde_proc *p)
{
    DWORD code = 0;

    if (p->exited || p->process == NULL) {
        return;
    }
    if (WaitForSingleObject(p->process, 0) != WAIT_OBJECT_0) {
        return;
    }
    if (GetExitCodeProcess(p->process, &code)) {
        p->exit_code = (int) code;
    }
    p->exited = 1;
}

int sde_proc_running(sde_proc *p)
{
    if (p == NULL) {
        return 0;
    }
    reap(p);
    return p->exited ? 0 : 1;
}

int sde_proc_exit_code(sde_proc *p)
{
    if (p == NULL) {
        return -1;
    }
    reap(p);
    return p->exit_code;
}

void sde_proc_kill(sde_proc *p)
{
    if (p == NULL || p->process == NULL) {
        return;
    }
    reap(p);
    if (!p->exited) {
        (void) TerminateProcess(p->process, 1);
    }
}

long sde_proc_read(sde_proc *p, int *stream, sde_buf *out, size_t max)
{
    pchunk *c;
    size_t  want;
    long    got;

    if (p == NULL) {
        return -1;
    }

    sde_mutex_lock(p->lock);
    c = p->head;
    if (c == NULL) {
        sde_mutex_unlock(p->lock);
        reap(p);
        if (p->exited && p->readers_done >= 2) {
            return -1;
        }
        return 0;
    }

    want = c->len - c->off;
    if (want > max) {
        want = max;
    }
    if (stream != NULL) {
        *stream = c->stream;
    }
    if (sde_buf_add(out, c->data + c->off, want) != 0) {
        sde_mutex_unlock(p->lock);
        return 0;
    }
    c->off += want;
    got = (long) want;

    if (c->off >= c->len) {
        p->head = c->next;
        if (p->head == NULL) {
            p->tail = NULL;
        }
        free(c->data);
        free(c);
    }
    sde_mutex_unlock(p->lock);
    return got;
}

void sde_proc_free(sde_proc *p)
{
    pchunk *c;

    if (p == NULL) {
        return;
    }

    sde_proc_kill(p);
    if (p->t_out != NULL) {
        sde_thread_join(p->t_out);
        p->t_out = NULL;
    }
    if (p->t_err != NULL) {
        sde_thread_join(p->t_err);
        p->t_err = NULL;
    }
    if (p->process != NULL) {
        CloseHandle(p->process);
        p->process = NULL;
    }
    if (p->out_read != NULL) {
        CloseHandle(p->out_read);
        p->out_read = NULL;
    }
    if (p->err_read != NULL) {
        CloseHandle(p->err_read);
        p->err_read = NULL;
    }
    if (p->nul != NULL && p->nul != INVALID_HANDLE_VALUE) {
        CloseHandle(p->nul);
        p->nul = NULL;
    }

    while (p->head != NULL) {
        c = p->head;
        p->head = c->next;
        free(c->data);
        free(c);
    }
    sde_mutex_free(p->lock);
    free(p);
}

#endif /* SDE_PLATFORM_WIN32 */
