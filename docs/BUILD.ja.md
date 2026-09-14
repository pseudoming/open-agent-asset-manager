# ビルド・実行・テスト

[English](BUILD.md) · [简体中文](BUILD.zh-CN.md) · [日本語](BUILD.ja.md) · [Deutsch](BUILD.de.md) · [README](README.ja.md)

## 必要な環境

以下は **Linux x64 の開発用プレビュー**向けの手順です。デスクトップセッションのある Ubuntu や WSLg を含みます。
**Node.js 22.14 以降**、npm、Python 3、C++ コンパイラー、make が必要です。Electron 用の一般的な Linux
デスクトップライブラリも必要です。画面がない環境では、描画テストに Xvfb を使用します。

既定の Shared パッケージは Unix 系のファイル操作を提供します。Linux ビルドでは、ファイルシステム用の
ヘルパーとファイルロック用のモジュールをコンパイルします。どちらも製品の保護機構に必要です。

現在の Linux ビルドには `/usr/bin/x86_64-linux-gnu-g++-11` の **g++ 11.4.0** が必要です。
確認済みの環境と CI は **Ubuntu 22.04 x64** を使用します。別の Ubuntu リリースでは g++-11 のバージョンが
異なる場合があります。Ubuntu 22.04 では次のように準備します。

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends -y g++-11 make python3 xvfb xauth libgtk-3-0 libnss3 libasound2 libgbm1
```

## 依存関係のインストールとビルド

リポジトリのルートで実行します。

```sh
npm ci
npm run build
```

ロックファイルが依存関係の解決結果を固定します。ビルドは各マニフェストからワークスペースの順序を決め、
宣言された依存関係と TypeScript の入出力境界を検証し、指定された出力ディレクトリを清掃して、生成した入口を確認します。

## ソースからデスクトップを起動する

ビルド後、固定された Electron バージョンに合わせて SQLite を準備し、デスクトップを起動します。

```sh
npm exec -- electron-rebuild -v 42.7.0 -m packages/core -o better-sqlite3
npm run start --workspace @oaam/client-desktop
```

この再ビルドで、ローカルの SQLite ネイティブモジュールが Electron の ABI 用になります。通常は OS ユーザーの
アプリケーションデータディレクトリに OAAM ライブラリを作成します。開発には専用のプロファイルを指定できます。

```sh
npm run start --workspace @oaam/client-desktop -- --user-data-dir=/absolute/path/to/your/oaam-dev-profile
```

自分が所有し、このプレビュー専用に確保したディレクトリを使ってください。依存関係を変更する前にデスクトップを閉じます。

## チェックを実行する

SQLite を Electron 用に準備した場合は、Node のテストを実行する前に Node 用へ戻します。

```sh
npm rebuild better-sqlite3
npm run verify
```

新しく npm ci を実行した直後なら、npm run verify を直接実行できます。ソースのビルド、書式と型の検査、
アーキテクチャとアセットの適合テスト、デスクトップの実描画検証、各ワークスペースのカバレッジ検査を行います。
テストは架空のサンプルを使い、非公開文書、保存済みの実機証拠、認証情報、インストール済みのコーディングツールに依存しません。
成功しても、特定の外部ツールによる実際の読み込みを証明するものではありません。

## プラットフォームと配布の範囲

CI は Windows x64 と macOS 26 ARM64 でソースビルド、アーキテクチャテスト、選択したパステストを実行します。
macOS で確認できているのはソースコードの検証範囲のみです。資産の読み取り、書き込み、復元に必要な
安全なファイル操作はまだ Darwin に対応していないため、資産管理の一連の操作はまだサポートしていません。
デスクトップのパッケージ化と UI テストも今後の作業です。

現在のデスクトップ配布の主な対象は Windows x64 と、明示的に選択された Ubuntu WSL x64 環境です。
上の手順では、**その Windows 配布物は生成されません**。Windows 向けネイティブ Shared、Electron のリソース、
選択した WSL 向けの対応する Linux ランタイムとサービスを一緒に準備する必要があります。TypeScript のコンパイルだけで
Windows のポータブルパッケージができるわけではなく、他の OS でのインストール動作も保証しません。

Windows のネイティブ開発には Visual Studio の C++ ビルドツールと Python が必要です。共通の配布ビルダーを含みます。
npm ci と npm run build の後、変更のない checkout から未使用の絶対パスに出力します。

```sh
npm run package:desktop -- --output /absolute/new/oaam-linux
npm run package:wsl-resource -- --output /absolute/new/oaam-wsl-resource
```

最初のコマンドは完全な Linux Desktop、次は Windows 用の補助 Linux サービスだけを生成します。サービスの
アーカイブとマニフェストを Windows にコピーし、両方で同じソース commit を使います。Windows で npm ci と npm run build 後に実行します。

```powershell
$archive = 'C:\oaam-build\OAAM-0.1.0-beta.1-restricted-wsl-support-linux-x64.tar.gz'
$nodeExecutable = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$npmCli = Join-Path (Split-Path -Parent $nodeExecutable) 'node_modules/npm/bin/npm-cli.js'
if (!(Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw 'Node installation is missing npm-cli.js' }
& $nodeExecutable $npmCli run package:desktop -- --output C:\oaam-build\desktop-windows --wsl-archive $archive --wsl-manifest "$archive.manifest.json"
```

artifacts ディレクトリにバージョン付き ZIP または tar.gz と SHA-256・完全なファイル一覧を出力し、実際に展開して
検証します。Linux の実行権限を保持します。実行ファイル横の build-info.json は製品バージョン、チャネル、コンポーネント、
ソース commit、ビルド番号・時刻、ツールを記録します。--build-number と --build-time で指定でき、ローカルの既定値は local と現在の UTC 時刻です。
tests/repository/package-assembly の recipe/lock が外部依存を固定し、内部 tarball は今回のビルドに結び付けます。
Windows は同じ commit の WSL サービスと実際の PE メタデータも検証します。

製品バージョンはルート package.json が管理します。正式版は OAAM、beta は OAAM Preview の固定プロファイルを
アップグレード後も使用します。dev.N には絶対パスの --user-data-dir が必須で、他のチャネルでも明示指定を優先します。
公開 main の push は有効期限付き Actions テスト成果物を生成し、ダウンロードには GitHub ログインが必要です。
正確な v&lt;version&gt; tag は検証と両パッケージの成功後に Release 草稿を作成し、beta はプレリリースにします。
候補のレビューと公開後に通常の公開ダウンロードを提供します。ビルド成功だけでは実機動作の証明になりません。
Linux の検証環境は Ubuntu WSL/WSLg、Windows のローカルと選択した WSL は別の証拠範囲です。補助サービスは Linux Desktop や独立 Headless ではありません。

Headless は Client/Host プロトコル用の技術的な入口です。データ、データベース、プラットフォーム、アクセスルートの
明示的な設定が必要で、対話型デスクトップの代わりではありません。隔離した設定例は自動テストで確認できます。

## コードを変更する

製品コードとテストは TypeScript で記述します。実際の失敗、古い承認、完全なファイル構造のケースを維持してください。
局所的な変更では影響するテストを実行し、共通ビルド、プロトコル、承認、永続化の変更では公開版の全検証を実行します。

設計の背景は[技術紹介](ARCHITECTURE.ja.md)、画面の操作は[使い方](USAGE.ja.md)を参照してください。
