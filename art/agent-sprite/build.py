"""Build the Agents sidebar character: one 24x24 pixel sprite per agent status.

Edit base.txt (the pixel map) or the POSES below, then run:
    python3 art/agent-sprite/build.py
It writes mods/studio-dashboard/sprites/<status>[-<frame>].png at 2x (48px), so a
24pt slot on a Retina screen shows one image pixel per screen pixel: no blur.
Busy states (working, blocked) get two frames, <status>-0.png and -1.png, that the
mod flips natively; calm ones are one still PNG.
"""
from pathlib import Path
import subprocess, tempfile

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / 'mods/studio-dashboard/sprites'
SCALE = 2
KEY = '#ff00ff'  # transparent

PAL = {
    'K': '#1f2a5a', 'H': '#2b3a8c', 'h': '#4a63c9', 'S': '#ffdcc8', 's': '#f0b9a2',
    'W': '#ffffff', 'w': '#d5dcef', 'E': '#1f2a5a', 'R': '#d9433b', 'P': '#ff9fae',
    'Y': '#e8b23a', 'y': '#c38f1f', 'L': '#2b3a8c', 'l': '#7fb2e5', 'D': '#c98b55',
    'd': '#9b6538', 'O': '#ff8a3d', 'G': '#3ecf8e', 'Z': '#9aa3b5',
}

def load():
    rows = [l.strip().strip('|') for l in (HERE / 'base.txt').read_text().splitlines()
            if l.strip() and not l.startswith('#')]
    assert all(len(r) == len(rows[0]) for r in rows), 'ragged rows in base.txt'
    # Mouth: a small open "talking" mouth, one row.
    rows[13] = rows[13][:11] + 'SS' + rows[13][13:]
    return rows

def pose(base, puts):
    g = [list(r) for r in base]
    for r, c, s in puts:
        for i, ch in enumerate(s):
            g[r][c + i] = ch
    return [''.join(r) for r in g]

BLOCKED_FACE = [(8, 9, 'SS'), (8, 14, 'SS'), (7, 9, 'KK'), (7, 14, 'KK'), (9, 9, 'EE'), (9, 14, 'EE'),
                (12, 11, 'KK'), (13, 11, 'KK')]
RAISED_ARM = [(6, 1, 'KKK'), (7, 0, 'KSSSK'), (8, 0, 'KSSSK'), *[(r, 1, 'KWK') for r in range(9, 15)],
              (15, 1, 'KWWWWW'), (16, 1, 'KKKK')]
BANG = [(0, 1, 'OO'), (1, 1, 'OO'), (2, 1, 'OO'), (4, 1, 'OO')]

def poses(base):
    return {
        # Typing: the hand on the keys, then lifted.
        'working': [base, pose(base, [(19, 13, 'SS'), (20, 13, 'WW')])],
        # Hand up; the "!" blinks (it lives on the top frame, see covers()).
        'blocked': [pose(base, BLOCKED_FACE + RAISED_ARM), pose(base, BLOCKED_FACE + RAISED_ARM + BANG)],
        'done': [pose(base, [(10, 9, 'KK'), (10, 14, 'KK'), (11, 8, 'KSSK'), (11, 13, 'KSSK'), (10, 8, 'S'),
                             (10, 11, 'S'), (10, 13, 'S'), (10, 16, 'S'), (12, 10, 'KSSK'), (13, 11, 'KK'),
                             (17, 18, 'GG'), (18, 18, 'GG')])],
        'idle': [pose(base, [(10, 9, 'SS'), (10, 14, 'SS'), (11, 9, 'KK'), (11, 14, 'KK'), (12, 11, 'KK'),
                             (0, 19, 'ZZZZZ'), (1, 22, 'Z'), (2, 21, 'Z'), (3, 20, 'Z'), (4, 19, 'ZZZZZ')])],
    }

def covers(name, frames):
    # The mod stacks frame 1 on frame 0 and blinks frame 1's opacity: wherever frame 0
    # draws, frame 1 must draw too, or frame 0 shows through when it should be hidden.
    if len(frames) < 2:
        return
    a, b = frames
    holes = [(y, x) for y, r in enumerate(a) for x, c in enumerate(r) if c in PAL and b[y][x] not in PAL]
    assert not holes, f'{name}: frame 1 is transparent over frame 0 at (row, col) {holes[:5]}'

def ppm(rows, path):
    hexes = lambda c: PAL.get(c, KEY).lstrip('#')
    body = '\n'.join(' '.join(' '.join(str(int(hexes(c)[i:i + 2], 16)) for i in (0, 2, 4)) for c in r) for r in rows)
    path.write_text(f'P3 {len(rows[0])} {len(rows)} 255\n{body}\n')

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for name, frames in poses(load()).items():
            covers(name, frames)
            pngs = []
            for i, rows in enumerate(frames):
                p = Path(tmp) / f'{name}{i}.ppm'
                ppm(rows, p)
                png = Path(tmp) / f'{name}{i}.png'
                subprocess.run(['magick', p, '-transparent', KEY, '-filter', 'point', '-resize', f'{SCALE * 100}%', png], check=True)
                pngs.append(png)
            for old in [*OUT.glob(f'{name}.*'), *OUT.glob(f'{name}-*')]:
                old.unlink()
            for i, png in enumerate(pngs):
                subprocess.run(['magick', png, OUT / (f'{name}.png' if len(pngs) == 1 else f'{name}-{i}.png')], check=True)
    print('\n'.join(sorted(p.name for p in OUT.iterdir())))

if __name__ == '__main__':
    main()
