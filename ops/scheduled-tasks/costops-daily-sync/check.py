#!/usr/bin/env python3
"""CostOps daily sync -- card ef6c6a2c. Fires POST /api/costs/sync per provider, one at a
time, error-isolated (one provider's failure never blocks the others). No LLM. Matches the
costops-alert-monitor pattern: plain HTTP against the dashboard's own API."""
import json
import urllib.request
import urllib.error
import os

DASHBOARD_URL = "http://127.0.0.1:3420"
TOKEN_PATH = os.path.expanduser("~/marveen/store/.dashboard-token")
PROVIDERS = ["render", "openai", "github", "deepseek"]


def sync_provider(token, provider):
    req = urllib.request.Request(
        f"{DASHBOARD_URL}/api/costs/sync?provider={provider}",
        method="POST",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read())
            print(f"[costops-daily-sync] {provider}: ok -- {body}")
    except urllib.error.HTTPError as e:
        print(f"[costops-daily-sync] {provider}: HTTP {e.code} -- {e.read().decode(errors='replace')[:300]}")
    except Exception as e:
        print(f"[costops-daily-sync] {provider}: error -- {e}")


def main():
    with open(TOKEN_PATH) as f:
        token = f.read().strip()
    for provider in PROVIDERS:
        sync_provider(token, provider)


if __name__ == "__main__":
    main()
