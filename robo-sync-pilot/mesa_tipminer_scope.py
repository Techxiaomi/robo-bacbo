import os
import re


MESA_PADRAO_CODIGO = "BACBO_INT"

TIPMINER_ROUND_ID_PADRAO = (
    "cc71e81d-8b56-4868-91c7-7224be543dce"
)

TIPMINER_ROUND_ID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{12}$"
)


def normalizar_codigo_mesa(valor):
    return str(valor or "").strip().upper()


def resolver_tipminer_round_id(
    mesa_codigo,
    env=None,
):
    codigo = normalizar_codigo_mesa(
        mesa_codigo
    )

    if (
        not codigo
        or any(
            ch not in
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_"
            for ch in codigo
        )
    ):
        raise RuntimeError(
            "BACBO_MESA_CODIGO invalido: "
            f"{codigo or '<vazio>'}"
        )

    ambiente = (
        os.environ
        if env is None
        else env
    )

    informado = str(
        ambiente.get(
            "TIPMINER_BACBO_ROUND_ID",
            "",
        )
        or ""
    ).strip()

    if informado:
        if not TIPMINER_ROUND_ID_PATTERN.fullmatch(
            informado
        ):
            raise RuntimeError(
                "TIPMINER_BACBO_ROUND_ID invalido"
            )

        if (
            codigo != MESA_PADRAO_CODIGO
            and informado.lower()
            == TIPMINER_ROUND_ID_PADRAO.lower()
        ):
            raise RuntimeError(
                "Mesa nao padrao nao pode reutilizar "
                "TIPMINER_BACBO_ROUND_ID da mesa padrao"
            )

        return informado

    if codigo == MESA_PADRAO_CODIGO:
        return TIPMINER_ROUND_ID_PADRAO

    raise RuntimeError(
        "TIPMINER_BACBO_ROUND_ID obrigatorio "
        "para mesa nao padrao"
    )
