"""Cached directory snapshots need not depend on an old daemon's node map."""
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app.routes import drive


def test_resolve_node_after_daemon_restart(monkeypatch):
    nodes = {}
    data = {"drivewsid": "file-id", "docwsid": "document-id", "etag": "current"}
    api = Mock()
    api.drive.get_node_data.return_value = data
    monkeypatch.setattr(drive, "_nodes", lambda: nodes)
    monkeypatch.setattr(drive, "run", lambda fn: fn(api))

    assert drive._node_data("file-id") == data
    assert drive._node_data("file-id") == data
    api.drive.get_node_data.assert_called_once_with("file-id")


def test_missing_node_is_not_a_success_shaped_fallback(monkeypatch):
    api = Mock()
    api.drive.get_node_data.return_value = {}
    monkeypatch.setattr(drive, "_nodes", lambda: {})
    monkeypatch.setattr(drive, "run", lambda fn: fn(api))

    with pytest.raises(HTTPException) as exc:
        drive._node_data("missing")
    assert exc.value.status_code == 404
