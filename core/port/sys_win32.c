/*
 * sys_win32.c - Win32 implementation of port.h (time, files, dirs, paths,
 * threads, standard streams).
 *
 * A fork that targets another platform writes a sibling of this file; the
 * kernel never includes <windows.h> itself.
 */
#include "infantgod_cfg.h"

#if defined(SDE_PLATFORM_WIN32)

#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <direct.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "port.h"

/* ====================================================================== */
/* helpers                                                                */
/* ====================================================================== */

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

static int is_sep(char c)
{
    return (c == '/' || c == '\\') ? 1 : 0;
}

/* ====================================================================== */
/* startup                                                                */
/* ====================================================================== */

void sde_port_startup(void)
{
    static int done = 0;
    HANDLE     h;

    if (done) {
        return;
    }
    done = 1;

    /*
     * MinGW's text mode would turn every '\n' in a protocol frame into
     * "\r\n"; the protocol is byte-exact, so force binary.
     */
    (void) _setmode(_fileno(stdin), _O_BINARY);
    (void) _setmode(_fileno(stdout), _O_BINARY);
    (void) _setmode(_fileno(stderr), _O_BINARY);

    /*
     * Children get their own pipes (see sde_proc_start).  Leaving our own
     * handles inheritable as well would let a child hold the shell's pipes
     * open, so drop the flag here.
     */
    h = GetStdHandle(STD_INPUT_HANDLE);
    if (h != NULL && h != INVALID_HANDLE_VALUE) {
        (void) SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
    }
    h = GetStdHandle(STD_OUTPUT_HANDLE);
    if (h != NULL && h != INVALID_HANDLE_VALUE) {
        (void) SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
    }
    h = GetStdHandle(STD_ERROR_HANDLE);
    if (h != NULL && h != INVALID_HANDLE_VALUE) {
        (void) SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
    }
}

/* ====================================================================== */
/* time                                                                   */
/* ====================================================================== */

unsigned long sde_port_now_ms(void)
{
    return (unsigned long) GetTickCount64();
}

void sde_port_sleep_ms(unsigned long ms)
{
    Sleep((DWORD) ms);
}

/* ====================================================================== */
/* standard streams                                                       */
/* ====================================================================== */

static int raw_write(HANDLE h, const char *data, size_t len)
{
    size_t done = 0;

    while (done < len) {
        DWORD chunk = (DWORD) (len - done);
        DWORD wrote = 0;

        if (chunk > 1u << 20) {
            chunk = 1u << 20;
        }
        if (!WriteFile(h, data + done, chunk, &wrote, NULL) || wrote == 0) {
            return -1;
        }
        done += (size_t) wrote;
    }
    return 0;
}

int sde_port_stdout_write(const char *data, size_t len)
{
    return raw_write(GetStdHandle(STD_OUTPUT_HANDLE), data, len);
}

int sde_port_stderr_write(const char *data, size_t len)
{
    return raw_write(GetStdHandle(STD_ERROR_HANDLE), data, len);
}

/* ====================================================================== */
/* paths                                                                  */
/* ====================================================================== */

int sde_port_path_is_abs(const char *p)
{
    if (p == NULL || p[0] == '\0') {
        return 0;
    }
    if (is_sep(p[0])) {
        return 1;
    }
    if (((p[0] >= 'a' && p[0] <= 'z') || (p[0] >= 'A' && p[0] <= 'Z'))
        && p[1] == ':') {
        return 1;
    }
    return 0;
}

/* Appends one component to a NUL-terminated component list. */
static int comps_push(sde_vec *v, const char *s, size_t n)
{
    char *copy;

    copy = (char *) malloc(n + 1);
    if (copy == NULL) {
        return -1;
    }
    memcpy(copy, s, n);
    copy[n] = '\0';
    if (sde_vec_push(v, copy) != 0) {
        free(copy);
        return -1;
    }
    return 0;
}

static void comps_free(sde_vec *v)
{
    size_t i;

    for (i = 0; i < v->count; i++) {
        free(v->items[i]);
    }
    sde_vec_free(v);
}

