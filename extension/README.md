# extension — Detector de Clickbait (Extensão Chrome)

Extensão para Google Chrome / Edge que classifica manchetes de notícias em tempo real usando o modelo BERTimbau treinado, acessado via API local.

## Pré-requisito: API rodando localmente

A extensão **não** roda o modelo dentro do navegador. Ela se comunica com a API Python que você precisa iniciar antes:

```bash
# Na raiz do projeto:
python model/api.py
# → API disponível em http://127.0.0.1:8000 (apenas nesta máquina)
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
3. Títulos em artigos e links de notícia serão classificados conforme o tempo de resposta do modelo:
   - **⚠️ Clickbait (XX%)** — vermelho
   - **✓ Legítima** — verde
4. Clique no ícone da extensão para consultar totais desde o último reset. Se a API estava offline, a extensão tenta novamente algumas vezes; use **Verificar página agora** para tentar de novo sem recarregar a aba.

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
[API FastAPI 127.0.0.1:8000]
       │ BERTimbau (PyTorch)
       ▼
[service_worker.js] → resultados e contadores persistidos
       ▼
[content_script.js] → badges ao lado das manchetes
```

A seleção identifica títulos usando tags de cabeçalho (`h1` a `h4`) e classes jornalísticas comuns (`.feed-post-link`, `[class*='headline']`, `[class*='title']`, etc.), descartando menus de navegação, rodapés, barras laterais e metadados de autoria. Elementos aninhados são deduplicados para evitar badges duplicados. A API remota não é suportada nesta versão: para disponibilizá-la remotamente no futuro, configure HTTPS, autenticação e permissões da extensão, sem apenas abrir a porta local.
