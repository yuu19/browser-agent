# browser-agent

ログイン済みブラウザを安全な範囲で操作し、機密情報をマスクしたスクリーンショットを生成する共通ツールです。

通常操作の実行エンジンには固定版の`agent-browser`を使います。撮影はPlaywright Libraryで別に実行し、未マスク画像を成果物として残しません。記事・Markdown・ユーザーマニュアル本文の生成は責務に含みません。

## 必要なもの

- Node.js 24以上
- Linux x64またはLinux Arm64
- Google Chrome Stable、またはPlaywright Chromium
- ImageMagick 6または7
- fontconfig
- `lsof`と`fuser`

セットアップ:

```bash
npm ci
# Linux Arm64でPlaywright Chromiumを使う場合
npx playwright install --with-deps chromium
# Google Chromeを使う場合
npx playwright install --with-deps chrome
node scripts/fetch-fonts.js
npm link
browser-agent doctor
browser-agent validate
```

`agent-browser` 0.35.1とPlaywright Library 1.62.0は`package-lock.json`で固定しています。`agent-browser`のLinux x64・Arm64ネイティブバイナリは、実行のたびに承認済みSHA-256と照合します。グローバルコマンドや継承した`AGENT_BROWSER_*`設定は使いません。

ブラウザのフォント構成は[ブラウザの日本語・英語フォント](docs/chrome-fonts.md)、安全境界の詳細は[操作エンジンの安全設計](docs/agent-browser-security.md)を参照してください。

## データの置き場所

```text
browser-agent/
├── assets/fonts/                         # 固定TTF、ライセンス、SHA-256
├── config/agent-browser-*.json           # 承認バイナリとdefault-deny操作方針
├── config/fontconfig/                    # 専用フォント設定
├── sites/<site>/site.json                # サイトと許可オリジン
├── sites/<site>/captures.json            # 撮影、マスク、注釈
├── bin/browser-agent.js
└── src/

~/.local/share/browser-agent/              # Git管理しない
├── profiles/                              # ログイン時だけ更新する正本profile
├── auth/                                  # login saveだけが更新する認証state
├── runtime/<site>/
│   ├── sessions/                          # 内容を含まない実行メタデータ
│   ├── working-profiles/                  # 操作・撮影ごとの一時コピー
│   ├── downloads/                         # 取得不能な隔離領域
│   ├── configs/                           # 強制設定
│   └── audit.jsonl                        # 内容を含まない監査記録
└── fontconfig/
```

データ正本は`BROWSER_AGENT_DATA_DIR`、サイト定義は`BROWSER_AGENT_SITES_DIR`で変更できます。profileや認証stateをVault、Git、呼び出し元プロジェクトへ復元・複製する機能はありません。

## サイト設定

`sites/example/site.json`をコピーします。

```json
{
  "baseUrl": "https://admin.example.com/",
  "loginUrl": "https://login.example.com/",
  "allowedOrigins": [
    "https://admin.example.com",
    "https://login.example.com"
  ],
  "authMode": "profile",
  "browser": {
    "channel": "auto",
    "viewport": { "width": 1440, "height": 900 },
    "deviceScaleFactor": 2,
    "locale": "ja-JP",
    "captureHeaded": false
  }
}
```

`allowedOrigins`は、操作前後に全タブのトップレベルURLを検査する境界です。省略すると`baseUrl`と`loginUrl`のオリジンを使います。パス、クエリ、ワイルドカードは指定できません。

この境界は、画像、JavaScript、APIなどのサブリソース通信を遮断するネットワークサンドボックスではありません。対象サイト自体を信頼できない場合や、外部通信も制限する必要がある場合には使用しないでください。

`viewport`はCSSピクセル、`deviceScaleFactor`はPNGの倍率です。上の設定では1440×900のレイアウトを2880×1800で保存します。操作と撮影は同じChrome実行ファイル、viewport、倍率、localeを使います。

認証方式:

- `profile`: 手動ログインだけが正本profileを更新します。通常操作と撮影は、正本の専用コピーを使い、終了時に削除します。
- `state`: `login save`だけが認証stateを更新します。通常操作は認証stateを一度だけ読み込み、正本へ書き戻しません。

認証情報、Cookie、APIキー、パスワードをサイト設定へ書かないでください。

## ログイン

profile方式:

```bash
browser-agent login open example
# ブラウザでログインとMFAを完了
browser-agent login close example
```

state方式:

```bash
browser-agent login open example
# ブラウザでログインとMFAを完了
browser-agent login save example
```

state方式では、一時ファイルのサイズとJSON構造を確認し、Playwrightのネットワークアクセスを伴わない新規contextで読み込めることを検証します。成功した場合だけ、パーミッション`0600`で認証stateを原子的に置き換えます。

パスワード、MFAコード、APIキーなどは、headedブラウザで人が入力します。`browser`の`fill`や`type`には機密値を渡さないでください。