char *sde_port_path_norm_into(const char *p, sde_buf *out)
{
    sde_buf  pre;
    sde_vec  comps;
    const char *s;
    size_t   i;
    int      absolute = 0;

    if (p == NULL) {
        p = "";
    }

    sde_buf_init(&pre);
    sde_vec_init(&comps);
    s = p;

    if (((s[0] >= 'a' && s[0] <= 'z') || (s[0] >= 'A' && s[0] <= 'Z'))
        && s[1] == ':') {
        if (sde_buf_addc(&pre, s[0]) != 0
            || sde_buf_addc(&pre, ':') != 0) {
            goto oom;
        }
        s += 2;
        if (is_sep(*s)) {
            if (sde_buf_addc(&pre, '/') != 0) {
                goto oom;
            }
            while (is_sep(*s)) {
                s++;
            }
        }
        absolute = 1;
    } else if (is_sep(*s)) {
        int unc = 0;

        if (is_sep(s[1])) {
            unc = 1;
        }
        while (is_sep(*s)) {
            s++;
        }
        if (sde_buf_adds(&pre, unc ? "//" : "/") != 0) {
            goto oom;
        }
        absolute = 1;

        if (unc) {
            int taken;

            for (taken = 0; taken < 2; taken++) {
                const char *seg = s;
                size_t      n;

                while (*s != '\0' && !is_sep(*s)) {
                    s++;
                }
                n = (size_t) (s - seg);
                if (n == 0) {
                    break;
                }
                if (taken > 0 && sde_buf_addc(&pre, '/') != 0) {
                    goto oom;
                }
                if (sde_buf_add(&pre, seg, n) != 0) {
                    goto oom;
                }
                while (is_sep(*s)) {
                    s++;
                }
            }
        }
    }

    while (*s != '\0') {
        const char *seg = s;
        size_t      n;

        while (*s != '\0' && !is_sep(*s)) {
            s++;
        }
        n = (size_t) (s - seg);
        while (is_sep(*s)) {
            s++;
        }

        if (n == 0 || (n == 1 && seg[0] == '.')) {
            continue;
        }
        if (n == 2 && seg[0] == '.' && seg[1] == '.') {
            if (comps.count > 0) {
                free(comps.items[comps.count - 1]);
                comps.count--;
            } else if (!absolute) {
                if (comps_push(&comps, "..", 2) != 0) {
                    goto oom;
                }
            }
            continue;
        }
        if (comps_push(&comps, seg, n) != 0) {
            goto oom;
        }
    }

    /* pre already ends in '/' for rooted paths; a bare drive has no room. */
    if (sde_buf_add(&pre, "", 0) != 0) {
        goto oom;
    }
    if (pre.len > 0 && pre.data[pre.len - 1] != '/' && comps.count > 0) {
        if (sde_buf_addc(&pre, '/') != 0) {
            goto oom;
        }
    }
    for (i = 0; i < comps.count; i++) {
        if (i > 0 && sde_buf_addc(&pre, '/') != 0) {
            goto oom;
        }
        if (sde_buf_adds(&pre, (const char *) comps.items[i]) != 0) {
            goto oom;
        }
    }

    if (pre.len == 0) {
        if (sde_buf_adds(&pre, ".") != 0) {
            goto oom;
        }
    }

    comps_free(&comps);
    if (sde_buf_add(out, pre.data, pre.len) != 0) {
        sde_buf_free(&pre);
        return NULL;
    }
    sde_buf_free(&pre);
    return out->data;

oom:
    comps_free(&comps);
    sde_buf_free(&pre);
    return NULL;
}

char *sde_port_path_norm(const char *p)
{
    sde_buf b;
    char   *r;

    sde_buf_init(&b);
    r = sde_port_path_norm_into(p, &b);
    if (r == NULL) {
        sde_buf_free(&b);
        return NULL;
    }
    return sde_buf_take(&b);
}

