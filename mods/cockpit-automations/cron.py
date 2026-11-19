"""Local crontab adapter. Commands are stored, never executed by this adapter."""
import hashlib
import secrets
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

NAME = '# herdr-cockpit-name: '
# Above the name line: {"key": …, "description": …}. The key names the job's log and last run and stays
# the same across edits (line numbers don't).
META = '# herdr-cockpit-meta: '
DISABLED = '# herdr-cockpit-disabled: '
HOME = Path.home() / '.config/herdr-app/cockpit-automations'
# Cron runs saved jobs through this script, so each run lands in logs/<key>.log and runs/<key>.json.
# It lives in the data folder, not the mod: uninstalling or renaming the mod must not break crontab.
RUNNER = HOME / 'run.sh'
RUNNER_SOURCE = r'''#!/bin/sh
# Herdr Cockpit automation runner: run.sh <key> <command>. Written by cockpit-automations/cron.py.
key="$1"; command="$2"
here=$(dirname "$0")
mkdir -p "$here/logs" "$here/runs"
log="$here/logs/$key.log"; run="$here/runs/$key.json"
started=$(date +%s)
printf '{"started": %s, "pid": %s}\n' "$started" "$$" > "$run"
printf '\n=== %s ===\n' "$(date '+%Y-%m-%d %H:%M:%S %z')" >> "$log"
/bin/sh -c "$command" >> "$log" 2>&1
code=$?
printf '=== exit %s ===\n' "$code" >> "$log"
printf '{"started": %s, "ended": %s, "code": %s}\n' "$started" "$(date +%s)" "$code" > "$run"
# Keep the last 5000 lines.
if [ "$(wc -l < "$log")" -gt 5000 ]; then tail -n 5000 "$log" > "$log.tmp" && mv "$log.tmp" "$log"; fi
exit "$code"
'''
ALIASES = {'@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly'}


def read_crontab():
    result = subprocess.run(['crontab', '-l'], capture_output=True, text=True, timeout=10)
    if result.returncode and 'no crontab for' not in result.stderr.lower():
        raise ValueError(result.stderr.strip() or 'Cannot read crontab')
    return result.stdout if result.returncode == 0 else ''


def revision(text):
    return hashlib.sha256(text.encode()).hexdigest()


def wrap(key, command):
    return f'/bin/sh {shlex.quote(str(RUNNER))} {key} {shlex.quote(command)}'


def unwrap(command):
    """(key, the person's command) for a line this file wrapped, else (None, command)."""
    prefix = f'/bin/sh {shlex.quote(str(RUNNER))} '
    if not command.startswith(prefix):
        return None, command
    try:
        parts = shlex.split(command[len(prefix):])
    except ValueError:
        return None, command
    if len(parts) != 2 or not re.fullmatch(r'[0-9a-f]{8,32}', parts[0]):
        return None, command
    return parts[0], parts[1]


def meta(lines, index):
    """The meta line's data for the job whose name sits at lines[index - 1]."""
    if index < 2 or not lines[index - 2].startswith(META):
        return None
    try:
        data = json.loads(lines[index - 2][len(META):])
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def entries(text):
    jobs = []
    lines = text.splitlines(keepends=True)
    for index, original in enumerate(lines):
        line = original.strip()
        enabled = not line.startswith(DISABLED)
        if not enabled:
            line = line[len(DISABLED):]
        if not line or line.startswith('#') or re.match(r'^\w+\s*=', line):
            continue
        parts = line.split(None, 1 if line.startswith('@') else 5)
        if len(parts) != (2 if line.startswith('@') else 6):
            continue
        schedule, command = ' '.join(parts[:-1]), parts[-1]
        named = index > 0 and lines[index - 1].startswith(NAME)
        name = json.loads(lines[index - 1][len(NAME):]) if named else command
        data = meta(lines, index) if named else None
        key, command = unwrap(command)
        jobs.append(dict(id=str(index), name=name, schedule=schedule, command=command,
                         enabled=enabled, named=named, has_meta=data is not None,
                         description=str((data or {}).get('description') or ''), key=key))
    return jobs


def alive(pid):
    if not isinstance(pid, int):
        return True  # a runner from before pids were kept: can't tell, assume running
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    return True


