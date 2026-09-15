<div align="center">

# Open Agent Asset Manager

### 资产随人，不必迁就工具。

让技能、指令和工作流拥有一个独立于任何编程工具的家。

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Deutsch](README.de.md)

[下载桌面版](https://github.com/pseudoming/open-agent-asset-manager/releases) · [使用指南](USAGE.zh-CN.md) · [源码构建](BUILD.zh-CN.md) · [技术设计](ARCHITECTURE.zh-CN.md)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](../LICENSE) · 桌面 Beta 版

</div>

![OAAM 中 Atlas Notes 演示项目已保存的团队指引预览](images/oaam-overview.png)

*合成演示项目 Atlas Notes 中已保存的团队指引预览。*

## 你可以用它做什么

**带走已有积累**

将可复用的技能、指令及配套文件放进统一的版本库。

**应用前看清变化**

选择目标工具，先审阅将要修改的文件，再应用。

**留住后续改进**

将支持的外部修改接纳回来，保存为新的版本。

OAAM 管理 **Guidance、Rule、Workflow、Skill、Subagent 声明和 Memory** 六类资产。项目资产和全局库分别保留归属；完整目录资产保存资源、相对路径、文件字节和可执行属性。

已有 **Claude Code、Codex、Cursor、OpenCode、Antigravity 和 zcode** 的适配器。可用操作取决于具体的 App、CLI 或 IDE 入口、资产类型、平台和检测到的版本。无法转换的内容会明确说明，需要损失细节时会先请求确认。

**设置也随资产保留**

设为仅手动调用的 Skill，迁移后也应保留这一设置。OAAM 将该设置与正文分别记录，并能在支持的 Claude Code、Cursor 转换中保留它。模型和思考强度的选择也会保存，供目标分析使用。[查看具体例子与限制](ARCHITECTURE.zh-CN.md#调用方式)。

## 第一次使用

1. 添加项目，选择允许 OAAM 读取的工具位置。
2. 导入已有指令或技能，查看保存后的版本与文件。
3. 选择另一个支持的工具，审阅目标和变更，然后应用。
4. 支持的文件在 OAAM 外部发生修改后，审阅并保存这些改进，形成新版本。

详见[使用指南](USAGE.zh-CN.md)。扫描和预览不会直接应用变更。

## 下载并启动

从 [Releases](https://github.com/pseudoming/open-agent-asset-manager/releases) 下载已发布的 Beta：选择 Windows x64 ZIP 或 Linux x64 tar.gz，以及对应清单。完整解压后，Windows 运行 `oaam-desktop.exe`；Linux 在解压目录运行 `./oaam-desktop`。桌面包自带 Electron/Node 和 OAAM 依赖；Linux 还需要[桌面系统库](USAGE.zh-CN.md#linux-运行库)。只有[源码开发](BUILD.zh-CN.md)需要 Node.js 和构建工具。

Beta 版本共用 **OAAM Preview** 数据目录。升级时关闭 OAAM，将新版解压到新目录；已保存的资产库仍保留在原数据目录。首次导入前可查看[启动与升级说明](USAGE.zh-CN.md)。

## 当前范围

- 提供 **Windows x64 和 Linux x64** 桌面包。Linux 验证范围为 Ubuntu WSL/WSLg；原生 Ubuntu 和 macOS 的安装运行验收仍待完成。Windows 应用也可管理你明确选定的 WSL 发行版中的资产。
- 本版补齐 **Claude Code CLI 2.1.220** 在 Linux 项目中的 Skill 部署与反向接纳；其他工具、范围和资产组合仍遵循各自的支持边界。
- 聊天正文、凭据、私有会话、插件私有数据和工具内置托管内容不属于 OAAM 的资产库。

## 一起改进

欢迎提交具体使用场景、可复现的问题和范围明确的改进。先阅读[构建与测试指南](BUILD.zh-CN.md)，再提交 Issue 或 Pull Request。四种语言的 README 都欢迎完善。

经过审查的贡献可能随同一个公开快照交付，我们会保留贡献者选择公开的署名。

## 许可证

OAAM 自有代码采用 [Apache License 2.0](../LICENSE)。第三方依赖和导入资产保留各自的许可证。
