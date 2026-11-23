# Detecção de Clickbait com BERTimbau

Projeto de Trabalho de Conclusão de Curso (TCC) voltado à classificação automática de manchetes em português como **clickbait** ou **não clickbait**, utilizando ajuste fino (*fine-tuning*) do BERTimbau.

O repositório reúne uma base rotulada, um script para treinamento e inferência e um notebook para experimentação no Google Colab. O modelo-base utilizado é `neuralmind/bert-base-portuguese-cased`.

## Funcionalidades

- Treinamento de um classificador binário com pesos por classe.
- Limpeza de espaços, remoção de títulos duplicados e verificação de rótulos conflitantes.
- Divisão estratificada em treino, validação e teste.
- Escolha do limiar de classificação com base no F1 de clickbait na validação.
- Avaliação no conjunto de teste e exportação das métricas e da matriz de confusão.
- Classificação de títulos individuais ou de arquivos CSV.
- API HTTP com FastAPI para classificação individual e em lote.
- Notebook com análise de falsos negativos e testes manuais.

## Classes

| Valor | Classe no código | Significado |
| --- | --- | --- |
| `0` | `LEGITIMA` | Manchete rotulada como não clickbait |
| `1` | `CLICKBAIT` | Manchete rotulada como clickbait |

A classificação considera apenas o título. O rótulo `LEGITIMA` é o nome usado pelo código e não representa uma verificação da veracidade da notícia.

## Estrutura do repositório

```text
tcc_clickbait/
├── README.md
├── clickbait_bertimbau_v3.py
├── novo dataset + noticias clickbait csv.csv
└── tcc_clickbait.ipynb
```

| Arquivo | Descrição |
| --- | --- |
| `clickbait_bertimbau_v3.py` | Pipeline de treinamento, classificação e API |
| `novo dataset + noticias clickbait csv.csv` | Base de manchetes com rótulos binários |
| `tcc_clickbait.ipynb` | Experimentos e execução no Google Colab |

Os pesos do classificador treinado e os relatórios de avaliação não estão incluídos no repositório. Eles são gerados pelo comando `train`.

## Dataset

O CSV utiliza codificação UTF-8, separador `;` e as seguintes colunas:

| Coluna | Conteúdo |
| --- | --- |
| `titulo` | Texto da manchete |
| `clickbait_label_v2` | Rótulo de referência: `0` ou `1` |

Contagem da base incluída no repositório:

| Classe | Registros originais | Após limpeza e remoção de duplicatas |
| --- | ---: | ---: |
| Não clickbait (`0`) | 8.880 | 8.548 |
| Clickbait (`1`) | 6.125 | 6.108 |
| **Total** | **15.005** | **14.656** |

Aplicando a normalização de espaços do script, são removidos 349 registros duplicados. Não foram encontrados títulos normalizados idênticos com rótulos conflitantes nessa versão da base.

Para treinar com outra base, mantenha as duas colunas obrigatórias. O carregamento descarta títulos ausentes ou vazios, rejeita rótulos ausentes ou inválidos e interrompe o treinamento se houver títulos iguais com rótulos diferentes. É necessário ter exemplos das duas classes em quantidade suficiente para a divisão estratificada.

## Preparação do ambiente

É necessário um ambiente Python 3 compatível com PyTorch e Transformers. O repositório não fixa versões das dependências nem informa uma versão mínima de Python testada.

Clone o projeto:

```bash
git clone https://github.com/knutzin/tcc_clickbait.git
cd tcc_clickbait
python -m venv .venv
```

Ative o ambiente no Windows PowerShell:

```powershell
.venv\Scripts\Activate.ps1
```

Ou no Linux/macOS:

```bash
source .venv/bin/activate
```

Instale as dependências utilizadas pelo script:

```bash
python -m pip install torch transformers accelerate scikit-learn pandas numpy fastapi uvicorn
```

Para executar o notebook localmente e exportar sua análise para Excel:

```bash
python -m pip install jupyter openpyxl
```

O primeiro treinamento precisa de acesso à internet para baixar o modelo-base e o tokenizador. Uma GPU CUDA acelera o treinamento; o script também prevê execução sem CUDA. O uso de precisão mista FP16 é ativado quando CUDA está disponível. Para utilizar uma GPU NVIDIA, a instalação do PyTorch precisa ser compatível com o ambiente CUDA.

