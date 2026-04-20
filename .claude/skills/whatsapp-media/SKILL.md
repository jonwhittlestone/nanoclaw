# WhatsApp Media — Bidirectional Image and File Support

Handle inbound media attachments and send files back to WhatsApp.

## When to use

- Any message that arrives with a `media` field set (image, voice note, document, video)
- "save that photo to my daily note" / "add this image to today's note"
- "send me the PDF" / "send me that file"
- "show me the chart from my France trip note"
- After generating a file (PDF, image, export) that should be delivered to the chat

## Inbound: bare media (no instruction)

When a message arrives where `media` is set but `content` is empty or contains no clear instruction, **do not silently ignore it**. Proactively ask what the user would like to do.

Tailor the prompt to the media type:

**Image (`image/*`):**
> 📷 I received a photo. What would you like me to do with it?
> • Save it to today's daily note
> • Save it somewhere else in the vault
> • Describe what's in it
> • Something else?

**Voice note (`audio/*`):**
> 🎙️ I received a voice note. What would you like me to do with it?
> • Transcribe it
> • Save the audio file to the vault
> • Something else?

**Document (`application/*` or other):**
> 📄 I received a file (`<fileName>`). What would you like me to do with it?
> • Save it to the vault
> • Extract and summarise the text
> • Something else?

Wait for the user's reply before acting.

## Inbound: accessing a received file

When a message arrives with a `media` field, the file is already downloaded and ready:

- `media.path` — path to the file, e.g. `/workspace/group/media/abc123.jpg`
- `media.mimeType` — MIME type, e.g. `image/jpeg`, `audio/ogg; codecs=opus`
- `media.fileName` — original filename if available (documents only)

No extra fetch needed — read or copy the file directly from `media.path`.

### Example: save journal photo to Obsidian daily note

```python
import json, shutil
from pathlib import Path
from datetime import date

VAULT = Path('/workspace/extra/obsidian')

def get_attachment_folder(vault: Path) -> Path:
    app_json = vault / '.obsidian' / 'app.json'
    if app_json.exists():
        cfg = json.loads(app_json.read_text())
        folder = cfg.get('attachmentFolderPath', '')
        if folder and not folder.startswith('/'):
            return vault / folder
    return vault

src = Path(media_path)   # e.g. /workspace/group/media/msg-xyz.jpg
attachments = get_attachment_folder(VAULT)
attachments.mkdir(exist_ok=True)
dest = attachments / src.name
shutil.copy2(src, dest)

daily_note = VAULT / 'periodic' / 'daily' / f'{date.today().strftime("%Y-%m-%d")}.md'
with open(daily_note, 'a') as f:
    f.write(f'\n![[{src.name}]]\n')
```

(Requires vault mounted via `additionalMounts` with `containerPath: "obsidian"` — available at `/workspace/extra/obsidian/`.)

## Outbound: sending a file back

### Sending a file from the vault

Vault files are at `/workspace/extra/obsidian/` — **not** under `/workspace/group/`, so you must copy the file to the group workspace first:

```python
import shutil, uuid
from pathlib import Path

VAULT = Path('/workspace/extra/obsidian')

def get_attachment_folder(vault: Path) -> Path:
    import json
    app_json = vault / '.obsidian' / 'app.json'
    if app_json.exists():
        cfg = json.loads(app_json.read_text())
        folder = cfg.get('attachmentFolderPath', '')
        if folder and not folder.startswith('/'):
            return vault / folder
    return vault

# Find the file in the vault
attachments = get_attachment_folder(VAULT)
src = attachments / 'my-image.jpg'           # wherever it lives in the vault

# Stage it under /workspace/group/ so ipc.ts can translate the path
staging = Path('/workspace/group/media') / src.name
staging.parent.mkdir(exist_ok=True)
shutil.copy2(src, staging)
```

Then write the IPC message (see below) with `filePath` pointing to `/workspace/group/media/<filename>`.

### IPC message format

Write a JSON file to `/workspace/ipc/messages/<uuid>.json`:

```json
{
  "type": "file",
  "chatJid": "<the chat JID from context>",
  "filePath": "/workspace/group/<your-output-file>",
  "mimeType": "application/pdf",
  "caption": "Here is your file"
}
```

- For images use `"mimeType": "image/jpeg"` (or `image/png`)
- `filePath` must be under `/workspace/group/` — the host translates this automatically
- The file is delivered within ~1 second of writing the IPC file

## Vault mount (required for daily note writes)

For journal photo use cases, the vault must be in `additionalMounts` in the group config:

```json
"containerConfig": {
  "additionalMounts": [
    {
      "hostPath": "~/Dropbox/DropsyncFiles/jw-mind",
      "containerPath": "obsidian",
      "readonly": false
    }
  ]
}
```

The vault is then accessible at `/workspace/extra/obsidian/` inside the container.
