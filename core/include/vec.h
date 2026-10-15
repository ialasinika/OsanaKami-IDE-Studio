/*
 * vec.h - a growable array of pointers.
 *
 * Deliberately untyped: the kernel stores heterogeneous things in lists and
 * does not need the ceremony of a generic container library.
 */
#ifndef INFANTGOD_VEC_H
#define INFANTGOD_VEC_H

#include <stddef.h>

typedef struct sde_vec {
    void **items;
    size_t count;
    size_t cap;
} sde_vec;

void  sde_vec_init(sde_vec *v);
void  sde_vec_free(sde_vec *v);
void  sde_vec_clear(sde_vec *v);
int   sde_vec_push(sde_vec *v, void *item);
void *sde_vec_at(const sde_vec *v, size_t i);

#endif /* INFANTGOD_VEC_H */
