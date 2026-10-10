"""GP1 redacted platform bootstrap, reusing GP0 environment and preservation helpers."""
import runpy, os, sys, subprocess
from pathlib import Path
helper=runpy.run_path('/workspace/GP0/remote-prepare.py')
root=Path('/workspace/gp1');root.mkdir(exist_ok=True)
os.environ.update(PYTHONPATH='/workspace/pydeps',PYTHONPYCACHEPREFIX=str(root/'pycache'),PIP_CACHE_DIR=str(root/'pip-cache'),TMPDIR=str(root/'tmp'))
(root/'tmp').mkdir(exist_ok=True)
if sys.argv[1]=='install':
    package=sys.argv[2]
    assert package.split('=')[0].lower() not in {'torch','torchvision','torchaudio','numpy','pillow'}
    command=['/opt/venv/bin/python','-m','pip','install','--no-deps','--target','/workspace/pydeps',package]
else: command=sys.argv[2:]
r=subprocess.run(command,env=os.environ,capture_output=True,text=True)
print(helper['safe'](r.stdout+r.stderr),end='',flush=True)
raise SystemExit(r.returncode)
