#!/usr/bin/env python3
"""build.py -- turn a seIDE release bundle into a Windows installer (.msi).

    python tools/msi/build.py --check --bundle DIR --version X.Y.Z
    python tools/msi/build.py --bundle DIR --version X.Y.Z --out FILE.msi
                              [--manufacturer "seIDE contributors"]
                              [--ui-name seIDE]

The bundle is a *runnable* release directory produced elsewhere by the release
tool (seide.exe, VERSION, shell/, langs/, docs/, examples/, ...).  This tool
never runs the release tool and never invents payload: it walks the bundle,
substitutes one <Component> per file into ``tools/msi/seide.wxs``, and shells
out to WiX.

The exact WiX invocation settled on here is::

    wix build -arch x64 -ext WixToolset.UI.wixext \\
              -d Version=<version> -d Manufacturer=<manufacturer> \\
              -d UiName=<ui-name> -o <out.msi> build/msi/seide-<version>.wxs

``wix build`` is the WiX 4/5 single-command entry point (there is no more
candle/light pair), so this is the whole pipeline.  ``-arch x64`` is stated
explicitly rather than left to WiX because the payload is a native x64 kernel.
``-ext WixToolset.UI.wixext`` is required because the template uses the
built-in WiX UI (``WixUI_InstallDir``): in WiX 4/5 the UI is a shipped
extension, not part of the core schema, so the build must name it.  ``-d``
supplies the preprocessor variables, ``-o`` names the output, and the expanded
``.wxs`` is passed as a positional argument.  The paths are passed as absolute
paths, and the working directory is pinned to the repository root: ``wix`` is a
.NET tool and resolves relative ``-o`` and ``Source`` paths against the process
working directory, not the project.

The expanded source is written to ``build/msi/seide-<version>.wxs`` and left
there on purpose: ``seide.wxs`` sources the shim with the path
``..\\..\\tools\\msi\\seide-window.cmd``, which is only correct from
``build/msi/``, and keeping the generated file makes a failed build diagnosable.

Version mapping
    The release version is ``X.Y.Z`` or ``X.Y.Z-pre.N``.  Windows Installer's
    ProductVersion is numeric, so ``-pre.N`` (which is a *pre-release* marker,
    not a fourth version field) is dropped for the MSI and the short numeric
    form is used.  The literal version -- pre-release included -- is what
    appears in the ``.msi`` file name the caller chose.  Pre-releases should
    not be shipped as GA installers at all; see tools/msi/README.md.

Exit codes
    0   the MSI was built, or ``--check`` found the template sound
    2   tooling or packaging failure: WiX is not installed, ``wix build``
        failed, the bundle is missing/empty, or the expanded XML is wrong
    3   the command line was malformed (bad/missing version, bad flag)

Standard library only, no network.  ``--check`` never needs WiX.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ElementTree
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = Path(__file__).resolve().parent / "seide.wxs"
MSI_BUILD_DIR = REPO_ROOT / "build" / "msi"

#: The one placeholder line the template carries.  It must be replaced whole.
FILES_MARKER = "        <!-- @@FILES@@ -->"
FRAGMENT_MARKER = "@@FRAGMENT_ID@@"
UI_NAME_MARKER = "@@UI_NAME@@"

#: Release version grammar: X.Y.Z, optionally with a pre-release marker.
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-pre\.(\d+))?$")

#: Component GUIDs are derived, not random: uuid5 of the bundle-relative path
#: under a namespace fixed for this product.  Deterministic GUIDs mean a
#: rebuilt MSI upgrades in place instead of churning component identity, and a
#: path that stops existing is cleanly removed by the next upgrade.
COMPONENT_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://seide.invalid/msi/components")

#: A file name that would break the .wxs text, the command line, or WiX naming.
BAD_PATH_RE = re.compile(r'[<>:"|?*\\]')

WIX_ENV_VAR = "WIX"
WIX_NAMES = ("wix.exe", "wix")


class _Parser(argparse.ArgumentParser):
    """ArgumentParser that reports usage errors with the documented exit code."""

    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        print(f"msi/build.py: usage error: {message}", file=sys.stderr)
        raise SystemExit(3)


class PackagingError(Exception):
    """A bundle or template problem that must fail as exit code 2."""


def note(message: str) -> None:
    """Print one progress line in the tool's own ``[msi] ...`` voice."""
    print(f"[msi] {message}", flush=True)


def ascii_path(relative: str) -> str:
    """Return *relative* as a plain ASCII string, or raise PackagingError."""
    try:
        return relative.encode("ascii").decode("ascii")
    except UnicodeEncodeError:
        raise PackagingError(f"bundle path is not ASCII: {relative!r}") from None


