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
CONFIG = 'cockpit/config.json'  # where config.json goes, under HOME

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
    if 'keybindings.json' in files:
        keys_text = json.dumps(keys, indent=2) + '\n'
        if not keys_target.exists() or keys_target.read_text() != keys_text:
            keys_target.write_text(keys_text)
    # Files no longer in the source stay recorded until prune() removes them.
    STATE.write_text(json.dumps({**previous, **{n: digest(d) for n, d in files.items()}}, indent=2) + '\n')
    print('Published Cockpit.', flush=True)

def remove_empty(folders):
    """Remove folders left empty; Herdr's generated .d.ts and jsconfig.json don't count."""
    for folder in sorted(set(folders), key=lambda f: len(f.parts), reverse=True):
        if not folder.is_dir() or folder in (HOME, HOME / 'mods', HOME / 'layouts'):
            continue
        if all(f.name.endswith('.d.ts') or f.name == 'jsconfig.json' for f in folder.iterdir()):
            shutil.rmtree(folder)

def prune(files):
    """Delete published files that are gone from the source (a removed or renamed mod)."""
    previous = json.loads(STATE.read_text()) if STATE.exists() else {}
    stale = [n for n in previous.keys() - files.keys() if n != 'keybindings.json']
    for name in stale:
        (HOME / name).unlink(missing_ok=True)
    remove_empty((HOME / n).parent for n in stale)
    STATE.write_text(json.dumps({n: digest(d) for n, d in files.items()}, indent=2) + '\n')

def migrate_from_studio():
    """One-time move from the old name, Herdr Studio. Copies (not moves) your data, so the old
    folders stay as a backup, and drops the old layout's key bindings. Safe to run again."""
    for old, new in (('studio-tasks', 'cockpit-tasks'), ('studio-automations', 'cockpit-automations')):
        if (HOME / old).is_dir() and not (HOME / new).exists():
            shutil.copytree(HOME / old, HOME / new)
            print(f'Copied ~/.config/herdr-app/{old}/ to {new}/', flush=True)
    keys_target = HOME / 'keys.json'
    if keys_target.exists():
        keys = json.loads(keys_target.read_text())
        old = [section for section in ('layout:studio', 'mod:studio-leader') if section in keys]
        for section in old:
            del keys[section]
        if old:
            keys_target.write_text(json.dumps(keys, indent=2) + '\n')

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
    remove_empty((HOME / n).parent for n in previous)
    STATE.unlink()
    print('Removed Herdr Cockpit. Your tasks are still in ~/.config/herdr-app/cockpit-tasks/.', flush=True)
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
migrate_from_studio()
files = sources()
publish(files)
# Switch first, then remove stale files, so the layout on screen never loses its files.
subprocess.run(['herdr-app', 'do', 'layout.switch', '{"name":"cockpit"}'], check=True, timeout=15)
prune(files)
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
                prune(files)
            except (RuntimeError, subprocess.SubprocessError) as error:
                print(f'Not published: {error}. Fix and save again.', flush=True)
    except KeyboardInterrupt:
        pass
