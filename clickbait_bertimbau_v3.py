"""
Classificador de manchetes usando BERTimbau.

0 = notícia legítima
1 = clickbait

O arquivo de entrada deve ter as colunas:
- titulo
- clickbait_label_v2
"""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Iterable
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    cohen_kappa_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
)
from sklearn.model_selection import train_test_split
from torch.utils.data import Dataset
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    DataCollatorWithPadding,
    EarlyStoppingCallback,
    Trainer,
    TrainingArguments,
    set_seed,
)

MODELO_BASE = "neuralmind/bert-base-portuguese-cased"
COLUNA_TITULO = "titulo"
COLUNA_ROTULO = "clickbait_label_v2"
COLUNA_RESULTADO = "clickbait_label_bot"
MAX_TOKENS = 128
SEMENTE = 42


def limpar_titulo(text: str) -> str:
    """Faz uma limpeza simples no texto antes da tokenização."""
    if text is None:
        return ""
    text = str(text).replace("\u00a0", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()

class DatasetTitulos(Dataset):
    def __init__(self, texts, labels, tokenizer, max_length=MAX_TOKENS):
        self.texts = list(texts)
        self.labels = list(labels)
        self.tokenizer = tokenizer
        self.max_length = max_length
    def __len__(self):
        return len(self.texts)
    def __getitem__(self, index):
        encoded = self.tokenizer(
            self.texts[index],
            truncation=True,
            max_length=self.max_length,
            padding=False,
        )
        encoded["labels"] = int(self.labels[index])
        return encoded

class TreinadorBalanceado(Trainer):
    """Ajusta o peso das classes durante o treinamento."""
    def __init__(self, *args, pesos_classes=None, **kwargs):
        super().__init__(*args, **kwargs)
        if pesos_classes is None:
            pesos_classes = torch.tensor([1.0, 1.0], dtype=torch.float32)
        self.pesos_classes = pesos_classes.float()
    def compute_loss(
        self,
        model,
        inputs,
        return_outputs=False,
        num_items_in_batch=None,
    ):
        labels = inputs.pop("labels")
        outputs = model(**inputs)
        logits = outputs.logits

        loss_fn = nn.CrossEntropyLoss(weight=self.pesos_classes.to(logits.device))
        loss = loss_fn(logits.view(-1, model.config.num_labels), labels.view(-1),)
        return (loss, outputs) if return_outputs else loss


def calcular_metricas(labels, predictions):
    labels = np.asarray(labels, dtype=int)
    predictions = np.asarray(predictions, dtype=int)
    return {
        "accuracy": float(accuracy_score(labels, predictions)),
        "balanced_accuracy": float(
            balanced_accuracy_score(labels, predictions)
        ),
        "precision_clickbait": float(
            precision_score(labels, predictions, pos_label=1, zero_division=0)
        ),
        "recall_clickbait": float(
            recall_score(labels, predictions, pos_label=1, zero_division=0)
        ),
        "f1_clickbait": float(
            f1_score(labels, predictions, pos_label=1, zero_division=0)
        ),
        "cohen_kappa": float(cohen_kappa_score(labels, predictions)),
    }


def metricas_validacao(eval_pred):
    logits, labels = eval_pred
    predictions = np.argmax(logits, axis=-1)
    return calcular_metricas(labels, predictions)

def calcular_pesos(labels: Iterable[int]) -> torch.Tensor:
    labels = np.asarray(list(labels), dtype=int)
    counts = np.bincount(labels, minlength=2)

    if np.any(counts == 0):
        raise ValueError(f"As duas classes 0 e 1 devem existir no treino. Contagens: {counts.tolist()}")

    total = counts.sum()
    weights = total / (2.0 * counts)
    return torch.tensor(weights, dtype=torch.float32)

def carregar_dados(csv_path: str, sep: str = ";"):
    df = pd.read_csv(
        csv_path,
        sep=sep,
        encoding="utf-8",
        usecols=[COLUNA_TITULO, COLUNA_ROTULO],
    )

    if df[COLUNA_TITULO].isna().any():
        df = df.dropna(subset=[COLUNA_TITULO]).copy()

    df[COLUNA_TITULO] = df[COLUNA_TITULO].map(limpar_titulo)
    df = df[df[COLUNA_TITULO].str.len() > 0].copy()

    if df[COLUNA_ROTULO].isna().any():
        raise ValueError("Há rótulos vazios na coluna clickbait_label_v2.")

    df[COLUNA_ROTULO] = df[COLUNA_ROTULO].astype(int)

    rotulos_invalidos = sorted(set(df[COLUNA_ROTULO].unique()) - {0, 1})
    if rotulos_invalidos:
        raise ValueError(f"A coluna {COLUNA_ROTULO} deve conter somente 0 e 1. " f"Valores inválidos: {rotulos_invalidos}")

    # Remove casos que poderiam aparecer em mais de um conjunto.
    conflitos = (
        df.groupby(COLUNA_TITULO)[COLUNA_ROTULO].nunique().loc[lambda x: x > 1]
    )
    if len(conflitos) > 0:
        raise ValueError(f"Foram encontradas {len(conflitos)} manchetes duplicadas com " "rótulos conflitantes. Corrija o dataset antes de treinar.")

    qtd_antes = len(df)
    df = df.drop_duplicates(subset=[COLUNA_TITULO], keep="first").reset_index(drop=True)
    qtd_removidas = qtd_antes - len(df)
    return df, qtd_removidas

def separar_dados(df: pd.DataFrame):
    df_treino, df_temp = train_test_split(df, test_size=0.20, random_state=SEMENTE, stratify=df[COLUNA_ROTULO],)

    df_validacao, df_teste = train_test_split(df_temp, test_size=0.50, random_state=SEMENTE, stratify=df_temp[COLUNA_ROTULO],)

    return (df_treino.reset_index(drop=True), df_validacao.reset_index(drop=True), df_teste.reset_index(drop=True),)


def buscar_melhor_limiar(labels, probabilities):
    """Procura o limiar com melhor F1 no conjunto de validação."""
    labels = np.asarray(labels, dtype=int)
    probabilities = np.asarray(probabilities, dtype=float)

    melhor_limiar = 0.50
    melhor_f1 = -1.0

    for limiar in np.linspace(0.05, 0.95, 181):
        predictions = (probabilities >= limiar).astype(int)
        score = f1_score(labels, predictions, pos_label=1, zero_division=0)

        if score > melhor_f1:
            melhor_f1 = score
            melhor_limiar = float(limiar)
        elif np.isclose(score, melhor_f1):
            # Em caso de empate, usa o valor mais próximo de 0,5.
            if abs(limiar - 0.5) < abs(melhor_limiar - 0.5):
                melhor_limiar = float(limiar)

    return melhor_limiar, float(melhor_f1)

def obter_probabilidades(logits):
    logits_tensor = torch.tensor(logits, dtype=torch.float32)
    return torch.softmax(logits_tensor, dim=1)[:, 1].cpu().numpy()

def treinar_bertimbau(
    csv_path: str,
    output_dir: str,
    sep: str = ";",
    epochs: int = 4,
    train_batch_size: int = 8,
    eval_batch_size: int = 16,
    gradient_accumulation_steps: int = 2,
    learning_rate: float = 2e-5,
):
    set_seed(SEMENTE)

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    dados, duplicatas_removidas = carregar_dados(csv_path, sep=sep)
    df_treino, df_validacao, df_teste = separar_dados(dados)

    print("\n=== DATASET ===")
    print(f"Registros únicos usados: {len(dados)}")
    print(f"Duplicatas removidas: {duplicatas_removidas}")
    print("Distribuição total:")
    print(dados[COLUNA_ROTULO].value_counts().sort_index())
    print(
        f"Treino: {len(df_treino)} | "
        f"Validação: {len(df_validacao)} | "
        f"Teste: {len(df_teste)}"
    )

    tokenizer = AutoTokenizer.from_pretrained(MODELO_BASE, do_lower_case=False,)

    model = AutoModelForSequenceClassification.from_pretrained(MODELO_BASE, num_labels=2, id2label={0: "LEGITIMA", 1: "CLICKBAIT"}, label2id={"LEGITIMA": 0, "CLICKBAIT": 1},)

    dados_treino = DatasetTitulos(df_treino[COLUNA_TITULO], df_treino[COLUNA_ROTULO], tokenizer,)
    dados_validacao = DatasetTitulos(df_validacao[COLUNA_TITULO], df_validacao[COLUNA_ROTULO], tokenizer,)
    dados_teste = DatasetTitulos(df_teste[COLUNA_TITULO], df_teste[COLUNA_ROTULO], tokenizer,)
    collator = DataCollatorWithPadding(tokenizer=tokenizer)
    pesos_classes = calcular_pesos(df_treino[COLUNA_ROTULO])

    print(
        "Pesos das classes no treino: "
        f"classe 0={pesos_classes[0]:.4f}, "
        f"classe 1={pesos_classes[1]:.4f}"
    )

    tem_gpu = torch.cuda.is_available()
    print("Dispositivo:", "CUDA/GPU" if tem_gpu else "CPU")

    config_treino = TrainingArguments(
        output_dir=str(output_dir / "checkpoints"),
        learning_rate=learning_rate,
        per_device_train_batch_size=train_batch_size,
        per_device_eval_batch_size=eval_batch_size,
        gradient_accumulation_steps=gradient_accumulation_steps,
        num_train_epochs=epochs,
        weight_decay=0.01,
        warmup_steps=100,
        eval_strategy="epoch",
        save_strategy="epoch",
        logging_strategy="steps",
        logging_steps=50,
        load_best_model_at_end=True,
        metric_for_best_model="f1_clickbait",
        greater_is_better=True,
        save_total_limit=2,
        report_to="none",
        fp16=tem_gpu,
        seed=SEMENTE,
        data_seed=SEMENTE,
    )

    treinador = TreinadorBalanceado(
        model=model,
        args=config_treino,
        train_dataset=dados_treino,
        eval_dataset=dados_validacao,
        processing_class=tokenizer,
        data_collator=collator,
        compute_metrics=metricas_validacao,
        pesos_classes=pesos_classes,
        callbacks=[EarlyStoppingCallback(early_stopping_patience=2)],
    )

    treinador.train()

    # Escolhe o limiar com os dados de validação.
    resultado_validacao = treinador.predict(dados_validacao)
    probs_validacao = obter_probabilidades(resultado_validacao.predictions)
    limiar, melhor_f1_validacao = buscar_melhor_limiar(resultado_validacao.label_ids, probs_validacao,)

    print(
        f"\nLimiar escolhido na validação: {limiar:.3f} "
        f"(F1 clickbait={melhor_f1_validacao:.4f})"
    )

    # Faz a avaliação final no conjunto de teste.
    resultado_teste = treinador.predict(dados_teste)
    probs_teste = obter_probabilidades(resultado_teste.predictions)
    predicoes_teste = (probs_teste >= limiar).astype(int)
    rotulos_teste = np.asarray(resultado_teste.label_ids, dtype=int)

    metricas_teste = calcular_metricas(rotulos_teste, predicoes_teste)
    cm = confusion_matrix(rotulos_teste, predicoes_teste, labels=[0, 1])

    print("\n=== MÉTRICAS FINAIS NO TESTE ===")
    for key, value in metricas_teste.items():
        print(f"{key}: {value:.4f}")

    print("\nMatriz de confusão [[VN, FP], [FN, VP]]:")
    print(cm)

    model_dir = output_dir / "modelo_bertimbau_clickbait"
    treinador.save_model(str(model_dir))
    tokenizer.save_pretrained(str(model_dir))

    with open(model_dir / "limiar.json", "w", encoding="utf-8") as f:
        json.dump(
            {
                "threshold_clickbait": limiar,
                "optimized_for": "f1_clickbait_on_validation",
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    with open(model_dir / "metrics_test.json", "w", encoding="utf-8") as f:
        json.dump(
            {
                **metricas_teste,
                "threshold_clickbait": limiar,
                "test_size": int(len(df_teste)),
                "dataset_unique_size": int(len(dados)),
                "duplicatas_removidas": int(duplicatas_removidas),
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    pd.DataFrame(cm, index=["real_0_legitima", "real_1_clickbait"], columns=["pred_0_legitima", "pred_1_clickbait"],).to_csv(model_dir / "confusion_matrix.csv", encoding="utf-8",)

    # Salva os conjuntos usados no treinamento, validação e teste.
    df_treino.to_csv(output_dir / "split_train.csv", index=False, sep=";")
    df_validacao.to_csv(output_dir / "split_validation.csv", index=False, sep=";")
    df_teste.to_csv(output_dir / "split_test.csv", index=False, sep=";")

    print(f"\nModelo salvo em: {model_dir.resolve()}")
    return model_dir

class ClassificadorClickbait:
    def __init__(self, model_dir: str):
        self.model_dir = Path(model_dir)

        if not self.model_dir.exists():
            raise FileNotFoundError(f"Diretório do modelo não encontrado: {self.model_dir}")

        self.tokenizer = AutoTokenizer.from_pretrained(str(self.model_dir))
        self.model = AutoModelForSequenceClassification.from_pretrained(str(self.model_dir))

        if torch.cuda.is_available():
            self.device = torch.device("cuda")
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            self.device = torch.device("mps")
        else:
            self.device = torch.device("cpu")

        self.model.to(self.device)
        self.model.eval()

        arquivo_limiar = self.model_dir / "limiar.json"
        if arquivo_limiar.exists():
            with open(arquivo_limiar, "r", encoding="utf-8") as f:
                self.limiar = float(json.load(f).get("threshold_clickbait", 0.5))
        else:
            self.limiar = 0.5

    @torch.inference_mode()
    def predict_many(self, headlines, batch_size: int = 32):
        headlines = [limpar_titulo(x) for x in headlines]

        if any(not x for x in headlines):
            raise ValueError("Nenhuma manchete pode ser vazia.")

        results = []

        for start in range(0, len(headlines), batch_size):
            batch = headlines[start : start + batch_size]

            encoded = self.tokenizer(
                batch,
                return_tensors="pt",
                truncation=True,
                max_length=MAX_TOKENS,
                padding=True,
            )
            encoded = {key: value.to(self.device) for key, value in encoded.items()
            }

            logits = self.model(**encoded).logits
            probabilities = torch.softmax(logits, dim=1)[:, 1]
            labels = (probabilities >= self.limiar).long()

            for headline, label, probability in zip(
                batch,
                labels.cpu().tolist(),
                probabilities.cpu().tolist(),
            ):
                results.append(
                    {
                        "titulo": headline,
                        COLUNA_RESULTADO: int(label),
                        "probabilidade_clickbait": round(
                            float(probability), 6
                        ),
                    }
                )

        return results

    def predict_one(self, headline: str):
        return self.predict_many([headline], batch_size=1)[0]


def classificar_csv(
    model_dir: str,
    csv_path: str,
    output_path: str,
    text_column: str = COLUNA_TITULO,
    sep: str = ";",
    batch_size: int = 32,
):
    classifier = ClassificadorClickbait(model_dir)
    df = pd.read_csv(csv_path, sep=sep, encoding="utf-8")

    if text_column not in df.columns:
        raise ValueError(
            f"Coluna '{text_column}' não encontrada. "
            f"Colunas existentes: {list(df.columns)}"
        )

    predictions = classifier.predict_many(df[text_column].fillna("").astype(str).tolist(), batch_size=batch_size,)

    # Adiciona a classificação final: 0 ou 1.
    df[COLUNA_RESULTADO] = [
        p[COLUNA_RESULTADO] for p in predictions
    ]

    df.to_csv(
        output_path,
        index=False,
        sep=sep,
        encoding="utf-8",
    )

    print(f"Arquivo rotulado salvo em: {Path(output_path).resolve()}")


def criar_api(model_dir: str):
    # Imports usados somente quando a API é iniciada.
    from fastapi import FastAPI, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel, Field

    classifier = ClassificadorClickbait(model_dir)

    app = FastAPI(
        title="API de Classificação de Clickbait - BERTimbau",
        version="1.0.0",
    )

    # Durante os testes, a API aceita chamadas de qualquer origem.
    # Depois, pode ser limitado ao ID da extensão do Chrome.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    class HeadlineRequest(BaseModel):
        titulo: str = Field(min_length=1, max_length=1000)

    class BatchRequest(BaseModel):
        titulos: list[str] = Field(min_length=1, max_length=100)

    @app.get("/health")
    def health():
        return {
            "status": "ok",
            "modelo": MODELO_BASE,
            "device": str(classifier.device),
            "threshold_clickbait": classifier.limiar,
        }

    @app.post("/classificar")
    def classificar(request: HeadlineRequest):
        try:
            return classifier.predict_one(request.titulo)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/classificar-lote")
    def classificar_lote(request: BatchRequest):
        try:
            return {
                "resultados": classifier.predict_many(request.titulos)
            }
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    return app


def criar_parser():
    parser = argparse.ArgumentParser(
        description="BERTimbau para classificação binária de clickbait."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    train_parser = subparsers.add_parser("train")
    train_parser.add_argument("--csv", required=True)
    train_parser.add_argument(
        "--output-dir",
        default="saida_bertimbau",
    )
    train_parser.add_argument("--sep", default=";")
    train_parser.add_argument("--epochs", type=int, default=4)
    train_parser.add_argument(
        "--train-batch-size",
        type=int,
        default=8,
    )
    train_parser.add_argument(
        "--eval-batch-size",
        type=int,
        default=16,
    )
    train_parser.add_argument(
        "--gradient-accumulation-steps",
        type=int,
        default=2,
    )
    train_parser.add_argument(
        "--learning-rate",
        type=float,
        default=2e-5,
    )

    serve_parser = subparsers.add_parser("serve")
    serve_parser.add_argument("--model-dir", required=True)
    serve_parser.add_argument("--host", default="0.0.0.0")
    serve_parser.add_argument("--port", type=int, default=8000)

    classify_parser = subparsers.add_parser("classify")
    classify_parser.add_argument("--model-dir", required=True)
    classify_parser.add_argument("--titulo", required=True)

    classify_csv_parser = subparsers.add_parser("classify-csv")
    classify_csv_parser.add_argument("--model-dir", required=True)
    classify_csv_parser.add_argument("--csv", required=True)
    classify_csv_parser.add_argument("--output", required=True)
    classify_csv_parser.add_argument(
        "--text-column",
        default=COLUNA_TITULO,
    )
    classify_csv_parser.add_argument("--sep", default=";")
    classify_csv_parser.add_argument(
        "--batch-size",
        type=int,
        default=32,
    )

    return parser


def main():
    parser = criar_parser()
    args = parser.parse_args()

    if args.command == "train":
        treinar_bertimbau(
            csv_path=args.csv,
            output_dir=args.output_dir,
            sep=args.sep,
            epochs=args.epochs,
            train_batch_size=args.train_batch_size,
            eval_batch_size=args.eval_batch_size,
            gradient_accumulation_steps=args.gradient_accumulation_steps,
            learning_rate=args.learning_rate,
        )

    elif args.command == "serve":
        import uvicorn

        app = criar_api(args.model_dir)
        uvicorn.run(
            app,
            host=args.host,
            port=args.port,
        )

    elif args.command == "classify":
        classifier = ClassificadorClickbait(args.model_dir)
        result = classifier.predict_one(args.titulo)
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif args.command == "classify-csv":
        classificar_csv(
            model_dir=args.model_dir,
            csv_path=args.csv,
            output_path=args.output,
            text_column=args.text_column,
            sep=args.sep,
            batch_size=args.batch_size,
        )


if __name__ == "__main__":
    main()
