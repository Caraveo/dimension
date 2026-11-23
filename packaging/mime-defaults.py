#!/usr/bin/python3
"""Register or remove Dimension in the system MIME defaults."""

import argparse
import os
import tempfile
from pathlib import Path

DESKTOP_ID = "io.github.caraveo.Dimension.desktop"


def associations(path, types, install):
    if not install and not path.exists():
        return
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    start = next((i for i, line in enumerate(lines) if line.strip() == "[Default Applications]"), None)
    if start is None:
        if not install:
            return
        if lines and lines[-1]:
            lines.append("")
        lines.append("[Default Applications]")
        start = len(lines) - 1
    end = next((i for i in range(start + 1, len(lines)) if lines[i].strip().startswith("[")), len(lines))
    updated = []
    seen = set()
    for line in lines[start + 1:end]:
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or key not in types:
            updated.append(line)
            continue
        choices = [item.strip() for item in value.split(";") if item.strip() and item.strip() != DESKTOP_ID]
        if install:
            choices.insert(0, DESKTOP_ID)
        if choices:
            updated.append(f"{key}={';'.join(choices)};")
        seen.add(key)
    if install:
        updated.extend(f"{mime}={DESKTOP_ID};" for mime in types if mime not in seen)
    new_lines = [*lines[:start + 1], *updated, *lines[end:]]
    if new_lines == lines and path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            output.write("\n".join(new_lines) + "\n")
            output.flush()
            os.fchmod(output.fileno(), mode)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["install", "remove"])
    parser.add_argument("defaults", type=Path)
    parser.add_argument("desktop", type=Path)
    args = parser.parse_args()
    mime_line = next(line for line in args.desktop.read_text().splitlines() if line.startswith("MimeType="))
    types = mime_line.partition("=")[2].rstrip(";").split(";")
    associations(args.defaults, types, args.action == "install")


if __name__ == "__main__":
    main()
