# iOS Cosign and JoJo Install

[简体中文](./README.zh-CN.md)

This deterministic Workflow prepares the native iOS build environment in the
Florak monorepo. It runs the repository scripts in the documented order:

1. `./Scripts/cosign.sh` while the target phone is connected;
2. `./jojoInstall.sh Grace` for the domestic app, or `Cici` when selected.

Both commands run from the iOS project root. The Workflow stops immediately if
cosign fails and stores stdout, stderr, and a JSON summary under
`/tmp/ios_perf-opt/ios-cosign-jojo-install/<runId>/`. It does not build, install,
or launch the app.

The repository-native `Scripts/cosign.sh` may update
`Flow/GraceDebug.entitlements` by removing capabilities that are incompatible
with the debug certificate. This is part of that script's contract; inspect the
Git diff after the Workflow finishes.

## Run

```bash
deer-workflow run ./examples/ios-cosign-jojo-install/workflow.ts \
  --input '{
    "repositoryRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak",
    "projectRoot": "/Users/bytedance/Documents/BDWorkSpace/Florak/flow/ios",
    "udid": "00008030-001A286A2229802E",
    "target": "Grace"
  }'
```

Omit `udid` only when the underlying cosign command can select the intended
connected device unambiguously. After this Workflow succeeds, run
[`ios-build-install`](../ios-build-install/README.md).

## Inputs

- `repositoryRoot`: Git root; defaults to `projectRoot`.
- `projectRoot`: iOS root containing `Scripts/cosign.sh` and `jojoInstall.sh`.
- `udid`: optional device UDID forwarded as `--device-udid`.
- `target`: `Grace` or `Cici`; defaults to `Grace`.
- `cosignScriptPath` / `jojoInstallScriptPath`: optional script overrides.
- `outputDir`: defaults to `/tmp/ios_perf-opt/ios-cosign-jojo-install/<runId>`.

## Output

- `cosign.stdout.txt` / `cosign.stderr.txt`
- `jojo-install.stdout.txt` / `jojo-install.stderr.txt`
- `summary.json`
