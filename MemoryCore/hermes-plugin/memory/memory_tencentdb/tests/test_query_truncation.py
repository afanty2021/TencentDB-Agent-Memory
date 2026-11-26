"""Tests pinning the Gateway query-size contract on the plugin client.

The Gateway validates free-text queries with ``z.string().min(1).max(2048)``
(src/gateway/generated/schemas.ts — ``atomicSearchRequestSchema`` and
``conversationSearchRequestSchema``). Zod's ``.max()`` on a string counts
UTF-16 code units (JS ``String.prototype.length``), NOT Python code points —
an emoji-heavy query truncated by ``len()`` would still be rejected.

Observed live 2026-11-26: Hermes prefetch passes the raw user turn text as
the recall query; a teacher pasting a long message blew the limit and L1
recall silently degraded all morning ("prefetch partial failures: l1:
HTTP Error 400"). The clamp therefore lives in the client, the single choke
point shared by prefetch, ``memory_search`` and ``conversation_search``.

These tests stub ``_post`` so they neither spawn processes nor open sockets.
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from plugins.memory.memory_tencentdb.client import MemoryTencentdbSdkClient

WIRE_LIMIT_UNITS = 2048  # zod z.string().max(2048) — UTF-16 code units


def _units(s: str) -> int:
    """String length the way the Gateway (zod / JS) measures it."""
    return len(s.encode("utf-16-le")) // 2


@pytest.fixture
def capturing_client():
    """Client whose _post captures the JSON body instead of hitting the network."""
    client = MemoryTencentdbSdkClient(api_key="k")
    captured: dict = {}

    def fake_post(path, body, timeout=None):
        captured["path"] = path
        captured["body"] = body
        return {"code": 0, "data": {}}

    with patch.object(client, "_post", side_effect=fake_post):
        yield client, captured


class TestAtomicSearchClamp:
    def test_overlimit_bmp_query_is_truncated_to_wire_limit(self, capturing_client):
        client, captured = capturing_client
        query = "x" * 3000
        client.atomic_search(query)
        sent = captured["body"]["query"]
        assert _units(sent) <= WIRE_LIMIT_UNITS

    def test_truncation_keeps_the_head_of_the_query(self, capturing_client):
        client, captured = capturing_client
        query = "".join(chr(0x4E00 + (i % 3000)) for i in range(3000))
        client.atomic_search(query)
        sent = captured["body"]["query"]
        assert query.startswith(sent)

    def test_within_limit_query_passes_through_unchanged(self, capturing_client):
        client, captured = capturing_client
        query = "y" * WIRE_LIMIT_UNITS  # exactly at the limit is legal
        client.atomic_search(query)
        assert captured["body"]["query"] == query

    def test_astral_heavy_query_stays_under_wire_limit_without_lone_surrogates(self, capturing_client):
        client, captured = capturing_client
        query = "\U0001F600" * 3000  # each emoji = 2 UTF-16 units → 6000 units
        client.atomic_search(query)
        sent = captured["body"]["query"]
        assert _units(sent) <= WIRE_LIMIT_UNITS
        # strict encode raises on a lone surrogate — the cut must land cleanly
        sent.encode("utf-16-le")
        json.dumps(sent)


class TestConversationSearchClamp:
    def test_overlimit_query_is_truncated_to_wire_limit(self, capturing_client):
        client, captured = capturing_client
        client.conversation_search("z" * 3000)
        assert captured["path"] == "/v3/conversation/search"
        assert _units(captured["body"]["query"]) <= WIRE_LIMIT_UNITS

    def test_within_limit_query_passes_through_unchanged(self, capturing_client):
        client, captured = capturing_client
        query = "w" * 100
        client.conversation_search(query)
        assert captured["body"]["query"] == query


class TestNoQueryMaterialInLogs:
    def test_truncation_warning_logs_lengths_only(self, capturing_client, caplog):
        client, _ = capturing_client
        sentinel = "SECRET-TEACHER-CONTENT-7f3a"
        with caplog.at_level("WARNING", logger="plugins.memory.memory_tencentdb.client"):
            client.atomic_search(sentinel + "x" * 3000)
        assert sentinel not in caplog.text