def release_versions(version: str) -> tuple[str, str]:
    """Return ``(literal, numeric)`` for a release version string.

    ``literal`` is what the caller typed (used in messages and file names);
    ``numeric`` is the Windows Installer ProductVersion that ``wix build -d
    Version=`` receives.
    """
    match = VERSION_RE.match(version)
    if match is None:
        raise PackagingError(
            f"version {version!r} is not X.Y.Z or X.Y.Z-pre.N"
        )
    major, minor, patch, pre = match.groups()
    # Windows Installer ignores a fourth field unless it is non-zero, so the
    # plain X.Y.Z form is passed through untouched and only a pre-release gets
    # a fourth field.
    numeric = f"{major}.{minor}.{patch}.{pre}" if pre else f"{major}.{minor}.{patch}"
    return version, numeric


def file_ordinal(relative: str) -> int:
    """Return the deterministic numeric prefix of a component id."""
    return int(hashlib.sha1(relative.encode("utf-8")).hexdigest()[:8], 16)


def component_id(relative: str) -> str:
    """Return a readable, collision-free component id for a bundle file."""
    stem = re.sub(r"[^A-Za-z0-9]", "_", relative)[:60]
    return f"C_{file_ordinal(relative):08x}_{stem}"


def component_guid(relative: str) -> str:
    """Return the deterministic component GUID (upper case, braces) for a file."""
    return "{" + str(uuid.uuid5(COMPONENT_NAMESPACE, relative)).upper() + "}"


def harvest(bundle: Path) -> list[str]:
    """Return the bundle's files as sorted, ASCII, forward-slash relatives."""
    if not bundle.is_dir():
        raise PackagingError(f"bundle directory not found: {bundle}")
    relatives: list[str] = []
    for dirpath, dirnames, filenames in os.walk(bundle):
        # Sort in place so os.walk's traversal order is deterministic too, not
        # just the final list; sorted(dirnames) alone would still depend on
        # the filesystem's readdir order.
        dirnames.sort()
        where = Path(dirpath).relative_to(bundle)
        for name in filenames:
            relative = name if str(where) == "." else f"{where.as_posix()}/{name}"
            relative = ascii_path(relative)
            if BAD_PATH_RE.search(relative) or relative.startswith("/"):
                raise PackagingError(
                    f"bundle file name cannot be packaged: {relative!r}"
                )
            relatives.append(relative)
    # Windows is case-insensitive, so two bundle files whose paths differ only
    # by case would collide into one installed file and one of them would
    # silently win.  Refuse rather than ship that.
    seen: dict[str, str] = {}
    for relative in relatives:
        key = relative.lower()
        if key in seen:
            raise PackagingError(
                f"bundle paths differ only by case: {seen[key]!r} and {relative!r}"
            )
        seen[key] = relative

    relatives.sort()
    if not relatives:
        raise PackagingError(f"bundle has no files: {bundle}")
    return relatives


def source_attr(bundle: Path, relative: str) -> str:
    """Return the ``Source=`` value: absolute, backslash-separated for WiX."""
    return str(bundle / Path(relative.replace("/", "\\")))


def _render_file_component(relative: str, bundle: Path, indent: str) -> str:
    """Render the <Component> for one bundle file (already correctly nested)."""
    name = relative.rsplit("/", 1)[-1]
    return "\n".join(
        [
            f'{indent}<Component Id="{component_id(relative)}" Guid="{component_guid(relative)}">',
            f'{indent}  <File Id="{component_id(relative)}_file" Name="{name}"'
            f' Source="{source_attr(bundle, relative)}" KeyPath="yes" />',
            f"{indent}</Component>",
        ]
    )


def render_files_block(bundle: Path, relatives: list[str]) -> str:
    """Render the <Directory> tree, one <Component> per file, and the refs.

    The bundle's directory structure is rebuilt as nested <Directory>
    elements; every file becomes its own component with a deterministic GUID
    so that install, repair and uninstall are all per-file operations.
    """
    lines: list[str] = []

    # --- the directory tree, with the components inside it --------------------
    # A leaf is a (file, nesting depth); nodes with files but no subdirectory
    # still need a Directory element, so build the tree first.
    tree: dict[str, dict] = {}
    for relative in relatives:
        parts = relative.split("/")
        node = tree
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node.setdefault("__files__", []).append((relative, len(parts)))

    def emit(node: dict, indent: str) -> None:
        for key in sorted(node):
            if key == "__files__":
                for relative, _depth in node[key]:
                    lines.append(_render_file_component(relative, bundle, indent))
                continue
            lines.append(f'{indent}<Directory Id="{component_id(key)}_dir" Name="{key}">')
            emit(node[key], indent + "  ")
            lines.append(f"{indent}</Directory>")

    emit(tree, " " * 8)

    # --- one ComponentRef per component --------------------------------------
    for relative in relatives:
        lines.append(f'      <ComponentRef Id="{component_id(relative)}" />')
    return "\n".join(lines)


