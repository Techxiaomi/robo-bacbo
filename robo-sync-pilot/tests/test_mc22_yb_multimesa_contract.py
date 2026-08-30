import json
import os
import unittest
from pathlib import Path

import tipminer_collector as collector_module


class FakePipeline:
    def __init__(self):
        self.operations = []

    def set(self, key, value):
        self.operations.append(
            ("set", key, value)
        )
        return self

    def publish(self, channel, payload):
        self.operations.append(
            ("publish", channel, payload)
        )
        return self

    def execute(self):
        self.operations.append(
            ("execute",)
        )
        return []


class FakeRedis:
    def __init__(self):
        self.pipelines = []

    def pipeline(self, transaction=True):
        pipeline = FakePipeline()
        pipeline.operations.append(
            ("transaction", bool(transaction))
        )
        self.pipelines.append(pipeline)
        return pipeline


def new_collector():
    instance = object.__new__(
        collector_module.TipMinerCollector
    )
    instance.history = []
    instance.redis = FakeRedis()
    return instance


class MC22YBMultimesaContractTests(
    unittest.TestCase
):
    def test_redis_constants_are_scoped_by_current_table(self):
        suffix = (
            ":"
            + collector_module.MESA_CODIGO
        ).upper()

        for value in (
            collector_module.REDIS_HISTORY_KEY,
            collector_module.REDIS_LATEST_ROUND_KEY,
            collector_module.REDIS_EVENTS_CHANNEL,
            collector_module.REDIS_HISTORY_ACK_KEY,
        ):
            self.assertTrue(
                str(value).upper().endswith(suffix),
                value,
            )

    def test_redis_scope_helper_supports_another_table_without_double_suffix(self):
        original_code = (
            collector_module.MESA_CODIGO
        )

        env_name = (
            "MC22_YB_GATE_REDIS_TEST"
        )

        try:
            collector_module.MESA_CODIGO = (
                "MESA_TESTE_2"
            )

            os.environ.pop(
                env_name,
                None
            )

            self.assertEqual(
                collector_module._redis_scoped(
                    env_name,
                    "bacbo_events",
                ),
                "bacbo_events:MESA_TESTE_2",
            )

            os.environ[env_name] = (
                "custom:MESA_TESTE_2"
            )

            self.assertEqual(
                collector_module._redis_scoped(
                    env_name,
                    "ignorado",
                ),
                "custom:MESA_TESTE_2",
            )

        finally:
            collector_module.MESA_CODIGO = (
                original_code
            )

            os.environ.pop(
                env_name,
                None
            )

    def test_live_and_history_events_stamp_table_code(self):
        instance = new_collector()

        round_data = {
            "uuid": "mc22-yb-python-round",
            "type": "PLAYER",
            "result": 7,
            "instant": "2026-08-30T00:00:00.000Z",
        }

        self.assertTrue(
            instance._publish_live_round(
                round_data
            )
        )

        live_pipeline = (
            instance.redis.pipelines[-1]
        )

        live_publish = next(
            op
            for op in live_pipeline.operations
            if op[0] == "publish"
        )

        self.assertEqual(
            live_publish[1],
            collector_module.REDIS_EVENTS_CHANNEL,
        )

        live_event = json.loads(
            live_publish[2]
        )

        self.assertEqual(
            live_event["mesa_codigo"],
            collector_module.MESA_CODIGO,
        )

        self.assertEqual(
            live_event["action"],
            "live_round",
        )

        instance._publish_history_sync(
            "signature-test",
            barrier_id="barrier-test",
        )

        history_pipeline = (
            instance.redis.pipelines[-1]
        )

        history_publish = next(
            op
            for op in history_pipeline.operations
            if op[0] == "publish"
        )

        self.assertEqual(
            history_publish[1],
            collector_module.REDIS_EVENTS_CHANNEL,
        )

        history_event = json.loads(
            history_publish[2]
        )

        self.assertEqual(
            history_event["mesa_codigo"],
            collector_module.MESA_CODIGO,
        )

        self.assertEqual(
            history_event["action"],
            "history_sync",
        )

        self.assertEqual(
            history_event["barrier_id"],
            "barrier-test",
        )

    def test_history_ack_from_other_table_is_not_accepted(self):
        instance = new_collector()

        reads = []

        wrong_ack = {
            "mesa_codigo": "MESA_TESTE_2",
            "signature": "sig-1",
            "barrier_id": "barrier-1",
            "applied_at": 200,
            "process_epoch": "wrong-table",
        }

        valid_ack = {
            "mesa_codigo": (
                collector_module.MESA_CODIGO
            ),
            "signature": "sig-1",
            "barrier_id": "barrier-1",
            "applied_at": 200,
            "process_epoch": "correct-table",
        }

        pending = [
            wrong_ack,
            valid_ack,
        ]

        def read_ack():
            value = pending.pop(0)
            reads.append(value)
            return value

        instance._read_history_ack = (
            read_ack
        )

        instance._raise_if_shutdown = (
            lambda: None
        )

        instance._wait_or_shutdown = (
            lambda _seconds: None
        )

        def unexpected_republish(
            _signature,
            barrier_id=None,
        ):
            self.fail(
                "ACK divergente nao deve virar sucesso "
                "nem exigir republish imediato"
            )

        instance._publish_history_sync = (
            unexpected_republish
        )

        result = (
            instance
            ._await_history_application_ack(
                "sig-1",
                "barrier-1",
                100,
            )
        )

        self.assertEqual(
            len(reads),
            2
        )

        self.assertIs(
            reads[0],
            wrong_ack
        )

        self.assertIs(
            result,
            valid_ack
        )

    def test_tipminer_round_id_is_parameterized_in_both_urls(self):
        source = Path(
            collector_module.__file__
        ).read_text(
            encoding="utf-8"
        )

        scope_source = (
            Path(collector_module.__file__)
            .with_name("mesa_tipminer_scope.py")
            .read_text(
                encoding="utf-8"
            )
        )

        self.assertIn(
            "resolver_tipminer_round_id",
            source,
        )

        self.assertIn(
            "TIPMINER_BACBO_ROUND_ID",
            scope_source,
        )

        self.assertIn(
            'f"{TIPMINER_ROUND_ID}/history?limit=200"',
            source,
        )

        self.assertIn(
            'f"{TIPMINER_ROUND_ID}/live"',
            source,
        )


if __name__ == "__main__":
    unittest.main()
