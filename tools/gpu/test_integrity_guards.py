"""Run with python3 -O tools/gpu/test_integrity_guards.py; no GPU packages needed.

Execute the actual integrity guard statements in isolation so the remote-only
bootstrap scripts cannot install packages or modify the supplied environment.
Both Python optimization levels must preserve rejection of invalid inputs.
"""
import ast
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).resolve().parent


class IntegrityGuardsTest(unittest.TestCase):
    def check_guard(self, filename, message, valid, invalid, count=1):
        tree = ast.parse((ROOT / filename).read_text())
        guards = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.If) or len(node.body) != 1:
                continue
            statement = node.body[0]
            if not isinstance(statement, ast.Raise) or not isinstance(statement.exc, ast.Call):
                continue
            error = statement.exc
            if not error.args:
                continue
            text = error.args[0]
            prefix = text.left if isinstance(text, ast.BinOp) else text
            if isinstance(prefix, ast.Constant) and prefix.value == message:
                guards.append(node)
        self.assertEqual(len(guards), count, f'{filename}: missing explicit guard: {message}')
        for node in guards:
            for optimization in (0, 2):
                with self.subTest(file=filename, line=node.lineno, optimization=optimization):
                    code = compile(ast.Module(body=[node], type_ignores=[]), filename, 'exec', optimize=optimization)
                    exec(code, dict(valid))
                    with self.assertRaisesRegex(RuntimeError, message):
                        exec(code, dict(invalid))

    def test_prepare_hash_guards(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            valid = dict(ROOT=root, wheel=root/'wheel', partial=root/'partial', weight=root/'weight',
                         code=root/'code', name='source.py', digest=lambda path: 'expected',
                         WHEEL_SHA='expected', MANIFEST_SHA='expected', WEIGHT_SHA='expected', expected='expected')
            invalid = dict(valid, digest=lambda path: 'corrupt')
            for message, count in [('Downloaded wheel SHA-256 mismatch', 1), ('Manifest pin mismatch', 1),
                                   ('Upstream source hash mismatch: ', 1), ('Checkpoint SHA-256 mismatch', 2)]:
                self.check_guard('gp0-remote-prepare.py', message, valid, invalid, count)

    def test_prepare_package_preservation(self):
        self.check_guard('gp0-remote-prepare.py', 'Protected package versions or paths changed',
                         dict(before={'torch': 'same'}, after={'torch': 'same'}),
                         dict(before={'torch': 'same'}, after={'torch': 'changed'}))
        self.check_guard('gp0-remote-prepare.py', 'Supplied /opt/venv pip freeze changed',
                         dict(freeze_before='same', freeze_after='same'),
                         dict(freeze_before='same', freeze_after='changed'))

    def test_package_shadow_guards(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            protected = {'torch', 'torchvision', 'torchaudio', 'numpy', 'PIL'}
            for filename, message in [('gp0-remote-prepare.py', 'Protected package shadow'),
                                      ('gp1-audit.py', 'Protected overlay package detected')]:
                good = root/'good'; good.mkdir(exist_ok=True)
                bad = root/'bad'; bad.mkdir(exist_ok=True)
                (good/'allowed').touch()
                (bad/'torch').touch()
                self.check_guard(filename, message,
                                 dict(protected=protected, Path=lambda _: good),
                                 dict(protected=protected, Path=lambda _: bad))
        self.check_guard('gp1-audit.py', 'Protected packages shadowed',
                         dict(versions={'paths': {'torch': '/opt/venv/lib/torch/__init__.py'}}),
                         dict(versions={'paths': {'torch': '/workspace/pydeps/torch/__init__.py'}}))

    def test_audit_preservation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'freeze-before.txt').write_text('original')
            self.check_guard('gp1-audit.py', 'Protected pip freeze changed',
                             dict(root=root, freeze='original'), dict(root=root, freeze='changed'))
        self.check_guard('gp1-audit.py', 'Protected versions changed',
                         dict(old={'torch': 'original'}, versions={'torch': 'original'}),
                         dict(old={'torch': 'original'}, versions={'torch': 'changed'}))

    def test_install_guard(self):
        for package in ('torch', 'torchvision==1', 'TORCHAUDIO==1', 'numpy', 'Pillow==1'):
            self.check_guard('gp1-remote.py', 'Protected package install is forbidden',
                             dict(package='allowed==1'), dict(package=package))

    def test_master_hash_guards(self):
        pixels = b'master pixels'
        expected = hashlib.sha256(pixels).hexdigest()
        image = SimpleNamespace(tobytes=lambda: pixels)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'input.jpg'
            path.write_bytes(pixels)
            valid = dict(hashlib=hashlib, path=path, image=image,
                         row={'sha256': expected, 'master_rgb_sha256': expected})
            invalid = dict(valid, row={'sha256': 'corrupt', 'master_rgb_sha256': 'corrupt'})
            self.check_guard('gp1-masters.py', 'JPEG hash differs', valid, invalid)
            self.check_guard('gp1-masters.py', 'Master pixels differ across Pillow versions', valid, invalid)
        valid = dict(hashlib=hashlib, master=image, photo={'master_rgb_sha256': expected},
                     meta={'master_rgb_sha256': expected})
        invalid = dict(valid, photo={'master_rgb_sha256': 'corrupt'})
        self.check_guard('gp1-pictures.py', 'Master pixel SHA-256 mismatch', valid, invalid, count=2)


if __name__ == '__main__':
    unittest.main()
