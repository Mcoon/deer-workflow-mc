# Legacy UI-Graph Archive

归档的旧 iOS UI-Graph workflow（已被新的 app-graph-* + ios-ui-graph-manager v2 取代）。

## legacy-ui-graph-YYYYMMDD.tar.gz 内容

- examples/ios-ui-graph-navigator (旧逐步执行核)
- examples/ios-ui-discovery (旧探索)
- examples/ios-ui-navigate (旧导航)
- examples/ios-ui-map-report (旧地图报告)
- examples/ios-case-runner (旧 case 执行)
- examples/ios-case-authoring (旧 case 编写)
- tests/examples/*.test.ts (对应测试)

## 恢复方法

    cd /Users/bytedance/Documents/deer-workflow-mc
    tar xzf examples/_archive/legacy-ui-graph-YYYYMMDD.tar.gz

## 未归档(仍在用)

- ios-ui-graph-console : map 服务器(现指向 v2 graph)
- ios-ui-graph-experiment / ios-ui-graph-discovery / ios-ui-semantic-map-report : console 运行时依赖
- ios-regression-kit : 新旧共用的公共库
- ios-ui-graph-manager : 新 Graph Manager(v2 唯一写入者)
