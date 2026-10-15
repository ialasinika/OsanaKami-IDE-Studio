/*
 * test_json.c - self-check for json.c.  Not part of the shipped kernel; it
 * exists so a fork can run `make check` after touching the protocol layer.
 */
#include "infantgod_cfg.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#include "buf.h"
#include "json.h"

static int failures = 0;

static void ok(int cond, const char *what)
{
    if (!cond) {
        failures++;
        printf("FAIL %s\n", what);
    } else {
        printf("ok   %s\n", what);
    }
}

static void test_roundtrip(void)
{
    const char *doc =
        "{\"id\":7,\"method\":\"file.write\",\"params\":{"
        "\"path\":\"src/a.c\",\"rev\":12,\"text\":\"a\\tb\\n\\u00e9\\ud83d\\ude00\","
        "\"flags\":[true,false,null,-3,2.5e2]}}";
    char       err[128];
    sde_json  *v;
    sde_json  *p;
    sde_buf    out;
    sde_json  *again;

    v = sde_json_parse(doc, strlen(doc), err, sizeof(err));
    ok(v != NULL, "parse nested document");
    if (v == NULL) {
        printf("     error: %s\n", err);
        return;
    }

    ok(strcmp(sde_json_gets(v, "method", "?"), "file.write") == 0, "method");
    ok(sde_json_geti(v, "id", -1) == 7, "int keeps integer-ness");

    p = sde_json_get(v, "params");
    ok(p != NULL && p->type == SDE_JSON_OBJ, "params is object");
    ok(strcmp(sde_json_gets(p, "path", "?"), "src/a.c") == 0, "path");

    /* "a\tb\n" + U+00E9 (2 bytes) + U+1F600 (4 bytes) */
    {
        const char *s = sde_json_gets(p, "text", "?");
        size_t      n = strlen(s);
        ok(n == 2 + 1 + 1 + 2 + 4, "utf8 escape decodes to right byte count");
        ok((unsigned char) s[0] == 'a' && s[1] == '\t' && s[2] == 'b'
           && s[3] == '\n', "control escapes");
        ok((unsigned char) s[4] == 0xC3 && (unsigned char) s[5] == 0xA9,
           "U+00E9 -> C3 A9");
        ok((unsigned char) s[6] == 0xF0 && (unsigned char) s[9] == 0x80,
           "U+1F600 -> F0 9F 98 80");
    }

    {
        sde_json *f = sde_json_get(p, "flags");
        ok(sde_json_count(f) == 5, "array length");
        ok(sde_json_as_bool(sde_json_at(f, 0), -1) == 1, "flags[0]");
        ok(sde_json_at(f, 2)->type == SDE_JSON_NULL, "flags[2] null");
        ok(sde_json_as_int(sde_json_at(f, 3), 0) == -3, "flags[3]");
        ok(sde_json_as_num(sde_json_at(f, 4), 0.0) == 250.0, "flags[4] 2.5e2");
    }

    sde_buf_init(&out);
    ok(sde_json_write(&out, v) == 0, "serialize");
    again = sde_json_parse(sde_buf_cstr(&out), out.len, err, sizeof(err));
    ok(again != NULL, "re-parse own output");
    if (again != NULL) {
        sde_buf compact;

        sde_buf_init(&compact);
        sde_json_write(&compact, again);
        ok(compact.len == out.len
           && memcmp(compact.data, out.data, out.len) == 0,
           "serialize is a fixed point");
        sde_buf_free(&compact);
        sde_json_free(again);
    }
    printf("     wire: %s\n", sde_buf_cstr(&out));

    sde_buf_free(&out);
    sde_json_free(v);
}

static void test_pretty(void)
{
    const char *doc = "{\"a\":[1,2],\"b\":{}}";
    sde_json  *v;
    sde_buf    out;

    v = sde_json_parse(doc, strlen(doc), NULL, 0);
    sde_buf_init(&out);
    sde_json_write_pretty(&out, v, 2);
    ok(strcmp(sde_buf_cstr(&out),
              "{\n  \"a\": [\n    1,\n    2\n  ],\n  \"b\": {}\n}") == 0,
       "pretty printer");
    printf("     pretty:\n%s\n", sde_buf_cstr(&out));
    sde_buf_free(&out);
    sde_json_free(v);
}

static void test_bad(void)
{
    static const char *bad[] = {
        "",            "{\"a\":}",     "[1,]",       "{\"a\" 1}",
        "\"unterminated", "01",        "tru",        "[1 2]",
        "{\"a\":1}x",  "\"\\q\"",      "\"\\ud800\"", "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]",
        "-",           "1.",         "1e"
    };
    size_t i;

    for (i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        char      err[128];
        sde_json *v = sde_json_parse(bad[i], strlen(bad[i]), err, sizeof(err));
        if (v != NULL) {
            failures++;
            printf("FAIL accepted bad input #%lu: %s\n",
                   (unsigned long) i, bad[i]);
            sde_json_free(v);
        }
    }
    ok(1, "all malformed inputs rejected");
}

static void test_build(void)
{
    sde_json *msg;
    sde_buf   out;

    msg = sde_json_obj();
    sde_json_set(msg, "jsonrpc", sde_json_str("2.0"));
    sde_json_set(msg, "id", sde_json_int(1));
    sde_json_set(msg, "ok", sde_json_bool(1));
    sde_json_set(msg, "x", sde_json_null());
    /* overwriting a key must free the old value, not leak or alias it */
    sde_json_set(msg, "id", sde_json_int(2));

    sde_buf_init(&out);
    sde_json_write(&out, msg);
    ok(strcmp(sde_buf_cstr(&out),
              "{\"jsonrpc\":\"2.0\",\"id\":2,\"ok\":true,\"x\":null}") == 0,
       "hand-built object");
    sde_buf_free(&out);
    sde_json_free(msg);
}

int main(void)
{
    test_roundtrip();
    test_pretty();
    test_build();
    test_bad();
    printf(failures ? "\nFAILED (%d)\n" : "\nall good\n", failures);
    return failures ? 1 : 0;
}
