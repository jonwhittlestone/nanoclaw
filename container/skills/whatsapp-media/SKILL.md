---
name: whatsapp-media
description: Send a file or image back to the user via WhatsApp. Use when the user asks you to "show me", "send me", or "share" a photo or file from the vault.
---

## Receiving images

When a message includes `media_path`, the file is already on disk at that path inside your container. Read or copy it directly — no download needed.

## Sending a file back to WhatsApp

To send an image or file to the user, write a JSON file to `/workspace/ipc/messages/<uuid>.json`.

**The file must be under `/workspace/group/`** — so if it's in the vault, copy it first:

```python
import json, shutil, uuid
from pathlib import Path

VAULT = Path('/workspace/extra/obsidian')

def get_attachment_folder(vault):
    import json as _json
    app_json = vault / '.obsidian' / 'app.json'
    if app_json.exists():
        cfg = _json.loads(app_json.read_text())
        folder = cfg.get('attachmentFolderPath', '')
        if folder and not folder.startswith('/'):
            return vault / folder
    return vault

# 1. Find the file in the vault
attachments = get_attachment_folder(VAULT)
src = attachments / 'copse-marshmallows-19-04-26.jpg'   # adjust filename

# 2. Copy to /workspace/group/ so ipc.ts can resolve the path
staging = Path('/workspace/group/media') / src.name
staging.parent.mkdir(exist_ok=True)
shutil.copy2(src, staging)

# 3. Write the IPC message
ipc_path = Path('/workspace/ipc/messages') / f'{uuid.uuid4()}.json'
ipc_path.parent.mkdir(parents=True, exist_ok=True)
ipc_path.write_text(json.dumps({
    'type': 'file',
    'chatJid': os.environ['NANOCLAW_CHAT_JID'],
    'filePath': f'/workspace/group/media/{src.name}',
    'mimeType': 'image/jpeg',
    'caption': 'Here it is!'
}))
```

The file is delivered within ~1 second of writing the IPC file.

### MIME types
- JPEG image: `image/jpeg`
- PNG image: `image/png`
- PDF: `application/pdf`

### Getting the chatJid

The chat JID is available as an environment variable:

```python
import os
chat_jid = os.environ['NANOCLAW_CHAT_JID']  # e.g. '447894495422@s.whatsapp.net'
```