char *sde_port_path_join(const char *a, const char *b)
{
    sde_buf cat;
    char   *r;

    if (b == NULL) {
        b = "";
    }
    if (a == NULL || a[0] == '\0' || sde_port_path_is_abs(b)) {
        return sde_port_path_norm(b);
    }
    sde_buf_init(&cat);
    if (sde_buf_adds(&cat, a) != 0
        || sde_buf_addc(&cat, '/') != 0
        || sde_buf_adds(&cat, b) != 0) {
        sde_buf_free(&cat);
        return NULL;
    }
    r = sde_port_path_norm(sde_buf_cstr(&cat));
    sde_buf_free(&cat);
    return r;
}

char *sde_port_path_abs(const char *p)
{
    char  cwd[1024];
    char *r;

    if (p != NULL && sde_port_path_is_abs(p)) {
        return sde_port_path_norm(p);
    }
    if (_getcwd(cwd, (int) sizeof(cwd)) == NULL) {
        return sde_port_path_norm(p);
    }
    r = sde_port_path_join(cwd, p);
    return r;
}

static char *lower_dup(const char *s)
{
    size_t n = strlen(s);
    char  *c = (char *) malloc(n + 1);
    size_t i;

    if (c == NULL) {
        return NULL;
    }
    for (i = 0; i <= n; i++) {
        char ch = s[i];
        c[i] = (ch >= 'A' && ch <= 'Z') ? (char) (ch - 'A' + 'a') : ch;
    }
    return c;
}

/* Does `pa` name `ra` itself, or something below it?  Both are absolute. */
static int within_pair(const char *ra, const char *pa)
{
    char  *rl;
    char  *pl;
    size_t rlen;
    int    yes = 0;

    rl = lower_dup(ra);
    pl = lower_dup(pa);
    if (rl == NULL || pl == NULL) {
        free(rl);
        free(pl);
        return 0;
    }
    rlen = strlen(rl);
    while (rlen > 1 && rl[rlen - 1] == '/') {
        rl[--rlen] = '\0';
    }
    if (strcmp(rl, pl) == 0) {
        yes = 1;
    } else if (strlen(pl) > rlen && strncmp(rl, pl, rlen) == 0
               && pl[rlen] == '/') {
        yes = 1;
    }
    free(rl);
    free(pl);
    return yes;
}

/* The "\\?\" prefixes Windows puts on a resolved name, removed the way a
 * client would write the same path. */
static char *strip_win_prefix(const char *resolved)
{
    size_t len;

    if (strncmp(resolved, "\\\\?\\UNC\\", 8) == 0) {
        len = strlen(resolved + 8);
        {
            char *out = (char *) malloc(len + 3);
            if (out == NULL) {
                return NULL;
            }
            out[0] = '\\';
            out[1] = '\\';
            memcpy(out + 2, resolved + 8, len + 1);
            return out;
        }
    }
    if (strncmp(resolved, "\\\\?\\", 4) == 0) {
        return sde_port_strdup(resolved + 4);
    }
    return sde_port_strdup(resolved);
}

/*
 * What the filesystem actually resolves `abs` to, with the not-yet-existing
 * tail kept lexically.  A string comparison against the workspace root cannot
 * see a junction or a symbolic link: `<root>/link/secret.txt` starts with
 * the root's name while the bytes live somewhere else.  Containment therefore has
 * to compare the names Windows itself reports.
 *
 * The nearest existing ancestor is opened with FILE_FLAG_BACKUP_SEMANTICS
 * (which is how a directory gets a handle), and GetFinalPathNameByHandleA
 * returns the resolved name with the "\\?\" prefix, which is stripped before
 * normalising.  Returns NULL when nothing along the path can be opened; the
 * caller then falls back to the lexical answer rather than failing the
 * resolution of a workspace that does not exist yet.
 */
