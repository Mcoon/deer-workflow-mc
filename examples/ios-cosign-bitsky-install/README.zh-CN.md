[English](./README.md) | 简体中文

# iOS 签名与 BitSky Install

该 Workflow 为 Flow iOS 真机 BitSky 构建准备环境，按顺序执行仓库原生
cosign、`orbit bundle install` 和 `bitsky_install`。它不会构建、安装或启动 App。

```bash
deer-workflow run ./examples/ios-cosign-bitsky-install/workflow.ts \
  --input '{
    "repositoryRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak",
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "udid": "00008030-001A286A2229802E",
    "target": "Grace",
    "configuration": "Debug",
    "developerDir": "/Applications/Xcode_26.app/Contents/Developer"
  }'
```

产物统一写入 `/tmp/ios_perf-opt/ios-cosign-bitsky-install/<runId>/`。完成后运行
[`ios-build-install`](../ios-build-install/README.zh-CN.md)，生成 dSYM 并只安装不启动。

旧路径 `examples/ios-cosign-jojo-install/workflow.ts` 继续保留为兼容入口，内部已转发到该 BitSky Workflow。
