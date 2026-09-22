"""
Ponto de entrada da API FastAPI do classificador de clickbait.

Uso:
  # Opção 1 — direto pelo Python
  python model/api.py

  # Opção 2 — via uvicorn (recarrega automaticamente em dev)
  uvicorn model.api:app --host 0.0.0.0 --port 8000 --reload

Variáveis de ambiente:
  MODEL_DIR  Caminho para o diretório com o modelo treinado.
             Padrão: model/modelo_bertimbau_clickbait
  API_HOST   Host em que a API escuta. Padrão: 0.0.0.0
  API_PORT   Porta em que a API escuta. Padrão: 8000
"""

from __future__ import annotations

import os
import sys

# Garante que o pacote-irmão clickbait_bertimbau_v3 seja encontrado
# independentemente de onde o script é chamado.
sys.path.insert(0, os.path.dirname(__file__))

from clickbait_bertimbau_v3 import criar_api  # noqa: E402

MODEL_DIR = os.getenv("MODEL_DIR", os.path.join(os.path.dirname(__file__), "modelo_bertimbau_clickbait"))

app = criar_api(MODEL_DIR)

if __name__ == "__main__":
    import uvicorn

    host = os.getenv("API_HOST", "0.0.0.0")
    port = int(os.getenv("API_PORT", "8000"))

    print(f"Iniciando API em http://{host}:{port}")
    print(f"Modelo carregado de: {MODEL_DIR}")
    uvicorn.run(app, host=host, port=port)
