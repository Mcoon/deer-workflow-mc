#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


EXECUTED_COMMANDS: list[list[str]] = []


def run_json(
    args: list[str],
    timeout: int = 30,
    positional_tail: list[str] | None = None,
) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as file:
        output_path = Path(file.name)
    command = [
        "xcrun",
        "devicectl",
        *args,
        "--quiet",
        "--json-output",
        str(output_path),
        *(positional_tail or []),
    ]
    EXECUTED_COMMANDS.append(command)
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"Command failed ({result.returncode}): {' '.join(command)}\n"
                f"{result.stderr.strip()}"
            )
        return json.loads(output_path.read_text(encoding="utf-8"))
    finally:
        output_path.unlink(missing_ok=True)


def app_path(udid: str, bundle_id: str) -> str:
    payload = run_json(
        [
            "device",
            "info",
            "apps",
            "--device",
            udid,
            "--include-all-apps",
            "--bundle-id",
            bundle_id,
        ]
    )
    apps = payload.get("result", {}).get("apps", [])
    matches = [app for app in apps if app.get("bundleIdentifier") == bundle_id]
    if len(matches) != 1:
        raise RuntimeError(
            f"Expected one installed app for {bundle_id}; found {len(matches)}."
        )
    url = str(matches[0].get("url", "")).strip()
    if not url:
        raise RuntimeError(f"Installed app {bundle_id} has no URL.")
    parsed = urlparse(url)
    return unquote(parsed.path if parsed.scheme == "file" else url).rstrip("/")


def running_processes(udid: str, installed_app_path: str) -> list[dict[str, Any]]:
    payload = run_json(
        [
            "device",
            "info",
            "processes",
            "--device",
            udid,
            "--filter",
            f'executable.path BEGINSWITH "{installed_app_path}"',
        ]
    )
    return payload.get("result", {}).get("runningProcesses", [])


def process_ids(udid: str, installed_app_path: str) -> list[int]:
    identifiers: list[int] = []
    for process in running_processes(udid, installed_app_path):
        identifier = process.get("processIdentifier")
        if isinstance(identifier, int):
            identifiers.append(identifier)
    return sorted(set(identifiers))


def terminate_pid(udid: str, pid: int) -> None:
    run_json(
        [
            "device",
            "process",
            "terminate",
            "--device",
            udid,
            "--pid",
            str(pid),
            "--kill",
        ]
    )


def wait_for_old_pids_to_exit(
    udid: str,
    installed_app_path: str,
    old_pids: list[int],
    timeout_seconds: float = 8,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    remaining = old_pids
    while time.monotonic() < deadline:
        current = set(process_ids(udid, installed_app_path))
        remaining = [pid for pid in old_pids if pid in current]
        if not remaining:
            return
        time.sleep(0.4)
    raise RuntimeError(f"Old app PIDs are still running after SIGKILL: {remaining}")


def launch(udid: str, bundle_id: str) -> int:
    payload = run_json(
        [
            "device",
            "process",
            "launch",
            "--device",
            udid,
            "--terminate-existing",
        ],
        positional_tail=[bundle_id],
    )
    identifier = (
        payload.get("result", {})
        .get("process", {})
        .get("processIdentifier")
    )
    if not isinstance(identifier, int):
        raise RuntimeError("devicectl launch succeeded without a processIdentifier.")
    return identifier


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", required=True)
    parser.add_argument("--bundle-id", required=True)
    args = parser.parse_args()

    installed_app_path = app_path(args.device, args.bundle_id)
    old_pids = process_ids(args.device, installed_app_path)
    for pid in old_pids:
        terminate_pid(args.device, pid)
    wait_for_old_pids_to_exit(args.device, installed_app_path, old_pids)
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
    print(
        json.dumps(
            {
                "schemaVersion": "ios-ui-devicectl-restart/v1",
                "bundleId": args.bundle_id,
                "appPath": installed_app_path,
                "oldPids": old_pids,
                "terminatedPids": old_pids,
                "newPid": new_pid,
                "currentPids": current_pids,
                "executedCommands": EXECUTED_COMMANDS,
                "success": True,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(
            json.dumps(
                {
                    "schemaVersion": "ios-ui-devicectl-restart/v1",
                    "success": False,
                    "error": str(error),
                    "executedCommands": EXECUTED_COMMANDS,
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        raise SystemExit(1)
