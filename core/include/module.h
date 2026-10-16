/*
 * module.h - the trim manifest.
 *
 * InfantGod Studio is meant to be forked, and the first thing a fork does is decide what
 * *not* to keep.  That decision should be answerable in one screen, so the
 * kernel keeps an explicit table of its own source modules: what each one
 * does, and what disappears with it.
 *
 * The table is documentation with a runtime home, not a plugin registry.
 * Nothing is loaded dynamically and no module is discovered at runtime; the
 * table exists so `infantgod modules` can print the truth, and so that a fork's
 * first diff is obviously "delete a line here, a line in Makefile, a line in
 * rpc.c, and the file itself".
 */
#ifndef INFANTGOD_MODULE_H
#define INFANTGOD_MODULE_H

#include <stddef.h>

typedef struct sde_module {
    const char *name;     /* source stem: "view" -> core/src/view.c */
    const char *role;     /* one line: what it does */
    const char *loses;    /* one line: what a fork gives up by deleting it */
    int         optional; /* 1 = the kernel still builds and runs without it */
} sde_module;

/* Returns the table and, through `count`, how many entries it has. */
const sde_module *sde_modules(size_t *count);

#endif /* INFANTGOD_MODULE_H */
