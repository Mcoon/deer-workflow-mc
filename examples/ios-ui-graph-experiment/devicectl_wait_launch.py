#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import subprocess
import time

from devicectl_restart import app_path, launch, process_ids


def wait_for_exit(
    udid: str,
    installed_app_path: str,
    old_pids: list[int],
    timeout_seconds: float,
) -> list[int]:
    deadline = time.monotonic() + timeout_seconds
    current_pids = process_ids(udid, installed_app_path)
    while time.monotonic() < deadline:
        current_pids = process_ids(udid, installed_app_path)
        if not any(pid in current_pids for pid in old_pids):
            return current_pids
        time.sleep(0.4)
    raise RuntimeError(
        f"App did not exit after tapping restart; old PIDs are still running: "
        f"{[pid for pid in old_pids if pid in current_pids]}"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", required=True)
    parser.add_argument("--bundle-id", required=True)
    parser.add_argument("--tap-point", required=True)
    parser.add_argument("--timeout-seconds", type=float, default=12)
    args = parser.parse_args()

    coordinates = [int(value) for value in args.tap_point.split(",")]
    if len(coordinates) != 2:
        raise RuntimeError("--tap-point must contain x,y coordinates.")

    installed_app_path = app_path(args.device, args.bundle_id)
    old_pids = process_ids(args.device, installed_app_path)
    if not old_pids:
        raise RuntimeError("The app must be running before tapping its restart action.")

    tap_command = [
        "mobilecli",
        "io",
        "tap",
        "--device",
        args.device,
        args.tap_point,
    ]
    tap = subprocess.run(tap_command, capture_output=True, text=True, timeout=30)
    if tap.returncode != 0:
        raise RuntimeError(
            f"Restart tap failed ({tap.returncode}): {tap.stderr.strip()}"
        )
    wait_for_exit(
        args.device,
        installed_app_path,
        old_pids,
        args.timeout_seconds,
    )
    new_pid = launch(args.device, args.bundle_id)
    if new_pid in old_pids:
        raise RuntimeError(
            f"devicectl launch reused an old PID instead of creating a new process: {new_pid}"
        )
    current_pids = process_ids(args.device, installed_app_path)
    if new_pid not in current_pids:
        raise RuntimeError(
            f"New PID {new_pid} is not present in the post-launch process list {current_pids}."
        )
    if any(pid in current_pids for pid in old_pids):
        raise RuntimeError(
            f"Old app PIDs remain after relaunch: "
            f"{[pid for pid in old_pids if pid in current_pids]}"
        )

    print(
        json.dumps(
            {
                "schemaVersion": "ios-ui-devicectl-wait-launch/v1",
                "bundleId": args.bundle_id,
                "appPath": installed_app_path,
                "tapPoint": {
                    "x": coordinates[0],
                    "y": coordinates[1],
                },
                "oldPids": old_pids,
                "newPid": new_pid,
                "currentPids": current_pids,
                "success": True,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
