from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILE = ROOT / "robo-sync-pilot" / "tests" / "test_pure_logic.py"
text = FILE.read_text(encoding="utf-8")

old = '''class FakeTime:\n    atual = 100.0\n\n    @classmethod\n    def time(cls):\n        return cls.atual\n'''
new = '''class FakeTime:\n    atual = 100.0\n\n    @classmethod\n    def time(cls):\n        return cls.atual\n\n    @classmethod\n    def monotonic(cls):\n        return cls.atual\n'''
if old in text:
    text = text.replace(old, new, 1)
elif 'def monotonic(cls):' not in text:
    raise SystemExit('FakeTime esperado não encontrado')

old = '''        for stage_fechado in (\n            "WaitingForBets", "ClosingBets", "FirstDie", "SecondDie",\n            "ThirdDie", "FourthDie", "Confirmation", "Resolved"\n        ):\n            with self.ns["estado_mesa_lock"]:\n                self.ns["estado_mesa"]["stage"] = stage_fechado\n                self.ns["estado_mesa"]["atualizado_em_ms"] = int(time.time() * 1000)\n            self.assertEqual(self.avaliar(self.ordem)["estado"], "AGUARDAR_STAGE")\n\n        with self.ns["estado_mesa_lock"]:\n            self.ns["estado_mesa"]["stage"] = "AcceptingBets"\n            self.ns["estado_mesa"]["atualizado_em_ms"] = int(time.time() * 1000)\n        self.assertEqual(self.avaliar(self.ordem)["estado"], "ABERTA")\n\n        with self.ns["estado_mesa_lock"]:\n            self.ns["estado_mesa"]["stage"] = "Betting"\n            self.ns["estado_mesa"]["atualizado_em_ms"] = int(time.time() * 1000)\n        self.assertEqual(self.avaliar(self.ordem)["estado"], "ABERTA")\n'''
new = '''        for stage_aberto in ("WaitingForBets", "ClosingBets", "AcceptingBets", "Betting"):\n            with self.ns["estado_mesa_lock"]:\n                self.ns["estado_mesa"]["stage"] = stage_aberto\n                self.ns["estado_mesa"]["atualizado_em_ms"] = int(time.time() * 1000)\n            self.assertEqual(self.avaliar(self.ordem)["estado"], "ABERTA")\n\n        for stage_fechado in (\n            "FirstDie", "SecondDie", "ThirdDie", "FourthDie", "Confirmation", "Resolved"\n        ):\n            with self.ns["estado_mesa_lock"]:\n                self.ns["estado_mesa"]["stage"] = stage_fechado\n                self.ns["estado_mesa"]["atualizado_em_ms"] = int(time.time() * 1000)\n            self.assertEqual(self.avaliar(self.ordem)["estado"], "AGUARDAR_STAGE")\n'''
if old in text:
    text = text.replace(old, new, 1)
elif 'for stage_aberto in ("WaitingForBets", "ClosingBets", "AcceptingBets", "Betting")' not in text:
    raise SystemExit('contrato de stages BUG-028 antigo não encontrado')

FILE.write_text(text, encoding="utf-8")
print('Contrato Python BUG-046 alinhado: FakeTime.monotonic e stages pré-dados.')
