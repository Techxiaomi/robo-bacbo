#!/usr/bin/env python3
"""Scanner simples de prevenção para segredos óbvios antes de commits."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", "node_modules", "venv", ".venv", "__pycache__"}
SKIP_FILES = {".env", "sessao_salva.json"}
TEXT_EXTS = {".py", ".js", ".html", ".json", ".md", ".txt", ".yml", ".yaml", ".env", ""}

PATTERNS = [
    ("senha Python hardcoded", re.compile(r'^\s*SENHA_CASSINO\s*=\s*[\'\"](?!\s*$|<|\$)[^\'\"]{3,}[\'\"]', re.I | re.M)),
    ("usuário Python hardcoded", re.compile(r'^\s*USUARIO_CASSINO\s*=\s*[\'\"](?!\s*$|<|\$)[^\'\"]{3,}[\'\"]', re.I | re.M)),
    ("password JS hardcoded", re.compile(r'password\s*:\s*[\'\"](?!\s*$|<|\$)[^\'\"]{4,}[\'\"]', re.I)),
    ("token Bearer", re.compile(r'Bearer\s+[A-Za-z0-9._~+\-/=]{20,}', re.I)),
    ("chave privada", re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')),
]

violations = []
for path in ROOT.rglob("*"):
    if not path.is_file():
        continue
    if any(part in SKIP_DIRS for part in path.parts):
        continue
    if path.name in SKIP_FILES:
        violations.append((path, "arquivo sensível não deve existir na baseline versionável"))
        continue
    if path.name == ".env.example":
        continue
    if path.suffix.lower() not in TEXT_EXTS:
        continue
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    for label, pattern in PATTERNS:
        if pattern.search(text):
            violations.append((path, label))

if violations:
    print("[FALHA] Possíveis segredos/arquivos sensíveis encontrados:")
    for path, label in violations:
        print(f" - {path.relative_to(ROOT)}: {label}")
    sys.exit(1)

print("[OK] Nenhum segredo óbvio detectado pelos padrões preventivos.")
