# iOS 签名与 JoJo 依赖安装

[English](./README.md)

这个确定性 Workflow 用于准备 Florak monorepo 的 iOS 构建环境，严格按文档顺序执行：

1. 连接目标手机，在 iOS 工程根执行 `./Scripts/cosign.sh`；
2. 国内版执行 `./jojoInstall.sh Grace`，海外版传 `Cici`。

两个命令都从 iOS 工程根执行。cosign 失败后不会继续安装依赖；stdout、stderr
和结构化 summary 统一写到
`/tmp/ios_perf-opt/ios-cosign-jojo-install/<runId>/`。该 Workflow 不构建、
不安装 App，也不启动 App。

仓库原生 `Scripts/cosign.sh` 可能会修改 `Flow/GraceDebug.entitlements`，删除与
Debug 证书不兼容的 capability。这是该脚本自身约定；Workflow 完成后应检查 Git diff。

## 运行

```bash
deer-workflow run ./examples/ios-cosign-jojo-install/workflow.ts \
  --input '{
    "repositoryRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak",
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "udid": "00008030-001A286A2229802E",
    "target": "Grace"
  }'
```

只有底层 cosign 能唯一选中目标设备时才省略 `udid`。成功后继续运行
[`ios-build-install`](../ios-build-install/README.zh-CN.md)。

## 输入

- `repositoryRoot`：Git 根，默认等于 `projectRoot`。
- `projectRoot`：包含 `Scripts/cosign.sh` 和 `jojoInstall.sh` 的 iOS 工程根。
- `udid`：可选；存在时以 `--device-udid` 传给 cosign。
- `target`：`Grace` 或 `Cici`，默认 `Grace`。
- `cosignScriptPath` / `jojoInstallScriptPath`：可选脚本覆盖。
- `outputDir`：默认 `/tmp/ios_perf-opt/ios-cosign-jojo-install/<runId>`。

## 输出

- `cosign.stdout.txt` / `cosign.stderr.txt`
- `jojo-install.stdout.txt` / `jojo-install.stderr.txt`
- `summary.json`
