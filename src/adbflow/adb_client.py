from __future__ import annotations

import base64
import re
import subprocess
import threading
import time
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


_ADB_RUN_SEMAPHORE = threading.BoundedSemaphore(value=2)


def _run(cmd: list[str], *, text: bool = True, check: bool = True, timeout_sec: float = 25.0) -> CommandResult:
    timeout_sec = max(1.0, float(timeout_sec))
    max_attempts = 3
    with _ADB_RUN_SEMAPHORE:
        for attempt in range(1, max_attempts + 1):
            try:
                proc = subprocess.run(cmd, capture_output=True, text=text, check=False, timeout=timeout_sec)
                break
            except subprocess.TimeoutExpired as exc:
                raise ADBError(f"命令执行超时（{timeout_sec}s）：{' '.join(cmd)}") from exc
            except OSError as exc:
                if exc.errno == 24 and attempt < max_attempts:
                    # EMFILE: back off briefly and retry to survive FD burst under heavy loops.
                    time.sleep(0.2 * attempt)
                    continue
                if exc.errno == 24:
                    raise ADBError("系统文件句柄不足（Too many open files），请稍后重试或提高 ulimit -n。") from exc
                raise
    result = CommandResult(proc.returncode, proc.stdout or "", proc.stderr or "")
    if check and proc.returncode != 0:
        raise ADBError(f"命令执行失败：{' '.join(cmd)}\n{result.stderr.strip()}")
    return result


