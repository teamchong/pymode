# Hermes-Agent Cloudflare Backend — Integration Patch

## Files to add

### `tools/environments/cloudflare.py`
Copy from pymode repo `tools/environments/cloudflare.py` (395 lines)

## Changes to `tools/terminal_tool.py`

### 1. Import (after line 363, DaytonaEnvironment lazy import pattern)
No top-level import needed — use lazy import like Daytona.

### 2. `_get_env_config()` — add default cwd (around line 461)
```python
elif env_type == "cloudflare":
    default_cwd = "/data"
```

### 3. Image selection (around line 892)
```python
elif env_type == "cloudflare":
    image = "python:3.13-wasm"  # not a real image, just a label
```

### 4. Container config (around line 953)
```python
if env_type in ("docker", "singularity", "modal", "daytona", "cloudflare"):
```

### 5. `_create_environment()` factory (after daytona block, around line 607)
```python
elif env_type == "cloudflare":
    from tools.environments.cloudflare import CloudflareEnvironment as _CloudflareEnvironment
    return _CloudflareEnvironment(
        cwd=cwd, timeout=timeout,
        persistent_filesystem=persistent, task_id=task_id,
    )
```

### 6. `check_terminal_requirements()` (around line 1233)
```python
elif env_type == "cloudflare":
    worker_url = os.getenv("CLOUDFLARE_WORKER_URL")
    if not worker_url:
        logger.error(
            "Cloudflare backend selected but CLOUDFLARE_WORKER_URL is not set. "
            "Set it to your PyMode worker URL or switch TERMINAL_ENV."
        )
        return False
    try:
        import urllib.request
        resp = urllib.request.urlopen(f"{worker_url}/sandbox/health-check/status", timeout=5)
        return resp.status == 200
    except Exception:
        logger.error("Cannot reach Cloudflare worker at %s", worker_url)
        return False
```

### 7. Error messages — add "cloudflare" to valid backend lists
```
"Unknown TERMINAL_ENV '%s'. Use one of: local, docker, singularity, modal, daytona, ssh, cloudflare."
```

## Environment variables

```bash
TERMINAL_ENV=cloudflare
CLOUDFLARE_WORKER_URL=https://your-pymode-worker.workers.dev
CLOUDFLARE_API_KEY=optional-bearer-token
```

## Config in `~/.hermes/.env`
```
TERMINAL_ENV=cloudflare
CLOUDFLARE_WORKER_URL=https://my-pymode.workers.dev
```