static char *real_path_of(const char *abs)
{
    char  *probe;
    char  *suffix = NULL;
    char  *found = NULL;
    size_t len;

    probe = sde_port_strdup(abs);
    if (probe == NULL) {
        return NULL;
    }
    for (;;) {
        HANDLE h;
        char   resolved[4096];
        DWORD  n;

        h = CreateFileA(probe, 0,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
        if (h != INVALID_HANDLE_VALUE) {
            n = GetFinalPathNameByHandleA(h, resolved,
                                          (DWORD) sizeof(resolved),
                                          FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
            (void) CloseHandle(h);
            if (n > 0 && (size_t) n < sizeof(resolved)) {
                char *base = strip_win_prefix(resolved);
                char *whole = NULL;

                if (base != NULL) {
                    whole = (suffix == NULL) ? sde_port_strdup(base)
                                             : sde_port_path_join(base, suffix);
                    free(base);
                }
                found = (whole == NULL) ? NULL : sde_port_path_norm(whole);
                free(whole);
            }
            break;
        }

        /* Not there: drop the last component onto `suffix` and try the parent. */
        len = strlen(probe);
        while (len > 0 && !is_sep(probe[len - 1])) {
            len--;
        }
        if (len == 0) {
            break;
        }
        {
            char  *component = sde_port_strdup(probe + len);
            char  *next = NULL;

            probe[len - 1] = '\0';
            if (component != NULL) {
                next = (suffix == NULL) ? component
                                        : sde_port_path_join(component, suffix);
            }
            free(suffix);
            suffix = (next == NULL) ? NULL : next;
            if (next == NULL) {
                free(component);
                break;
            }
        }
    }
    free(probe);
    free(suffix);
    return found;
}

int sde_port_path_within(const char *root, const char *p)
{
    char *ra;
    char *pa;
    char *real_r;
    char *real_p;
    int   yes;

    ra = sde_port_path_abs(root);
    pa = sde_port_path_abs(p);
    if (ra == NULL || pa == NULL) {
        free(ra);
        free(pa);
        return 0;
    }
    yes = within_pair(ra, pa);
    if (yes) {
        real_r = real_path_of(ra);
        real_p = real_path_of(pa);
        if (real_r != NULL && real_p != NULL) {
            yes = within_pair(real_r, real_p);
        }
        free(real_r);
        free(real_p);
    }
    free(ra);
    free(pa);
    return yes;
}

/* ====================================================================== */
/* files                                                                  */
/* ====================================================================== */

int sde_port_read_file(const char *path, sde_buf *out, char *err, size_t errcap)
{
    FILE  *f;
    char   chunk[16384];
    size_t n;

    f = fopen(path, "rb");
    if (f == NULL) {
        set_err(err, errcap, "cannot open for reading", path);
        return -1;
    }
    while ((n = fread(chunk, 1, sizeof(chunk), f)) > 0) {
        if (sde_buf_add(out, chunk, n) != 0) {
            fclose(f);
            set_err(err, errcap, "out of memory reading", path);
            return -1;
        }
    }
    if (ferror(f)) {
        fclose(f);
        set_err(err, errcap, "read error on", path);
        return -1;
    }
    fclose(f);
    return 0;
}

/*
 * Reads up to `len` bytes at `offset` and appends them to `out`, which is what
 * a session needs: a window of a file that must never be pulled into memory
 * whole.  Returns the number of bytes appended, or -1 with `err` set.  When
 * `out_size` is not NULL it receives the file's size as it was measured after
 * the read -- the file may have grown or shrunk while it was being read, and a
 * caller that reports the size it just saw is more useful than one that reports
 * the size from before.
 *
 * `offset` past the end of the file is not an error: it is an empty window.
 */
long sde_port_read_at(const char *path, long offset, size_t len, sde_buf *out,
                      long *out_size, char *err, size_t errcap)
{
    char  chunk[65536];
    FILE *f;
    long  total = 0;
    long  size;

    if (out_size != NULL) {
        *out_size = -1;
    }
    if (offset < 0) {
        set_err(err, errcap, "negative offset reading", path);
        return -1;
    }
    size = sde_port_file_size(path);
    if (size < 0) {
        set_err(err, errcap, "cannot read", path);
        return -1;
    }
    if (offset >= size || len == 0u) {
        if (out_size != NULL) {
            *out_size = size;
        }
        return 0;
    }
    f = fopen(path, "rb");
    if (f == NULL) {
        set_err(err, errcap, "cannot open for reading", path);
        return -1;
    }
    if (_fseeki64(f, offset, SEEK_SET) != 0) {
        fclose(f);
        set_err(err, errcap, "cannot seek in", path);
        return -1;
    }
    for (;;) {
        size_t want = len - (size_t) total;
        size_t got;

        if (want == 0u) {
            break;
        }
        if (want > sizeof(chunk)) {
            want = sizeof(chunk);
        }
        got = fread(chunk, 1, want, f);
        if (got == 0u) {
            if (ferror(f)) {
                fclose(f);
                set_err(err, errcap, "read failed on", path);
                return -1;
            }
            break;   /* end of file */
        }
        if (sde_buf_add(out, chunk, got) != 0) {
            fclose(f);
            set_err(err, errcap, "out of memory reading", path);
            return -1;
        }
        total += (long) got;
    }
    if (fclose(f) != 0) {
        set_err(err, errcap, "read failed on", path);
        return -1;
    }
    size = sde_port_file_size(path);
    if (out_size != NULL) {
        *out_size = size;
    }
    return total;
}

/*
 * Appends `len` bytes to `path`, creating it when it is not there.  Unlike
 * `sde_port_write_file()` this never truncates, which is what makes a session's
 * temporary file grow one chunk at a time.
 */
int sde_port_append_file(const char *path, const char *data, size_t len,
                         char *err, size_t errcap)
{
    FILE  *f;
    size_t total;

    if (len > 0u && data == NULL) {
        set_err(err, errcap, "no data appending to", path);
        return -1;
    }
    f = fopen(path, "ab");
    if (f == NULL) {
        set_err(err, errcap, "cannot open for appending", path);
        return -1;
    }
    total = (len == 0u) ? 0u : fwrite(data, 1, len, f);
    if (total != len) {
        fclose(f);
        set_err(err, errcap, "short append on", path);
        return -1;
    }
    if (fclose(f) != 0) {
        set_err(err, errcap, "cannot flush", path);
        return -1;
    }
    return 0;
}

int sde_port_mkdirs(const char *path, char *err, size_t errcap)
{
    sde_buf norm;
    char   *n;
    size_t  i;

    sde_buf_init(&norm);
    if (sde_port_path_norm_into(path, &norm) == NULL) {
        sde_buf_free(&norm);
        set_err(err, errcap, "path too long", path);
        return -1;
    }
    n = norm.data;

    for (i = 1; i < norm.len; i++) {
        if (n[i] == '/') {
            char save = n[i];
            n[i] = '\0';
            if (i > 1 && !CreateDirectoryA(n, NULL)
                && GetLastError() != ERROR_ALREADY_EXISTS) {
                n[i] = save;
                sde_buf_free(&norm);
                set_err(err, errcap, "cannot create directory", path);
                return -1;
            }
            n[i] = save;
        }
    }
    if (!CreateDirectoryA(n, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) {
        DWORD a = GetFileAttributesA(n);
        if (a == INVALID_FILE_ATTRIBUTES
            || !(a & FILE_ATTRIBUTE_DIRECTORY)) {
            sde_buf_free(&norm);
            set_err(err, errcap, "cannot create directory", path);
            return -1;
        }
    }
    sde_buf_free(&norm);
    return 0;
}

/*
 * A name next to `path` for the bytes to land in before they are published.
 * Keeping it in the same directory is what makes MoveFileExA a rename rather
 * than a copy, and the process id plus a counter keep two writers in one
 * directory apart.
 */
static char *write_temp_name(const char *path)
{
    static volatile LONG counter = 0;
    unsigned long n = (unsigned long) InterlockedIncrement(&counter);
    size_t len = strlen(path);
    char  *out = (char *) malloc(len + 40);

    if (out == NULL) {
        return NULL;
    }
    sprintf(out, "%s.sde-%lu-%lu", path,
            (unsigned long) GetCurrentProcessId(), n);
    return out;
}

int sde_port_write_file(const char *path, const char *data, size_t len,
                        char *err, size_t errcap)
{
    FILE  *f;
    char  *parent;
    char  *tmp;
    size_t total;
    const char *slash;

    /* Make sure the containing directory exists before opening the file. */
    parent = sde_port_path_abs(path);
    if (parent != NULL) {
        slash = strrchr(parent, '/');
        if (slash != NULL && slash != parent) {
            char  *dir = (char *) malloc((size_t) (slash - parent) + 1);
            if (dir != NULL) {
                memcpy(dir, parent, (size_t) (slash - parent));
                dir[slash - parent] = '\0';
                (void) sde_port_mkdirs(dir, NULL, 0);
                free(dir);
            }
        }
        free(parent);
    }

    /*
     * Write the bytes to a sibling and rename it over the target.  A write
     * that dies halfway must leave the old file whole: `fopen(path, "wb")`
     * truncates first and turns a crash -- or a full disk -- into a lost file.
     * The rename is the only step that changes what other readers see, so the
     * target is either the old bytes or the new ones, never a prefix of either.
     */
    tmp = write_temp_name(path);
    if (tmp == NULL) {
        set_err(err, errcap, "out of memory writing", path);
        return -1;
    }
    f = fopen(tmp, "wb");
    if (f == NULL) {
        free(tmp);
        set_err(err, errcap, "cannot open for writing", path);
        return -1;
    }
    total = (len == 0) ? 0 : fwrite(data, 1, len, f);
    if (total != len) {
        fclose(f);
        (void) DeleteFileA(tmp);
        free(tmp);
        set_err(err, errcap, "short write on", path);
        return -1;
    }
    if (fclose(f) != 0) {
        (void) DeleteFileA(tmp);
        free(tmp);
        set_err(err, errcap, "cannot flush", path);
        return -1;
    }
    if (MoveFileExA(tmp, path, MOVEFILE_REPLACE_EXISTING) == 0) {
        (void) DeleteFileA(tmp);
        free(tmp);
        set_err(err, errcap, "cannot replace", path);
        return -1;
    }
    free(tmp);
    return 0;
}

int sde_port_file_exists(const char *path)
{
    struct stat st;

    return (stat(path, &st) == 0) ? 1 : 0;
}

int sde_port_is_dir(const char *path)
{
    struct stat st;

    if (stat(path, &st) != 0) {
        return 0;
    }
    return (st.st_mode & S_IFMT) == S_IFDIR ? 1 : 0;
}

long sde_port_file_size(const char *path)
{
    struct stat st;

    if (stat(path, &st) != 0) {
        return -1;
    }
    return (long) st.st_size;
}

long sde_port_file_mtime(const char *path)
{
    struct stat st;

    if (stat(path, &st) != 0) {
        return -1;
    }
    return (long) st.st_mtime;
}

int sde_port_remove_file(const char *path)
{
    return DeleteFileA(path) ? 0 : -1;
}

int sde_port_replace_file(const char *from, const char *to)
{
    /*
     * MoveFileEx with REPLACE_EXISTING is atomic enough for our purpose: a
     * reader either sees the whole old file or the whole new one, never a
     * half-written document.
     */
    if (MoveFileExA(from, to, MOVEFILE_REPLACE_EXISTING) != 0) {
        return 0;
    }
    /* Some volumes refuse a move across directories; fall back to a copy. */
    if (CopyFileA(from, to, FALSE) != 0) {
        DeleteFileA(from);
        return 0;
    }
    DeleteFileA(from);
    return -1;
}

/* C89 has no strdup(), and the kernel needs it in a dozen places. */
char *sde_port_strdup(const char *s)
{
    size_t n;
    char  *p;

    if (s == NULL) {
        return NULL;
    }
    n = strlen(s);
    p = (char *) malloc(n + 1);
    if (p == NULL) {
        return NULL;
    }
    memcpy(p, s, n + 1);
    return p;
}

long sde_port_pid(void)
{
    return (long) GetCurrentProcessId();
}

/* ====================================================================== */
/* directories                                                            */
/* ====================================================================== */

void sde_port_dirent_free(sde_dirent *d)
{
    if (d == NULL) {
        return;
    }
    free(d->name);
    free(d);
}

int sde_port_list_dir(const char *path, sde_vec *out, char *err, size_t errcap)
{
    char             pattern[1024];
    WIN32_FIND_DATAA fd;
    HANDLE           h;

    if (snprintf(pattern, sizeof(pattern), "%s\\*", path) < 0) {
        set_err(err, errcap, "path too long", path);
        return -1;
    }
    pattern[sizeof(pattern) - 1] = '\0';

    h = FindFirstFileA(pattern, &fd);
    if (h == INVALID_HANDLE_VALUE) {
        set_err(err, errcap, "cannot list directory", path);
        return -1;
    }
    for (;;) {
        if (strcmp(fd.cFileName, ".") != 0 && strcmp(fd.cFileName, "..") != 0) {
            sde_dirent *e = (sde_dirent *) malloc(sizeof(sde_dirent));
            if (e == NULL) {
                FindClose(h);
                set_err(err, errcap, "out of memory listing", path);
                return -1;
            }
            e->name = (char *) malloc(strlen(fd.cFileName) + 1);
            if (e->name == NULL) {
                free(e);
                FindClose(h);
                set_err(err, errcap, "out of memory listing", path);
                return -1;
            }
            strcpy(e->name, fd.cFileName);
            e->is_dir = (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? 1 : 0;
            e->size = (long) fd.nFileSizeLow;
            if (sde_vec_push(out, e) != 0) {
                sde_port_dirent_free(e);
                FindClose(h);
                set_err(err, errcap, "out of memory listing", path);
                return -1;
            }
        }
        if (!FindNextFileA(h, &fd)) {
            break;
        }
    }
    FindClose(h);
    return 0;
}

/* ====================================================================== */
/* locks                                                                  */
/* ====================================================================== */

struct sde_mutex {
    CRITICAL_SECTION cs;
};

sde_mutex *sde_mutex_new(void)
{
    sde_mutex *m = (sde_mutex *) malloc(sizeof(sde_mutex));

    if (m == NULL) {
        return NULL;
    }
    InitializeCriticalSection(&m->cs);
    return m;
}

void sde_mutex_free(sde_mutex *m)
{
    if (m == NULL) {
        return;
    }
    DeleteCriticalSection(&m->cs);
    free(m);
}

void sde_mutex_lock(sde_mutex *m)
{
    EnterCriticalSection(&m->cs);
}

void sde_mutex_unlock(sde_mutex *m)
{
    LeaveCriticalSection(&m->cs);
}

/* ====================================================================== */
/* threads                                                                */
/* ====================================================================== */

struct sde_thread {
    HANDLE        h;
    sde_thread_fn fn;
    void         *ud;
};

static DWORD WINAPI thread_tramp(LPVOID arg)
{
    sde_thread  *t = (sde_thread *) arg;
    sde_thread_fn fn = t->fn;
    void         *ud = t->ud;

    fn(ud);
    return 0;
}

sde_thread *sde_thread_start(sde_thread_fn fn, void *ud)
{
    sde_thread *t = (sde_thread *) malloc(sizeof(sde_thread));

    if (t == NULL) {
        return NULL;
    }
    t->fn = fn;
    t->ud = ud;
    t->h = CreateThread(NULL, 0, thread_tramp, t, 0, NULL);
    if (t->h == NULL) {
        free(t);
        return NULL;
    }
    return t;
}

void sde_thread_join(sde_thread *t)
{
    if (t == NULL) {
        return;
    }
    WaitForSingleObject(t->h, INFINITE);
    CloseHandle(t->h);
    free(t);
}

void sde_thread_free(sde_thread *t)
{
    if (t == NULL) {
        return;
    }
    CloseHandle(t->h);
    free(t);
}

#endif /* SDE_PLATFORM_WIN32 */
