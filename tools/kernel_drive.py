"""Drive build/infantgod.exe's `rpc` endpoint over stdio.

This is the harness behind `tools/kernel_probe.py`, the shipped kernel
regression probe.  It is stdlib-only and starts the binary with `--root <dir>`,
so a probe can point the kernel at a scratch workspace instead of yours.

Windows pipes are not selectable in CPython, so replies are read by a
background thread into a queue and a "reply" is a queue get with a timeout.
That keeps a probe honest: a silent method (a notification, a crash) shows up as
`<silence>` rather than as a hang.
"""
import json
import os
import queue
import subprocess
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, "build", "infantgod.exe")


class Kernel:
    """One `infantgod rpc` process, speaking newline-delimited JSON-RPC."""

    def __init__(self, root, exe=EXE, extra=()):
        self.root = root
        self.p = subprocess.Popen(
            [exe, "rpc", "--root", root] + list(extra),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=ROOT,
        )
        self.q = queue.Queue()
        self.next_id = 1
        self.notes = []
        self.unsolicited = []
        self.stderr = []
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._drain_err, daemon=True).start()

    def _pump(self):
        for line in self.p.stdout:
            self.q.put(line.decode("utf-8", "surrogateescape").rstrip("\n"))

    def _drain_err(self):
        for line in self.p.stderr:
            self.stderr.append(line.decode("utf-8", "replace").rstrip("\n"))

    def raw(self, line, timeout=5.0):
        """Send one raw line; return the first frame back, or `<silence>`."""
        self.p.stdin.write((line + "\n").encode("utf-8", "surrogateescape"))
        self.p.stdin.flush()
        return self.next_reply(timeout)

    def next_reply(self, timeout=5.0):
        try:
            return self.q.get(timeout=timeout)
        except queue.Empty:
            return "<silence>"

    def drain(self, timeout=0.6):
        """Every frame that arrives within `timeout` of the last one."""
        out = []
        while True:
            frame = self.next_reply(timeout)
            if frame == "<silence>":
                return out
            out.append(frame)

    def call(self, method, params=None, rid=None):
        """Send a request and read until the frame carrying that id arrives.

        Notifications (no id) are collected into `self.notes` rather than being
        mistaken for the reply -- the kernel interleaves them freely.

        One exception: a frame that cannot be parsed at all is answered with
        `"id": null`, because the id was inside the unparseable text.  Only one
        request is ever in flight here, so that reply must be ours; it is
        returned rather than waited out.
        """
        if rid is None:
            rid = self.next_id
            self.next_id += 1
        frame = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            frame["params"] = params
        self.p.stdin.write((json.dumps(frame, ensure_ascii=False) + "\n")
                           .encode("utf-8", "surrogateescape"))
        self.p.stdin.flush()

        unsolicited = []
        while True:
            got = self.next_reply(5.0)
            if got == "<silence>":
                self.unsolicited = unsolicited
                return got
            try:
                parsed = json.loads(got)
            except ValueError:
                self.unsolicited = unsolicited
                return got
            if isinstance(parsed, dict) and "id" in parsed:
                if parsed.get("id") == rid:
                    self.notes.extend(unsolicited)
                    self.unsolicited = []
                    return parsed
                if parsed.get("id") is None and "error" in parsed:
                    self.notes.extend(unsolicited)
                    self.unsolicited = []
                    return parsed
            unsolicited.append(parsed)

    def alive(self):
        return self.p.poll() is None

    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.wait(timeout=5)
        except Exception:
            self.p.kill()


def show(label, value):
    if isinstance(value, str):
        text = value
    elif isinstance(value, (bytes, bytearray)):
        text = repr(bytes(value))
    else:
        text = json.dumps(value, ensure_ascii=False)
    if len(text) > 320:
        text = text[:320] + " ...(truncated)"
    print(f"{label}: {text}")


if __name__ == "__main__":
    k = Kernel(ROOT)
    show("hello", k.call("hello"))
    k.close()
