import faulthandler
import os
import sys
from pathlib import Path


_fault_file = None


def _is_live_bridge_process(argv=None):
    values = list(sys.argv if argv is None else argv)
    if not values:
        return False
    return Path(str(values[0])).name.lower() == "live_bridge.py"


def _enable_live_bridge_fault_diagnostics():
    global _fault_file
    if not _is_live_bridge_process():
        return False

    try:
        project_root = Path(__file__).resolve().parent.parent
        logs_dir = project_root / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        fault_path = logs_dir / f"live-bridge-python-fault-{os.getpid()}.log"
        _fault_file = fault_path.open("a", encoding="utf-8", buffering=1)
        _fault_file.write(
            f"LIVE_BRIDGE_FAULTHANDLER_ENABLED pid={os.getpid()} argv0={Path(sys.argv[0]).name}\n"
        )
        _fault_file.flush()
        faulthandler.enable(file=_fault_file, all_threads=True)
        return True
    except Exception as error:
        try:
            sys.stderr.write(
                f"LIVE_BRIDGE_FAULTHANDLER_SETUP_FAILED={type(error).__name__}: {error}\n"
            )
            sys.stderr.flush()
        except Exception:
            pass
        return False


_enable_live_bridge_fault_diagnostics()