class ADBClient:
    ADB_KEYBOARD_IME_ID = "com.android.adbkeyboard/.AdbIME"

    def __init__(self) -> None:
        self._ensured_remote_dirs: set[tuple[str, str]] = set()
        self._ensured_remote_dirs_lock = threading.Lock()
        self._shell_timeout_sec = 25.0
        self._pull_timeout_sec = 25.0

    def configure_timeouts(self, *, shell_timeout_sec: float | None = None, pull_timeout_sec: float | None = None) -> None:
        if shell_timeout_sec is not None:
            self._shell_timeout_sec = max(1.0, float(shell_timeout_sec))
        if pull_timeout_sec is not None:
            self._pull_timeout_sec = max(1.0, float(pull_timeout_sec))

    def list_devices(self) -> list[str]:
        out = _run(["adb", "devices"], timeout_sec=self._shell_timeout_sec).stdout.splitlines()
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
        return _run(cmd, check=check, timeout_sec=self._shell_timeout_sec)

    def pull(self, device_id: str, remote_path: str, local_path: str) -> None:
        Path(local_path).parent.mkdir(parents=True, exist_ok=True)
        _run(["adb", "-s", device_id, "pull", remote_path, local_path], check=True, timeout_sec=self._pull_timeout_sec)

    def push(self, device_id: str, local_path: str, remote_path: str) -> None:
        src = Path(local_path).expanduser().resolve()
        if not src.exists() or not src.is_file():
            raise ADBError(f"本地文件不存在：{src}")
        _run(["adb", "-s", device_id, "push", str(src), remote_path], check=True, timeout_sec=self._pull_timeout_sec)

    def ensure_remote_dir(self, device_id: str, remote_dir: str, *, force: bool = False) -> None:
        normalized = str(remote_dir or "").strip()
        if not normalized:
            return
        key = (str(device_id), normalized.rstrip("/"))
        if not force:
            with self._ensured_remote_dirs_lock:
                if key in self._ensured_remote_dirs:
                    return
        self.shell(device_id, "mkdir", "-p", normalized)
        with self._ensured_remote_dirs_lock:
            self._ensured_remote_dirs.add(key)

    def mkdir(self, device_id: str, remote_dir: str) -> None:
        self.ensure_remote_dir(device_id, remote_dir)

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
        chunk_size = 40
        for idx in range(0, len(safe_paths), chunk_size):
            chunk = safe_paths[idx : idx + chunk_size]
            self.shell(device_id, "rm", "-f", *chunk)

    def input_text(self, device_id: str, text: str) -> str:
        raw = str(text or "")
        if not raw:
            return "empty"

        return self.input_text_clipboard(device_id, raw)

    def input_text_clipboard(self, device_id: str, text: str) -> str:
        raw = str(text or "")
        if not raw:
            return "empty"

        # Prefer clipboard + paste to better support unicode/emoji on modern Android.
        clip = self.shell(device_id, "cmd", "clipboard", "set", "text", raw, check=False)
        if clip.code == 0:
            paste = self.shell(device_id, "input", "keyevent", "KEYCODE_PASTE", check=False)
            if paste.code == 0:
                return "clipboard"

        if _contains_non_ascii(raw):
            raise ADBError(
                "当前设备未能使用剪贴板粘贴，无法稳定输入中文/表情。"
                "请确认输入框可粘贴，或改用英文数字文本。"
            )

        escaped = _escape_adb_input_text(raw)
        self.shell(device_id, "input", "text", escaped, check=True)
        return "input_text"

    def input_text_auto(self, device_id: str, text: str) -> str:
        raw = str(text or "")
        if not raw:
            return "empty"
        if _contains_non_ascii(raw):
            try:
                return self.input_text_adb_keyboard(device_id, raw)
            except ADBError as exc:
                raise ADBError(
                    f"自动通道未能通过 ADB Keyboard 输入中文/表情：{exc}"
                ) from exc
        return self.input_text(device_id, raw)

    def input_text_by_channel(self, device_id: str, text: str, channel: str = "auto") -> str:
        mode = _normalize_input_channel(channel)
        raw = str(text or "")
        if not raw:
            return "empty"
        if mode == "adb_keyboard":
            return self.input_text_adb_keyboard(device_id, raw)
        if mode == "clipboard":
            return self.input_text_clipboard(device_id, raw)
        if mode == "input_text":
            if _contains_non_ascii(raw):
                raise ADBError("`input text` 模式不支持稳定输入中文/表情，请改用 ADB Keyboard 或剪贴板。")
            escaped = _escape_adb_input_text(raw)
            self.shell(device_id, "input", "text", escaped, check=True)
            return "input_text"
        return self.input_text_auto(device_id, raw)

    def input_text_adb_keyboard(self, device_id: str, text: str, restore_ime: bool = True) -> str:
        raw = str(text or "")
        if not raw:
            return "empty"

        ime_id = self._find_adb_keyboard_ime_id(device_id)
        if not ime_id:
            raise ADBError(
                "未检测到 ADB Keyboard 输入法。请先在手机安装并启用 ADB Keyboard，"
                "包名通常为 `com.android.adbkeyboard`。"
            )

        previous_ime = self.current_input_method(device_id)
        try:
            self.shell(device_id, "ime", "enable", ime_id, check=False)
            self.shell(device_id, "ime", "set", ime_id, check=True)
            errors: list[str] = []
            payload = base64.b64encode(raw.encode("utf-8")).decode("ascii")
            ok = self._adb_keyboard_broadcast(
                device_id=device_id,
                action="ADB_INPUT_B64",
                msg=payload,
                errors=errors,
            )
            if not ok:
                ok = self._adb_keyboard_broadcast(
                    device_id=device_id,
                    action="ADB_INPUT_TEXT",
                    msg=raw,
                    errors=errors,
                )
            if not ok:
                err_text = " | ".join(x for x in errors if x) or "未知错误"
                raise ADBError(f"ADB Keyboard 广播失败：{err_text}")
        finally:
            if restore_ime and previous_ime and previous_ime != ime_id:
                self.shell(device_id, "ime", "set", previous_ime, check=False)
        return "adb_keyboard"

    def _adb_keyboard_broadcast(
        self,
        device_id: str,
        action: str,
        msg: str,
        errors: list[str],
    ) -> bool:
        result = self.shell(
            device_id,
            "am",
            "broadcast",
            "-a",
            action,
            "--es",
            "msg",
            msg,
            check=False,
        )
        stdout = (result.stdout or "").strip()
        stderr = (result.stderr or "").strip()
        if result.code == 0 and "Broadcast completed" in stdout:
            return True
        errors.append(f"{action}: {stderr or stdout or f'code={result.code}'}")
        return False

    def list_input_methods(self, device_id: str) -> list[str]:
        out = self.shell(device_id, "ime", "list", "-s", check=False).stdout
        return [line.strip() for line in out.splitlines() if line.strip()]

    def current_input_method(self, device_id: str) -> str:
        out = self.shell(device_id, "settings", "get", "secure", "default_input_method", check=False).stdout
        return str(out or "").strip()

    def _find_adb_keyboard_ime_id(self, device_id: str) -> str:
        imes = self.list_input_methods(device_id)
        for ime_id in imes:
            if ime_id == self.ADB_KEYBOARD_IME_ID:
                return ime_id
        for ime_id in imes:
            text = ime_id.lower()
            if "adbkeyboard" in text or "adb_keyboard" in text:
                return ime_id
        return ""


def _escape_adb_input_text(value: str) -> str:
    # `adb shell input text` needs `%s` for spaces; keep others as-is.
    return value.replace(" ", "%s").replace("\n", "%s")


def _contains_non_ascii(value: str) -> bool:
    return any(ord(ch) > 127 for ch in value)


def _normalize_input_channel(value: str) -> str:
    text = str(value or "").strip().lower()
    if text in {"adb", "adb_keyboard", "adbkeyboard", "keyboard"}:
        return "adb_keyboard"
    if text in {"clipboard", "clip"}:
        return "clipboard"
    if text in {"input_text", "ascii", "shell"}:
        return "input_text"
    return "auto"
