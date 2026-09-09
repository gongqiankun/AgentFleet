"""Pinned Linux native history adapter. See native-image-cleanup.ts for guards."""
from contextlib import contextmanager
from copy import deepcopy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import uuid

PLACEHOLDER = "[image removed]"
MAX_ROLLOUT = 64 * 1024 * 1024


class CleanupError(Exception):
    pass


def digest(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def regular(path):
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.geteuid():
        raise CleanupError("Expected a regular, non-hardlinked file")
    return st


def verified_home(home):
    home = Path(home)
    if not home.is_absolute() or home.resolve() != home or not home.is_dir():
        raise CleanupError("Invalid Codex home")
    return home


@contextmanager
def writer_lock(home, thread_id):
    # Match codex-rs/thread-store/src/local/writer_lock.rs: coordinate opening
    # the per-thread flock so native stale-lock cleanup cannot unlink it.
    if str(uuid.UUID(thread_id)) != thread_id:
        raise CleanupError("Invalid native thread ID")
    directory = home / 'thread-writer-locks'
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink():
        raise CleanupError("Symlinked lock directory")
    def lock_file(path):
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.geteuid():
            os.close(fd)
            raise CleanupError("Unsafe lock file")
        return fd
    coord = lock_file(directory / '.coordination.lock')
    writer = None
    try:
        fcntl.flock(coord, fcntl.LOCK_EX | fcntl.LOCK_NB)
        writer = lock_file(directory / (thread_id + '.lock'))
        fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(coord, fcntl.LOCK_UN)
        yield
    except BlockingIOError as exc:
        raise CleanupError("Native writer busy; no changes made") from exc
    finally:
        # Leave the inode in place. Native stale-lock collection owns removal.
        if writer is not None:
            os.close(writer)
        os.close(coord)


def redact_content(content, image_hashes, variant):
    if not isinstance(content, list):
        raise CleanupError("Unknown content shape")
    result = deepcopy(content)
    removed = []
    for i, item in enumerate(content):
        if not isinstance(item, dict):
            raise CleanupError("Unknown content item")
        if variant == 'response':
            field, kind = 'image_url', 'input_image'
        else:
            field, kind = ('image_url' if 'image_url' in item else 'url'), 'image'
        value = item.get(field)
        if item.get('type') == kind and isinstance(value, str) and digest(value.encode()) in image_hashes:
            if not value.startswith(('data:image/png;base64,', 'data:image/jpeg;base64,', 'data:image/webp;base64,')):
                raise CleanupError("Only inline image bytes are supported")
            # Refuse unknown metadata instead of silently deleting it.
            if set(item) - {'type', field, 'detail'}:
                raise CleanupError("Unknown image fields")
            replacement = {'type': 'input_text' if variant == 'response' else 'text', 'text': PLACEHOLDER}
            if variant == 'event':
                replacement['text_elements'] = []
            result[i] = replacement
            removed.append(i)
    return result, removed


def image_digests(value):
    if isinstance(value, str) and value.startswith('data:image/'):
        yield digest(value.encode())
    elif isinstance(value, list):
        for item in value:
            yield from image_digests(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from image_digests(item)


def rollout_plan(data, thread_id, turn_id, hashes):
    if len(data) > MAX_ROLLOUT or not data.endswith(b'\n'):
        raise CleanupError("Oversize or incomplete rollout")
    lines = data.splitlines(keepends=True)
    rows = [json.loads(line) for line in lines]
    meta = rows[0]
    payload = meta.get('payload', {})
    if meta.get('type') != 'session_meta' or payload.get('id') != thread_id or payload.get('session_id', thread_id) != thread_id:
        raise CleanupError("Native thread identity mismatch")
    if payload.get('cli_version') != '0.153.4' or payload.get('history_mode', 'legacy') not in ('legacy', 'paginated'):
        raise CleanupError("Unverified native storage version")
    if any(r.get('type') == 'session_meta' for r in rows[1:]):
        raise CleanupError("Multiple session identities")
    for row in rows:
        if row.get('type') == 'compacted' and any(h in hashes for h in image_digests(row)):
            raise CleanupError("Compacted image context requires an additional verified adapter")
    active = None
    unfinished = set()
    terminated = False
    changed = 0
    removed_bytes = 0
    result = []
    for original, raw in zip(rows, lines):
        row = deepcopy(original)
        p = row.get('payload', {})
        if row.get('type') == 'event_msg' and p.get('type') == 'task_started':
            active = p.get('turn_id')
            if not isinstance(active, str) or not active:
                raise CleanupError("Missing turn identity")
            unfinished.add(active)
        if row.get('type') == 'event_msg' and p.get('type') in ('task_complete', 'turn_aborted'):
            unfinished.discard(p.get('turn_id'))
        selected = active == turn_id
        if row.get('type') == 'event_msg' and p.get('type') in ('task_complete', 'turn_aborted') and p.get('turn_id') == turn_id:
            terminated = True
        if selected and row.get('type') == 'response_item' and p.get('type') == 'message' and p.get('role') == 'user':
            claimed_turn = p.get('internal_chat_message_metadata_passthrough', {}).get('turn_id', turn_id)
            if claimed_turn != turn_id:
                raise CleanupError("Conflicting turn identity")
            p['content'], removed = redact_content(p['content'], hashes, 'response')
            if removed:
                kinds = p.get('internal_chat_message_metadata_passthrough', {}).get('content_item_kinds')
                if kinds is not None:
                    if len(kinds) != len(p['content']):
                        raise CleanupError("Unknown content-kind mapping")
                    for i in removed:
                        if kinds[i] != 'user.image':
                            raise CleanupError("Conflicting content kind")
                        kinds[i] = 'user.text'
        if selected and row.get('type') == 'event_msg' and p.get('type') in ('item_started', 'item_completed'):
            item = p.get('item', {})
            if item.get('type') == 'UserMessage':
                if p.get('thread_id') != thread_id or p.get('turn_id') != turn_id:
                    raise CleanupError("Conflicting item identity")
                item['content'], _ = redact_content(item['content'], hashes, 'event')
        if selected and row.get('type') == 'event_msg' and p.get('type') == 'user_message':
            if any(digest(url.encode()) in hashes for url in p.get('images', []) if isinstance(url, str)):
                if any(not isinstance(url, str) for url in p['images']):
                    raise CleanupError("Unknown legacy image array")
                p['images'] = [url for url in p['images'] if digest(url.encode()) not in hashes]
        if selected and any(h in hashes for h in image_digests(row)):
            raise CleanupError("Unknown image occurrence in selected turn; no changes made")
        if selected:
            def count_bytes(value):
                if isinstance(value, str): return len(value.encode()) if digest(value.encode()) in hashes else 0
                if isinstance(value, list): return sum(count_bytes(v) for v in value)
                if isinstance(value, dict): return sum(count_bytes(v) for v in value.values())
                return 0
            removed_bytes += count_bytes(original) - count_bytes(row)
        if row == original:
            result.append(raw)
        else:
            updated = encoded(row)
            if len(updated) > len(raw) - 1:
                raise CleanupError("Replacement would move native byte offsets")
            result.append(updated + b' ' * (len(raw) - 1 - len(updated)) + b'\n')
            changed += 1
    if unfinished:
        raise CleanupError("Unfinished turn without terminal evidence")
    if not terminated:
        raise CleanupError("No terminal evidence for selected turn")
    output = b''.join(result)
    if len(output) != len(data):
        raise CleanupError("Native offsets changed")
    return output, changed, removed_bytes


def cleanup(home, rollout, thread_id, targets, expected_digest=None, preview=False):
    home = verified_home(home)
    rollout = Path(rollout)
    if rollout.resolve() != rollout or not any(rollout.is_relative_to(home / directory) for directory in ('sessions', 'archived_sessions')):
        raise CleanupError("Rollout outside native session directory")
    if not targets or len(targets) > 100:
        raise CleanupError("Invalid image scope")
    for target in targets:
        hashes = target['hashes']
        if not hashes or len(hashes) > 400 or any(len(h) != 64 or any(c not in '0123456789abcdef' for c in h) for h in hashes):
            raise CleanupError("Invalid image identity")
    with writer_lock(home, thread_id):
        st = regular(rollout)
        if st.st_size > MAX_ROLLOUT:
            raise CleanupError("History exceeds 64 MiB safety limit")
        data = rollout.read_bytes()
        if not preview and digest(data) != expected_digest:
            raise CleanupError("Preview stale; no changes made")
        output, changed, removed_bytes = data, 0, 0
        for target in targets:
            output, count, image_bytes = rollout_plan(output, thread_id, target['turnId'], set(target['hashes']))
            changed += count
            removed_bytes += image_bytes
        db_path = home / 'thread_history_1.sqlite'
        for suffix in ('-wal', '-shm'):
            sidecar = Path(str(db_path) + suffix)
            if sidecar.exists() or sidecar.is_symlink():
                regular(sidecar)
        if db_path.exists() or db_path.is_symlink():
            regular(db_path)
            db = sqlite3.connect(str(db_path), timeout=0)
        elif json.loads(data.splitlines()[0])['payload'].get('history_mode', 'legacy') == 'legacy':
            db = sqlite3.connect(':memory:')
            db.execute('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_json TEXT)')
        else:
            raise CleanupError("Paginated history database missing")
        temporary = None
        try:
            db.execute('PRAGMA secure_delete=ON')
            db.execute('BEGIN IMMEDIATE')
            # Keep native indices and row identities intact. Only update the
            # image content in the exact selected thread/turn's projected items.
            updates = []
            for target in targets:
                turn_id, hashes = target['turnId'], set(target['hashes'])
                for item_id, body in db.execute('SELECT item_id,item_json FROM thread_items WHERE thread_id=? AND turn_id=?', (thread_id, turn_id)):
                    item = json.loads(body)
                    if item.get('type') == 'userMessage':
                        if item.get('id') != item_id:
                            raise CleanupError("Projection item identity mismatch")
                        item['content'], removed = redact_content(item['content'], hashes, 'projection')
                        if removed:
                            updates.append((encoded(item).decode(), thread_id, turn_id, item_id))
            receipt = {'threadId': thread_id, 'changedRolloutRecords': changed,
                       'changedProjectedItems': len(updates), 'beforeSha256': digest(data),
                       'afterSha256': digest(output), 'rolloutBytes': len(output),
                       'byteOffsetsPreserved': True, 'imageContentBytes': removed_bytes, 'measuredAt': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()}
            # Report actual native usage, never infer tokens from file size.
            for line in reversed(data.splitlines()):
                row = json.loads(line)
                p = row.get('payload', {})
                if row.get('type') == 'event_msg' and p.get('type') == 'token_count' and isinstance(p.get('info'), dict):
                    info = p['info']
                    receipt['tokenUsage'] = {k: info[k] for k in ('last_token_usage', 'total_token_usage', 'model_context_window') if k in info}
                    break
            if preview:
                db.rollback()
                return receipt
            if changed:
                fd, name = tempfile.mkstemp(prefix='.image-cleanup-', dir=rollout.parent)
                temporary = Path(name)
                with os.fdopen(fd, 'wb') as target:
                    os.fchmod(target.fileno(), stat.S_IMODE(st.st_mode))
                    target.write(output)
                    target.flush()
                    os.fsync(target.fileno())
                current = regular(rollout)
                if current.st_ino != st.st_ino or digest(rollout.read_bytes()) != expected_digest:
                    raise CleanupError("Rollout changed during cleanup")
                os.replace(temporary, rollout)
                temporary = None
                directory = os.open(rollout.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            db.executemany('UPDATE thread_items SET item_json=? WHERE thread_id=? AND turn_id=? AND item_id=?', updates)
            db.commit()
            return receipt
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()
            if temporary is not None:
                temporary.unlink(missing_ok=True)

if __name__ == '__main__':
    import sys
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    try:
        request = json.loads(sys.stdin.read(131073))
        if request.get('version') != '0.153.4':
            raise CleanupError('Only verified Codex 0.153.4 is supported')
        print(json.dumps(cleanup(request['home'], request['rollout'], request['threadId'], request['targets'], request.get('expectedDigest'), request.get('preview', False))))
    except Exception as exc:
        print(json.dumps({'error': str(exc)[:500]}))
        sys.exit(1)
