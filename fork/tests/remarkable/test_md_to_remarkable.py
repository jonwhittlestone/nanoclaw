"""
Tests for container/skills/remarkable/md_to_remarkable.py

Run with: make test-fork   (or: cd fork && uv run pytest)
"""
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# The script ships inside the container skill folder; add it to sys.path so
# pytest can import it as a module.
import sys
import urllib.error
import urllib.request
SKILL_DIR = Path(__file__).resolve().parents[3] / "container" / "skills" / "remarkable"
sys.path.insert(0, str(SKILL_DIR))

import md_to_remarkable

from md_to_remarkable import (
    _ext_from_content_type,
    _ext_from_url,
    _pandoc_cmd,
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
    def _mock_opener(self, fake_resp):
        """Return a mock opener whose .open() yields fake_resp as a context manager."""
        mock_opener = MagicMock()
        mock_opener.open.return_value = fake_resp
        return mock_opener

    def test_downloads_image_and_replaces_url(self, tmp_path):
        # given — markdown with one web image
        text = "Before\n![alt text](https://example.com/photo.png)\nAfter"
        fake_bytes = b'\x89PNG\r\n'

        mock_resp = MagicMock()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.headers.get.return_value = "image/png"
        mock_resp.read.return_value = fake_bytes

        with patch("urllib.request.build_opener", return_value=self._mock_opener(mock_resp)):
            # when
            result = download_web_images(text, tmp_path)

        # then — URL replaced with local path, bytes written to disk
        assert "https://example.com" not in result
        assert "web-image-1.png" in result
        assert (tmp_path / "web-image-1.png").read_bytes() == fake_bytes

    def test_uses_the_gateway_proxy_first(self, tmp_path):
        # given — v2 routes agent egress through the OneCLI gateway (and may
        # lock direct egress down), so the default opener (env proxy) goes first
        text = "![](https://substackcdn.com/image/fetch/photo.png)"
        mock_resp = MagicMock()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.headers.get.return_value = "image/png"
        mock_resp.read.return_value = b"\x89PNG"

        with patch("urllib.request.build_opener") as mock_build:
            mock_build.return_value = self._mock_opener(mock_resp)
            download_web_images(text, tmp_path)
            # then — first opener has no empty ProxyHandler override
            first_args, _ = mock_build.call_args_list[0]
            assert not any(isinstance(a, urllib.request.ProxyHandler) for a in first_args)
            assert mock_build.call_count == 1

    def test_falls_back_to_direct_when_proxy_fails(self, tmp_path):
        # given — proxied attempt fails, direct attempt succeeds
        text = "![](https://example.com/photo.png)"
        good = MagicMock()
        good.__enter__ = lambda s: s
        good.__exit__ = MagicMock(return_value=False)
        good.headers.get.return_value = "image/png"
        good.read.return_value = b"\x89PNG"
        proxied = MagicMock()
        proxied.open.side_effect = urllib.error.URLError("tunnel refused")

        with patch("urllib.request.build_opener", side_effect=[proxied, self._mock_opener(good)]) as mock_build:
            result = download_web_images(text, tmp_path)

        # then — second opener bypasses the proxy and the image is used
        second_args, _ = mock_build.call_args_list[1]
        assert any(isinstance(a, urllib.request.ProxyHandler) for a in second_args)
        assert "web-image-1.png" in result

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

        with patch("urllib.request.build_opener", return_value=self._mock_opener(mock_resp)), \
             patch("shutil.which", return_value="/usr/bin/convert"), \
             patch("subprocess.run", side_effect=fake_convert):
            # when
            result = download_web_images(text, tmp_path)

        # then — .webp replaced with .png in the markdown reference
        assert ".webp" not in result
        assert ".png" in result

    def test_leaves_url_unchanged_on_download_failure(self, tmp_path):
        # given — proxy blocks or host unreachable
        text = "![](https://unreachable.example.com/img.png)"

        mock_opener = MagicMock()
        mock_opener.open.side_effect = OSError("Connection refused")

        with patch("urllib.request.build_opener", return_value=mock_opener):
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


# ── _pandoc_cmd ───────────────────────────────────────────────────────────────

class TestPandocCmd:
    def _variables(self, cmd: list) -> dict:
        """Extract --variable key=value pairs from a pandoc command list."""
        out = {}
        for i, arg in enumerate(cmd):
            if arg == '--variable' and i + 1 < len(cmd):
                k, _, v = cmd[i + 1].partition('=')
                out[k] = v
        return out

    def test_uses_scrartcl_for_large_font_support(self, tmp_path):
        # given — scrartcl (KOMA-Script) supports arbitrary font sizes unlike article
        cmd = _pandoc_cmd(tmp_path / 'in.md', tmp_path / 'out.pdf', tmp_path)
        assert self._variables(cmd)['documentclass'] == 'scrartcl'

    def test_font_size_is_40_percent_larger_than_default(self, tmp_path):
        # given — default was 11pt; 11 * 1.4 = 15.4 → 15pt
        cmd = _pandoc_cmd(tmp_path / 'in.md', tmp_path / 'out.pdf', tmp_path)
        assert self._variables(cmd)['fontsize'] == '15pt'

    def test_line_spacing_is_25_percent_larger_than_default(self, tmp_path):
        # given — default was 1.3; 1.3 * 1.25 = 1.625
        cmd = _pandoc_cmd(tmp_path / 'in.md', tmp_path / 'out.pdf', tmp_path)
        assert self._variables(cmd)['linestretch'] == '1.625'


# ── v2 container layout ───────────────────────────────────────────────────────

class TestV2Layout:
    def test_vault_mount_defaults_to_v2_extra_mount(self, monkeypatch):
        # v2 mounts additionalMounts under /workspace/extra/<containerPath>;
        # the vault's containerPath is "obsidian"
        monkeypatch.delenv("REMARKABLE_VAULT", raising=False)
        assert md_to_remarkable.vault_mount() == Path("/workspace/extra/obsidian")

    def test_vault_mount_is_overridable(self, monkeypatch, tmp_path):
        monkeypatch.setenv("REMARKABLE_VAULT", str(tmp_path))
        assert md_to_remarkable.vault_mount() == tmp_path

    def test_mermaid_writes_its_own_puppeteer_config_for_system_chromium(self, tmp_path):
        # v2's image has /usr/bin/chromium but no /app/puppeteer.config.json
        text = "```mermaid\ngraph TD; A-->B\n```"
        seen = {}

        def fake_mmdc(cmd, **kwargs):
            seen["cmd"] = cmd
            Path(cmd[cmd.index("--output") + 1]).write_bytes(b"\x89PNG")
            return MagicMock(returncode=0)

        def which(name):
            return {"mmdc": "/usr/bin/mmdc", "chromium": "/usr/bin/chromium"}.get(name)

        with patch("shutil.which", side_effect=which), patch("subprocess.run", side_effect=fake_mmdc):
            render_mermaid_blocks(text, tmp_path)

        cfg = Path(seen["cmd"][seen["cmd"].index("--puppeteerConfigFile") + 1])
        import json
        assert json.loads(cfg.read_text())["executablePath"] == "/usr/bin/chromium"

    def test_mermaid_uses_mmdc_12_size_flag(self, tmp_path):
        # mermaid-cli 12 (pinned in fork/config.json) replaced --width with --size
        text = "```mermaid\ngraph TD; A-->B\n```"
        seen = {}

        def fake_mmdc(cmd, **kwargs):
            seen["cmd"] = cmd
            Path(cmd[cmd.index("--output") + 1]).write_bytes(b"\x89PNG")
            return MagicMock(returncode=0)

        with patch("shutil.which", return_value="/usr/bin/mmdc"), patch("subprocess.run", side_effect=fake_mmdc):
            render_mermaid_blocks(text, tmp_path)

        assert "--width" not in seen["cmd"]
        assert seen["cmd"][seen["cmd"].index("--size") + 1] == "1200"

    def test_fork_config_pins_mermaid_cli_12(self):
        import json
        cfg = json.loads((Path(__file__).resolve().parents[2] / "config.json").read_text())
        assert "@mermaid-js/mermaid-cli@12.2.0" in cfg["groups"]["whatsapp_main"]["packages"]["npm"]
