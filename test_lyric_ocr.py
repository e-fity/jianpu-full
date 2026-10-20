"""Regression tests for missing lyric verses and word deduplication."""
import unittest
import numpy as np
from jianpu2letter.lyric_ocr import (group_tokens, lyric_bands,
                                     positioned_characters, read_cells)


def token(text, x0, x1, y0=10, y1=30, **extra):
    return dict(text=text, x0=x0, x1=x1, y0=y0, y1=y1, cy=(y0+y1)/2, **extra)


class LyricRegressionTests(unittest.TestCase):
    def test_multiline_box_cannot_create_a_fourth_verse(self):
        bands = [(10, 30), (50, 70), (90, 110)]
        tokens = [token('世间', 0, 60), token('失败', 0, 60, 50, 70),
                  token('百千', 0, 60, 90, 110), token('世失', 0, 20, 10, 70)]
        groups = group_tokens(tokens, bands)
        self.assertEqual([[t['text'] for t in group] for group in groups],
                         [['世间'], ['失败'], ['百千']])

    def test_beams_without_text_do_not_create_lyrics(self):
        binary = np.zeros((90, 100), np.uint8)
        binary[5:20, 10:40] = 255
        binary[45:70, 10:80] = 255
        bands = lyric_bands(binary, 0, 90, 30, [token('歌词', 10, 80, 45, 70)])
        self.assertEqual(len(bands), 1)
        self.assertLessEqual(bands[0][0], 45)
        self.assertGreaterEqual(bands[0][1], 70)
        self.assertEqual(lyric_bands(binary, 0, 90, 30, []), [])

    def test_close_neighbours_in_one_phrase_survive(self):
        binary = np.zeros((40, 80), np.uint8)
        result = positioned_characters(binary, [token('成功失败', 0, 40)], 48)
        self.assertEqual(''.join(ch for ch, _ in result), '成功失败')

    def test_partly_overlapping_phrase_keeps_uncovered_words(self):
        binary = np.zeros((40, 80), np.uint8)
        result = positioned_characters(binary,
            [token('成', 0, 10, confidence=1), token('成功', 0, 20)], 10)
        self.assertEqual(''.join(ch for ch, _ in result), '成功')

    def test_direct_syllable_is_not_repeated_on_melisma(self):
        binary = np.zeros((40, 100), np.uint8)
        tokens = [token('江', 10, 30, note_cx=20), token('江', 10, 70)]
        result = positioned_characters(binary, tokens, 20,
                                      [dict(cx=20), dict(cx=50)])
        self.assertEqual(result, [('江', 20)])

    def test_context_with_extra_character_cannot_shift_alignment(self):
        class Engine:
            calls = 0
            def text_recognizer(self, images):
                self.calls += 1
                if self.calls == 1:
                    return [('江', .9), ('水', .9)], 0
                return [('江河水', .99)], 0
        binary = np.zeros((40, 100), np.uint8)
        binary[10:30, 12:28] = 255
        binary[10:30, 62:78] = 255
        color = np.repeat((255-binary)[:, :, None], 3, axis=2)
        result = read_cells(Engine(), color, binary, [(10, 30)],
                            [dict(n=6, cx=20), dict(n=1, cx=70)], 20)
        self.assertEqual([(t['text'], t['note_cx']) for t in result], [('江', 20), ('水', 70)])

    def test_context_keeps_verse_number_and_punctuation(self):
        class Engine:
            calls = 0
            def text_recognizer(self, images):
                self.calls += 1
                return ([('1.江，', .9)] if self.calls == 1 else [('江', .9)]), 0
        binary = np.zeros((40, 60), np.uint8)
        binary[10:30, 12:28] = 255
        color = np.repeat((255-binary)[:, :, None], 3, axis=2)
        result = read_cells(Engine(), color, binary, [(10, 30)], [dict(n=6, cx=20)], 20)
        self.assertEqual(result[0]['text'], '1.江，')

    def test_sparse_ink_cannot_merge_three_verses(self):
        binary = np.zeros((130, 160), np.uint8)
        binary[5:120, :4] = 255  # Scan noise bridges all three rows.
        binary[2:4, :] = 255    # Long score rule must not set the threshold.
        tokens = []
        for top, text in [(10, '第一段'), (50, '第二段'), (90, '第三段')]:
            for x in range(10, 110, 20):
                binary[top:top+20, x:x+12] = 255
            tokens.append(token(text, 10, 110, top, top+20))
        bands = lyric_bands(binary, 0, 130, 20, tokens)
        self.assertEqual(len(bands), 3)
        groups = group_tokens(tokens, bands)
        self.assertEqual([g[0]['text'] for g in groups], ['第一段', '第二段', '第三段'])

    def test_box_margin_touching_octave_dots_is_not_multiline(self):
        groups = group_tokens([token('我最珍惜的', 0, 60, 12, 70)], [(0, 20), (25, 65)])
        self.assertEqual([[t['text'] for t in g] for g in groups], [['我最珍惜的']])


if __name__ == '__main__':
    unittest.main()