def expand_template(bundle: Path, version: str, manufacturer: str, ui_name: str) -> str:
    """Return the .wxs text with the marker replaced by harvested components."""
    if not TEMPLATE.is_file():
        raise PackagingError(f"template not found: {TEMPLATE}")
    relatives = harvest(bundle)
    text = TEMPLATE.read_text(encoding="utf-8")
    if text.count(FILES_MARKER) != 1:
        raise PackagingError(
            f"{TEMPLATE} must contain exactly one {FILES_MARKER!r} marker line"
        )

    block = render_files_block(bundle, relatives)
    # The shim and the Start Menu shortcut are hand-written in the template, so
    # the ComponentRefs this marker carries are for the payload only; the two
    # static components in the template stand on their own inside the group.
    text = text.replace(FILES_MARKER, block)
    text = text.replace(FRAGMENT_MARKER, "SeidePayload")
    text = text.replace(UI_NAME_MARKER, ui_name)
    text = text.replace("$(var.Manufacturer)", manufacturer)
    return text


def expanded_path(version: str) -> Path:
    """Return where the expanded source for *version* is written."""
    return MSI_BUILD_DIR / f"seide-{version}.wxs"


def write_expanded(text: str, version: str) -> Path:
    """Write the expanded source under build/msi/ and return its path."""
    MSI_BUILD_DIR.mkdir(parents=True, exist_ok=True)
    path = expanded_path(version)
    path.write_text(text, encoding="utf-8")
    return path


def _parse_source(path: Path) -> tuple[list[str], list[str], list[str]]:
    """Parse *path*; return (component ids, File names, ComponentRef ids)."""
    root = ElementTree.parse(path).getroot()

    def tagged(suffix: str) -> list:
        return [element for element in root.iter() if element.tag.endswith(suffix)]

    components = [element.get("Id") for element in tagged("Component")]
    keypaths = [element.get("Name") for element in tagged("File")]
    refs = [element.get("Id") for element in tagged("ComponentRef")]
    return components, keypaths, refs


def do_check(bundle: Path, version: str) -> int:
    """Expand the template, prove it is well formed, and count the components.

    Never invokes WiX: this is the check a machine without WiX (this one) can
    still run, and the check CI runs before it provisions WiX.
    """
    literal, numeric = release_versions(version)
    relatives = harvest(bundle)
    note(f"bundle: {bundle}")
    note(f"version: {literal} (ProductVersion {numeric})")
    note(f"files: {len(relatives)}")

    text = expand_template(bundle, literal, "seIDE contributors", "seIDE")
    path = write_expanded(text, literal)
    note(f"expanded: {path}")

    try:
        components, keypaths, refs = _parse_source(path)
    except ElementTree.ParseError as exc:
        print(f"msi/build.py: expanded source is not well-formed XML: {exc}", file=sys.stderr)
        return 2

    # One payload component per bundle file, plus the hand-written shim and
    # Start Menu shortcut components in the template itself.
    expected = len(relatives) + 2
    if len(components) != expected:
        print(
            f"msi/build.py: expected {expected} components ({len(relatives)} payload + 2), "
            f"found {len(components)}",
            file=sys.stderr,
        )
        return 2

    # Every bundle file must appear exactly once, and as a key path.
    wanted = [relative.rsplit("/", 1)[-1] for relative in relatives]
    for name in wanted:
        if keypaths.count(name) != 1:
            print(
                f"msi/build.py: {name!r} appears {keypaths.count(name)} times as a "
                f"<File> key path, expected exactly 1",
                file=sys.stderr,
            )
            return 2

    # Every component in the feature's group (payload plus the template's own
    # two) must be referenced, or it ships unreferenced.
    unreferenced = sorted(set(components) - set(refs))
    if unreferenced:
        print(
            f"msi/build.py: components with no ComponentRef: {', '.join(unreferenced)}",
            file=sys.stderr,
        )
        return 2

    note(f"components: {len(components)}")
    note(f"component refs: {len(refs)}")
    note("well-formed")
    return 0


def find_wix() -> Path | None:
    """Return the ``wix`` executable: $WIX, then PATH, then dotnet tools dir."""
    override = os.environ.get(WIX_ENV_VAR)
    if override:
        candidate = Path(override)
        if candidate.is_file():
            return candidate
        found = shutil.which(override)
        if found:
            return Path(found)
    for name in WIX_NAMES:
        found = shutil.which(name)
        if found:
            return Path(found)
    # "dotnet tool install --global wix" drops wix.exe in the user's tools
    # directory, which is on PATH only in a shell that has been restarted.
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidate = Path(local) / "Microsoft" / "WinGet" / "Links" / "wix.exe"
        if candidate.is_file():
            return candidate
    home = os.environ.get("USERPROFILE")
    if home:
        candidate = Path(home) / ".dotnet" / "tools" / "wix.exe"
        if candidate.is_file():
            return candidate
    return None


