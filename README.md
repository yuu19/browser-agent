# browser-agent

ログイン済みのGoogle Chromeを複数プロジェクトから操作し、機密情報を撮影時にマスクしたスクリーンショットを生成する共通ツールです。

記事・Markdown・ユーザーマニュアル本文の生成は責務に含みません。

## 必要なもの

- Node.js 20以上
- Google Chrome Stable (`google-chrome`)
- ImageMagick (`magick`、注釈を描画する場合)
- Noto CJKとInter（日本語・英語のフォールバック表示）

セットアップ:

```bash
npm install
npm link
browser-agent doctor
browser-agent validate
```

Playwright CLIとPlaywright Libraryは`package-lock.json`で固定します。グローバルに導入済みの`playwright-cli`には依存しません。

Chromeのフォント構成、導入手順、確認方法は[Chromeの日本語・英語フォント](docs/chrome-fonts.md)を参照してください。
今回導入したパッケージ、追加設定、実行状態、再現手順は[セットアップ記録](docs/setup-record.md)にまとめています。

## ディレクトリ

```text
browser-agent/
├── sites/<site>/site.json
├── sites/<site>/captures.json
├── bin/browser-agent.js
└── src/

~/.local/share/browser-agent/     # Git管理しない
├── profiles/
├── auth/
└── runtime/
```

ランタイムデータの場所は`BROWSER_AGENT_DATA_DIR`、サイト定義の場所は`BROWSER_AGENT_SITES_DIR`で変更できます。

## サイト設定

`sites/example/site.json`をコピーしてサイトを追加します。

```json
{
  "baseUrl": "https://admin.example.com/",
  "loginUrl": "https://admin.example.com/login",
  "authMode": "profile",
  "browser": {
    "channel": "chrome",
    "viewport": { "width": 1440, "height": 900 },
    "deviceScaleFactor": 2,
    "locale": "ja-JP",
    "captureHeaded": false
  }
}
```

`viewport`は画面上のCSSピクセル数、`deviceScaleFactor`はPNGの出力倍率です。
上の設定ではレイアウトを1440×900に保ったまま、2880×1800のPNGを生成します。
倍率は1以上4以下で指定でき、既定値は2です。マスクと赤枠・番号も同じ倍率で処理します。

`authMode`:

- `profile`: Chromeプロファイルをそのまま再利用します。既定値です。同一サイトの並列利用はロックされます。
- `state`: 手動ログイン後のCookie・localStorage等を保存し、独立したブラウザセッションへ読み込みます。

認証情報、Cookie、APIキー、パスワードをサイト設定へ書かないでください。

## ログイン

### profile方式

```bash
browser-agent login open example
# ChromeでログインとMFAを完了
browser-agent login close example
```

Chromeプロファイル自体へ状態が保存されるため、`login save`は不要です。

### state方式

```bash
browser-agent login open example
# ChromeでログインとMFAを完了
browser-agent login save example
```

`login save`を実行するまで既存の認証stateは更新されません。保存先は`~/.local/share/browser-agent/auth/<site>.json`で、パーミッションは`0600`です。

## 通常のブラウザ操作

固定版Playwright CLIへコマンドを渡します。`open`時のChrome、認証、profile、headed設定はサイト設定から強制されます。

```bash
browser-agent browser example open
browser-agent browser example snapshot
browser-agent browser example click e3
browser-agent browser example screenshot --filename=docs/images/check.png
browser-agent browser example close
```

`state`方式ではプロジェクトごとに独立したnamed sessionを使用します。明示する場合は次のように指定します。

```bash
browser-agent browser example --session=investigation open
```

`profile`方式は同一profileの同時起動を拒否します。異常終了後にブラウザが停止していることを確認したうえで、残存ロックを削除できます。

```bash
browser-agent unlock example
```

## 撮影定義

`sites/<site>/captures.json`は、撮影IDをキーにしたオブジェクトです。

```json
{
  "user-list": {
    "path": "/users",
    "output": "docs/images/users.png",
    "fullPage": false,
    "waitMs": 500,
    "maskColor": "#1f2937",
    "prepare": [
      {
        "action": "click",
        "locator": { "type": "role", "role": "tab", "name": "ユーザー" },
        "match": "one"
      }
    ],
    "masks": [
      {
        "locator": { "type": "css", "value": "[data-private='email']" },
        "match": "all",
        "required": true
      }
    ],
    "annotations": [
      {
        "locator": { "type": "role", "role": "button", "name": "ユーザーを追加" },
        "match": "one",
        "required": true,
        "label": "1"
      }
    ]
  }
}
```

### locator

任意JavaScriptは許可しません。次の構造化locatorを使用できます。

```json
{ "type": "role", "role": "button", "name": "保存", "exact": true }
{ "type": "label", "value": "メールアドレス", "exact": true }
{ "type": "text", "value": "設定", "exact": true }
{ "type": "testId", "value": "api-key" }
{ "type": "placeholder", "value": "検索", "exact": true }
{ "type": "css", "value": "[data-private='true']" }
```

`match`は次のいずれかです。省略時は`one`です。

```json
"one"
"all"
{ "count": 3 }
```

`required`は既定で`true`です。必須マスクが0件、または一致条件を満たさない場合、画像は一切出力されません。任意マスクでも複数一致による曖昧さはエラーになります。

### 撮影前の限定操作

`prepare`で許可する操作は次だけです。

- `click`
- `hover`
- `press`
- `scrollIntoView`
- `waitFor`

`fill`、`type`、`upload`、任意JavaScriptはcapture定義では実行できません。クリックは画面を変更し得るため、定義追加時に保存・削除操作でないことをレビューしてください。

## 撮影

呼び出し元プロジェクトで実行します。出力はそのディレクトリ配下の相対パスに限定されます。

```bash
cd ~/projects/project-a
browser-agent capture example home
```

単発撮影または一部上書きもできます。

```bash
browser-agent capture example \
  --path=/settings \
  --output=docs/images/settings.png \
  --mask='{"locator":{"type":"testId","value":"api-key"},"match":"one"}' \
  --annotation='{"locator":{"type":"role","role":"button","name":"保存"},"match":"one"}'
```

主な上書きオプションは`browser-agent --help`で確認できます。

## 安全上の注意

- PNGには撮影時マスクを適用しますが、Playwrightのsnapshotやブラウザ画面を操作するエージェントから値を隠す機能ではありません。エージェントにも見せられない情報には、専用テストアカウントやダミーデータを使ってください。
- `storage-state.json`やprofileをGitへ追加しないでください。
- 加工前の未マスク画像は作成しません。マスク済みの一時PNGも処理終了時に削除します。
- 既存の完成PNGは、撮影・注釈がすべて成功した後だけ原子的に置き換えます。

設計上の判断と責務は[docs/implementation-plan.md](docs/implementation-plan.md)にまとめています。

## 検証

```bash
npm run verify
npm run test:integration
```

通常のテストは設定、パス境界、ロック、原子的な書き込みを検証します。統合テストは実際のGoogle ChromeとImageMagickを起動し、撮影画像のマスク色・注釈色と、必須マスク失敗時に既存画像を保持することを検証します。
