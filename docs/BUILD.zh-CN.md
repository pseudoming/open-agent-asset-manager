# 构建、运行与测试

[English](BUILD.md) · [简体中文](BUILD.zh-CN.md) · [日本語](BUILD.ja.md) · [Deutsch](BUILD.de.md) · [README](README.zh-CN.md)

## 前置条件

下面的源码启动流程用于 **Linux x64 开发预览**，包括带桌面会话或 WSLg 的 Ubuntu。需要
**Node.js 22.14 或更新版本**、npm、Python 3、C++ 编译器和 make。Electron 还需要常用 Linux
桌面库；无显示器时，界面检查使用 Xvfb。

默认 Shared 包提供 Unix-like 物理文件机制。Linux 构建会编译文件系统 helper 与文件锁模块，
它们属于产品保护，必须保留。

当前 Linux 构建要求 `/usr/bin/x86_64-linux-gnu-g++-11` 对应 **g++ 11.4.0**。已验证环境与 CI
采用 **Ubuntu 22.04 x64**；其他 Ubuntu 版本可能安装不同版本的 g++-11。Ubuntu 22.04 的准备命令为：

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends -y g++-11 make python3 xvfb xauth libgtk-3-0 libnss3 libasound2 libgbm1
```

## 安装依赖与构建

在仓库根目录运行：

```sh
npm ci
npm run build
```

锁文件固定依赖解析。构建按清单决定工作区顺序，检查声明的依赖和 TypeScript 输入/输出边界，
清理声明的输出目录，并检查编译后的入口。

## 从源码启动桌面端

构建后，让 SQLite 匹配锁定的 Electron 版本，然后启动已有桌面入口：

```sh
npm exec -- electron-rebuild -v 42.7.0 -m packages/core -o better-sqlite3
npm run start --workspace @oaam/client-desktop
```

原生重建命令会把本地 SQLite 模块切换为 Electron ABI。产品版本由根 package.json 拥有；正式版
使用当前用户的 OAAM 数据目录，beta 使用 OAAM Preview，各渠道升级时保留自己的目录。
dev.N 构建必须指定绝对路径的独立 profile：

```sh
npm run start --workspace @oaam/client-desktop -- --user-data-dir=/absolute/path/to/your/oaam-dev-profile
```

请使用自己拥有、专门为预览准备的目录。改变依赖前先关闭桌面端。

## 运行检查

如果已经为 Electron 重建 SQLite，运行 Node 测试前先恢复 Node 版本：

```sh
npm rebuild better-sqlite3
npm run verify
```

刚完成 npm ci 时可以直接运行 npm run verify。它会构建源码，检查格式和类型，执行架构、资产
一致性与真实界面渲染检查，并运行各工作区覆盖率门。这些检查使用合成样本，不依赖私有文档、
保存的本机证据、凭据或已安装的编程工具；测试通过也不能代替某个外部工具的实际加载证明。

## 平台与打包边界

CI 在 Windows x64 和 macOS 26 ARM64 上运行源码构建、架构测试及选定的路径测试。
macOS 当前证据仅覆盖源码检查。资产读取、写入与恢复所需的安全文件操作尚未适配 Darwin，
因此尚不支持完整资产旅程；桌面打包和界面测试也仍待完成。

已发布的桌面包覆盖 Windows x64 和 Linux x64。Linux 安装运行证据限 Ubuntu WSL/WSLg，Windows
应用也可管理明确选定的 WSL 发行版中的资产。普通下载与启动见[使用指南](USAGE.zh-CN.md)。上面的命令构建
工作区；下面的打包命令组装完整归档，包括目标平台的原生资源及 Windows 所需的配套 WSL 服务。
仅编译源码不代表其他平台已经完成安装运行验收。

Windows 原生开发需要 Visual Studio C++ 构建工具和 Python。源码包含共用打包入口。完成 npm ci
和 npm run build 后，从干净 checkout 构建到尚不存在的绝对路径：

```sh
npm run package:desktop -- --output /absolute/new/oaam-linux
npm run package:wsl-resource -- --output /absolute/new/oaam-wsl-resource
```

第一个命令生成完整 Linux Desktop，第二个仅生成 Windows 所需的配套 Linux 服务。将服务归档及
清单复制到 Windows，两端必须使用同一源码 commit。在 Windows 完成 npm ci 和 npm run build 后运行：

```powershell
$archive = 'C:\oaam-build\OAAM-0.1.0-beta.2-restricted-wsl-support-linux-x64.tar.gz'
$nodeExecutable = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$npmCli = Join-Path (Split-Path -Parent $nodeExecutable) 'node_modules/npm/bin/npm-cli.js'
if (!(Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw 'Node installation is missing npm-cli.js' }
& $nodeExecutable $npmCli run package:desktop -- --output C:\oaam-build\desktop-windows --wsl-archive $archive --wsl-manifest "$archive.manifest.json"
```

每个输出的 artifacts 目录包含带版本号的 ZIP 或 tar.gz，以及 SHA-256 和完整文件清单。打包程序
实际解压核对，Linux 可执行权限随包保留。可执行文件旁的 build-info.json 记录组件、产品版本与渠道、
源码 commit、构建时间与编号、工具版本。可用 --build-number 和 --build-time 指定构建输入；本地默认记录
local 和当前 UTC 时间。tests/repository/package-assembly 的正式 recipe/lock 固定外部依赖，内部 tarball
则绑定本次构建字节。Windows 包另核对同 commit 的 WSL 服务与实际 PE 元数据。

公开 main 推送生成会过期、需登录 GitHub 下载的 Actions 测试产物。精确 v&lt;version&gt; tag 在全部检查
及双平台打包成功后创建 Release 草稿，beta 标为预发布；草稿经候选审阅和发布后才提供普通公开下载。
打包成功本身不代表实机旅程通过：Linux 验收环境限 Ubuntu WSL/WSLg，Windows 应用通过内置服务访问明确选定的 WSL 发行版。
配套 WSL 服务不等于完整 Linux Desktop 或独立 Headless。

Headless 包是技术性的 Client/Host 协议入口，需要明确指定数据、数据库、平台和访问根，并非
交互式桌面的替代品。自动测试提供了隔离配置的例子。

## 修改代码

产品源码与测试使用 TypeScript。保留真实失败、过期授权和完整文件图用例。范围明确的改动运行
受影响测试；共享构建、协议、授权或持久化变化运行完整公开验证。

设计原理见[技术介绍](ARCHITECTURE.zh-CN.md)，界面操作见[使用指南](USAGE.zh-CN.md)。