def wix_command(wix: Path, expanded: Path, out: Path, numeric: str, manufacturer: str, ui_name: str) -> list[str]:
    """Return the exact ``wix build`` argv."""
    return [
        str(wix),
        "build",
        "-arch",
        "x64",
        # The template uses the built-in WiX UI, which in WiX 4/5 lives in an
        # extension: without this the bind fails on the ui: namespace.
        "-ext",
        "WixToolset.UI.wixext",
        "-d",
        f"Version={numeric}",
        "-d",
        f"Manufacturer={manufacturer}",
        "-d",
        f"UiName={ui_name}",
        "-o",
        str(out),
        str(expanded),
    ]


def do_build(bundle: Path, version: str, out: Path, manufacturer: str, ui_name: str) -> int:
    """Expand the template and invoke WiX, or fail loudly without producing a file."""
    literal, numeric = release_versions(version)
    relatives = harvest(bundle)
    note(f"bundle: {bundle}")
    note(f"version: {literal} (ProductVersion {numeric})")
    note(f"files: {len(relatives)}")

    try:
        text = expand_template(bundle, literal, manufacturer, ui_name)
    except PackagingError as exc:
        print(f"msi/build.py: {exc}", file=sys.stderr)
        return 2
    path = write_expanded(text, literal)
    note(f"expanded: {path}")

    wix = find_wix()
    if wix is None:
        # Never write a fake or empty .msi to satisfy a caller: fail with the
        # one line that says what is missing and how to get it.
        print(
            "msi/build.py: WiX is not installed (no wix on PATH and no $WIX); "
            "install it with 'dotnet tool install --global wix' or the WiX 4/5 "
            "installer from https://wixtoolset.org/, then re-run",
            file=sys.stderr,
        )
        return 2

    # A stale .msi from an earlier run must not be mistaken for this one's
    # output, and a failed bind must not leave one behind.
    if out.exists():
        out.unlink()

    command = wix_command(wix, path, out, numeric, manufacturer, ui_name)
    note(f"wix: {wix}")
    note(f"run: {' '.join(command)}")
    try:
        done = subprocess.run(command, cwd=str(REPO_ROOT), check=False)
    except OSError as exc:
        print(f"msi/build.py: cannot run {wix}: {exc}", file=sys.stderr)
        return 2
    if done.returncode != 0:
        print(f"msi/build.py: wix build failed with exit {done.returncode}", file=sys.stderr)
        return 2
    if not out.is_file():
        print(f"msi/build.py: wix reported success but {out} was not created", file=sys.stderr)
        return 2
    note(f"wrote: {out} ({out.stat().st_size} bytes)")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="msi/build.py",
        description=(
            "Build a seIDE MSI from a release bundle. "
            "Exit codes: 0 ok, 2 tooling/packaging failure, 3 usage error."
        ),
    )
    parser.add_argument("--bundle", required=True, metavar="DIR",
                        help="runnable release bundle directory to package")
    parser.add_argument("--version", required=True, metavar="X.Y.Z",
                        help="release version, X.Y.Z or X.Y.Z-pre.N")
    parser.add_argument("--out", metavar="FILE.msi",
                        help="output MSI (required unless --check)")
    parser.add_argument("--manufacturer", default="seIDE contributors",
                        metavar="NAME", help="ARP publisher / Manufacturer property")
    parser.add_argument("--ui-name", default="seIDE", metavar="NAME",
                        help="ARP display name and Start Menu shortcut name")
    parser.add_argument("--check", action="store_true",
                        help="expand and validate the .wxs only; never needs WiX")
    return parser


def main(argv=None) -> int:
    """Entry point; returns the process exit code."""
    args = _build_parser().parse_args(argv)
    bundle = Path(args.bundle).resolve()
    manufacturer = args.manufacturer
    ui_name = args.ui_name

    if args.check:
        if args.out:
            print("msi/build.py: --out is meaningless with --check", file=sys.stderr)
            return 3
    elif not args.out:
        print("msi/build.py: usage error: --out is required unless --check", file=sys.stderr)
        return 3

    # The version grammar is a command-line contract, so a malformed version is
    # a usage error (3), reported before anything is touched on disk -- even in
    # --check, which otherwise reports bundle problems as 2.
    try:
        release_versions(args.version)
    except PackagingError as exc:
        print(f"msi/build.py: usage error: {exc}", file=sys.stderr)
        return 3

    try:
        if args.check:
            return do_check(bundle, args.version)
        return do_build(bundle, args.version, Path(args.out).resolve(), manufacturer, ui_name)
    except PackagingError as exc:
        print(f"msi/build.py: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("msi/build.py: interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
