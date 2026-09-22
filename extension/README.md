# extension — Detector de Clickbait (Extensão Chrome)

Extensão para Google Chrome / Edge que classifica manchetes de notícias em tempo real usando o modelo BERTimbau treinado, acessado via API local.

## Pré-requisito: API rodando localmente

A extensão **não** roda o modelo dentro do navegador. Ela se comunica com a API Python que você precisa iniciar antes:

```bash
# Na raiz do projeto:
python model/api.py
# → API disponível em http://localhost:8000
```

## Instalação da extensão (modo desenvolvedor)

1. Abra o Chrome e acesse `chrome://extensions/`
2. Ative o **Modo desenvolvedor** (canto superior direito)
3. Clique em **"Carregar sem compactação"**
4. Selecione a pasta `extension/` deste projeto
5. A extensão aparecerá na barra de ferramentas 🔍

## Como usar

1. Inicie a API: `python model/api.py`
2. Abra qualquer site de notícias (G1, UOL, Folha, etc.)
3. As manchetes serão classificadas automaticamente em ~1–2 segundos:
   - **⚠️ Clickbait (XX%)** — vermelho
   - **✓ Legítima** — verde
4. Clique no ícone da extensão para ver as estatísticas da sessão

## Estrutura

```
extension/
├── manifest.json               # Manifest V3
├── background/
│   └── service_worker.js       # Gerencia chamadas à API e armazena estatísticas
├── content/
│   ├── content_script.js       # Extrai manchetes e aplica badges no DOM
│   └── content_style.css       # Estilos dos badges
├── popup/
│   ├── popup.html              # Interface do popup
│   ├── popup.js                # Lógica do popup
│   └── popup.css               # Estilos do popup
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Arquitetura

```
[Página de notícias]
       │ manchetes extraídas do DOM
       ▼
[content_script.js]
       │ chrome.runtime.sendMessage(CLASSIFY_BATCH)
       ▼
[service_worker.js]
       │ POST /classificar-lote
       ▼
[API FastAPI localhost:8000]
       │ BERTimbau (PyTorch)
       ▼
[service_worker.js] → badges aplicados nas manchetes
```
