"""Regression coverage for short final rows and same-row footer text."""
import unittest

from jianpu2letter.ocr_jianpu import _row_has_end_bar, _row_music_right_bound


class RowEndingTests(unittest.TestCase):
    H = 20

    @staticmethod
    def block(x, y=0, w=10, h=20, area=140):
        return dict(x=x, y=y, w=w, h=h, area=area)

    def fixture(self, kind="double", extra_xs=()):
        blocks = [self.block(x) for x in (10, 40, 70, *extra_xs)]
        components = blocks + [
            self.block(100, y=-5, w=2, h=30, area=60),
            self.block(108, y=-5, w=2, h=30, area=60),
        ]
        if kind in ("backward", "forward"):
            dot_x = 93 if kind == "backward" else 116
            components += [self.block(dot_x, y=y, w=3, h=3, area=9)
                           for y in (3, 15)]
        return dict(blocks=blocks, cy=10.0, H=self.H), components

    @staticmethod
    def text_token(y=0):
        return dict(x0=165.0, x1=250.0, y0=float(y), y1=float(y+20),
                    cy=float(y+10), text="微信")

    def test_row_end_accepts_double_and_backward_but_not_forward(self):
        for kind, expected in (("double", True), ("backward", True),
                               ("forward", False)):
            with self.subTest(kind=kind):
                row, components = self.fixture(kind)
                self.assertEqual(_row_has_end_bar(row, components, self.H), expected)

    def test_middle_double_bar_is_not_row_end(self):
        row, components = self.fixture(extra_xs=(140,))
        self.assertFalse(_row_has_end_bar(row, components, self.H))

    def test_separate_same_row_footer_sets_right_bound(self):
        for kind in ("double", "backward"):
            with self.subTest(kind=kind):
                row, components = self.fixture(kind, extra_xs=(170, 195, 225))
                bound = _row_music_right_bound(
                    row, components, self.H, [self.text_token()])
                self.assertEqual(bound, 125.0)

    def test_music_between_bar_and_footer_prevents_trimming(self):
        row, components = self.fixture(extra_xs=(130, 170, 195, 225))
        self.assertIsNone(_row_music_right_bound(
            row, components, self.H, [self.text_token()]))

    def test_lyrics_below_row_do_not_supply_footer_evidence(self):
        row, components = self.fixture(extra_xs=(170, 195, 225))
        self.assertIsNone(_row_music_right_bound(
            row, components, self.H, [self.text_token(y=50)]))

    def test_forward_repeat_does_not_trim_following_content(self):
        row, components = self.fixture("forward", extra_xs=(170, 195, 225))
        self.assertIsNone(_row_music_right_bound(
            row, components, self.H, [self.text_token()]))

    def test_numbers_alone_do_not_supply_footer_evidence(self):
        row, components = self.fixture(extra_xs=(170, 195, 225))
        self.assertIsNone(_row_music_right_bound(row, components, self.H, []))


if __name__ == "__main__":
    unittest.main()
