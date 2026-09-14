<div align="center">

# Open Agent Asset Manager

### 资产随人，不必迁就工具。

让技能、指令和工作流拥有一个独立于任何编程工具的家。

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Deutsch](README.de.md)

[查看使用指南](USAGE.zh-CN.md) · [从源码运行](#从源码运行) · [技术设计](ARCHITECTURE.zh-CN.md)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](../LICENSE) · 源码预览版

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

## 从源码运行

**Linux x64 开发预览**需要 **Node.js 22.14 或更新版本**、npm 和当前系统的 C++ 构建工具。Python、系统库和原生模块要求见[构建指南](BUILD.zh-CN.md)。

```sh
git clone https://github.com/pseudoming/open-agent-asset-manager.git
cd open-agent-asset-manager
npm ci
npm run build
npm exec -- electron-rebuild -v 42.7.0 -m packages/core -o better-sqlite3
npm run start --workspace @oaam/client-desktop
```

原生模块步骤会让 SQLite 匹配 Electron。之后若要运行 Node 测试，请按构建指南重新编译该模块。当前提供源码预览，尚未提供可下载的桌面安装包。

## 当前范围

- 桌面交付主要面向 **Windows x64**，包括用户明确选定的 Ubuntu WSL x64 环境。在其他系统上构建成功不代表已完成该平台的安装运行验收。
- 聊天正文、凭据、私有会话、插件私有数据和工具内置托管内容不属于 OAAM 的资产库。

## 一起改进

欢迎提交具体使用场景、可复现的问题和范围明确的改进。先阅读[构建与测试指南](BUILD.zh-CN.md)，再提交 Issue 或 Pull Request。四种语言的 README 都欢迎完善。

经过审查的贡献可能随同一个公开快照交付，我们会保留贡献者选择公开的署名。

## 许可证

OAAM 自有代码采用 [Apache License 2.0](../LICENSE)。第三方依赖和导入资产保留各自的许可证。
