# browser-agent実装方針

## 目的

複数プロジェクトから、ログイン済みブラウザを限定操作し、機密情報をマスクした高解像度スクリーンショットを再現可能に生成します。

## 責務

`browser-agent`が持つ責務:

- サイトと許可オリジンの検証
- 認証profileとstateの正本管理
- `agent-browser`へ渡す操作と設定の制限
- 実行中セッション、ロック、隔離download、監査記録の管理
- Playwright Libraryによる限定操作、マスク、注釈、完成PNGの検査

`agent-browser`へ委譲する責務:

- Chromeの起動とnamed session
- snapshot参照を使ったUI操作
- タブ、ダイアログ、待機、DOM読み取りの低レベル実行

責務外:

- ページ内容の安全性保証
- サブリソースを含む完全なネットワーク隔離
- パスワードやMFAコードの自動入力
- 未マスク画像、PDF、downloadファイルの公開
- 記事やマニュアル本文の生成

## コマンド境界

- `browser-agent browser`: default-denyの低レベル操作入口
- `browser-agent login open/save/close`: 人によるログインと明示保存
- `browser-agent capture`: 宣言済み準備操作、マスク、注釈、画像更新
- `browser-agent unlock`: 停止を確認した古い実行状態の退避
- `browser-agent validate`: ブラウザを起動しないサイト・撮影設定検査
- `browser-agent doctor`: バイナリ、ブラウザ、フォント、画像処理、回収用コマンドの検査

## 実装上の不変条件

1. 操作エンジンの版、ネイティブバイナリ、action方針を実行前に検証する。
2. Chrome実行ファイル、viewport、倍率、localeは操作と撮影で一致させる。
3. profile正本はログイン以外から更新しない。
4. state正本は`login save`以外から更新しない。
5. 通常操作はprivateな作業用profileだけを使う。
6. 許可外トップレベルオリジンを検知したセッションは継続しない。
7. 任意コード、ファイル、raw capture、認証storageの操作を公開しない。
8. 未マスク画像をディスクへ書かない。
9. 完成PNGは全検査成功後だけ原子的に置き換える。
10. 古いロックは、全対象の停止を確認するまで変更しない。

詳細は[操作エンジンの安全設計](agent-browser-security.md)を参照してください。

## 検証段階

1. 単体テストで設定、引数、パス、権限、hash、方針、ロックを検証する。
2. 使い捨てローカルサイトで実ブラウザ操作と撮影を検証する。
3. 対象と操作を別途承認した後、既存サイト1件で読み取り専用カナリアを行う。

単体・ローカル統合テストの成功を、既存サイトでの確認、デプロイ、commit、pushの完了とは扱いません。
