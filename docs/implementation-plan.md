# browser-agent 実装案

## 目的

複数のプロジェクトから、ログイン済みのGoogle ChromeをPlaywrightで操作し、機密情報を撮影時にマスクした高解像度スクリーンショットを再現可能に生成する。

## 責務の分離

```text
Git管理するもの
  assets/fonts/                 固定フォント、ライセンス、取得元とSHA-256
  config/fontconfig/            Chrome専用のフォールバック設定
  sites/<site>/site.json       サイト、認証方式、ブラウザ設定
  sites/<site>/captures.json   撮影、マスク、注釈、準備操作
  src/                         検証・認証・撮影処理

Git管理しないもの
  ~/.local/share/browser-agent/profiles/  Chromeプロファイル
  ~/.local/share/browser-agent/auth/      Playwright認証state
  ~/.local/share/browser-agent/runtime/   一時設定・ロック
```

## コマンド境界

- `browser-agent browser`: 固定版Playwright CLIへの入口。通常操作はheadedで行う。
- `browser-agent login open/save/close`: 手動ログインとMFAを扱う。`state`方式は明示的に保存する。
- `browser-agent capture`: 宣言済みの限定操作、マスク、注釈、原子的な画像更新を行う。
- `browser-agent validate`: ブラウザを起動せず、全設定を検証する。

## 安全性

- 認証情報、Cookie、Chromeプロファイルはリポジトリ外に置く。
- 対話操作用の`browser`では、未マスク画像を残す`screenshot`と`pdf`を実行しない。完成画像は`capture`だけで生成する。
- 設定から任意JavaScript、入力、アップロードを実行しない。
- 定義済み撮影のURLは上書きしない。画面ごとに撮影定義とマスクをレビューする。
- ログイン済み画面は既定で`masked`とし、少なくとも1件の必須マスクを要求する。公開画面だけは`public`を明示する。
- 必須マスクが一致しない、または件数条件を満たさない場合は撮影しない。
- Webフォントと表示対象画像の読み込みを確認する。意図的に読み込めない画像は、構造化locatorで個別に除外する。
- サイト固有のWebフォントを優先し、未指定時の日本語と英語だけを固定したローカルTTFへフォールバックする。
- ローカルTTFのSHA-256が不一致の場合はChromeを起動しない。撮影中はフォントをダウンロードしない。
- マスクはPlaywrightのScreenshot APIで適用し、未マスク画像をディスクへ書かない。
- 表示領域とPNG出力倍率を分離し、既定では1440×900のレイアウトを2880×1800で出力する。
- 赤枠・番号の座標、余白、線幅、文字サイズをPNG出力倍率に合わせる。
- 出力は呼び出し元ディレクトリ配下の相対パスに限定する。
- 完成画像は同一ディレクトリ内の一時ファイルから原子的に置き換える。
- 完成画像を不透明な8-bit sRGB RGB PNGへ正規化し、寸法と形式を保存前に検査する。

## 実装フェーズ

1. 設定スキーマとパス境界を実装する。
2. `profile` / `state`認証とPlaywright CLIラッパーを実装する。
3. 準備操作、fail-closedマスク、高DPI撮影、赤枠・番号注釈を実装する。
4. 単体テストと実ブラウザを用いたローカル統合テストを行う。
