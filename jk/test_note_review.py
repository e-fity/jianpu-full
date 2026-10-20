# -*- coding: utf-8 -*-
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np

import note_review
import webapp


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.table = self.root / 'test_notes.json'
        self.overlay = self.root / 'test_overlay.png'
        self.source = self.root / 'source.png'
        source = np.full((100, 200, 3), 255, dtype=np.uint8)
        cv2.putText(source, '3', (40, 47), cv2.FONT_HERSHEY_SIMPLEX, .5, (0, 0, 0), 1)
        cv2.putText(source, '0', (100, 47), cv2.FONT_HERSHEY_SIMPLEX, .5, (0, 0, 0), 1)
        cv2.imencode('.png', source)[1].tofile(str(self.source))
        image = source.copy()
        cv2.rectangle(image, (38, 33), (48, 49), (0, 0, 255), 2)
        cv2.rectangle(image, (98, 33), (108, 49), (0, 0, 255), 2)
        cv2.imencode('.png', image)[1].tofile(str(self.overlay))
        self.payload = {'format': 'jianpu2letter-notes-v1', 'source': str(self.source),
                        'title': 'test', 'scale': 2, 'tempo_qpm': 100,
                        'counts': dict(total=3, unknown=1, rests=1, letters=1),
                        'lines': [{'line': 1, 'notes': [
                            dict(line=1, index=1, n=None, o=0, letter=None, q=1, unknown=True, box=[80,70,12,24]),
                            dict(line=1, index=2, n=4, o=0, letter='G', q=.5, box=[98,70,12,24]),
                            dict(line=1, index=3, n=0, o=0, letter='0', q=2, box=[200,70,12,24])]}]}
        self.table.write_text(json.dumps(self.payload), encoding='utf-8')
        self.lib_patch = patch.object(webapp, 'LIB', str(self.root))
        self.lib_patch.start()
        self.client = webapp.app.test_client()

    def tearDown(self):
        self.lib_patch.stop()
        self.tmp.cleanup()

    def state(self):
        response = self.client.get('/api/review/test')
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def save(self, action, index=1, **extra):
        body = dict(action=action, line=1, index=index, revision=self.state()['revision'])
        body.update(extra)
        return self.client.post('/api/review/test', json=body)

    def test_detects_unknown_and_suspicious_rest_not_neighbor(self):
        self.assertEqual([n['index'] for n in self.state()['notes'] if n['red']], [1, 3])
        response = self.client.get('/review/test')
        self.assertEqual(response.status_code, 200)
        response.close()

    def test_hide_preserves_json_bytes_and_other_pixels(self):
        before = self.table.read_bytes()
        image = note_review._image(self.overlay.read_bytes())
        result = self.save('hide')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.table.read_bytes(), before)
        self.assertEqual([n['index'] for n in result.json['notes'] if n['red']], [3])
        after = note_review._image(self.overlay.read_bytes())
        np.testing.assert_array_equal(after[:, 70:], image[:, 70:])
        self.assertEqual(Path(str(self.table) + '.before-review.bak').read_bytes(), before)

    def test_assign_syncs_pitch_shift_duration_counts_and_download(self):
        result = self.save('assign', n=3, o=2, q=.75)
        self.assertEqual(result.status_code, 200)
        payload = json.loads(self.table.read_bytes())
        note = payload['lines'][0]['notes'][0]
        self.assertEqual((note['n'], note['o'], note['letter'], note['shift'], note['q']), (3, 2, 'T', 'LSHIFT', .75))
        self.assertNotIn('unknown', note)
        self.assertEqual(payload['counts'], dict(total=3, letters=2, rests=1, unknown=0))
        self.assertFalse(result.json['notes'][0]['red'])
        self.assertEqual(payload['lines'][0]['notes'][1:], self.payload['lines'][0]['notes'][1:])
        response = self.client.get('/library/notes/test')
        self.assertEqual(response.data, self.table.read_bytes())
        response.close()

    def test_delete_removes_duration_and_reindexes(self):
        from make_video import timeline
        old_duration = sum(n['q'] for n in self.payload['lines'][0]['notes'])
        self.assertEqual(self.save('delete').status_code, 200)
        payload = json.loads(self.table.read_bytes())
        notes = payload['lines'][0]['notes']
        self.assertEqual([n['index'] for n in notes], [1, 2])
        self.assertEqual(sum(n['q'] for n in notes), old_duration - 1)
        self.assertEqual(payload['counts']['total'], 2)
        # 下游直接读取修改后的音符，无未识别占位留下。
        self.assertTrue(all(n['n'] is not None for n in notes))
        events, duration, _ = timeline(payload, 60, 0)
        self.assertEqual(len(events), 2)
        self.assertEqual(duration, old_duration - 1)

    def test_edit_after_hide_and_remove_old_shift(self):
        self.assertEqual(self.save('hide').status_code, 200)
        self.assertEqual(self.save('assign', n=1, o=-3, q=1).status_code, 200)
        self.assertEqual(self.save('assign', n=0, o=0, q=.5).status_code, 200)
        note = json.loads(self.table.read_bytes())['lines'][0]['notes'][0]
        self.assertEqual(note['letter'], '0')
        self.assertNotIn('shift', note)

    def test_stale_revision_rejected_without_mutation(self):
        old = self.state()['revision']
        self.save('hide')
        before = self.table.read_bytes(), self.overlay.read_bytes()
        self.assertEqual(self.save('delete', revision=old).status_code, 400)
        self.assertEqual((self.table.read_bytes(), self.overlay.read_bytes()), before)

    def test_invalid_input_preserves_files(self):
        before = self.table.read_bytes(), self.overlay.read_bytes()
        for values in [dict(n=8,o=0,q=1), dict(n=1,o=4,q=1), dict(n=1,o=0,q=0), dict(n=1,o=0,q='nan')]:
            self.assertEqual(self.save('assign', **values).status_code, 400)
        self.assertEqual(self.save('other').status_code, 400)
        self.assertEqual(self.save('hide', index=2).status_code, 400)
        self.assertEqual(self.client.post('/api/review/test', json=[]).status_code, 400)
        self.assertEqual((self.table.read_bytes(), self.overlay.read_bytes()), before)

    def test_missing_source_preserves_files(self):
        self.source.unlink()
        self.assertFalse(self.state()['can_edit'])
        before = self.table.read_bytes(), self.overlay.read_bytes()
        self.assertEqual(self.save('delete').status_code, 400)
        self.assertEqual((self.table.read_bytes(), self.overlay.read_bytes()), before)

    def test_failed_commit_restores_both_files(self):
        before = self.table.read_bytes(), self.overlay.read_bytes()
        real_replace = note_review.os.replace
        def replace(src, dest):
            if Path(dest) == self.table:
                raise OSError('simulated failure')
            real_replace(src, dest)
        with patch.object(note_review.os, 'replace', side_effect=replace):
            self.assertEqual(self.save('assign', n=2, o=0, q=1).status_code, 500)
        self.assertEqual((self.table.read_bytes(), self.overlay.read_bytes()), before)

    def test_add_inserts_by_x_and_scales_box(self):
        from make_video import timeline, midi_of
        result = self.save('add', image_box=[70, 35, 10, 14], n=3, o=0, q=.5)
        self.assertEqual(result.status_code, 200, result.json)
        payload = json.loads(self.table.read_bytes())
        notes = payload['lines'][0]['notes']
        self.assertEqual([n['index'] for n in notes], [1, 2, 3, 4])
        self.assertEqual(notes[2]['box'], [140, 70, 20, 28])
        self.assertEqual(notes[2]['letter'], 'F')
        self.assertEqual(result.json['selected'], {'line': 1, 'index': 3})
        self.assertEqual(payload['counts']['total'], 4)
        events, duration, _ = timeline(payload, 60, 0)
        self.assertEqual(duration, 4)
        self.assertEqual(midi_of(events[2]['item'], 60), 64)

    def test_resize_unknown_preserves_pitch_and_duration(self):
        result = self.save('box', image_box=[38, 32, 10, 25])
        self.assertEqual(result.status_code, 200, result.json)
        note = json.loads(self.table.read_bytes())['lines'][0]['notes'][0]
        self.assertEqual(note['box'], [76, 64, 20, 50])
        self.assertIsNone(note['n'])
        self.assertEqual(note['q'], 1)
        self.assertTrue(result.json['notes'][0]['red'])
        self.assertEqual(note_review.read_review(self.table, self.overlay)['notes'][0]['edit_rect'], [38,32,10,25])

    def test_move_and_assign_restores_previous_patch(self):
        self.assertEqual(self.save('assign', image_box=[40,35,7,12], n=3,o=0,q=1).status_code, 200)
        result = self.save('assign', image_box=[70,35,12,18], n=2,o=0,q=1)
        self.assertEqual(result.status_code, 200, result.json)
        image = note_review._image(self.overlay.read_bytes())
        source = note_review._image(self.source.read_bytes())
        np.testing.assert_array_equal(image[35:47,40:47],source[35:47,40:47])
        notes = json.loads(self.table.read_bytes())['lines'][0]['notes']
        self.assertEqual([n['letter'] for n in notes], ['G','D','0'])
        self.assertEqual(result.json['selected']['index'], 2)

    def test_bad_or_duplicate_new_boxes_do_not_write(self):
        before = self.table.read_bytes(), self.overlay.read_bytes()
        for box in [[-1,0,10,10], [199,0,10,10], [0,0,1,10], [0,0,float('inf'),10], [1,2,3], 'bad', [40,35,6,12]]:
            response = self.save('add', image_box=box,n=3,o=0,q=1)
            self.assertEqual(response.status_code, 400, box)
        self.assertEqual(self.save('add',line=99,image_box=[70,35,10,10],n=3,o=0,q=1).status_code,400)
        self.assertEqual((self.table.read_bytes(),self.overlay.read_bytes()),before)

    def test_paint_and_reedit_do_not_touch_neighbor(self):
        before = note_review._image(self.overlay.read_bytes())
        self.assertEqual(self.save('assign',image_box=[40,35,7,12],n=1,o=-3,q=1).status_code,200)
        self.assertEqual(self.save('assign',image_box=[40,35,7,12],n=3,o=0,q=1).status_code,200)
        after = note_review._image(self.overlay.read_bytes())
        np.testing.assert_array_equal(after[:,50:],before[:,50:])
        self.assertNotIn('shift',json.loads(self.table.read_bytes())['lines'][0]['notes'][0])

    def test_delete_large_review_box_keeps_every_nonred_pixel(self):
        payload = json.loads(self.table.read_bytes())
        payload['lines'][0]['notes'][0]['review_box'] = [20,20,120,50]
        self.table.write_text(json.dumps(payload),encoding='utf-8')
        image = note_review._image(self.overlay.read_bytes())
        cv2.putText(image, 'FFF', (50,46), cv2.FONT_HERSHEY_SIMPLEX, .45, (0,0,0),1)
        cv2.imencode('.png',image)[1].tofile(str(self.overlay))
        before = image.copy()
        self.assertEqual(self.save('delete').status_code,200)
        after = note_review._image(self.overlay.read_bytes())
        np.testing.assert_array_equal(after[~note_review._red(before)],before[~note_review._red(before)])
        np.testing.assert_array_equal(after[:,50:],before[:,50:])

    def test_delete_recognized_note_does_not_paste_original(self):
        image=note_review._image(self.overlay.read_bytes())
        cv2.putText(image,'G',(49,46),cv2.FONT_HERSHEY_SIMPLEX,.4,(0,0,0),1)
        cv2.imencode('.png',image)[1].tofile(str(self.overlay))
        self.assertEqual(self.save('delete',index=2).status_code,200)
        np.testing.assert_array_equal(note_review._image(self.overlay.read_bytes()),image)

    def test_resized_border_crossing_letter_restores_exact_pixels(self):
        image=note_review._image(self.overlay.read_bytes())
        cv2.putText(image,'FFF',(55,45),cv2.FONT_HERSHEY_SIMPLEX,.6,(0,0,0),1)
        cv2.imencode('.png',image)[1].tofile(str(self.overlay))
        self.assertEqual(self.save('box',image_box=[38,32,35,24]).status_code,200)
        # 框扩大后条目按横坐标重新排序，获取原未识别条目。
        selected=next(n for n in self.state()['notes'] if n['n'] is None)
        self.assertEqual(self.save('delete',index=selected['index']).status_code,200)
        after=note_review._image(self.overlay.read_bytes())
        np.testing.assert_array_equal(after[:,52:],image[:,52:])

    def test_unknown_song(self):
        self.assertEqual(self.client.get('/api/review/missing').status_code, 404)
        self.assertEqual(self.client.get('/review/missing').status_code, 404)


if __name__ == '__main__':
    unittest.main()
