"""Separate lyric ink rows and recognize syllables at their source note positions."""
import cv2
import numpy as np


def text_bands(binary, top, bottom, height):
    """Locate actual ink rows so a multiline OCR box cannot invent a verse."""
    top, bottom = max(0, int(top)), min(binary.shape[0], int(bottom))
    strip = binary[top:bottom]
    if not strip.size:
        return []
    # Long score lines must not dominate the threshold; scattered ink must
    # not connect three lyric rows into one oversized band either.
    rules = cv2.morphologyEx(strip, cv2.MORPH_OPEN,
                             np.ones((1, max(1, int(3 * height))), np.uint8))
    projection = np.count_nonzero(cv2.subtract(strip, rules), axis=1)
    if not projection.size or not projection.max():
        return []
    active = projection > max(2, projection.max() * .08)
    edges = np.diff(np.r_[False, active, False].astype(int))
    runs = list(zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)))
    joined = []
    for left, right in runs:
        if joined and left - joined[-1][1] <= .04 * height:
            joined[-1] = (joined[-1][0], right)
        else:
            joined.append((left, right))
    # The dense core locates the row; restore ascenders/descenders around it.
    return [(max(top, int(top + left - .12 * height)),
             min(bottom, int(top + right + .12 * height)))
            for left, right in joined if .35 * height <= right - left <= 2 * height]


def group_tokens(tokens, bands):
    """Reject boxes spanning multiple ink rows; retain all actual lyric rows."""
    groups = [[] for _ in bands]
    for token in tokens:
        matches = [i for i, (top, bottom) in enumerate(bands)
                   if min(token['y1'], bottom) - max(token['y0'], top) >
                   max(.3 * (bottom - top), .25 * (token['y1'] - token['y0']))]
        if len(matches) == 1:
            groups[matches[0]].append(token)
    return [group for group in groups if group]


def lyric_bands(binary, top, bottom, height, page_tokens):
    bands = text_bands(binary, top, bottom, height)
    # Require a textual anchor: beams and slurs also form ink bands and must
    # not become phantom verses when the recognizer sees them as 一.
    groups = [[] for _ in bands]
    for token in page_tokens:
        matches = [i for i, (start, end) in enumerate(bands)
                   if min(token['y1'], end) - max(token['y0'], start) >
                   max(.3 * (end - start), .25 * (token['y1'] - token['y0']))]
        if len(matches) == 1:
            groups[matches[0]].append(token)
    return [band for band, group in zip(bands, groups) if group]


