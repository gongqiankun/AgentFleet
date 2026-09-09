import copy
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from cleanup import CleanupError, cleanup_fixture, digest, encoded, rollout_plan, writer_lock

IMAGE = 'data:image/png;base64,' + 'AAAA' * 100
OTHER = 'data:image/png;base64,' + 'BBBB' * 100


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='agentfleet-cleanup-unit-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        (self.home / '.agentfleet-image-cleanup-fixture').write_text('isolated-no-account-no-user-data\n')
        (self.home / 'config.toml').write_text('model_provider = "fixture"\n')
        self.thread, self.turn = str(uuid.uuid4()), str(uuid.uuid4())
        self.rows = [
            {'type': 'session_meta', 'payload': {'id': self.thread, 'cli_version': '0.153.4', 'history_mode': 'paginated'}},
            {'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': self.turn}},
            {'type': 'response_item', 'payload': {'type': 'message', 'id': 'response-1', 'role': 'user', 'content': [{'type': 'input_text', 'text': '文字 A\n保留换行和 emoji 🦊'}, {'type': 'input_image', 'image_url': IMAGE}, {'type': 'input_image', 'image_url': OTHER}]}},
            {'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': self.turn}},
            {'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 'another-turn'}},
            {'type': 'response_item', 'payload': {'type': 'message', 'id': 'response-2', 'role': 'user', 'content': [{'type': 'input_image', 'image_url': IMAGE}]}},
            {'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': 'another-turn'}},
        ]
        self.data = b''.join(encoded(row) + b'\n' for row in self.rows)
        (self.home / 'sessions').mkdir()
        self.path = self.home / 'sessions' / (self.thread + '.jsonl')
        self.path.write_bytes(self.data)
        self.dbpath = self.home / 'thread_history_1.sqlite'
        with closing(sqlite3.connect(self.dbpath,isolation_level=None)) as db:
            db.execute('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_json TEXT)')
            self.item = {'id': 'item-1', 'type': 'userMessage', 'content': [{'type': 'text', 'text': '文字 A\n保留换行和 emoji 🦊'}, {'type': 'image', 'url': IMAGE}, {'type': 'image', 'url': OTHER}]}
            for thread, turn in [(self.thread,self.turn), ('another-thread',self.turn), (self.thread,'another-turn')]:
                db.execute('INSERT INTO thread_items VALUES(?,?,?,?)', (thread, turn, 'item-1', encoded(self.item).decode()))

    def run_cleanup(self, **kwargs):
        return cleanup_fixture(self.home, self.path, self.thread, self.turn, [digest(IMAGE.encode())], digest(self.path.read_bytes()), **kwargs)

    def test_text_ids_other_images_and_offsets_preserved(self):
        receipt = self.run_cleanup()
        after = self.path.read_bytes()
        self.assertEqual(len(after), len(self.data))
        self.assertEqual([len(x) for x in after.splitlines()], [len(x) for x in self.data.splitlines()])
        rows = [json.loads(line) for line in after.splitlines()]
        self.assertEqual(rows[0],self.rows[0])
        self.assertEqual(rows[2]['payload']['id'],'response-1')
        self.assertEqual(rows[2]['payload']['content'][0],self.rows[2]['payload']['content'][0])
        self.assertEqual(rows[2]['payload']['content'][2],self.rows[2]['payload']['content'][2])
        self.assertEqual(rows[5],self.rows[5], 'same pixels in another turn remain')
        self.assertNotIn(IMAGE, json.dumps(rows[2]))
        with closing(sqlite3.connect(self.dbpath,isolation_level=None)) as db:
            untouched = db.execute('SELECT item_json FROM thread_items WHERE thread_id!=? OR turn_id!=?',(self.thread,self.turn)).fetchall()
            self.assertTrue(all(json.loads(row[0]) == self.item for row in untouched))
        self.assertEqual(receipt['changedProjectedItems'],1)
        self.assertEqual(self.run_cleanup()['changedRolloutRecords'],0)

    def test_stale_preview_rejected(self):
        self.path.write_bytes(self.data+b'\n')
        with self.assertRaisesRegex(CleanupError,'Preview stale'):
            cleanup_fixture(self.home,self.path,self.thread,self.turn,[digest(IMAGE.encode())],digest(self.data))
        self.assertEqual(self.path.read_bytes(),self.data+b'\n')

    def test_live_writer_blocks_without_changes(self):
        with writer_lock(self.home,self.thread):
            with self.assertRaisesRegex(CleanupError,'writer busy'):
                self.run_cleanup()
        self.assertEqual(self.path.read_bytes(),self.data)

    def test_before_replace_failure_preserves_both_stores(self):
        with self.assertRaisesRegex(CleanupError,'before replacement'):
            self.run_cleanup(failpoint='before_replace')
        self.assertEqual(self.path.read_bytes(),self.data)
        with closing(sqlite3.connect(self.dbpath,isolation_level=None)) as db:
            self.assertEqual(json.loads(db.execute('SELECT item_json FROM thread_items LIMIT 1').fetchone()[0]),self.item)

    def test_after_replace_failure_preserves_offsets_and_can_reconcile(self):
        with self.assertRaisesRegex(CleanupError,'after replacement'):
            self.run_cleanup(failpoint='after_replace')
        self.assertEqual(len(self.path.read_bytes()),len(self.data))
        receipt=self.run_cleanup()
        self.assertEqual(receipt['changedRolloutRecords'],0)
        self.assertEqual(receipt['changedProjectedItems'],1)

    def test_foreign_path_credentials_and_unknown_version_rejected(self):
        (self.home/'auth.json').write_text('{}')
        with self.assertRaisesRegex(CleanupError,'credentials'):
            self.run_cleanup()
        (self.home/'auth.json').unlink()
        other=self.home/'elsewhere';other.write_bytes(self.data)
        with self.assertRaisesRegex(CleanupError,'outside'):
            cleanup_fixture(self.home,other,self.thread,self.turn,[digest(IMAGE.encode())],digest(self.data))
        rows=copy.deepcopy(self.rows);rows[0]['payload']['cli_version']='future'
        with self.assertRaisesRegex(CleanupError,'version'):
            rollout_plan(b''.join(encoded(r)+b'\n' for r in rows),self.thread,self.turn,{digest(IMAGE.encode())})

    def test_incomplete_active_or_mismatched_history_rejected(self):
        with self.assertRaisesRegex(CleanupError,'incomplete'):
            rollout_plan(self.data[:-1],self.thread,self.turn,{digest(IMAGE.encode())})
        with self.assertRaisesRegex(CleanupError,'identity'):
            rollout_plan(self.data,str(uuid.uuid4()),self.turn,{digest(IMAGE.encode())})
        with self.assertRaisesRegex(CleanupError,'terminal'):
            rollout_plan(b''.join(encoded(r)+b'\n' for r in self.rows[:-1]),self.thread,self.turn,{digest(IMAGE.encode())})

    def test_tool_calls_results_and_legacy_text_are_unchanged(self):
        rows = copy.deepcopy(self.rows)
        rows.insert(3, {'type':'response_item','payload':{'type':'function_call','call_id':'keep-call','arguments':'{"command":"echo hello"}'}})
        rows.insert(4, {'type':'response_item','payload':{'type':'function_call_output','call_id':'keep-call','output':'工具输出\n保持原样'}})
        rows.insert(2, {'type':'event_msg','payload':{'type':'user_message','message':'原始文本 <image> 不得改写','images':[IMAGE,OTHER],'local_images':[]}})
        before = b''.join(encoded(r)+b'\n' for r in rows)
        after, _ = rollout_plan(before,self.thread,self.turn,{digest(IMAGE.encode())})
        parsed = [json.loads(line) for line in after.splitlines()]
        self.assertEqual(parsed[2]['payload']['message'],rows[2]['payload']['message'])
        self.assertEqual(parsed[2]['payload']['images'],[OTHER])
        for index in [4,5]:
            self.assertEqual(after.splitlines()[index],before.splitlines()[index])

    def test_unknown_image_fields_and_missing_paged_index_fail_closed(self):
        rows = copy.deepcopy(self.rows)
        rows[2]['payload']['content'][1]['future_metadata']='preserve me'
        with self.assertRaisesRegex(CleanupError,'Unknown image'):
            rollout_plan(b''.join(encoded(r)+b'\n' for r in rows),self.thread,self.turn,{digest(IMAGE.encode())})
        self.dbpath.unlink()
        with self.assertRaisesRegex(CleanupError,'database missing'):
            self.run_cleanup()
        self.assertEqual(self.path.read_bytes(),self.data)

    def test_symlinked_rollout_rejected(self):
        target=self.home/'real';self.path.rename(target);self.path.symlink_to(target)
        with self.assertRaises(CleanupError):self.run_cleanup()

if __name__ == '__main__': unittest.main()
