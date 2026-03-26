from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


class ADBError(RuntimeError):
    pass


@dataclass
class CommandResult:
    code: int
    stdout: str
    stderr: str


def _run(cmd: list[str], *, text: bool = True, check: bool = True) -> CommandResult:
    proc = subprocess.run(cmd, capture_output=True, text=text, check=False)
    result = CommandResult(proc.returncode, proc.stdout or "", proc.stderr or "")
    if check and proc.returncode != 0:
        raise ADBError(f"命令执行失败：{' '.join(cmd)}\n{result.stderr.strip()}")
    return result


class ADBClient:
    def list_devices(self) -> list[str]:
        out = _run(["adb", "devices"]).stdout.splitlines()
        devices: list[str] = []
        for line in out[1:]:
            line = line.strip()
            if not line:
                continue
            if "\tdevice" in line:
                devices.append(line.split("\t")[0])
        return devices

    def shell(self, device_id: str, *args: str, check: bool = True) -> CommandResult:
        cmd = ["adb", "-s", device_id, "shell", *args]
        return _run(cmd, check=check)

    def pull(self, device_id: str, remote_path: str, local_path: str) -> None:
        Path(local_path).parent.mkdir(parents=True, exist_ok=True)
        _run(["adb", "-s", device_id, "pull", remote_path, local_path], check=True)

    def mkdir(self, device_id: str, remote_dir: str) -> None:
        self.shell(device_id, "mkdir", "-p", remote_dir)

    def tap(self, device_id: str, x: int, y: int) -> None:
        self.shell(device_id, "input", "tap", str(x), str(y))

    def swipe(
        self,
        device_id: str,
        x1: int,
        y1: int,
        x2: int,
        y2: int,
        duration_ms: int = 350,
    ) -> None:
        self.shell(
            device_id,
            "input",
            "swipe",
            str(x1),
            str(y1),
            str(x2),
            str(y2),
            str(duration_ms),
        )

    def screen_size(self, device_id: str) -> tuple[int, int]:
        out = self.shell(device_id, "wm", "size").stdout
        # Typical: "Physical size: 1080x2400"
        m = re.search(r"(\d+)x(\d+)", out)
        if not m:
            raise ADBError(f"无法解析屏幕分辨率，输出内容：{out!r}")
        return int(m.group(1)), int(m.group(2))

    def screenshot_to_remote(self, device_id: str, remote_path: str) -> None:
        self.shell(device_id, "screencap", "-p", remote_path)

    def remove_remote_files(self, device_id: str, paths: Iterable[str]) -> None:
        safe_paths = [p for p in paths if p and p.startswith("/")]
        if not safe_paths:
            return
        # Keep deletion in one shell invocation while escaping with simple quoting.
        quoted = " ".join(f'"{p}"' for p in safe_paths)
        self.shell(device_id, "sh", "-c", f"rm -f {quoted}")
