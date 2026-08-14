# browser-agentセットアップ記録

この環境では、ログイン済みChromeを複数のプロジェクトから操作し、機密情報をマスクしたスクリーンショットを生成できます。
Cloudflare Dashboardは専用プロファイルでログイン済みです。
ブラウザの認証情報はGitで管理しません。

この文書は、2026年8月15日時点の導入内容と設定状態を記録しています。

## 今回導入したもの

### ブラウザ操作

リポジトリ内へ、次のNode.jsパッケージを導入しました。
バージョンは`package-lock.json`で固定しています。

| 用途 | パッケージ | バージョン |
|---|---|---|
| Codexからの対話的なブラウザ操作 | `@playwright/cli` | `0.1.17` |
| マスク付き撮影とブラウザ制御 | `playwright` | `1.62.0` |

導入時のコマンド:

```bash
npm install
```

公開版の更新は自動追従しません。
動作を確認してから、`package.json`と`package-lock.json`を更新します。

### 日本語・英語フォント

WSLのUbuntuへ、次のフォントを導入しました。

| 用途 | パッケージ | バージョン |
|---|---|---|
| 日本語のゴシック体・明朝体 | `fonts-noto-cjk` | `1:20230817+repack1-3` |
| 英語のUIフォント | `fonts-inter` | `4.0+ds-1` |

導入時のコマンド:

```bash
sudo apt-get install -y fonts-noto-cjk fonts-inter
```

フォントの割り当てと確認方法は[Chromeの日本語・英語フォント](chrome-fonts.md)に記録しています。

## 既存環境で確認したもの

次のソフトウェアはセットアップ開始時点で利用可能でした。
今回の作業では新規導入していません。

| 用途 | ソフトウェア | 確認したバージョン |
|---|---|---|
| JavaScript実行環境 | Node.js | `v25.6.0` |
| Node.jsパッケージ管理 | npm | `11.8.0` |
| SaaS管理画面の操作 | Google Chrome | `145.0.7632.159` |
| 赤枠・番号の画像加工 | ImageMagick | `6.9.12-98 Q16` |
| カラー絵文字 | `fonts-noto-color-emoji` | `2.047-0ubuntu0.24.04.1` |

プロジェクトが要求するNode.jsの最低バージョンは20です。
現在の実行環境はこの条件を満たしています。

## 追加した設定

### ブラウザ認証

Cloudflareは、SaaSごとの永続Chromeプロファイルを使います。
認証方式は`profile`です。
ログインとMFAはChrome上で手動実行しました。

Gitで管理する設定:

- [Cloudflareのブラウザ設定](../sites/cloudflare/site.json)
- [Cloudflareの撮影・マスク設定](../sites/cloudflare/captures.json)

Gitで管理しない実行状態:

```text
~/.local/share/browser-agent/profiles/cloudflare/
```

このディレクトリにはCookieなどのログイン状態が含まれます。
共有、バックアップへの無確認追加、Gitへの追加は行いません。

### Cloudflareの撮影

Cloudflare Dashboardは、セキュリティ確認を完了できるようheadedモードで撮影します。
アカウント切替ボタンが表示されるまで、最大30秒待機します。
画面レイアウトは1440×900 CSSピクセルに固定します。
完成するPNGは2880×1800ピクセルです。マスクと赤枠・番号も2倍解像度に追従します。

高解像度の設定を書き込むファイルは、`sites/cloudflare/site.json`です。
`browser`内の設定値は次のとおりです。

```json
"viewport": { "width": 1440, "height": 900 },
"deviceScaleFactor": 2
```

ほかのサイトでも、各`sites/<site>/site.json`へ同じ倍率を設定できます。
指定できる倍率は1以上4以下で、未指定時は2です。

撮影前にAnalyticsカードの描画領域が表示されるまで最大30秒待ちます。
表示後も5秒待ち、リソース一覧と集計値の読み込みを完了させます。
次の値だけをマスクします。

