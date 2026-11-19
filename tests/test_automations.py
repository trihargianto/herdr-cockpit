import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cron', Path(__file__).resolve().parents[1] / 'mods/cockpit-automations/cron.py')
cron = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cron)


class AutomationsTest(unittest.TestCase):
    def update(self, text, action, **args):
        return cron.modify(text, dict(action=action, revision=cron.revision(text), **args))

    def test_lifecycle_preserves_unrelated_lines(self):
        original = 'PATH=/usr/bin:/bin\n# Existing job\n0 1 * * * /usr/bin/true\n'
        added = self.update(original, 'save', id=None, name='Backup', schedule='0 9 * * *', command='/bin/echo backup')
        self.assertTrue(added.startswith(original))
        job = cron.entries(added)[-1]
        self.assertFalse(job['enabled'])
        enabled = self.update(added, 'toggle', id=job['id'])
        self.assertTrue(cron.entries(enabled)[-1]['enabled'])
        edited = self.update(enabled, 'save', id=job['id'], name='New name', schedule='@daily', command='/bin/echo done')
        self.assertEqual(cron.entries(edited)[-1]['name'], 'New name')
        self.assertTrue(cron.entries(edited)[-1]['enabled'])
        disabled = self.update(edited, 'toggle', id=job['id'])
        self.assertFalse(cron.entries(disabled)[-1]['enabled'])
        self.assertEqual(self.update(disabled, 'delete', id=job['id']), original)

    def test_meta_block_and_wrapped_command(self):
        original = 'MAILTO=""\n'
        command = "echo 'it''s' \\% done | tr a b"
        added = self.update(original, 'save', id=None, name='Report', description='Weekly numbers',
                            schedule='0 9 * * 1', command=command)
        job = cron.entries(added)[-1]
        self.assertEqual(job['command'], command)
        self.assertEqual(job['description'], 'Weekly numbers')
        self.assertRegex(job['key'], r'^[0-9a-f]{12}$')
        self.assertIn(str(cron.RUNNER), added.splitlines()[-1])
        # The name still sits right above the command, where the tab bar's feed looks for it.
        self.assertTrue(added.splitlines()[-2].startswith(cron.NAME))
        toggled = self.update(added, 'toggle', id=job['id'])
        self.assertEqual(cron.entries(toggled)[-1]['description'], 'Weekly numbers')
        edited = self.update(toggled, 'save', id=job['id'], name='Report', description='',
                             schedule='@daily', command='true')
        again = cron.entries(edited)[-1]
        self.assertEqual((again['key'], again['description'], again['command'], again['enabled']),
                         (job['key'], '', 'true', True))
        self.assertEqual(self.update(edited, 'delete', id=again['id']), original)

    def test_old_named_job_gains_a_key_on_save(self):
        text = '# herdr-cockpit-name: "Old"\n0 1 * * * /usr/bin/true\n'
        job = cron.entries(text)[0]
        self.assertEqual((job['name'], job['key'], job['description']), ('Old', None, ''))
        saved = self.update(text, 'save', id=job['id'], name='Old', schedule='0 1 * * *', command='/usr/bin/true')
        self.assertEqual(len(saved.splitlines()), 3)
        self.assertIsNotNone(cron.entries(saved)[0]['key'])

    def test_description_must_be_single_line(self):
        with self.assertRaises(ValueError):
            cron.validate('@daily', 'true', 'Job', 'a\nb')

    def test_existing_job_toggle_restores_it(self):
        text = '# keep\n*/5 * * * * echo hello\n'
        disabled = self.update(text, 'toggle', id='1')
        self.assertFalse(cron.entries(disabled)[0]['enabled'])
        self.assertEqual(self.update(disabled, 'toggle', id='1'), text)

    def test_stale_update_rejected(self):
        with self.assertRaisesRegex(ValueError, 'changed elsewhere'):
            cron.modify('0 1 * * * true\n', {'action': 'delete', 'id': '0', 'revision': cron.revision('')})

    def test_schedule_validation(self):
        for schedule in ['*/15 9-17 * * 1-5', '@reboot', '0 0 1,15 * *']:
            cron.validate(schedule, '/bin/true', 'Job')
        for schedule in ['0\n9 * * *', '60 * * * *', '* * * *', '* * * * *\n@daily', '*/0 * * * *', '5-2 * * * *']:
            with self.assertRaises(ValueError):
                cron.validate(schedule, '/bin/true', 'Job')
        with self.assertRaises(ValueError):
            cron.validate('@daily', 'true\nfalse', 'Job')

    def test_read_error_is_not_empty_crontab(self):
        import subprocess
        with patch.object(cron.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'permission denied')):
            with self.assertRaises(ValueError): cron.read_crontab()


if __name__ == '__main__':
    unittest.main()
