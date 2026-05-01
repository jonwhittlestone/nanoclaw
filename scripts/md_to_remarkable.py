#!/usr/bin/env python3
"""
Convert an Obsidian vault note to PDF and save it alongside the original .md file.
Dropbox syncs it automatically; open via the reMarkable Dropbox connector.

Runs inside the nanoclaw-agent container — invoked by oh-two via the Bash tool.

Usage:
    python3 /workspace/project/scripts/md_to_remarkable.py <path> [--dry-run]

<path> can be:
    - Vault-relative path:  trips/25-france-summer.md
    - Filename stem:        25-france-summer
    - Partial name:         france-summer  (errors if ambiguous)

Requires: pandoc, xelatex (texlive-xetex), mmdc (@mermaid-js/mermaid-cli), imagemagick
"""

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

VAULT_MOUNT = Path('/workspace/extra/jw-mind')

# mmdc puppeteer config — points to system Chromium inside the container.
# Falls back to mmdc's bundled Chromium if the config file is absent
# (e.g. when running on the host during development).
PUPPETEER_CONFIG = Path('/app/puppeteer.config.json')

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'}


# ── Mermaid rendering ──────────────────────────────────────────────────────────

def render_mermaid_blocks(text: str, tmp_dir: Path) -> str:
    """
    Find every ```mermaid...``` block, render it to a PNG via mmdc,
    and replace the block with a standard markdown image reference.

    If mmdc is not installed the block is left as-is (graceful degradation).
    """
    if not shutil.which('mmdc'):
        print("Warning: mmdc not found — mermaid blocks will appear as code. "
              "Install with: npm install -g @mermaid-js/mermaid-cli", file=sys.stderr)
        return text

    diagram_index = [0]  # mutable counter for use in nested function

    def replace_block(match: re.Match) -> str:
        diagram_index[0] += 1
        n = diagram_index[0]
        mmd_source = match.group(1).strip()

        mmd_file = tmp_dir / f'diagram-{n}.mmd'
        png_file = tmp_dir / f'diagram-{n}.png'
        mmd_file.write_text(mmd_source, encoding='utf-8')

        cmd = [
            'mmdc',
            '--input', str(mmd_file),
            '--output', str(png_file),
            '--backgroundColor', 'white',
            '--width', '1200',      # ~A5 at 226 DPI — good RM2 resolution
        ]
        if PUPPETEER_CONFIG.exists():
            cmd += ['--puppeteerConfigFile', str(PUPPETEER_CONFIG)]

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0 or not png_file.exists():
            print(f"Warning: mmdc failed for diagram {n}:\n{result.stderr}",
                  file=sys.stderr)
            return match.group(0)  # leave block unchanged

        print(f"  Rendered diagram {n} → {png_file.name}")
        return f'![Diagram {n}]({png_file})'

    return re.sub(r'```mermaid\n(.*?)```', replace_block, text, flags=re.DOTALL)


# ── Embedded image resolution ──────────────────────────────────────────────────

def resolve_embedded_images(text: str, note_path: Path) -> str:
    """
    Convert Obsidian embedded images ![[filename.ext]] to standard markdown
    ![](absolute/path/to/file) so pandoc can include them in the PDF.

    Search order:
      1. Same directory as the note
      2. Vault-wide recursive search (first match wins)

    Non-image embeds (![[other-note]]) are removed.
    """
    def resolve(match: re.Match) -> str:
        ref = match.group(1).strip()
        ref = ref.split('|')[0].strip()  # strip display alias: ![[file.jpg|caption]]

        suffix = Path(ref).suffix.lower()
        if suffix not in IMAGE_EXTENSIONS:
            return ''  # embedded note — remove

        candidate = note_path.parent / ref
        if candidate.exists():
            return f'![]({candidate})'

        matches = list(VAULT_MOUNT.rglob(ref))
        if matches:
            return f'![]({matches[0]})'

        print(f"Warning: image not found: {ref}", file=sys.stderr)
        return ''

    return re.sub(r'!\[\[([^\]]+)\]\]', resolve, text)


# ── Web image downloading ──────────────────────────────────────────────────────

def _ext_from_content_type(ct: str) -> str:
    mapping = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/svg+xml': '.svg',
    }
    return mapping.get(ct.split(';')[0].strip().lower(), '')


