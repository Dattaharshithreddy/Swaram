"""Tests for the optional API-key middleware (backend/utils/api_key.py)."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.utils.api_key import ApiKeyMiddleware

KEY = "k" * 32


@pytest.fixture
def client():
    app = FastAPI()

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.get("/profiles")
    def profiles():
        return []

    app.add_middleware(ApiKeyMiddleware, api_key=KEY)
    return TestClient(app)


def test_health_is_open(client):
    assert client.get("/health").status_code == 200


def test_missing_key_is_rejected(client):
    r = client.get("/profiles")
    assert r.status_code == 401
    assert "API key" in r.json()["detail"]


@pytest.mark.parametrize(
    "headers",
    [{"Authorization": f"Bearer {KEY}"}, {"X-API-Key": KEY}],
)
def test_correct_key_passes(client, headers):
    assert client.get("/profiles", headers=headers).status_code == 200


def test_wrong_key_is_rejected(client):
    assert client.get("/profiles", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_preflight_is_open(client):
    assert client.options("/profiles").status_code != 401


def test_short_key_refused():
    with pytest.raises(ValueError, match="at least"):
        ApiKeyMiddleware(FastAPI(), api_key="short")
