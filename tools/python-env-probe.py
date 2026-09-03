import importlib
import importlib.metadata as metadata
import sys
import traceback

CHECKS = [
    ("redis", lambda: importlib.import_module("redis")),
    ("requests", lambda: importlib.import_module("requests")),
    ("flask", lambda: importlib.import_module("flask")),
    ("sseclient.SSEClient", lambda: getattr(importlib.import_module("sseclient"), "SSEClient")),
    (
        "playwright.sync_api.sync_playwright",
        lambda: getattr(importlib.import_module("playwright.sync_api"), "sync_playwright"),
    ),
    ("playwright_stealth", lambda: importlib.import_module("playwright_stealth")),
]

DISTRIBUTIONS = [
    "redis",
    "requests",
    "Flask",
    "sseclient-py",
    "playwright",
    "playwright-stealth",
    "greenlet",
]

print("PYTHON ENV PROBE")
print("--------------------------------------------")
print("Executable:", sys.executable)
print("Version   :", sys.version.replace("\n", " "))

for dist in DISTRIBUTIONS:
    try:
        print(f"[PKG] {dist}=={metadata.version(dist)}")
    except metadata.PackageNotFoundError:
        print(f"[PKG] {dist}=AUSENTE")

for name, check in CHECKS:
    try:
        check()
        print(f"[OK]  {name}")
    except Exception:
        print(f"[ERRO] {name}")
        traceback.print_exc()
        print("PYTHON_ENV_PROBE=FAIL")
        raise SystemExit(71)

print("PYTHON_ENV_PROBE=PASS")
