# model — Classificador de Clickbait (BERTimbau)

Este módulo contém o código de **treinamento**, **inferência** e **API** do classificador de manchetes clickbait baseado no [BERTimbau](https://huggingface.co/neuralmind/bert-base-portuguese-cased).

## Estrutura

```
model/
├── clickbait_bertimbau_v3.py   # Lógica de treino, inferência e definição da API FastAPI
├── api.py                      # Ponto de entrada para iniciar a API
├── requirements.txt            # Dependências Python
└── modelo_bertimbau_clickbait/ # Modelo treinado (gerado após rodar o treino)
    ├── config.json
    ├── model.safetensors
    ├── tokenizer.json
    ├── tokenizer_config.json
    ├── limiar.json             # Limiar ótimo de probabilidade (buscado na validação)
    └── metrics_test.json       # Métricas finais no conjunto de teste
```

## Instalação

```bash
# Recomendado: use o .venv já existente na raiz, ou crie um novo
pip install -r model/requirements.txt
```

## Como iniciar a API

```bash
# Da raiz do projeto:
python model/api.py
```

A API sobe em `http://localhost:8000`. Endpoints disponíveis:

| Método | Rota               | Descrição                          |
|--------|--------------------|------------------------------------|
| GET    | `/health`          | Verifica se a API está no ar       |
| POST   | `/classificar`     | Classifica uma manchete            |
| POST   | `/classificar-lote`| Classifica uma lista de manchetes  |

### Exemplos

```bash
# Verificar status
curl http://localhost:8000/health

# Classificar uma manchete
curl -X POST http://localhost:8000/classificar \
  -H "Content-Type: application/json" \
  -d '{"titulo": "Governo anuncia novo pacote econômico"}'

# Classificar em lote
curl -X POST http://localhost:8000/classificar-lote \
  -H "Content-Type: application/json" \
  -d '{"titulos": ["Governo anuncia pacote econômico", "Você não vai acreditar no que esse político fez!"]}'
```

## Como re-treinar o modelo

```bash
python model/clickbait_bertimbau_v3.py train \
  --csv "data/novo dataset + noticias clickbait csv.csv" \
  --output-dir model \
  --sep ";"
```

## Variáveis de ambiente

| Variável   | Padrão                               | Descrição                       |
|------------|--------------------------------------|---------------------------------|
| `MODEL_DIR`| `model/modelo_bertimbau_clickbait`   | Caminho do modelo treinado      |
| `API_HOST` | `0.0.0.0`                            | Host da API                     |
| `API_PORT` | `8000`                               | Porta da API                    |
