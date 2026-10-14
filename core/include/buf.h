/*
 * buf.h - a growable byte buffer / string builder.
 *
 * Every module that builds text uses this.  It is deliberately tiny and has
 * no dependency on anything else in the kernel, so it survives any trim.
 */
#ifndef SEIDE_BUF_H
#define SEIDE_BUF_H

#include <stddef.h>

typedef struct sde_buf {
    char  *data;   /* always NUL-terminated once sde_buf_cstr() has been called */
    size_t len;
    size_t cap;
} sde_buf;

void        sde_buf_init(sde_buf *b);
void        sde_buf_free(sde_buf *b);
void        sde_buf_clear(sde_buf *b);
int         sde_buf_reserve(sde_buf *b, size_t extra);
int         sde_buf_add(sde_buf *b, const char *data, size_t len);
int         sde_buf_addc(sde_buf *b, char c);
int         sde_buf_adds(sde_buf *b, const char *s);
int         sde_buf_addi(sde_buf *b, long v);
int         sde_buf_addf(sde_buf *b, const char *fmt, ...);
const char *sde_buf_cstr(sde_buf *b);
char       *sde_buf_take(sde_buf *b);

#endif /* SEIDE_BUF_H */
