"""Cloudflare Workers terminal backend for hermes-agent.

Executes commands via PyMode's SandboxDO on Cloudflare Workers.
Each session gets a persistent Durable Object with:
  - Python execution (CPython 3.13 WASM)
  - R2-backed filesystem (persists across requests, like Modal/Daytona)
  - SQLite state tracking
  - Pre-bundled site-packages (FastMCP, pydantic, httpx, etc.)

Usage in hermes config:
    TERMINAL_ENV=cloudflare
    CLOUDFLARE_WORKER_URL=https://your-pymode-worker.workers.dev
    CLOUDFLARE_API_KEY=your-api-key  # optional, for auth

Or programmatically:
    from tools.environments.cloudflare import CloudflareEnvironment
    env = CloudflareEnvironment(
        worker_url="https://your-pymode-worker.workers.dev",
        task_id="session-123",
    )
    result = env.execute("python -c 'print(1+1)'")
    # {"output": "2\\n", "returncode": 0}
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
import urllib.error
from typing import Any, Optional

# Prefer httpx for async support (hermes uses it everywhere).
# Fall back to urllib for standalone usage.
try:
    import httpx
    _HAS_HTTPX = True
except ImportError:
    _HAS_HTTPX = False

try:
    from tools.environments.base import BaseEnvironment
except ImportError:
    # Allow standalone usage outside hermes repo
    class BaseEnvironment:  # type: ignore[no-redef]
        def __init__(self, cwd: str = "", timeout: int = 60, env: dict | None = None):
            self.cwd = cwd
            self.timeout = timeout
            self.env = env or {}

        def cleanup(self):
            pass


class CloudflareEnvironment(BaseEnvironment):
    """Cloudflare Workers backend — executes commands via PyMode SandboxDO.

    Matches the hermes-agent BaseEnvironment interface:
      execute(command, cwd, timeout, stdin_data) -> {"output": str, "returncode": int}
      cleanup() -> None

    Persistence model (same as Modal/Daytona):
      - persistent_filesystem=True: sandbox state + R2 files survive across sessions
      - persistent_filesystem=False: sandbox destroyed on cleanup()
    """

    def __init__(
        self,
        image: str = "python:3.13-wasm",
        cwd: str = "/data",
        timeout: int = 60,
        task_id: str = "default",
        persistent_filesystem: bool = True,
        worker_url: str | None = None,
        api_key: str | None = None,
        **kwargs: Any,
    ):
        super().__init__(cwd=cwd, timeout=timeout, env=kwargs.get("env"))
        self.task_id = task_id
        self.persistent = persistent_filesystem
        self.worker_url = (
            worker_url
            or os.environ.get("CLOUDFLARE_WORKER_URL", "")
        ).rstrip("/")
        self.api_key = api_key or os.environ.get("CLOUDFLARE_API_KEY", "")
        self._session_id = task_id  # DO keyed by task_id for persistence

        if not self.worker_url:
            raise ValueError(
                "CloudflareEnvironment requires CLOUDFLARE_WORKER_URL env var "
                "or worker_url parameter"
            )

    def execute(
        self,
        command: str,
        cwd: str = "",
        *,
        timeout: int | None = None,
        stdin_data: str | None = None,
    ) -> dict:
        """Execute a command via the PyMode sandbox.

        Returns: {"output": str, "returncode": int}
        """
        effective_timeout = timeout or self.timeout

        # Handle sudo (same pattern as Modal/Daytona)
        cmd, sudo_stdin = self._prepare_command(command)
        if sudo_stdin and stdin_data:
            stdin_data = sudo_stdin + "\n" + stdin_data
        elif sudo_stdin:
            stdin_data = sudo_stdin

        payload: dict[str, Any] = {
            "command": cmd,
            "timeout": effective_timeout,
        }
        # Only send cwd when explicitly passed — otherwise DO uses its persisted cwd
        if cwd:
            payload["cwd"] = cwd
        if stdin_data:
            payload["stdin_data"] = stdin_data
        if self.env:
            payload["env"] = self.env

        try:
            result = self._api_call("exec", payload, timeout=effective_timeout + 10)
            return {
                "output": result.get("output", ""),
                "returncode": result.get("returncode", 1),
            }
        except TimeoutError:
            return {
                "output": f"Command timed out after {effective_timeout}s\n",
                "returncode": 124,
            }
        except Exception as e:
            return {
                "output": f"CloudflareEnvironment error: {e}\n",
                "returncode": 1,
            }

    def cleanup(self):
        """Flush sandbox state. Destroy if non-persistent."""
        try:
            self._api_call("cleanup", {"destroy": not self.persistent}, timeout=30)
        except Exception:
            pass  # Best-effort cleanup

    # ---- Filesystem operations (direct R2 access) ----

    def read_file(self, path: str) -> str | None:
        """Read a file from the sandbox filesystem."""
        try:
            result = self._api_call("fs/read", {"path": path})
            return result.get("content")
        except Exception:
            return None

    def write_file(self, path: str, content: str) -> bool:
        """Write a file to the sandbox filesystem."""
        try:
            self._api_call("fs/write", {"path": path, "content": content})
            return True
        except Exception:
            return False

    def list_files(self, path: str = "/data") -> list[dict]:
        """List files in a directory."""
        try:
            result = self._api_call("fs/list", {"path": path})
            return result.get("entries", [])
        except Exception:
            return []

    def stat_file(self, path: str) -> dict | None:
        """Get file metadata."""
        try:
            return self._api_call("fs/stat", {"path": path})
        except Exception:
            return None

    def status(self) -> dict:
        """Check sandbox health."""
        try:
            return self._api_get("status")
        except Exception as e:
            return {"status": "error", "error": str(e)}

    # ---- Parallel delegation (replaces ThreadPoolExecutor) ----

    def delegate(
        self, tasks: list[dict], timeout: int = 120
    ) -> list[dict]:
        """Execute multiple commands in parallel child sandboxes.

        Each task gets its own isolated SandboxDO instance.
        Same semantics as hermes delegate_tool.py's ThreadPoolExecutor.

        Args:
            tasks: [{"id": str, "command": str, "timeout"?: int, "env"?: dict}]
            timeout: overall timeout for all tasks

        Returns:
            [{"id": str, "output": str, "returncode": int, "duration_ms": int}]
        """
        try:
            result = self._api_call(
                "delegate", {"tasks": tasks}, timeout=timeout + 10
            )
            return result.get("results", [])
        except Exception as e:
            return [
                {"id": t.get("id", str(i)), "output": f"Delegate error: {e}\n",
                 "returncode": 1, "duration_ms": 0}
                for i, t in enumerate(tasks)
            ]

    # ---- RPC for code_execution_tool (replaces Unix socket) ----

    def rpc_call(self, tool_name: str, args: dict) -> dict:
        """Call a tool via RPC on the sandbox.

        Replaces the Unix domain socket IPC in hermes code_execution_tool.py.
        Child sandbox code can POST tool calls here instead of using sockets.

        Returns: {"result": value} or {"error": "..."}
        """
        try:
            return self._api_call("rpc", {"tool": tool_name, "args": args}, timeout=300)
        except Exception as e:
            return {"error": str(e)}

    # ---- Binary file operations ----

    def upload_file(self, path: str, data: bytes) -> bool:
        """Upload a binary file to the sandbox filesystem."""
        url = f"{self.worker_url}/sandbox/{self._session_id}/upload?path={path}"
        req = urllib.request.Request(
            url, data=data,
            headers={
                "Content-Type": "application/octet-stream",
                **({"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status == 200
        except Exception:
            return False

    def download_file(self, path: str) -> bytes | None:
        """Download a binary file from the sandbox filesystem."""
        try:
            result = self._api_call("download", {"path": path}, timeout=60)
            # If the response was JSON (error), return None
            if isinstance(result, dict) and "error" in result:
                return None
            return result  # type: ignore
        except Exception:
            return None

    # ---- Internal helpers ----

    def _prepare_command(self, command: str) -> tuple[str, str | None]:
        """Transform sudo commands. Returns (command, sudo_stdin)."""
        if command.strip().startswith("sudo "):
            # Strip sudo — WASM runs as root-equivalent already
            return command.replace("sudo ", "", 1), None
        return command, None

    def _api_call(
        self, endpoint: str, payload: dict, timeout: int = 60
    ) -> dict:
        """POST JSON to the sandbox API."""
        url = f"{self.worker_url}/sandbox/{self._session_id}/{endpoint}"
        data = json.dumps(payload).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                **({"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}),
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {e.code}: {body}") from e
        except urllib.error.URLError as e:
            if "timed out" in str(e.reason):
                raise TimeoutError(str(e.reason)) from e
            raise

    def _api_get(self, endpoint: str, timeout: int = 10) -> dict:
        """GET from the sandbox API."""
        url = f"{self.worker_url}/sandbox/{self._session_id}/{endpoint}"
        req = urllib.request.Request(
            url,
            headers={
                **({"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}),
            },
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _auth_headers(self) -> dict[str, str]:
        h: dict[str, str] = {}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    # ---- Async API (httpx) — used when hermes runs in async gateway context ----

    async def aexecute(
        self,
        command: str,
        cwd: str = "",
        *,
        timeout: int | None = None,
        stdin_data: str | None = None,
    ) -> dict:
        """Async version of execute() using httpx."""
        if not _HAS_HTTPX:
            return self.execute(command, cwd, timeout=timeout, stdin_data=stdin_data)

        effective_timeout = timeout or self.timeout
        cmd, sudo_stdin = self._prepare_command(command)
        if sudo_stdin and stdin_data:
            stdin_data = sudo_stdin + "\n" + stdin_data
        elif sudo_stdin:
            stdin_data = sudo_stdin

        payload: dict[str, Any] = {
            "command": cmd,
            "timeout": effective_timeout,
        }
        if cwd:
            payload["cwd"] = cwd
        if stdin_data:
            payload["stdin_data"] = stdin_data
        if self.env:
            payload["env"] = self.env

        try:
            result = await self._async_api_call(
                "exec", payload, timeout=effective_timeout + 10
            )
            return {
                "output": result.get("output", ""),
                "returncode": result.get("returncode", 1),
            }
        except Exception as e:
            return {
                "output": f"CloudflareEnvironment error: {e}\n",
                "returncode": 1,
            }

    async def adelegate(
        self, tasks: list[dict], timeout: int = 120
    ) -> list[dict]:
        """Async version of delegate()."""
        if not _HAS_HTTPX:
            return self.delegate(tasks, timeout=timeout)
        try:
            result = await self._async_api_call(
                "delegate", {"tasks": tasks}, timeout=timeout + 10
            )
            return result.get("results", [])
        except Exception as e:
            return [
                {"id": t.get("id", str(i)), "output": f"Delegate error: {e}\n",
                 "returncode": 1, "duration_ms": 0}
                for i, t in enumerate(tasks)
            ]

    async def _async_api_call(
        self, endpoint: str, payload: dict, timeout: int = 60
    ) -> dict:
        """POST JSON via httpx (async)."""
        url = f"{self.worker_url}/sandbox/{self._session_id}/{endpoint}"
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            resp = await client.post(
                url, json=payload, headers=self._auth_headers()
            )
            resp.raise_for_status()
            return resp.json()
