简体中文 | [English](./README.md)

# deer-workflow

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@deerwork-ai/deer-workflow)](https://www.npmjs.com/package/@deerwork-ai/deer-workflow)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=000000)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6?logo=typescript&logoColor=ffffff)](https://www.typescriptlang.org)
[![Codex CLI](https://img.shields.io/badge/default_agent-Codex_CLI-000000?logo=openai&logoColor=ffffff)](https://github.com/openai/codex)
[![DeerFlow Stars](https://img.shields.io/github/stars/bytedance/deer-flow?label=DeerFlow%20Stars&logo=github)](https://github.com/bytedance/deer-flow)
[![GitHub Stars](https://img.shields.io/github/stars/deerwork-ai/deer-workflow?style=flat&logo=github)](https://github.com/deerwork-ai/deer-workflow)

一个用于构建可观察、可复用 Agent Graph 的开源 Dynamic Workflow Runtime。

`deer-workflow` 是 [**DeerFlow 3.0**](https://github.com/bytedance/deer-flow)
（即 **DeerWork**）的试点项目。

## 目录

- [为什么选择 Deer Workflow](#为什么选择-deer-workflow)
- [如何使用](#如何使用)
  - [快速开始](#快速开始)
  - [示例](#示例)
  - [文档](#文档)
- [如何开发](#如何开发)
  - [初始化](#初始化)
  - [验证修改](#验证修改)
  - [参与贡献](#参与贡献)
  - [许可证](#许可证)

# 为什么选择 Deer Workflow

Deer Workflow 是一种代码优先的
**[Graph Engineering](https://www.aibuilderclub.com/blog/graph-engineering-guide-2026)**
实现：TypeScript 定义有效的执行路径，Coding Agent 则负责每个节点内部的语义工作。

- **代码即计划。** 控制流、阶段、输入和失败处理都存在于可审阅的 TypeScript
  中，而不是隐藏在不透明的 Agent 对话里。
- **Agent 可替换。** Codex 是默认 Runtime，内置支持 Claude Code 与 Pi，而公共
  Agent 接口保持厂商中立。
- **执行可观察。** 交互式运行提供感知阶段状态的 TUI；自动化系统则可以消费
  稳定的 JSONL Event Stream。

# 如何使用

## 快速开始

安装 [Bun](https://bun.sh) 并登录
[Codex CLI](https://github.com/openai/codex)，然后安装正式发布的 CLI：

```bash
bun install --global @deerwork-ai/deer-workflow
```

描述需要的编排逻辑。Deer Workflow 会让 Codex 应用
[内置的 `workflow-creator` Skill](./skills/workflow-creator/)，并写出可运行的
TypeScript 模块：

```bash
deer-workflow create \
  "创建一个接收 topics 字符串数组的 Workflow，并行研究每个主题，最后汇编成报告" \
  > workflow.ts
```

如需使用其他已安装的 Harness 生成，可添加 `--agent claude` 或 `--agent pi`；
默认值仍是 Codex。

使用示例输入运行生成的 Workflow：

```bash
deer-workflow run ./workflow.ts \
  --input '{"topics":["Agent Skills","Dynamic Workflows"]}'
```

交互式终端会在实时 TUI 中显示阶段和 Markdown 日志。用于服务器、CI 和进程
管道时，可添加 `--print` 或 `-p`，让 stdout 每行输出一个 JSON 事件。

想理解或编辑生成的模块？请继续阅读[快速入门指南](./docs/index.zh-CN.md)。

## 示例

- [Deep Research](./examples/deep-research/README.zh-CN.md) 会发现研究角度、
  并行调查、验证结论，并生成交互式 HTML 报告。
- [Blog Writer](./examples/blog-writer/README.zh-CN.md) 会规划文章、通过 Pipeline
  起草各节、执行审阅，并返回结构化结果。
- [iOS 签名与 BitSky Install](./examples/ios-cosign-bitsky-install/README.zh-CN.md)
  依次完成真机签名、Ruby 依赖和 BitSky 构建物料准备。
- [iOS Build and Install](./examples/ios-build-install/README.zh-CN.md) 使用 BitSky
  构建真机 App 和可选 dSYM，导出到 `.vscode-out` 后只安装不启动。
- [iOS Launch Trace](./examples/ios-launch-trace/README.zh-CN.md) 会运行确定性的
  启动 Time Profiler 采集，并生成接近 Instruments 的 HTML 时间线。
- [iOS Attach Trace](./examples/ios-attach-trace/README.zh-CN.md) 会 attach 到
  已运行的 App，自动发现匹配的 `ios-build-install` 或 `flow-ios-bitsky` dSYM，
  并生成带业务源码符号的 HTML 时间线。
- [iOS Functional Regression](./examples/ios-functional-regression/README.zh-CN.md)
  使用 `mobilecli` 串行执行已验证 case，并生成证据报告。

这些示例位于本仓库中。运行文档中的命令前，请先克隆或下载仓库。

## 文档

- [快速入门](./docs/index.zh-CN.md) — 学习执行模型，并逐步构建一个 Workflow。
- [API 参考](./docs/api.zh-CN.md) — 查看精确的函数、类型、事件和 Runtime 行为。
- [Workflow Creator Skill](./skills/workflow-creator/SKILL.md) — 查看生成
  Workflow 模块时使用的指令。
- [English Documentation](./README.md)

## 执行 Trace

`run` 支持 opt-in 的完整执行 Trace：

```bash
bun run dev -- run examples/ios-launch-trace/workflow.ts --trace --input '{
  "projectRoot": "/path/to/Florak/flow/ios",
  "udid": "<device-udid>"
}'
```

默认输出到 `/Users/bytedance/.ios_pref_optimizer/deer-workflow-traces/<run-id>/`：

- `trace.jsonl`：严格时间序列，包含 Workflow event、Phase、Command、Agent 请求/回复；
- `summary.json`：总耗时、事件数、命令数、Agent 调用数和产物路径；
- `result.json`：最终返回值；
- `trace.html`：可按事件类型筛选和展开的可视报告。

使用 `--trace-dir <directory>` 可指定根目录。Trace 不记录进程环境变量；常见
authorization/cookie/password/token/API key 会脱敏，超长文本会截断并标注原长度。
Workflow 自定义命令应使用 `runTracedCommand`，框架的默认 `agent()` 会自动记录 prompt、
schema、model、sandbox、结构化回复、错误和耗时。

# 如何开发

## 初始化

克隆仓库，然后安装本地依赖和 Git Hooks：

```bash
git clone https://github.com/deerwork-ai/deer-workflow.git
cd deer-workflow
bun install
```

直接从源码运行 CLI：

```bash
bun run dev -- --help
```

## 验证修改

提交修改前运行完整质量门禁：

```bash
bun run check
```

## 参与贡献

Codex CLI 是默认 Agent Runtime，但不是架构依赖。`ClaudeAgent` 与 `PiAgent`
均为内置 Harness；欢迎为其他 Coding Agent 贡献集成。

完整命令参考请参阅[快速入门指南](./docs/index.zh-CN.md#开发仓库)。

## 许可证

本项目采用 [MIT 许可证](./LICENSE)。
