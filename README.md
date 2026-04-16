# Ollama Bridge

Ollama API を LM Studio (OpenAI 互換 API) に変換するブリッジサーバーです。

VS Code 拡張機能など、Ollama にしか対応していないツールから LM Studio を利用できるようになります。

## 必要なもの

- Node.js 18+
- LM Studio (起動済み、ローカルサーバー ON)

## 使い方

```bash
node bridge.mjs
```

またはダブルクリック:

```
start.bat
```

## オプション

| フラグ | デフォルト | 説明 |
|---|---|---|
| `--ollama-host` | `127.0.0.1` | ブリッジのリッスンアドレス |
| `--ollama-port` | `11434` | ブリッジのリッスンポート |
| `--lmstudio-url` | `http://127.0.0.1:1234` | LM Studio の URL |
| `--ollama-version` | `0.8.0` | 偽装する Ollama バージョン |

例:

```bash
node bridge.mjs --ollama-port 11435 --lmstudio-url http://192.168.1.10:1234

# バージョンを変更する場合 (拡張機能が最低バージョンを要求する場合)
node bridge.mjs --ollama-version 0.9.0
```

## 対応エンドポイント

| Ollama API | 変換先 (LM Studio) | 機能 |
|---|---|---|
| `GET /` | — | ヘルスチェック |
| `GET /api/version` | — | バージョン情報 |
| `GET /api/tags` | `GET /v1/models` | モデル一覧 |
| `POST /api/show` | `GET /v1/models` | モデル情報 |
| `POST /api/chat` | `POST /v1/chat/completions` | チャット (ストリーミング対応) |
| `POST /api/generate` | `POST /v1/chat/completions` | テキスト生成 (ストリーミング対応) |
| `POST /api/embeddings` | `POST /v1/embeddings` | エンベディング |
| `/v1/*` | そのままパススルー | OpenAI 互換 API 直接利用 |

## 注意事項

- 本物の Ollama が起動中の場合はポートが競合するため、先に停止してください
- LM Studio のローカルサーバーを事前に有効にしてください