## Treinamento

Execute na raiz do repositório:

```bash
python clickbait_bertimbau_v3.py train --csv "novo dataset + noticias clickbait csv.csv"
```

O pipeline realiza as seguintes etapas:

1. Limpa os títulos, valida os rótulos e remove duplicatas.
2. Separa aproximadamente 80% dos dados para treino, 10% para validação e 10% para teste, preservando a proporção das classes e utilizando semente `42`.
3. Tokeniza as manchetes com limite de 128 tokens e preenchimento dinâmico dos lotes.
4. Ajusta o BERTimbau com entropia cruzada ponderada pela frequência das classes no treino.
5. Avalia a cada época e seleciona o melhor checkpoint pelo F1 da classe clickbait, calculado com `argmax` durante o treinamento. O *early stopping* tem paciência de duas avaliações.
6. Busca um limiar entre `0.05` e `0.95`, em passos de `0.005`, para maximizar o F1 de clickbait na validação.
7. Aplica o limiar escolhido ao conjunto de teste e salva o modelo e os relatórios.

### Parâmetros de treinamento

| Argumento | Padrão | Descrição |
| --- | --- | --- |
| `--csv` | Obrigatório | Caminho da base rotulada |
| `--output-dir` | `saida_bertimbau` | Diretório de saída |
| `--sep` | `;` | Separador do CSV de entrada |
| `--epochs` | `4` | Número máximo de épocas |
| `--train-batch-size` | `8` | Tamanho do lote de treino por dispositivo |
| `--eval-batch-size` | `16` | Tamanho do lote de avaliação por dispositivo |
| `--gradient-accumulation-steps` | `2` | Passos de acumulação de gradientes |
| `--learning-rate` | `2e-5` | Taxa de aprendizado |

Exemplo com parâmetros explícitos:

```bash
python clickbait_bertimbau_v3.py train --csv "novo dataset + noticias clickbait csv.csv" --output-dir saida_bertimbau --epochs 4 --train-batch-size 8 --eval-batch-size 16 --gradient-accumulation-steps 2 --learning-rate 2e-5
```

### Arquivos gerados

```text
saida_bertimbau/
├── checkpoints/
├── split_train.csv
├── split_validation.csv
├── split_test.csv
└── modelo_bertimbau_clickbait/
    ├── ... arquivos do modelo e do tokenizador
    ├── limiar.json
    ├── metrics_test.json
    └── confusion_matrix.csv
```

- `limiar.json`: limiar de decisão escolhido na validação.
- `metrics_test.json`: acurácia, acurácia balanceada, precisão, recall e F1 de clickbait, Cohen's kappa, limiar e contagens da base e do teste.
- `confusion_matrix.csv`: matriz organizada como `[[VN, FP], [FN, VP]]`, com linhas representando as classes reais e colunas representando as predições.
- `split_*.csv`: conjuntos efetivamente utilizados, salvos com separador `;`.

As métricas dependem da execução do treinamento. O repositório não inclui resultados finais que permitam informar uma acurácia ou um F1 já comprovados.

## Classificação de um título

Após treinar o modelo:

```bash
python clickbait_bertimbau_v3.py classify --model-dir saida_bertimbau/modelo_bertimbau_clickbait --titulo "Você não vai acreditar no que aconteceu!"
```

A saída é um JSON com os campos:

| Campo | Conteúdo |
| --- | --- |
| `titulo` | Título após normalização dos espaços |
| `clickbait_label_bot` | Predição binária (`0` ou `1`) |
| `probabilidade_clickbait` | Probabilidade produzida pelo modelo para a classe `1`, arredondada a seis casas decimais |

O classificador carrega automaticamente `limiar.json`. Caso esse arquivo não exista, utiliza `0.5`. A inferência seleciona CUDA, MPS ou CPU, nessa ordem de disponibilidade.

Também é possível usar o classificador em Python:

```python
from clickbait_bertimbau_v3 import ClassificadorClickbait

classificador = ClassificadorClickbait(
    "saida_bertimbau/modelo_bertimbau_clickbait"
)

resultado = classificador.predict_one("Prefeitura anuncia novas linhas de ônibus")
print(resultado)

resultados = classificador.predict_many([
    "Prefeitura anuncia novas linhas de ônibus",
    "Você não vai acreditar nesta descoberta!",
])
print(resultados)
```

