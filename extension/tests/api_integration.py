"""Smoke-check the real local API without opening a listening port."""

import ast
import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "model"
sys.path.insert(0, str(MODEL))

from clickbait_bertimbau_v3 import criar_api  # noqa: E402


def check_bind_defaults():
    entry = ast.parse((MODEL / "api.py").read_text(encoding="utf-8"))
    defaults = [
        node.args[1].value
        for node in ast.walk(entry)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "getenv"
        and len(node.args) > 1
        and isinstance(node.args[0], ast.Constant)
        and node.args[0].value == "API_HOST"
    ]
    assert defaults == ["127.0.0.1"], defaults

    cli = ast.parse((MODEL / "clickbait_bertimbau_v3.py").read_text(encoding="utf-8"))
    hosts = [
        kw.value.value
        for node in ast.walk(cli)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "add_argument"
        and node.args
        and isinstance(node.args[0], ast.Constant)
        and node.args[0].value == "--host"
        for kw in node.keywords
        if kw.arg == "default" and isinstance(kw.value, ast.Constant)
    ]
    assert hosts == ["127.0.0.1"], hosts


def check_api():
    app = criar_api(str(MODEL / "modelo_bertimbau_clickbait"))
    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200 and health.json()["status"] == "ok"
        assert "access-control-allow-origin" not in health.headers

        title = "Governo anuncia medidas econômicas para o próximo semestre"
        result = client.post("/classificar-lote", json={"titulos": [title]})
        assert result.status_code == 200, result.text
        assert len(result.json()["resultados"]) == 1

        origin = client.options(
            "/classificar-lote",
            headers={
                "Origin": "https://example.org",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert "access-control-allow-origin" not in origin.headers


if __name__ == "__main__":
    check_bind_defaults()
    check_api()
    print("API local: bind, health, inferência e CORS OK")