def status(job):
    """Adds the last run and the log path, for jobs the runner tracks."""
    job['last_run'] = None
    job['log'] = None
    if job['key']:
        log = HOME / 'logs' / f"{job['key']}.log"
        job['log'] = str(log) if log.exists() else None
        try:
            job['last_run'] = json.loads((HOME / 'runs' / f"{job['key']}.json").read_text())
        except (OSError, ValueError):
            pass
        run = job['last_run']
        # Started but never ended: still running only while its process is alive.
        if isinstance(run, dict) and 'ended' not in run:
            run['interrupted'] = not alive(run.get('pid'))
    return job


def validate(schedule, command, name, description=''):
    if any(c in schedule for c in "\r\n\0"):
        raise ValueError("Enter a single-line schedule.")
    if not command.strip() or any(c in command for c in '\r\n\0'):
        raise ValueError('Enter a single-line command.')
    if not name.strip() or any(c in name for c in '\r\n\0'):
        raise ValueError('Enter a single-line name.')
    if any(c in description for c in '\r\n\0'):
        raise ValueError('Enter a single-line description.')
    if schedule in ALIASES:
        return
    fields = schedule.split()
    if len(fields) != 5:
        raise ValueError('Use five cron fields: minute hour day month weekday.')
    for field, (low, high) in zip(fields, [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]):
        for term in field.split(','):
            match = re.fullmatch(r'(\*|\d+(?:-\d+)?)(?:/(\d+))?', term)
            if not match or (match[2] is not None and int(match[2]) < 1):
                raise ValueError('Use numeric cron fields with *, ranges, lists, or positive steps.')
            if match[1] != '*':
                values = [int(n) for n in match[1].split('-')]
                if any(n < low or n > high for n in values) or values != sorted(values):
                    raise ValueError(f'Cron field must be between {low} and {high}.')


def modify(text, request):
    if request.get('revision') != revision(text):
        raise ValueError('Crontab changed elsewhere. Refresh and try again.')
    lines = text.splitlines(keepends=True)
    action = request['action']
    job = next((j for j in entries(text) if j['id'] == request.get('id')), None)
    if request.get('id') is not None and job is None:
        raise ValueError('Job no longer exists. Refresh and try again.')
    if action == 'save':
        name, schedule, command = (request[k].strip() for k in ('name', 'schedule', 'command'))
        description = str(request.get('description') or '').strip()
        validate(schedule, command, name, description)
        enabled = job['enabled'] if job else False
        key = (job and job['key']) or request.get('key') or secrets.token_hex(6)
        replacement = [META + json.dumps(dict(key=key, description=description), ensure_ascii=False) + '\n',
                       NAME + json.dumps(name, ensure_ascii=False) + '\n',
                       ('' if enabled else DISABLED) + schedule + ' ' + wrap(key, command) + '\n']
    elif action == 'toggle' and job:
        line = lines[int(job['id'])]
        replacement = [(DISABLED + line) if job['enabled'] else line.lstrip()[len(DISABLED):]]
    elif action == 'delete' and job:
        replacement = []
    else:
        raise ValueError('Unknown action')
    if job:
        end = int(job['id'])
        block = 1 + job['named'] + job['has_meta']
        start = end - block + 1 if action != 'toggle' else end
        lines[start:end + 1] = replacement
    else:
        if lines and not lines[-1].endswith('\n'):
            lines[-1] += '\n'
        lines.extend(replacement)
    return ''.join(lines)


def main():
    request = json.loads(sys.argv[1])
    text = read_crontab()
    if request['action'] != 'list':
        updated = modify(text, request)
        # Keep a recovery copy before installing; never remove unrelated entries.
        HOME.mkdir(parents=True, exist_ok=True)
        (HOME / 'crontab.backup').write_text(text)
        RUNNER.write_text(RUNNER_SOURCE)
        # A second read catches edits made while the update was being prepared.
        if read_crontab() != text:
            raise ValueError('Crontab changed elsewhere. Refresh and try again.')
        with tempfile.NamedTemporaryFile(mode='w', suffix='.cron') as file:
            file.write(updated)
            file.flush()
            result = subprocess.run(['crontab', file.name], capture_output=True, text=True, timeout=10)
        if result.returncode:
            raise ValueError(result.stderr.strip() or 'Cannot update crontab')
        text = read_crontab()
    elif RUNNER.exists() and RUNNER.read_text() != RUNNER_SOURCE:
        RUNNER.write_text(RUNNER_SOURCE)  # a newer runner reaches jobs saved before
    jobs = [status(job) for job in entries(text)]
    # revision guards writes; state also changes when a job runs, so the panel redraws for that.
    print(json.dumps(dict(jobs=jobs, revision=revision(text),
                          state=revision(json.dumps(jobs, sort_keys=True)))))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