## Classificação de um CSV

O arquivo de entrada precisa conter a coluna de títulos, mas não precisa ter rótulos de referência:

```bash
python clickbait_bertimbau_v3.py classify-csv --model-dir saida_bertimbau/modelo_bertimbau_clickbait --csv noticias.csv --output noticias_classificadas.csv
```

O comando preserva as colunas existentes e adiciona ou substitui `clickbait_label_bot`. A probabilidade não é exportada por esse comando.

Para personalizar a leitura:

```bash
python clickbait_bertimbau_v3.py classify-csv --model-dir saida_bertimbau/modelo_bertimbau_clickbait --csv noticias.csv --output noticias_classificadas.csv --text-column manchete --sep "," --batch-size 32
```

O separador informado também é usado na saída. Títulos ausentes, vazios ou compostos apenas por espaços interrompem a classificação; remova ou preencha esses registros antes de executar o comando. O diretório de destino do CSV deve existir.

## API HTTP

Inicie a API com um modelo já treinado:

```bash
python clickbait_bertimbau_v3.py serve --model-dir saida_bertimbau/modelo_bertimbau_clickbait --host 127.0.0.1 --port 8000
```

A documentação interativa fica em [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

| Método | Rota | Função |
| --- | --- | --- |
| `GET` | `/health` | Retorna status, identificador do modelo-base, dispositivo e limiar |
| `POST` | `/classificar` | Classifica um título |
| `POST` | `/classificar-lote` | Classifica uma lista de títulos |

Corpo JSON para `POST /classificar`:

```json
{
  "titulo": "Você não vai acreditar no que aconteceu!"
}
```

Corpo JSON para `POST /classificar-lote`:

```json
{
  "titulos": [
    "Prefeitura anuncia novas linhas de ônibus",
    "Você não vai acreditar nesta descoberta!"
  ]
}
```

A rota individual retorna os mesmos campos da classificação por terminal. A rota em lote retorna um objeto com a chave `resultados`, contendo a lista das classificações.

O esquema da requisição individual define títulos entre 1 e 1.000 caracteres; o esquema em lote define listas entre 1 e 100 itens. O classificador rejeita títulos vazios após a limpeza. O código configura CORS para aceitar qualquer origem durante os testes. Se `--host` for omitido, o servidor usa `0.0.0.0`.

## Google Colab

[Abrir notebook no Google Colab](https://colab.research.google.com/github/knutzin/tcc_clickbait/blob/main/tcc_clickbait.ipynb)

1. Ative uma GPU no ambiente de execução para usar a célula de verificação de GPU como está escrita.
2. Envie `clickbait_bertimbau_v3.py` e `novo dataset + noticias clickbait csv.csv` para `/content`.
3. Execute a instalação das dependências e a célula de treinamento.
4. Execute as células de análise de falsos negativos e classificação manual após o treinamento.

O notebook utiliza caminhos absolutos em `/content` e contém uma célula para montar o Google Drive. A montagem, por si só, não altera o diretório de saída do treinamento nem copia o modelo para o Drive.

**Ajuste do limiar:** as células de análise e teste manual usam o valor fixo `0.865`. Para manter os resultados coerentes com um novo treinamento, carregue o limiar salvo pelo script e substitua as comparações com `0.865` por comparações com `limiar`:

```python
import json

with open(f"{model_dir}/limiar.json", encoding="utf-8") as arquivo:
    limiar = json.load(arquivo)["threshold_clickbait"]
```

A análise de falsos negativos exporta `clickbaits_nao_detectados.xlsx`. Instale `openpyxl` se o ambiente não tiver um mecanismo para escrita de arquivos Excel. A chamada `torch.cuda.get_device_name(0)` da primeira célula exige CUDA disponível.

## Observações sobre reprodução

- A semente utilizada no código é `42`; os resultados ainda podem variar conforme hardware e versões das bibliotecas.
- O repositório não inclui um arquivo de dependências com versões fixadas.
- Não há documentação adicional sobre a origem da base e o procedimento de anotação dos rótulos.
- O projeto disponibiliza a API, mas não contém uma extensão de navegador ou interface web.
- Não há arquivo de licença no repositório.

Para consultar os argumentos disponíveis:

```bash
python clickbait_bertimbau_v3.py --help
python clickbait_bertimbau_v3.py train --help
```
