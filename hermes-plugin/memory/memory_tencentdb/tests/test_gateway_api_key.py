"""Tests for ``_resolve_gateway_api_key`` (Gateway Bearer source precedence).

Locks in the closure-review contract (plugin dotenv fallback 6bb69f0 +
review round 2026-09-16):

  1. **env 优先** — a key present in ``os.environ`` wins and the dotenv
     path is never consulted (a fake that raises proves the negative).
  2. **namespaced > legacy** — ``MEMORY_TENCENTDB_GATEWAY_API_KEY`` beats
     ``TDAI_GATEWAY_API_KEY`` when both are set.
  3. **dotenv 兜底** — with no env vars, the profile-aware
     ``<hermes_home>/.env`` value (via ``agent.credential_pool``) supplies
     the key.
  4. **缺文件降级** — when ``agent.credential_pool`` is unavailable
     (ImportError), the fallback degrades to ``None`` instead of raising
     (legacy env-only behaviour preserved).
  5. **无钥** — nothing anywhere → ``None`` → the client attaches no
     ``Authorization`` header (open-gateway compatibility).

Whitespace-only env values count as unset (defensive strip). The client
header assertions pin the end effect: ``None`` key ⇒ no ``Authorization``.
"""

from __future__ import annotations

import sys
import types

import pytest

from plugins.memory.memory_tencentdb import _resolve_gateway_api_key
from plugins.memory.memory_tencentdb.client import MemoryTencentdbSdkClient

_VARS = ("MEMORY_TENCENTDB_GATEWAY_API_KEY", "TDAI_GATEWAY_API_KEY")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in _VARS:
        monkeypatch.delenv(var, raising=False)


def _install_fake_dotenv(monkeypatch, values=None, forbidden=False):
    """Pin a fake ``agent.credential_pool`` for the duration of a test."""
    if forbidden:
        def get_env_prefer_dotenv(key: str) -> str:
            raise AssertionError("dotenv consulted while an env key is present")
    else:
        def get_env_prefer_dotenv(key: str) -> str:
            return (values or {}).get(key, "")
    module = types.ModuleType("agent.credential_pool")
    module.get_env_prefer_dotenv = get_env_prefer_dotenv
    monkeypatch.setitem(sys.modules, "agent.credential_pool", module)
    return module


def test_env_wins_over_dotenv(monkeypatch):
    monkeypatch.setenv("TDAI_GATEWAY_API_KEY", "env-key")
    _install_fake_dotenv(monkeypatch, values={"TDAI_GATEWAY_API_KEY": "dotenv-key"},
                         forbidden=True)
    assert _resolve_gateway_api_key() == "env-key"


def test_namespaced_var_beats_legacy(monkeypatch):
    monkeypatch.setenv("TDAI_GATEWAY_API_KEY", "legacy")
    monkeypatch.setenv("MEMORY_TENCENTDB_GATEWAY_API_KEY", "namespaced")
    assert _resolve_gateway_api_key() == "namespaced"


def test_legacy_var_used_when_namespaced_missing(monkeypatch):
    monkeypatch.setenv("TDAI_GATEWAY_API_KEY", "legacy")
    assert _resolve_gateway_api_key() == "legacy"


def test_dotenv_fallback_when_env_missing(monkeypatch):
    _install_fake_dotenv(monkeypatch, values={"TDAI_GATEWAY_API_KEY": "dotenv-key"})
    assert _resolve_gateway_api_key() == "dotenv-key"


def test_whitespace_only_env_counts_as_unset(monkeypatch):
    monkeypatch.setenv("TDAI_GATEWAY_API_KEY", "   \n")
    _install_fake_dotenv(monkeypatch, values={"TDAI_GATEWAY_API_KEY": "dotenv-key"})
    assert _resolve_gateway_api_key() == "dotenv-key"


def test_degrades_when_credential_pool_missing(monkeypatch):
    # None in sys.modules ⇒ import raises ImportError ⇒ graceful None.
    monkeypatch.setitem(sys.modules, "agent.credential_pool", None)
    assert _resolve_gateway_api_key() is None


def test_no_key_anywhere_returns_none(monkeypatch):
    _install_fake_dotenv(monkeypatch, values={})
    assert _resolve_gateway_api_key() is None


def test_client_omits_authorization_without_key():
    client = MemoryTencentdbSdkClient(api_key=None)
    assert "Authorization" not in client._build_headers(content_type=False)


def test_client_sends_bearer_with_key():
    client = MemoryTencentdbSdkClient(api_key="secret")
    headers = client._build_headers(content_type=False)
    assert headers["Authorization"] == "Bearer secret"
