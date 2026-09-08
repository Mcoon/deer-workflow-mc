# iOS Regression Kit

`ios-regression-kit` 是 App Graph v2 和 iOS 功能回归 Workflow 使用的
`ios-functional-regression` 共用的协议与工具层，不是单独运行的 Workflow。

它定义：

- `ios-device-profile/v1`
- `ios-ui-page/v1`
- `ios-ui-control/v1`
- `ios-ui-transition/v1`
- `ios-regression-case-set/v1`

关键原则：

- 运行证据放 `/Users/bytedance/.ios_pref_optimizer`；
- 可复用 UI/case/binding/baseline 资产放
  `ios-perf-optimizer/assets/app-regression`；
- 人看的长期决策和使用说明放 Head KB；
- 自然语言表达意图，结构化 ID/selector/assertion 决定执行；
- 坐标只作为同设备 profile 的 fallback；
- 未知、歧义或未验证的目标禁止点击。
