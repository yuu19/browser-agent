# ブラウザの日本語・英語フォント

ChromeまたはChromiumでサイト固有のWebフォントを読み込める場合は、そのフォントを表示します。Webフォントがない場合や、指定フォントに対象文字がない場合だけ、リポジトリ内の固定フォントを使います。

撮影時にフォントをダウンロードしません。固定フォントがない場合や内容が変わっている場合は、ブラウザを起動する前に停止します。

## 固定するフォールバック

| 表示対象 | フォント | 固定元 |
|---|---|---|
| 日本語のゴシック体 | Noto Sans JP Variable | Google Fontsの固定コミット |
| 英語のゴシック体 | Inter Variable 4.1 | Interの公式タグ`v4.1` |

フォント本体、ライセンス、取得元、SHA-256は[フォント資産](../assets/fonts/)で管理します。正確なURLとハッシュは[SOURCE.json](../assets/fonts/SOURCE.json)が正本です。

明朝体、等幅フォント、カラー絵文字は固定対象ではありません。サイトがWebフォントを配信しない場合は、実行環境のシステムフォントへフォールバックします。

## セットアップ

通常は検証済みフォントがリポジトリに含まれています。次のコマンドは内容を確認し、不足しているファイルだけを固定URLから取得します。

```bash
npm run fonts:fetch
```

既存ファイルのハッシュが異なる場合は、自動で上書きしません。差分を確認したうえで、正しい固定配布物へ戻す場合だけ次を実行します。

```bash
node scripts/fetch-fonts.js --force
```

撮影時にネットワーク取得は行いません。新しいフォント版へ更新するときは、取得元、SHA-256、ライセンス、実ブラウザ統合テストを同じ変更で更新します。

## 実行時の適用

`capture`、`login open`、`browser open`は、ブラウザ起動前にTTFのSHA-256を検証します。検証後、専用fontconfigをブラウザプロセスだけに適用します。

サイト固有のWebフォントは置き換えません。`sans-serif`と`system-ui`、およびChromeが英語の既定名として使うArial・Helvetica系の未導入フォントだけを固定フォールバックへ解決します。

実装上の正本:

- [フォント検証](../src/fonts.js)
- [fontconfig設定](../config/fontconfig/browser-agent-fonts.conf)
- [取得スクリプト](../scripts/fetch-fonts.js)

専用fontconfigの設定とキャッシュは、既定では次に置きます。ブラウザプロファイルや認証stateとは分離します。

```text
~/.local/share/browser-agent/fontconfig/
├── config/
└── cache/
```

`BROWSER_AGENT_DATA_DIR`を指定した場合は、そのディレクトリ配下へ移動します。ユーザー全体の`~/.config/fontconfig`は変更しません。

## 確認方法

フォント本体のハッシュだけを確認します。

```bash
npm run fonts:check
```

ブラウザ、ImageMagick、fontconfigの実際の選択をまとめて確認します。

```bash
browser-agent doctor
```

期待するフォールバックは次のとおりです。

```text
Japanese sans-serif font: Noto Sans JP .../assets/fonts/NotoSansJP-Variable.ttf
English sans-serif font: Inter Variable .../assets/fonts/InterVariable.ttf
```

実ブラウザ統合テストでは、DevToolsの実使用フォント情報を読み取り、日本語と英語がそれぞれ固定TTFへ解決されたことを確認します。
