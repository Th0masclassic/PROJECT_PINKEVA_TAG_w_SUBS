from pathlib import Path

from app.main import _resolve_storefront_directory


def test_storefront_directory_requires_index_and_assets(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("PINQEVA_STOREFRONT_DIR", str(tmp_path))
    assert _resolve_storefront_directory() is None

    (tmp_path / "index.html").write_text("<!doctype html>", encoding="utf-8")
    assert _resolve_storefront_directory() is None

    (tmp_path / "assets").mkdir()
    assert _resolve_storefront_directory() == tmp_path