- アカウント名とメールアドレス
- サイドバーの最近使ったリソース名と付随情報
- ドメイン数とドメイン名
- Worker数とWorker名
- 最近使ったリソース名
- Analyticsの集計値、増減率、グラフ描画領域

見出し、アイコン、カード枠、Analyticsの一般的な項目名は表示します。
設定を書き込むファイルは、`sites/cloudflare/captures.json`です。

必須の秘密値が1つでも見つからない場合は、画像を保存しません。
完成画像は次の場所へ出力します。

```text
artifacts/cloudflare/dashboard.png
```

`artifacts/`はGitの対象外です。

### フォントの優先順位

日本語ページではNoto CJK、英語ページではInterを優先します。
正本は[fontconfig設定](../config/fontconfig/browser-agent-fonts.conf)です。

実行環境では、次の場所へコピーしました。

```text
~/.config/fontconfig/conf.d/50-browser-agent-fonts.conf
```

設定の反映時に`fc-cache -f`を実行しました。
起動中のブラウザはないため、次回起動から新しい割り当てが使われます。

### Gitへ含めないもの

[.gitignore](../.gitignore)で、次の情報を対象外にしています。

- `node_modules/`
- Chromeプロファイル
- Playwrightの認証state
- `.env`とシークレット
- Playwrightの一時ファイル
- 加工前スクリーンショット
- `artifacts/`

## 追加したコマンド

`browser-agent`は次の操作を提供します。

| 操作 | コマンド |
|---|---|
| 環境確認 | `browser-agent doctor` |
| サイト設定の検証 | `browser-agent validate` |
| 手動ログイン開始 | `browser-agent login open <site>` |
| ログイン用Chromeの正常終了 | `browser-agent login close <site>` |
| 通常のブラウザ操作 | `browser-agent browser <site> ...` |
| マスク付き撮影 | `browser-agent capture <site> <capture>` |

現在、`npm link`によるグローバルコマンド登録は実施していません。
このリポジトリでは、次の形式で実行できます。

```bash
node bin/browser-agent.js validate
```

グローバルコマンドが必要な場合は、リポジトリ内で次を実行します。

```bash
npm link
```

## 新しい環境での再現手順

1. Google Chrome、Node.js 20以上、ImageMagickを用意します。
2. Noto CJKとInterをインストールします。
3. `npm ci`でロック済み依存関係を導入します。
4. fontconfig設定をユーザー設定へコピーします。
5. `fc-cache -f`を実行します。
6. `node bin/browser-agent.js doctor`を実行します。
7. `node bin/browser-agent.js validate`を実行します。
8. SaaSごとに`login open`でログインとMFAを完了します。
9. `login close`でChromeを正常終了します。

リポジトリ内の自動セットアップは次のコマンドです。

```bash
./setup.sh
```

`setup.sh`は`npm ci`、`npm link`、環境確認、サイト設定検証を実行します。
OSパッケージの導入とfontconfig設定のコピーは行いません。
これらはsudoやユーザーディレクトリの変更を伴うため、上記の手順で明示的に実行します。

## 検証結果

2026年8月15日に次を確認しました。

- `npm run verify`: 成功
- 実Chromeを使う撮影統合テスト: 3件成功
- Cloudflare設定検証: 成功
- Cloudflareのマスク付き撮影: 成功
- 高解像度撮影（1440×900表示、2880×1800出力）: 成功
- Cloudflareプロファイル: 保存済み
- ブラウザセッション: すべて終了済み
- 日本語ゴシック体: Noto Sans CJK JP
- 英語ゴシック体: Inter
- 日本語明朝体: Noto Serif CJK JP
- 日本語等幅フォント: Noto Sans Mono CJK JP

## 実装上の補足

撮影処理は、マスク対象をすべて検証してからPNGを書き込みます。
未マスク画像は保存しません。
注釈がない撮影でも完成画像を公開できるよう、回帰テストを追加しています。
高DPI撮影ではPlaywrightのdevice pixel出力を使い、ImageMagickで追加する注釈の座標、余白、線幅、文字も同じ倍率に変換します。

設計全体は[実装案](implementation-plan.md)を参照してください。