def _ext_from_url(url: str) -> str:
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    return suffix if suffix in {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'} else ''


def download_web_images(text: str, tmp_dir: Path) -> str:
    """
    Download standard markdown images with http/https URLs to local temp files,
    replacing each URL with the local path so pandoc can embed them in the PDF.

    Many CDNs (e.g. substackcdn) serve images as webp. xelatex does not support
    webp natively, so webp images are converted to PNG via ImageMagick (convert).

    Uses a proxy-free opener so that OneCLI's HTTP_PROXY (injected for Anthropic
    API credential injection) does not intercept CDN image requests, which need
    no credential injection and may be blocked by the proxy.

    If a download or conversion fails the image reference is left unchanged
    (graceful degradation — pandoc will silently skip images it can't read).
    """
    img_index = [0]

    def replace_url(match: re.Match) -> str:
        alt = match.group(1)
        url = match.group(2)
        img_index[0] += 1
        n = img_index[0]

        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': (
                    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
                    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                ),
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Accept-Language': 'en-GB,en;q=0.9',
                'Referer': 'https://substack.com/',
            })
            # Bypass HTTP_PROXY — OneCLI sets it for Anthropic API credential
            # injection, but CDN image requests need no credentials and the
            # proxy may block or reject external traffic.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(req, timeout=15) as resp:
                ct = resp.headers.get('Content-Type', '')
                ext = _ext_from_content_type(ct) or _ext_from_url(url) or '.bin'
                local_path = tmp_dir / f'web-image-{n}{ext}'
                local_path.write_bytes(resp.read())
        except Exception as exc:
            print(f"Warning: failed to download image {n} ({url}): {exc}", file=sys.stderr)
            return match.group(0)  # leave unchanged

        # Convert webp → PNG (xelatex doesn't support webp)
        if local_path.suffix.lower() == '.webp' and shutil.which('convert'):
            png_path = local_path.with_suffix('.png')
            result = subprocess.run(['convert', str(local_path), str(png_path)],
                                    capture_output=True)
            if result.returncode == 0 and png_path.exists():
                local_path.unlink()
                local_path = png_path
            else:
                print(f"Warning: webp→png conversion failed for image {n}", file=sys.stderr)

        print(f"  Downloaded image {n} → {local_path.name}")
        return f'![{alt}]({local_path})'

    return re.sub(r'!\[([^\]]*)\]\((https?://[^)]+)\)', replace_url, text)


# ── Obsidian syntax normalisation ──────────────────────────────────────────────

def strip_nav_header(text: str) -> str:
    """Remove a leading ---...--- block that isn't valid YAML (e.g. a nav bar).
    Real YAML frontmatter (key: value lines) is left intact for pandoc to use."""
    lines = text.split('\n')
    if not lines or lines[0].strip() != '---':
        return text
    try:
        end = lines.index('---', 1)
    except ValueError:
        return text
    block = '\n'.join(lines[1:end])
    if re.search(r'^\w[\w\s]*:', block, re.MULTILINE):
        return text  # looks like real YAML frontmatter — leave it
    return '\n'.join(lines[end + 1:]).lstrip('\n')


def preprocess_obsidian(text: str, note_path: Path, tmp_dir: Path) -> str:
    """Full Obsidian → standard markdown pipeline."""

    # 0. Strip non-YAML ---...--- headers
    text = strip_nav_header(text)

    # 1. Render mermaid diagrams to PNG (must run before wiki-link stripping)
    text = render_mermaid_blocks(text, tmp_dir)

    # 2. Resolve Obsidian embedded images ![[file.jpg]] → local absolute paths
    text = resolve_embedded_images(text, note_path)

    # 3. Download web-hosted images ![](https://...) → local temp files
    #    CDNs often serve webp; xelatex doesn't support it — convert via ImageMagick
    text = download_web_images(text, tmp_dir)

    # 4. [[link|display text]] → display text
    text = re.sub(r'\[\[([^|\]]+)\|([^\]]+)\]\]', r'\2', text)

    # 5. [[link]] → link name
    text = re.sub(r'\[\[([^\]]+)\]\]', r'\1', text)

    # 6. Obsidian callouts: "> [!note] Title" → "> **NOTE**: Title"
    text = re.sub(
        r'^(> )\[!(\w+)\](.*)',
        lambda m: f"{m.group(1)}**{m.group(2).upper()}**{m.group(3)}",
        text,
        flags=re.MULTILINE,
    )

    # 7. Inline tags: #tag → remove
    text = re.sub(r'(?<!\S)#[a-zA-Z][\w/:-]*', '', text)

    return text


# ── File resolution ────────────────────────────────────────────────────────────

