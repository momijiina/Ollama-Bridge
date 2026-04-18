# Ollama Bridge

Ollama API を LM Studio (OpenAI 互換 API) に変換するブリッジサーバーです。

VS Code Copilot や Continue など、Ollama にしか対応していないツールから LM Studio のモデルを利用できるようになります。

VS Codeがデフォルト対応してないので作成
<img width="3140" height="823" alt="image" src="https://github.com/user-attachments/assets/c20754af-9444-4bba-9118-72bcd327970a" />

モデルは**自動ロード**されるので事前の手動ロードは不要
<img width="2119" height="1789" alt="image" src="https://github.com/user-attachments/assets/3b365566-6af2-4382-a001-10a1b82722ed" />


## 特徴

- Ollama API を完全にエミュレートし、LM Studio へリクエストを転送
- VS Code Copilot との互換性 (`capabilities` フィールド対応)
- **モデル自動ロード** — `lms` CLI を使って未ロードのモデルを自動的にロード
- ストリーミング / 非ストリーミング両対応
- 画像入力 (Vision モデル) 対応
- エンベディング対応
- モデル名から capabilities を自動検出 (completion / tools / embed / vision)
- `/v1/*` パススルーで OpenAI 互換 API も直接利用可能

## 必要なもの

- Node.js 18+
- LM Studio (起動済み、ローカルサーバー ON)
- `lms` CLI (モデル自動ロードに必要。LM Studio インストール時に自動設定済み)

## 使い方

```bash
node bridge.mjs
```

またはダブルクリック:

```
start.bat
```

### VS Code Copilot で使う場合

1. LM Studio を起動し、ローカルサーバーを ON にする
2. 本物の Ollama が起動中であれば停止する (ポート 11434 の競合回避)
3. `node bridge.mjs` でブリッジを起動
4. VS Code の設定で Ollama プロバイダーを有効にし、モデルを選択

## オプション

| フラグ | デフォルト | 説明 |
|---|---|---|
| `--ollama-host` | `0.0.0.0` | ブリッジのリッスンアドレス |
| `--ollama-port` | `11434` | ブリッジのリッスンポート |
| `--lmstudio-url` | `http://127.0.0.1:1234` | LM Studio の URL |
| `--ollama-version` | `0.8.0` | 偽装する Ollama バージョン |
| `--context-length` | `65536` | モデル自動ロード時のコンテキスト長 |

例:

```bash
node bridge.mjs --ollama-port 11435 --lmstudio-url http://192.168.1.10:1234

# バージョンを変更する場合 (拡張機能が最低バージョンを要求する場合)
node bridge.mjs --ollama-version 0.9.0

# コンテキスト長を変更する場合 (VRAM に余裕がある場合)
node bridge.mjs --context-length 131072
```

## 対応エンドポイント

| Ollama API | 変換先 (LM Studio) | 機能 |
|---|---|---|
| `GET /` | — | ヘルスチェック |
| `HEAD /` | — | ヘルスチェック (HEAD) |
| `GET /api/version` | — | バージョン情報 |
| `GET /api/tags` | `GET /v1/models` | モデル一覧 |
| `GET /api/ps` | `GET /v1/models` | 実行中モデル一覧 |
| `POST /api/show` | `GET /v1/models` | モデル情報 (capabilities 含む) |
| `POST /api/chat` | `POST /v1/chat/completions` | チャット (ストリーミング対応) |
| `POST /api/generate` | `POST /v1/chat/completions` | テキスト生成 (ストリーミング対応) |
| `POST /api/embeddings` | `POST /v1/embeddings` | エンベディング |
| `POST /api/embed` | `POST /v1/embeddings` | エンベディング (別名) |
| `POST /api/pull` | — | スタブ (常に成功を返す) |
| `POST /api/push` | — | スタブ (常に成功を返す) |
| `POST /api/copy` | — | スタブ (常に成功を返す) |
| `POST /api/delete` | — | スタブ (常に成功を返す) |
| `/v1/*` | そのままパススルー | OpenAI 互換 API 直接利用 |

## capabilities 自動検出

`/api/show` のレスポンスには、モデル名に基づいた `capabilities` 配列が含まれます:

| モデル名に含む文字列 | 付与される capability |
|---|---|
| (全モデル) | `completion` |
| (非 embed モデル) | `tools` |
| `embed` | `embed` |
| `vl` / `vision` | `vision` |

## モデル自動ロード

チャットやテキスト生成リクエスト時に、指定されたモデルが LM Studio にロードされていない場合、`lms load` コマンドで自動的にロードします。

- 対象: `/api/chat`、`/api/generate`、`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`
- `lms status` でロード済みか確認し、未ロードなら `lms load "<model>" -y -c <context-length>` を実行
- タイムアウト: 2分 (大型モデルのロードに対応)
- 一度ロード確認したモデルはセッション内でキャッシュし、毎回 CLI を呼ばない
- CLI が失敗した場合もリクエストは続行されます

## デバッグ

`/api/chat` および `/v1/*` パススルーにはデバッグログが組み込まれています。ブリッジ起動中のコンソールで以下の情報が確認できます:

- リクエストボディ (先頭 500 文字)
- 変換後のモデル名、ストリーミング設定、メッセージ数
- LM Studio からのレスポンスステータス
- `/v1/*` パススルーのレスポンス Content-Type とレスポンス長

## 注意事項

- 本物の Ollama が起動中の場合はポートが競合するため、先に停止してください
- LM Studio のローカルサーバーを事前に有効にしてください
- `--ollama-host` のデフォルトは `0.0.0.0` (全インターフェースでリッスン) です
- モデル自動ロードには `lms` CLI が必要です。LM Studio インストール時に PATH に追加されます
- 大型モデルの初回ロードには時間がかかる場合があります