def read_cells(engine, color, binary, bands, notes, height):
    """Read visible syllables directly; the detector often misses isolated Hanzi."""
    recognize = getattr(engine, 'text_recognizer', None)
    if recognize is None:
        return []
    notes = sorted(notes, key=lambda note: note['cx'])
    tokens = []
    for top, bottom in bands:
        crops, boxes = [], []
        for index, note in enumerate(notes):
            if not note.get('n'):
                continue
            cx = note['cx']
            left = max(0, int((notes[index - 1]['cx'] + cx) / 2 if index else cx - height))
            right = min(binary.shape[1], int((cx + notes[index + 1]['cx']) / 2
                        if index + 1 < len(notes) else cx + height))
            ys, xs = np.nonzero(binary[top:bottom, left:right])
            if not len(xs):
                continue
            width = int(xs.max() - xs.min() + 1)
            ink_height = int(ys.max() - ys.min() + 1)
            horizontal = width > .6 * height and width > 3 * ink_height
            if not (ink_height > .45 * height and width > .25 * height or horizontal):
                continue
            x0 = max(0, left + int(xs.min()) - 3)
            x1 = min(binary.shape[1], left + int(xs.max()) + 4)
            crop = cv2.copyMakeBorder(color[top:bottom, x0:x1], 4, 4, 3, 3,
                                     cv2.BORDER_CONSTANT, value=(255, 255, 255))
            crops.append(crop)
            boxes.append((cx, x0, x1, horizontal, width, ink_height))
        if not crops:
            continue
        readings, _ = recognize(crops)
        candidates = []
        for crop, box, (text, score) in zip(crops, boxes, readings):
            hanzi = ''.join(ch for ch in text if '\u4e00' <= ch <= '\u9fff')
            # Ignore isolated brackets, but retain a visible unrecognized glyph
            # and the thin stroke of 一 for the context recognition below.
            if not hanzi and not box[3] and not (
                    not text and box[4] > .45 * height and box[5] > .45 * height):
                continue
            candidates.append((crop, box, text, hanzi, float(score)))
        if not candidates:
            continue
        packed = np.concatenate([item[0] for item in candidates], axis=1)
        context, _ = recognize([packed])
        context_text, context_score = context[0]
        context_chars = [ch for ch in context_text if '\u4e00' <= ch <= '\u9fff']
        use_context = len(context_chars) == len(candidates) and context_score >= .6
        for index, (_, box, text, hanzi, score) in enumerate(candidates):
            if use_context:
                # Replace only the recognized Hanzi; keep verse numbers and punctuation.
                syllable = (text.replace(hanzi, context_chars[index], 1)
                            if len(hanzi) == 1 else context_chars[index])
            else:
                if not hanzi or score < .2:
                    continue
                syllable = text
            tokens.append(dict(x0=box[1], x1=box[2], y0=top, y1=bottom,
                               cy=(top + bottom) / 2, text=syllable,
                               note_cx=box[0], confidence=float(context_score if use_context else score)))
    return tokens


def positioned_characters(binary, tokens, height, notes=None):
    characters = []
    direct = [t for t in tokens if 'note_cx' in t]
    for token in direct:
        characters.extend((ch, token['note_cx']) for ch in token['text'])
    claimed = {token['note_cx'] for token in direct}
    for token in sorted((t for t in tokens if 'note_cx' not in t),
                        key=lambda t: -t.get('confidence', 0.0)):
        # A complete direct reading supersedes an alternate phrase box;
        # imprecise boxes otherwise repeat a syllable on a melisma note.
        count = sum('\u4e00' <= ch <= '\u9fff' for ch in token['text'])
        covered = sum(token['x0'] <= (t['x0'] + t['x1']) / 2 <= token['x1']
                      for t in direct)
        if count and covered >= count:
            continue
        text, centers = character_centers(binary, token)
        additions = []
        for ch, x in zip(text, centers):
            if notes and min(notes, key=lambda n: abs(n['cx'] - x))['cx'] in claimed:
                continue
            # Compare only with OTHER OCR boxes, never neighbours in this phrase.
            if not any(abs(x - old[1]) < .45 * height for old in characters):
                additions.append((ch, x))
        characters.extend(additions)
    return sorted(characters, key=lambda pair: pair[1])


def character_centers(binary, token):
    text = ''.join(token['text'].split())
    x0, x1 = max(0, int(token['x0'])), min(binary.shape[1], int(np.ceil(token['x1'])))
    y0, y1 = max(0, int(token['y0'])), min(binary.shape[0], int(np.ceil(token['y1'])))
    crop = binary[y0:y1, x0:x1]
    fallback = [token['x0'] + (token['x1'] - token['x0']) * (i + .5) / max(len(text), 1)
                for i in range(len(text))]
    if not text or not crop.size:
        return text, fallback
    occupied = np.any(crop > 0, axis=0)
    edges = np.diff(np.r_[False, occupied, False].astype(int))
    runs = list(zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)))
    # Join disconnected radicals at the smallest gaps until one span per character remains.
    while len(runs) > len(text):
        index = min(range(len(runs) - 1), key=lambda i: runs[i + 1][0] - runs[i][1])
        runs[index:index + 2] = [(runs[index][0], runs[index + 1][1])]
    if len(runs) != len(text):
        return text, fallback
    return text, [x0 + (left + right) / 2 for left, right in runs]
