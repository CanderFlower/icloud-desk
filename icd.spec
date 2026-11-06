# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the iCloud Desk core (icd.exe: daemon + CLI).
#
#   .venv\Scripts\python.exe -m PyInstaller icd.spec --noconfirm --distpath build\pyi\dist --workpath build\pyi\work
#
# Produces an onedir build: icd\icd.exe + icd\_internal\ (web assets at _internal\web).

import os
import re

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata
from PyInstaller.utils.win32.versioninfo import (
    FixedFileInfo, StringFileInfo, StringStruct, StringTable, VarFileInfo, VarStruct, VSVersionInfo,
)

ROOT = os.path.abspath(SPECPATH)


def read_version():
    with open(os.path.join(ROOT, "app", "__init__.py"), encoding="utf-8") as fh:
        m = re.search(r'__version__\s*=\s*["\']([^"\']+)["\']', fh.read())
    return m.group(1) if m else "0.0.0"


VERSION = read_version()
NUMERIC = tuple((list(map(int, re.findall(r"\d+", VERSION)[:4])) + [0, 0, 0, 0])[:4])


def local_package_modules(package):
    """List the app package's modules from the file system (avoids importing it at spec time)."""
    base = os.path.join(ROOT, package)
    mods = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        rel = os.path.relpath(dirpath, ROOT).replace(os.sep, ".")
        for f in filenames:
            if f.endswith(".py"):
                mods.append(rel if f == "__init__.py" else f"{rel}.{f[:-3]}")
    return sorted(mods)


def safe(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except Exception as exc:  # optional packages may be missing
        print(f"icd.spec: skipped {fn.__name__}{args}: {exc}")
        return []


hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "keyring.backends.Windows",
    "win32ctypes.core",
    "tzlocal",
    "multipart",
    "python_multipart",
]
hiddenimports += safe(collect_submodules, "uvicorn")
hiddenimports += safe(collect_submodules, "pyicloud", filter=lambda name: not name.startswith("pyicloud.cli"))
hiddenimports += safe(collect_submodules, "keyring.backends")
hiddenimports += local_package_modules("app")

datas = [(os.path.join(ROOT, "web"), "web")]
datas += safe(collect_data_files, "pyicloud")
datas += safe(collect_data_files, "certifi")
datas += safe(collect_data_files, "fido2")  # public_suffix_list.dat is read at import time
for dist in ("keyring", "pyicloud", "fastapi", "uvicorn", "starlette"):
    datas += safe(copy_metadata, dist)

excludes = [
    "tkinter", "_tkinter", "turtle", "idlelib",
    "webview", "pywebview", "clr", "pythonnet", "clr_loader",
    "pytest", "_pytest", "test", "tests", "lib2to3", "pydoc_data",
    "IPython", "matplotlib", "numpy.tests", "PyQt5", "PyQt6", "PySide2", "PySide6",
]

version_info = VSVersionInfo(
    ffi=FixedFileInfo(filevers=NUMERIC, prodvers=NUMERIC, mask=0x3F, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
    kids=[
        StringFileInfo([
            StringTable("040904B0", [
                StringStruct("CompanyName", "iCloud Desk"),
                StringStruct("FileDescription", "iCloud Desk core (daemon and CLI)"),
                StringStruct("FileVersion", VERSION),
                StringStruct("InternalName", "icd"),
                StringStruct("LegalCopyright", "iCloud Desk"),
                StringStruct("OriginalFilename", "icd.exe"),
                StringStruct("ProductName", "iCloud Desk"),
                StringStruct("ProductVersion", VERSION),
            ])
        ]),
        VarFileInfo([VarStruct("Translation", [0x0409, 1200])]),
    ],
)

a = Analysis(
    [os.path.join(ROOT, "icd.py")],
    pathex=[ROOT],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="icd",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    icon=os.path.join(ROOT, "assets", "app.ico"),
    version=version_info,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="icd",
)
