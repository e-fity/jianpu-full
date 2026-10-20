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

    def test_reread_uses_original_and_converts_coordinate_scale(self):
        measures = [{'row':0,'notes':[dict(n=n['n'],o=n['o'],cx=(n['box'][0]+n['box'][2]/2)*2,
                      box=n['box'],lyric=l,markup={})
                      for n,l in zip(self.fixture.payload['lines'][0]['notes'],['不','管',''])]}]
        before=self.fixture.overlay.read_bytes()
        original=self.table.read_bytes()
        with patch.object(webapp.jianpu_api.ocr_jianpu,'ocr_to_stream',return_value=measures) as ocr, patch.object(webapp.jianpu_api.ocr_jianpu,'_LAST_SCALE',4), patch.object(webapp,'WORK',str(self.root/'work')):
            response=self.fixture.client.post('/api/lyrics/reread/test')
            self.assertEqual(response.status_code,200,response.json)
            self.assertEqual(response.json['changed'],2)
            self.assertEqual(ocr.call_args.args[0],str(self.fixture.source))
            self.assertFalse(ocr.call_args.kwargs['header_ocr'])
            self.assertEqual(self.table.read_bytes(),original)
            self.assertEqual(response.json['changes'][0]['after'],'不')
            applied=self.fixture.client.post('/api/lyrics/apply/test',json={'token':response.json['token'],'selected':[0]})
            self.assertEqual(applied.status_code,200,applied.json)
            self.assertEqual(applied.json['changed'],1)
            self.assertEqual((self.root/applied.json['backup']).read_bytes(),original)
            repeated=self.fixture.client.post('/api/lyrics/apply/test',json={'token':response.json['token'],'selected':[1]})
            self.assertEqual(repeated.status_code,400)
        result=json.loads(self.table.read_bytes())
        self.assertEqual(result['lines'][0]['notes'][0]['lyric'],'不')
        self.assertNotIn('lyric',result['lines'][0]['notes'][1])
        for n in result['lines'][0]['notes']:n.pop('lyric',None)
        self.assertEqual(result,self.fixture.payload)
        self.assertEqual(self.fixture.overlay.read_bytes(),before)

    def make_plan(self):
        result=lyric_sync.sync_lyrics(self.table,self.review,preview=True)
        token='abcdef123456'
        folder=self.root/('lyrics_'+token)
        folder.mkdir(exist_ok=True)
        (folder/'preview.json').write_text(json.dumps(result),encoding='utf-8')
        return token,result

    def test_preview_and_selected_add_replace_clear_preserve_other_fields(self):
        payload=copy.deepcopy(self.fixture.payload)
        notes=payload['lines'][0]['notes']
        notes[0]['lyric']='旧字'
        notes[2]['lyric']='误字'
        notes[1]['lyric2']='保留'
        self.table.write_text(json.dumps(payload),encoding='utf-8')
        before=self.table.read_bytes()
        token,plan=self.make_plan()
        self.assertEqual(self.table.read_bytes(),before)
        self.assertEqual([(c['before'],c['after']) for c in plan['changes']],[('旧字','不'),('','管'),('误字','')])
        result=lyric_sync.apply_lyrics(self.table,self.root,token,[0,2])
        self.assertEqual(result['changed'],2)
        notes[0]['lyric']='不'
        notes[2].pop('lyric')
        self.assertEqual(json.loads(self.table.read_bytes()),payload)
        self.assertEqual((self.root/result['backup']).read_bytes(),before)

    def test_stale_preview_rejects_manual_changes(self):
        token,_=self.make_plan()
        payload=copy.deepcopy(self.fixture.payload)
        payload['lines'][0]['notes'].pop(0)
        self.table.write_text(json.dumps(payload),encoding='utf-8')
        before=self.table.read_bytes()
        with self.assertRaisesRegex(ValueError,'数据已改变'):
            lyric_sync.apply_lyrics(self.table,self.root,token,[0])
        self.assertEqual(self.table.read_bytes(),before)

    def test_invalid_selection_and_other_song_cannot_apply(self):
        token,_=self.make_plan()
        before=self.table.read_bytes()
        with patch.object(webapp,'WORK',str(self.root)):
            for selected in ([],[99],[0,0],[True],['0'],None):
                response=self.fixture.client.post('/api/lyrics/apply/test',json={'token':token,'selected':selected})
                self.assertEqual(response.status_code,400,response.json)
            response=self.fixture.client.post('/api/lyrics/apply/test',json={'token':'../outside','selected':[0]})
            self.assertEqual(response.status_code,400)
        other=self.root/'other_notes.json';other.write_bytes(before)
        with self.assertRaises(ValueError):lyric_sync.apply_lyrics(other,self.root,token,[0])
        self.assertEqual(self.table.read_bytes(),before)

    def test_preview_no_differences_does_not_write(self):
        lyric_sync.sync_lyrics(self.table,self.review)
        before=self.table.read_bytes()
        _,plan=self.make_plan()
        self.assertEqual(plan['changes'],[])
        self.assertEqual(plan['changed'],0)
        self.assertEqual(self.table.read_bytes(),before)

    def test_reread_failure_preserves_files(self):
        before=self.table.read_bytes()
        with patch.object(webapp.jianpu_api.ocr_jianpu,'ocr_to_stream',side_effect=RuntimeError('OCR failed')):
            self.assertEqual(self.fixture.client.post('/api/lyrics/reread/test').status_code,500)
        self.assertEqual(self.table.read_bytes(),before)
        self.assertEqual(self.fixture.client.post('/api/lyrics/reread/missing').status_code,404)

    def test_reread_missing_image_does_not_call_ocr(self):
        self.fixture.source.unlink()
        with patch.object(webapp.jianpu_api.ocr_jianpu,'ocr_to_stream') as ocr:
            self.assertEqual(self.fixture.client.post('/api/lyrics/reread/test').status_code,400)
            ocr.assert_not_called()

    def test_empty_latest_lyric_removes_stale_text(self):
        p=copy.deepcopy(self.fixture.payload);p['lines'][0]['notes'][2]['lyric']='错误'
        self.table.write_text(json.dumps(p),encoding='utf-8')
        lyric_sync.sync_lyrics(self.table,self.review)
        self.assertNotIn('lyric',json.loads(self.table.read_bytes())['lines'][0]['notes'][2])

if __name__=='__main__':unittest.main()