## 通常のブラウザ操作

外側のコマンド体系は維持し、内側は`agent-browser`の参照記法を使います。

```bash
browser-agent browser example open
browser-agent browser example snapshot -i
browser-agent browser example click @e3
browser-agent browser example get text @e7
browser-agent browser example close
```

呼び出し元プロジェクトごとにセッション名が自動生成されます。明示する場合:

```bash
browser-agent browser example --session=investigation open /settings
```

許可する主な操作:

- `open`、`back`、`forward`、`reload`、`close`
- `snapshot`、現在DOMだけを対象にした`read`
- `click`、`hover`、`focus`、`press`、`select`、`check`、`uncheck`
- 非機密文字列だけを対象にした`fill`、`type`、`keyboard type`
- `wait`、`scroll`、`scrollintoview`
- 限定した`get`、`is`、`find`
- `tab list`、既存タブの切替・終了
- ダイアログの状態確認、accept、dismiss

拒否する主な操作:

- 任意JavaScript、CDP、任意ネットワーク・Cookie・storage操作
- ファイルのupload、download、ローカルファイル参照
- `screenshot`、`pdf`、HTML・入力値・属性の取得
- raw画像、LLM向けページ変換、外部URLを指定した`read`
- 新しいタブやウィンドウを直接作る操作
- `--profile`、`--config`、`--proxy`などの管理オプション上書き

上流のdefault-deny方針と外側のallowlistを二重に適用します。default-deny方針は操作エンジンを呼び出すたびに検証します。操作前後に全タブを検査し、許可外オリジン、未知のトップレベルtarget、stream有効化を検知した場合はセッションを終了します。出力はcontent boundary付きで50,000文字までに制限します。

同じセッションへの並行コマンドは待機せず失敗します。1時間操作されないセッションは終了対象です。

## 異常終了後の解除

```bash
browser-agent unlock example
```

`unlock`はロックを無条件削除しません。agent-browserのセッション一覧、記録したPID、Chromeのuser-data-dir、`lsof`/`fuser`を検査し、全対象が停止している場合だけ古いメタデータをprivateなarchiveへ移します。稼働中または検査不能なら何も変更せず停止します。

## 撮影定義

`sites/<site>/captures.json`は、撮影IDをキーにしたオブジェクトです。

```json
{
  "user-list": {
    "path": "/users",
    "output": "docs/images/users.png",
    "privacy": "masked",
    "fullPage": false,
    "waitMs": 500,
    "maskColor": "#1f2937",
    "readiness": {
      "fonts": true,
      "images": true,
      "timeoutMs": 10000,
      "ignoreImages": []
    },
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

ログイン済み画面は既定で`masked`です。少なくとも1件の必須マスクが必要です。認証情報、個人情報、非公開の識別子や数値がないと確認した画面だけ、`"privacy": "public"`を明示できます。

locatorは`role`、`label`、`text`、`testId`、`placeholder`、`css`を使えます。`match`は`one`、`all`、または`{ "count": 3 }`です。必須マスクや一致件数の検査に失敗した場合、画像は出力しません。

撮影前の`prepare`で許可する操作は`click`、`hover`、`press`、`scrollIntoView`、`waitFor`だけです。入力、upload、任意JavaScriptは実行できません。

## 撮影

呼び出し元プロジェクトで実行します。出力先は、そのディレクトリ配下の相対パスに限定されます。

```bash
cd ~/projects/project-a
browser-agent capture example user-list
```

単発撮影:

```bash
browser-agent capture example \
  --path=/settings \
  --output=docs/images/settings.png \
  --mask='{"locator":{"type":"testId","value":"api-key"},"match":"one"}' \
  --annotation='{"locator":{"type":"role","role":"button","name":"保存"},"match":"one"}'
```

撮影前にWebフォントと表示対象画像の読み込みを確認します。未マスク画像はディスクへ書かず、完成PNGは不透明な8-bit sRGB RGBへ正規化してから原子的に置き換えます。

## 監査記録

通常操作は、時刻、サイト、セッション、操作名、成否、操作前後のオリジン、エラーコードだけを記録します。selector、入力文字列、ページ内容、コマンド出力は記録しません。直近7日、最大1,000件を保持します。異なるセッションからの更新もサイト単位で直列化します。壊れた監査ファイルは上書きせずarchiveへ移します。

## 検証

```bash
npm run verify
npm run test:integration
browser-agent doctor
browser-agent validate
```

通常テストは設定、allowlist、バイナリハッシュ、default-deny方針、ロック、profileコピー、原子的書き込みを検証します。統合テストは使い捨てのローカルサイトだけを使い、実ブラウザ操作、許可外オリジン時の終了、state保存、profile正本の不変、マスク付き撮影を検証します。

既存サービスを対象にしたカナリア確認は自動実行しません。対象サイトと実行内容を別途承認した後に行います。
