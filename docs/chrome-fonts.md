# Chromeの日本語・英語フォント

ChromeとPlaywrightで取得する画面では、日本語をNoto CJK、英語をInterで表示します。
Webサイトが独自のWebフォントを配信している場合は、そのフォントが優先されます。
独自フォントを読み込めない場合や、指定フォントに文字がない場合に、この設定がフォールバックとして使われます。

## 現在の状態

2026年8月15日に、WSLのUbuntuへ次のフォントを導入しました。

| 用途 | パッケージ | 導入バージョン |
|---|---|---|
| 日本語のゴシック体・明朝体 | `fonts-noto-cjk` | `1:20230817+repack1-3` |
| 英語のUIフォント | `fonts-inter` | `4.0+ds-1` |
| カラー絵文字 | `fonts-noto-color-emoji` | `2.047-0ubuntu0.24.04.1` |

実際のフォールバックは次のとおりです。

| 表示対象 | 割り当て |
|---|---|
| 日本語のゴシック体 | Noto Sans CJK JP |
| 英語のゴシック体 | Inter |
| 日本語の明朝体 | Noto Serif CJK JP |
| 日本語の等幅フォント | Noto Sans Mono CJK JP |

## 新しい環境への導入

フォントをインストールします。

```bash
sudo apt-get install -y fonts-noto-cjk fonts-inter
```

リポジトリで管理しているフォールバック設定を、ユーザー用fontconfigへ配置します。

```bash
mkdir -p ~/.config/fontconfig/conf.d
cp config/fontconfig/browser-agent-fonts.conf \
  ~/.config/fontconfig/conf.d/50-browser-agent-fonts.conf
fc-cache -f
```

フォントキャッシュの更新後、起動中のChromeをすべて正常終了します。
次に起動したChromeから新しい割り当てが使われます。

## 確認方法

次のコマンドで、用途ごとの割り当てを確認できます。

```bash
fc-match 'sans-serif:lang=ja'
fc-match 'sans-serif:lang=en'
fc-match 'system-ui:lang=ja'
fc-match 'system-ui:lang=en'
fc-match 'serif:lang=ja'
fc-match 'monospace:lang=ja'
```

期待する結果は次のとおりです。

```text
Noto Sans CJK JP
Inter
Noto Sans CJK JP
Inter
Noto Serif CJK JP
Noto Sans Mono CJK JP
```

## 設定の管理

正本は[fontconfig設定](../config/fontconfig/browser-agent-fonts.conf)です。
実行環境では、次の場所へコピーして使用します。

```text
~/.config/fontconfig/conf.d/50-browser-agent-fonts.conf
```

正本を変更した場合は、もう一度コピーして`fc-cache -f`を実行します。
Chromeを再起動するまで、起動済みのブラウザには変更が反映されません。

`fonts-noto-cjk-extra`は導入していません。
標準パッケージに含まれない追加ウェイトが必要になった場合だけ導入します。
