import os
import sys


def load_env_file(file_path):
    """Carrega KEY=VALUE de um .env sem sobrescrever variáveis já definidas."""
    if not os.path.exists(file_path):
        return

    with open(file_path, "r", encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()

            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]

            if key and key not in os.environ:
                os.environ[key] = value

    # O executor Redis-only removeu a captura WebSocket da Evolution. Ao executar
    # robo.py, reinstala o coletor ROAD/LIVE antes da criação da primeira página.
    if os.path.basename(str(sys.argv[0] or "")).lower() == "robo.py":
        try:
            from bacbo_ws_collector import instalar_coletor_bacbo
            instalar_coletor_bacbo()
        except Exception as e:
            print(f"⚠️ Falha ao instalar coletor BacBo WebSocket: {type(e).__name__}: {e}")
