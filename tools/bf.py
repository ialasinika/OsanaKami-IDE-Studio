#!/usr/bin/env python3
"""bf.py -- a small, fast, dependency-free Brainfuck interpreter.

    python tools/bf.py program.bf [--input TEXT] [--tape N]
                                  [--eof zero|minus1] [--no-wrap] [--dump-tape]

Semantics
    The eight commands ``+ - < > [ ] . ,`` are executed; every other byte of the
    source is a comment and is ignored.  Cells are unsigned bytes that wrap
    modulo 256 unless ``--no-wrap`` is given, in which case overflow/underflow is
    a hard error.  ``--eof`` decides what ``,`` stores once the input is
    exhausted: ``zero`` stores 0, ``minus1`` stores 255 (the unsigned image of
    -1).  ``--input`` is encoded as UTF-8.

Efficiency
    The source is translated once at load time into a flat list of opcodes plus a
    precomputed jump table, so ``[`` and ``]`` never rescan the program.  The tape
    is a ``bytearray`` and the hot loop is a single if/elif chain over small ints.

Exit codes
    0   the program ran to completion
    2   the program could not be loaded or failed while running
    3   the command line was malformed
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Opcode values are just the ASCII bytes of the eight commands.
COMMAND_BYTES = b"+-<>[].,"
PLUS, MINUS, LEFT, RIGHT, LOOP, END, OUT, IN = COMMAND_BYTES

MAX_TAPE = 1 << 24


class BFError(Exception):
    """A load-time or run-time error raised by the interpreted program."""


class _Parser(argparse.ArgumentParser):
    """ArgumentParser that reports usage errors with the documented exit code."""

    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        print(f"bf.py: usage error: {message}", file=sys.stderr)
        raise SystemExit(3)


def _tape_size(text: str) -> int:
    """argparse type for ``--tape``: an integer in 1..MAX_TAPE."""
    try:
        size = int(text, 10)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not an integer") from None
    if not 1 <= size <= MAX_TAPE:
        raise argparse.ArgumentTypeError(f"tape size must be between 1 and {MAX_TAPE}")
    return size


def load(source: bytes):
    """Translate *source* into ``(code, jumps, offsets)``.

    ``code`` holds one opcode per command, ``jumps[i]`` is the index of the
    bracket matching ``code[i]``, and ``offsets[i]`` is the byte offset of that
    opcode in the original source (used for error messages).  Unbalanced
    brackets raise :class:`BFError`.
    """
    code, offsets = [], []
    for offset, byte in enumerate(source):
        if byte in COMMAND_BYTES:
            code.append(byte)
            offsets.append(offset)

    jumps = [-1] * len(code)
    open_at = []
    for index, opcode in enumerate(code):
        if opcode == LOOP:
            open_at.append(index)
        elif opcode == END:
            if not open_at:
                raise BFError(f"unmatched ']' at byte {offsets[index]} of the program")
            start = open_at.pop()
            jumps[start] = index
            jumps[index] = start
    if open_at:
        raise BFError(f"unmatched '[' at byte {offsets[open_at[0]]} of the program")
    return code, jumps, offsets


def execute(code, jumps, offsets, tape_size, data, eof, no_wrap, sink):
    """Run translated *code*, appending output bytes to *sink*.

    Returns ``(tape, pointer)``.  Raises :class:`BFError` on a run-time error;
    output produced before the error is already in *sink*.
    """
    tape = bytearray(tape_size)
    pointer = ip = read = 0
    length = len(code)
    available = len(data)

    while ip < length:
        opcode = code[ip]
        if opcode == PLUS:
            value = tape[pointer] + 1
            if value > 255:
                if no_wrap:
                    raise BFError(f"cell {pointer} overflowed 255 (byte {offsets[ip]})")
                value = 0
            tape[pointer] = value
        elif opcode == MINUS:
            value = tape[pointer] - 1
            if value < 0:
                if no_wrap:
                    raise BFError(f"cell {pointer} underflowed 0 (byte {offsets[ip]})")
                value = 255
            tape[pointer] = value
        elif opcode == RIGHT:
            pointer += 1
            if pointer >= tape_size:
                raise BFError(
                    f"pointer moved past the last cell ({tape_size - 1}) "
                    f"at byte {offsets[ip]}; try a bigger --tape"
                )
        elif opcode == LEFT:
            pointer -= 1
            if pointer < 0:
                raise BFError(f"pointer moved left of cell 0 at byte {offsets[ip]}")
        elif opcode == OUT:
            sink.append(tape[pointer])
        elif opcode == IN:
            if read < available:
                tape[pointer] = data[read]
                read += 1
            else:
                tape[pointer] = 0 if eof == "zero" else 255
        elif opcode == LOOP:
            if tape[pointer] == 0:
                ip = jumps[ip]  # jump onto the matching ']' and fall through
        else:  # END
            if tape[pointer] != 0:
                ip = jumps[ip]  # jump back onto the matching '['
        ip += 1

    return tape, pointer


def dump_tape(tape, pointer, stream, limit: int = 24) -> None:
    """Write a compact one-line description of the non-zero cells to *stream*."""
    non_zero = [(index, value) for index, value in enumerate(tape) if value]
    cells = " ".join(f"{index}={value}(0x{value:02x})" for index, value in non_zero[:limit])
    if len(non_zero) > limit:
        cells += f" ... +{len(non_zero) - limit} more"
    stream.write(f"tape: {len(tape)} cells, ptr={pointer}, nonzero={len(non_zero)}")
    stream.write(f" | {cells}\n" if cells else " | (all zero)\n")
    stream.flush()


def _emit(data: bytearray) -> None:
    """Write program output to stdout, tolerating a closed pipe."""
    if not data:
        return
    try:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    except BrokenPipeError:
        pass


def _build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="bf.py",
        description="Run a Brainfuck program. Exit codes: 0 ok, 2 program error, 3 usage error.",
    )
    parser.add_argument("file", metavar="file.bf", help="Brainfuck program to run")
    parser.add_argument("--input", default="", metavar="TEXT", help="text fed to ',' (UTF-8)")
    parser.add_argument(
        "--tape", type=_tape_size, default=30000, metavar="N", help="cells on the tape (default 30000)"
    )
    parser.add_argument(
        "--eof", choices=("zero", "minus1"), default="zero", help="value ',' stores at end of input"
    )
    parser.add_argument(
        "--no-wrap", action="store_true", help="make cell overflow/underflow a hard error"
    )
    parser.add_argument("--dump-tape", action="store_true", help="print a tape dump to stderr")
    return parser


def main(argv=None) -> int:
    """Entry point; returns the process exit code."""
    args = _build_parser().parse_args(argv)

    try:
        source = Path(args.file).read_bytes()
    except OSError as exc:
        print(f"bf.py: cannot read program: {exc}", file=sys.stderr)
        return 2

    try:
        code, jumps, offsets = load(source)
    except BFError as exc:
        print(f"bf.py: {exc}", file=sys.stderr)
        return 2

    sink = bytearray()
    try:
        tape, pointer = execute(
            code, jumps, offsets, args.tape, args.input.encode("utf-8"), args.eof, args.no_wrap, sink
        )
    except BFError as exc:
        _emit(sink)
        print(f"bf.py: {exc}", file=sys.stderr)
        return 2

    _emit(sink)
    if args.dump_tape:
        dump_tape(tape, pointer, sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
