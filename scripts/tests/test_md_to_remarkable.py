"""
Tests for md_to_remarkable.py

Run from scripts/ with: uv run pytest
"""
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# The script lives one directory above tests/ — add it to sys.path so pytest
# can import it as a module without an __init__.py at the scripts/ root.
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from md_to_remarkable import (
    _ext_from_content_type,
    _ext_from_url,
    download_web_images,
    render_mermaid_blocks,
    resolve_embedded_images,
    strip_nav_header,
)


# ── strip_nav_header ──────────────────────────────────────────────────────────

class TestStripNavHeader:
    def test_removes_non_yaml_block(self):
        # given — a nav bar disguised as a YAML block (no key: value pairs)
        text = "---\n[← Index](index.md)\n---\n\n# Content"
        # when
        result = strip_nav_header(text)
        # then
        assert result == "# Content"

    def test_preserves_real_yaml_frontmatter(self):
        # given — real YAML frontmatter with key: value lines
        text = "---\ntitle: My Note\nauthor: Jon\n---\n\n# Content"
        # when
        result = strip_nav_header(text)
        # then — left intact for pandoc to consume
        assert result == text

    def test_passes_through_text_with_no_header(self):
        # given
        text = "# Just a heading\n\nSome text."
        # when / then
        assert strip_nav_header(text) == text


# ── _ext_from_content_type ────────────────────────────────────────────────────

class TestExtFromContentType:
    def test_maps_webp(self):
        assert _ext_from_content_type("image/webp") == ".webp"

    def test_maps_png(self):
        assert _ext_from_content_type("image/png") == ".png"

    def test_strips_charset_suffix(self):
        # given — content type with charset parameter
        assert _ext_from_content_type("image/png; charset=utf-8") == ".png"

    def test_returns_empty_for_unknown(self):
        assert _ext_from_content_type("application/octet-stream") == ""


# ── _ext_from_url ─────────────────────────────────────────────────────────────

class TestExtFromUrl:
    def test_extracts_png_from_path(self):
        assert _ext_from_url("https://example.com/images/photo.png") == ".png"

    def test_returns_empty_for_query_string_url(self):
        # given — CDN URL where extension is buried in query params, not the path
        url = "https://substackcdn.com/image/fetch/f_webp/https%3A%2F%2Fexample.com%2Fimg"
        assert _ext_from_url(url) == ""

    def test_returns_empty_for_unknown_extension(self):
        assert _ext_from_url("https://example.com/file.bmp") == ""


# ── download_web_images ───────────────────────────────────────────────────────

class TestDownloadWebImages:
    def test_downloads_image_and_replaces_url(self, tmp_path):
        # given — markdown with one web image
        text = "Before\n![alt text](https://example.com/photo.png)\nAfter"
        fake_bytes = b'\x89PNG\r\n'

        mock_resp = MagicMock()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.headers.get.return_value = "image/png"
        mock_resp.read.return_value = fake_bytes

        with patch("urllib.request.urlopen", return_value=mock_resp):
            # when
            result = download_web_images(text, tmp_path)

        # then — URL replaced with local path, bytes written to disk
        assert "https://example.com" not in result
        assert "web-image-1.png" in result
        assert (tmp_path / "web-image-1.png").read_bytes() == fake_bytes

    def test_converts_webp_to_png(self, tmp_path):
        # given — CDN serves webp; xelatex cannot embed webp directly
        text = "![](https://cdn.example.com/image.webp)"
        fake_webp = b"RIFF\x00\x00\x00\x00WEBP"

        mock_resp = MagicMock()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.headers.get.return_value = "image/webp"
        mock_resp.read.return_value = fake_webp

        def fake_convert(cmd, **kwargs):
            # simulate ImageMagick writing the output PNG
            Path(cmd[2]).write_bytes(b"\x89PNG")
            return MagicMock(returncode=0)

        with patch("urllib.request.urlopen", return_value=mock_resp), \
             patch("shutil.which", return_value="/usr/bin/convert"), \
             patch("subprocess.run", side_effect=fake_convert):
            # when
            result = download_web_images(text, tmp_path)

        # then — .webp replaced with .png in the markdown reference
        assert ".webp" not in result
        assert ".png" in result

    def test_leaves_url_unchanged_on_download_failure(self, tmp_path):
        # given — unreachable host
        text = "![](https://unreachable.example.com/img.png)"

        with patch("urllib.request.urlopen", side_effect=OSError("Connection refused")):
            # when
            result = download_web_images(text, tmp_path)

        # then — original markdown unchanged (graceful degradation)
        assert result == text

    def test_ignores_non_http_urls(self, tmp_path):
        # given — local path in standard markdown syntax (not a web URL)
        text = "![](/workspace/extra/jw-mind/assets/diagram.png)"
        # when
        result = download_web_images(text, tmp_path)
        # then — untouched; resolve_embedded_images handles local refs
        assert result == text


# ── render_mermaid_blocks ─────────────────────────────────────────────────────

class TestRenderMermaidBlocks:
    def test_replaces_block_with_image_reference(self, tmp_path):
        # given
        text = "Before\n```mermaid\ngraph TD; A-->B\n```\nAfter"

        def fake_mmdc(cmd, **kwargs):
            # simulate mmdc writing a PNG
            png_path = Path(cmd[cmd.index("--output") + 1])
            png_path.write_bytes(b"\x89PNG")
            return MagicMock(returncode=0)

        with patch("shutil.which", return_value="/usr/bin/mmdc"), \
             patch("subprocess.run", side_effect=fake_mmdc):
            # when
            result = render_mermaid_blocks(text, tmp_path)

        # then — mermaid block replaced with an image reference
        assert "```mermaid" not in result
        assert "![Diagram 1]" in result

    def test_leaves_block_unchanged_when_mmdc_absent(self, tmp_path):
        # given
        text = "```mermaid\ngraph TD; A-->B\n```"
        with patch("shutil.which", return_value=None):
            # when
            result = render_mermaid_blocks(text, tmp_path)
        # then — graceful degradation: code block left as-is
        assert result == text


# ── resolve_embedded_images ───────────────────────────────────────────────────

class TestResolveEmbeddedImages:
    def test_resolves_image_in_same_directory(self, tmp_path):
        # given — a note with an Obsidian image embed
        note_dir = tmp_path / "notes"
        note_dir.mkdir()
        note_path = note_dir / "my-note.md"
        img_path = note_dir / "photo.png"
        img_path.write_bytes(b"\x89PNG")
        text = "Some text\n![[photo.png]]\nMore text"

        # when
        result = resolve_embedded_images(text, note_path)

        # then — embed replaced with standard markdown pointing at absolute path
        assert "![[photo.png]]" not in result
        assert f"![]({img_path})" in result

    def test_removes_non_image_embeds(self, tmp_path):
        # given — embedded note link (not an image)
        note_path = tmp_path / "note.md"
        text = "![[other-note]]"
        # when
        result = resolve_embedded_images(text, note_path)
        # then — removed entirely
        assert result == ""
