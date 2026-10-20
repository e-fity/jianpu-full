import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import test_note_review
import lyric_sync
import webapp


class LyricSyncTests(unittest.TestCase):
    def setUp(self):
        self.fixture=test_note_review.ReviewTests()
        self.fixture.setUp()
        self.root=self.fixture.root
        self.table=self.fixture.table
        self.donor_root=self.root/'piano11'
        (self.donor_root/'out').mkdir(parents=True)
        self.review=self.donor_root/'out'/'test_review.json'
        self.donor={'format':'jianpu2letter-review-v1','metadata':{'source_image':str(self.fixture.source)},
                    'lines':[{'line':1,'notes':[dict(n=n['n'],o=n['o'],source_x=n['box'][0]+n['box'][2]/2,lyric=l)
                             for n,l in zip(self.fixture.payload['lines'][0]['notes'],['不','管',''])]}]}
        self.write_donor()

    def write_donor(self):
        self.review.write_text(json.dumps(self.donor),encoding='utf-8')

    def tearDown(self):
        self.fixture.tearDown()

    def test_only_lyrics_change_backup_and_idempotence(self):
        before=self.table.read_bytes()
        result=lyric_sync.sync_lyrics(self.table,self.review)
        self.assertEqual(result['changed'],2)
        self.assertEqual((self.root/result['backup']).read_bytes(),before)
        after=json.loads(self.table.read_bytes())
        self.assertEqual(after['lines'][0]['notes'][0]['lyric'],'不')
        for n in after['lines'][0]['notes']: n.pop('lyric',None)
        self.assertEqual(after,self.fixture.payload)
        result=lyric_sync.sync_lyrics(self.table,self.review)
        self.assertEqual(result['changed'],0)
        self.assertIsNone(result['backup'])

    def test_deleted_note_does_not_shift_lyrics(self):
        p=copy.deepcopy(self.fixture.payload)
        p['lines'][0]['notes'].pop(0)
        for i,n in enumerate(p['lines'][0]['notes'],1):n['index']=i
        self.table.write_text(json.dumps(p),encoding='utf-8')
        result=lyric_sync.sync_lyrics(self.table,self.review)
        self.assertEqual(result['matched'],2)
        self.assertEqual(json.loads(self.table.read_bytes())['lines'][0]['notes'][0]['lyric'],'管')

    def test_duplicate_positions_skip_without_guessing(self):
        p=copy.deepcopy(self.fixture.payload)
        p['lines'][0]['notes'].append(dict(p['lines'][0]['notes'][0],index=4))
        self.table.write_text(json.dumps(p),encoding='utf-8')
        with self.assertRaises(ValueError):lyric_sync.sync_lyrics(self.table,self.review)

    def test_different_source_refused(self):
        src=self.root/'different.png';src.write_bytes(b'wrong image')
        self.donor['metadata']['source_image']=str(src);self.write_donor()
        before=self.table.read_bytes()
        with self.assertRaises(ValueError):lyric_sync.sync_lyrics(self.table,self.review)
        self.assertEqual(self.table.read_bytes(),before)

    def test_missing_source_and_rows_refused(self):
        self.donor['lines'][0]['line']=2;self.write_donor()
        with self.assertRaises(ValueError):lyric_sync.sync_lyrics(self.table,self.review)
        self.review.unlink()
        with self.assertRaises(ValueError):lyric_sync.sync_lyrics(self.table,self.review)

    def test_api_success_and_unknown_song(self):
        with patch.object(webapp.jianpu_api,'PIANO11',str(self.donor_root)):
            result=self.fixture.client.post('/api/lyrics/sync/test')
            self.assertEqual(result.status_code,200,result.json)
            self.assertEqual(result.json['changed'],2)
            self.assertEqual(self.fixture.client.post('/api/lyrics/sync/missing').status_code,404)

    def test_empty_latest_lyric_removes_stale_text(self):
        p=copy.deepcopy(self.fixture.payload);p['lines'][0]['notes'][2]['lyric']='错误'
        self.table.write_text(json.dumps(p),encoding='utf-8')
        lyric_sync.sync_lyrics(self.table,self.review)
        self.assertNotIn('lyric',json.loads(self.table.read_bytes())['lines'][0]['notes'][2])

if __name__=='__main__':unittest.main()
