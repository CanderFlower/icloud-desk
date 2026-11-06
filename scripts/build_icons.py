"""Build web/assets/icons.svg (an SVG <symbol> sprite) from Lucide icons.

Usage:
    python scripts/build_icons.py [path/to/lucide-static/icons]

Icon names are listed in web/assets/icons.txt (one per line, '#' comments).
Without a path the script downloads the lucide-static package from npm.
Lucide is ISC licensed: https://lucide.dev  (license kept in the sprite header).
In the UI:  icon('trash-2')  ->  <svg class="ic"><use href="#i-trash-2"/></svg>
"""
from __future__ import annotations

import io
import json
import re
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIST = ROOT / "web" / "assets" / "icons.txt"
OUT = ROOT / "web" / "assets" / "icons.svg"


def load_from_npm() -> dict[str, str]:
    meta = json.load(urllib.request.urlopen("https://registry.npmjs.org/lucide-static/latest"))
    print(f"lucide-static {meta['version']}")
    data = urllib.request.urlopen(meta["dist"]["tarball"]).read()
    icons: dict[str, str] = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for m in tar.getmembers():
            if m.name.startswith("package/icons/") and m.name.endswith(".svg"):
                icons[Path(m.name).stem] = tar.extractfile(m).read().decode()
    return icons


def load_from_dir(path: Path) -> dict[str, str]:
    return {p.stem: p.read_text(encoding="utf-8") for p in path.glob("*.svg")}


def main() -> int:
    icons = load_from_dir(Path(sys.argv[1])) if len(sys.argv) > 1 else load_from_npm()
    names = []
    for line in LIST.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line and line not in names:
            names.append(line)
    out = [
        '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">',
        "<!-- Lucide icons (https://lucide.dev), ISC License, Copyright (c) Lucide Contributors -->",
    ]
    missing = []
    for name in names:
        svg = icons.get(name)
        if not svg:
            missing.append(name)
            continue
        body = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1)
        body = re.sub(r"\s*\n\s*", "", body)
        out.append(f'<symbol id="i-{name}" viewBox="0 0 24 24">{body}</symbol>')
    out.append("</svg>")
    OUT.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(names) - len(missing)} icons")
    if missing:
        print("missing:", ", ".join(missing))
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
