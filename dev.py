"""Publish this workspace to a personal Herdr layout and watch for edits."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parent
HOME = Path.home() / '.config/herdr-app'
STATE = ROOT / '.published.json'
CONFIG = 'studio/config.json'  # where config.json goes, under HOME

def digest(data):
    return hashlib.sha256(data).hexdigest()

def sources():
    files = {str(p.relative_to(ROOT)): p.read_bytes()
            for folder in ('layouts', 'mods') for p in (ROOT / folder).rglob('*')
            if p.is_file() and not p.name.startswith('.')
            and p.name != 'jsconfig.json' and not p.name.endswith('.d.ts')}
    if (ROOT / 'keybindings.json').exists():
        files['keybindings.json'] = (ROOT / 'keybindings.json').read_bytes()
    # Your own settings (copied from config.example.json); the mods read them from Herdr's folder.
    if (ROOT / 'config.json').exists():
        data = (ROOT / 'config.json').read_bytes()
        try:
            json.loads(data)
        except ValueError as error:
            raise RuntimeError(f'config.json is not valid JSON: {error}')
        files[CONFIG] = data
    return files

def publish(files):
    previous = json.loads(STATE.read_text()) if STATE.exists() else {}
    # Never replace unrelated files or overwrite edits made directly in Herdr.
    for name in set(previous) | set(files):
        if name == 'keybindings.json':
            continue  # Source-only overrides are merged into keys.json below.
        target = HOME / name
        if target.exists():
            actual = digest(target.read_bytes())
            if actual != previous.get(name) and (name not in files or actual != digest(files[name])):
                raise RuntimeError(f'Conflicting file; preserve or move it first: {target}')
    changed_mods = {Path(name).parts[1] for name, data in files.items()
                    if name.startswith('mods/') and digest(data) != previous.get(name)}
    for mod in sorted(changed_mods):
        subprocess.run(['herdr-app', 'check', str(ROOT / 'mods' / mod)],
                       check=True, timeout=30)
    keys_target = HOME / 'keys.json'
    keys = json.loads(keys_target.read_text()) if keys_target.exists() else {}
    for section, bindings in json.loads(files.get('keybindings.json', b'{}')).items():
        keys.setdefault(section, {}).update(bindings)
    for name, data in files.items():
        if name == 'keybindings.json':
            continue
        target = HOME / name
        if not target.exists() or target.read_bytes() != data:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    for name in previous.keys() - files.keys():
        if name == 'keybindings.json':
            continue
        (HOME / name).unlink(missing_ok=True)
    if 'keybindings.json' in files:
        keys_text = json.dumps(keys, indent=2) + '\n'
        if not keys_target.exists() or keys_target.read_text() != keys_text:
            keys_target.write_text(keys_text)
    STATE.write_text(json.dumps({n: digest(d) for n, d in files.items()}, indent=2) + '\n')
    print('Published Studio.', flush=True)

def uninstall():
    """Switch Herdr back to its own layout and remove what dev.py published. Your tasks stay."""
    previous = json.loads(STATE.read_text()) if STATE.exists() else {}
    if not previous:
        print('Nothing to remove: .published.json is missing or empty.', flush=True)
        return
    subprocess.run(['herdr-app', 'do', 'layout.switch', '{"name":"main"}'], timeout=15)
    kept = []
    for name, sha in previous.items():
        if name == 'keybindings.json':
            continue
        target = HOME / name
        if not target.exists():
            continue
        if digest(target.read_bytes()) != sha:
            kept.append(str(target))  # changed inside Herdr since: not ours to delete
            continue
        target.unlink()
    # The key bindings dev.py merged into keys.json, where they still have this repository's value.
    keys_target = HOME / 'keys.json'
    if (ROOT / 'keybindings.json').exists() and keys_target.exists():
        keys = json.loads(keys_target.read_text())
        for section, bindings in json.loads((ROOT / 'keybindings.json').read_text()).items():
            for key, action in bindings.items():
                if keys.get(section, {}).get(key) == action:
                    del keys[section][key]
            if section in keys and not keys[section]:
                del keys[section]
        keys_target.write_text(json.dumps(keys, indent=2) + '\n')
    # Folders left empty (mods/studio-*, studio/); Herdr's generated .d.ts files don't count.
    for folder in sorted({(HOME / n).parent for n in previous}, key=lambda f: len(f.parts), reverse=True):
        if not folder.is_dir() or folder in (HOME, HOME / 'mods', HOME / 'layouts'):
            continue
        leftovers = [f for f in folder.iterdir() if not (f.name.endswith('.d.ts') or f.name == 'jsconfig.json')]
        if not leftovers:
            shutil.rmtree(folder)
    STATE.unlink()
    print('Removed Herdr Studio. Your tasks are still in ~/.config/herdr-app/studio-tasks/.', flush=True)
    for path in kept:
        print(f'Kept (changed inside Herdr since publishing): {path}', flush=True)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--once', action='store_true', help='Publish and activate, then exit')
parser.add_argument('--uninstall', action='store_true', help="Switch back to Herdr's layout and remove what was published")
args = parser.parse_args()
if not shutil.which('herdr-app'):
    raise SystemExit("herdr-app isn't on your PATH. Install Herdr, open it once, then check with `herdr-app status`.")
if args.uninstall:
    uninstall()
    raise SystemExit(0)
files = sources()
publish(files)
subprocess.run(['herdr-app', 'do', 'layout.switch', '{"name":"studio"}'], check=True, timeout=15)
if not args.once:
    print('Watching workspace edits. Ctrl-C stops syncing; Herdr keeps the layout.', flush=True)
    try:
        while True:
            time.sleep(1)
            try:
                updated = sources()
                if updated == files:
                    continue
                files = updated
                publish(files)
            except (RuntimeError, subprocess.SubprocessError) as error:
                print(f'Not published: {error}. Fix and save again.', flush=True)
    except KeyboardInterrupt:
        pass