def find_note(query: str) -> Path:
    """Resolve query to a single .md file. Exits with message if not found/ambiguous."""

    candidate = VAULT_MOUNT / query
    if candidate.exists() and candidate.is_file():
        return candidate

    if not query.endswith('.md'):
        candidate = VAULT_MOUNT / (query + '.md')
        if candidate.exists():
            return candidate

    stem = Path(query).stem
    matches = [p for p in VAULT_MOUNT.rglob('*.md') if stem.lower() in p.stem.lower()]

    if len(matches) == 1:
        return matches[0]

    if len(matches) > 1:
        listing = '\n'.join(f'  {m.relative_to(VAULT_MOUNT)}' for m in matches[:15])
        print(f"Ambiguous — {len(matches)} matches for '{query}':\n{listing}\n"
              "Re-run with an exact vault-relative path.", file=sys.stderr)
        sys.exit(2)

    print(f"Note not found: '{query}'\nVault root: {VAULT_MOUNT}", file=sys.stderr)
    sys.exit(1)


# ── Conversion ─────────────────────────────────────────────────────────────────

def _pandoc_cmd(md_file: Path, pdf_path: Path, resource_path: Path) -> list[str]:
    """Return the pandoc command list for xelatex PDF conversion.

    Uses scrartcl (KOMA-Script) which supports arbitrary font sizes, unlike the
    standard article class that is limited to 10/11/12pt. Font size is 15pt
    (~40% larger than the 11pt default) and line spacing is 1.625 (~25% larger
    than the 1.3 default) — both tuned for comfortable reMarkable reading.
    """
    return [
        'pandoc', str(md_file),
        '--output', str(pdf_path),
        '--pdf-engine=xelatex',
        '--variable', 'documentclass=scrartcl',
        '--variable', 'papersize=a5',
        '--variable', 'geometry:margin=2.5cm',
        '--variable', 'fontsize=15pt',
        '--variable', 'linestretch=1.625',
        '--highlight-style=tango',
        '--standalone',
        '--resource-path', str(resource_path),
    ]


def convert_to_pdf(note_path: Path, pdf_path: Path) -> None:
    """Preprocess Obsidian markdown and convert to PDF via pandoc + xelatex."""

    with tempfile.TemporaryDirectory(prefix='remarkable-', dir='/tmp') as tmp:
        tmp_dir = Path(tmp)
        content = note_path.read_text(encoding='utf-8')
        processed = preprocess_obsidian(content, note_path, tmp_dir)

        md_file = tmp_dir / 'input.md'
        md_file.write_text(processed, encoding='utf-8')

        result = subprocess.run(
            _pandoc_cmd(md_file, pdf_path, note_path.parent),
            capture_output=True,
            text=True,
        )

        # ── wkhtmltopdf variant ───────────────────────────────────────────────
        # If xelatex is not available (e.g. on the host), use wkhtmltopdf instead.
        # wkhtmltopdf ignores the LaTeX geometry variable; override margins with
        # --pdf-engine-opt.
        #
        # result = subprocess.run(
        #     [
        #         'pandoc', str(md_file),
        #         '--output', str(pdf_path),
        #         '--pdf-engine=wkhtmltopdf',
        #         '--variable', 'papersize=a5',
        #         '--variable', 'geometry:margin=0.5cm',
        #         '--variable', 'fontsize=13pt',
        #         '--variable', 'linestretch=1.4',
        #         '--pdf-engine-opt=--margin-top',    '--pdf-engine-opt=5',
        #         '--pdf-engine-opt=--margin-bottom', '--pdf-engine-opt=5',
        #         '--pdf-engine-opt=--margin-left',   '--pdf-engine-opt=5',
        #         '--pdf-engine-opt=--margin-right',  '--pdf-engine-opt=5',
        #         '--highlight-style=tango',
        #         '--standalone',
        #         '--resource-path', str(note_path.parent),
        #     ],
        #     capture_output=True,
        #     text=True,
        # )
        if result.returncode != 0:
            print(f"pandoc failed:\n{result.stderr}", file=sys.stderr)
            sys.exit(1)
    # tmp_dir (and all rendered PNGs/downloaded images) cleaned up automatically here


# ── Entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description='Convert an Obsidian note to PDF (saved alongside the .md)'
    )
    parser.add_argument('path', help='Vault-relative path, filename stem, or search term')
    parser.add_argument('--dry-run', action='store_true',
                        help='Show what would happen without writing anything')
    args = parser.parse_args()

    note_path = find_note(args.path)
    pdf_path = note_path.with_suffix('.pdf')

    print(f"Note:   {note_path.relative_to(VAULT_MOUNT)}")
    print(f"Output: {pdf_path.relative_to(VAULT_MOUNT)}")

    if args.dry_run:
        print("Dry run — nothing written.")
        return

    print("Converting ...")
    convert_to_pdf(note_path, pdf_path)
    size_kb = pdf_path.stat().st_size // 1024
    print(f"Done. PDF saved ({size_kb} KB). Dropbox will sync it to your reMarkable shortly.")


if __name__ == '__main__':
    main()
