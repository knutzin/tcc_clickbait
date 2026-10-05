# tcc_clickbait — Detector de Clickbait com BERTimbau

Repositório do TCC sobre detecção automática de clickbait em manchetes de notícias brasileiras, usando o modelo **BERTimbau** (BERT pré-treinado em português) com fine-tuning para classificação binária.

## Estrutura do repositório

```
tcc_clickbait/
├── model/          # Modelo BERTimbau + API FastAPI
├── extension/      # Extensão Chrome para classificação em tempo real
├── data/           # Dataset de manchetes
└── notebooks/      # Experimentos e análises
```

## Início rápido

### 1. Iniciar a API do modelo

```bash
# Ative o ambiente virtual
.venv\Scripts\activate   # Windows

# Inicie a API
python model/api.py
# → http://127.0.0.1:8000/health
```

### 2. Instalar a extensão no Chrome

1. Acesse `chrome://extensions/`
2. Ative **Modo desenvolvedor**
3. **"Carregar sem compactação"** → selecionar pasta `extension/`

### 3. Navegar por portais de notícias

As manchetes são classificadas automaticamente com badges visuais:
- **⚠️ Clickbait** (vermelho)
- **✓ Legítima** (verde)

## Módulos

| Pasta | Descrição |
|---|---|
| [`model/`](model/README.md) | Código de treino, inferência e API FastAPI |
| [`extension/`](extension/README.md) | Extensão Chrome (Manifest V3) |
| [`data/`](data/) | Dataset CSV com manchetes anotadas |
| [`notebooks/`](notebooks/) | Notebook de experimentos |

## Tecnologias

- **Modelo**: [BERTimbau](https://huggingface.co/neuralmind/bert-base-portuguese-cased) via HuggingFace Transformers
- **API**: FastAPI + Uvicorn
- **Extensão**: JavaScript puro, Chrome Manifest V3
