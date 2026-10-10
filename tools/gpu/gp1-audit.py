"""Record GP1 protected runtime preservation and scoped workspace inventory."""
import runpy,os,json,subprocess,importlib.metadata,hashlib
from pathlib import Path
from datetime import datetime,timezone
h=runpy.run_path('/workspace/GP0/remote-prepare.py');root=Path('/workspace/gp1')
base=dict(os.environ);base.pop('PYTHONPATH',None)
freeze=h['command'](['/opt/venv/bin/python','-m','pip','freeze'],base)
(root/'freeze-after.txt').write_text(freeze)
assert freeze==(root/'freeze-before.txt').read_text(),'Protected pip freeze changed'
versions=h['versions'](dict(base,PYTHONPATH='/workspace/pydeps'))
old=json.loads((root/'versions-before.json').read_text());assert all(versions[k]==v for k,v in old.items()),'Protected versions changed'
assert all(str(path).startswith('/opt/venv/') for path in versions['paths'].values()),'Protected packages shadowed'
assert not {'torch','torchvision','torchaudio','numpy','PIL'}.intersection(p.name for p in Path('/workspace/pydeps').iterdir()),'Protected overlay package detected'
packages=[]
for d in importlib.metadata.distributions(path=['/workspace/pydeps']):
 packages.append(dict(name=d.metadata['Name'],version=d.version,license=d.metadata.get('License'),license_expression=d.metadata.get('License-Expression'),classifiers=d.metadata.get_all('Classifier')))
inventory={}
for directory in Path('/workspace').iterdir():
 files=[directory] if directory.is_file() else [p for p in directory.rglob('*') if p.is_file()]
 inventory[str(directory)]={'files':len(files),'bytes':sum(p.stat().st_size for p in files)}
record=dict(at=datetime.now(timezone.utc).isoformat(),state='SSH reachable; left running',versions=versions,packages=packages,freeze_identical=True,freeze_sha256=hashlib.sha256(freeze.encode()).hexdigest(),inventory=inventory,df=h['command'](['df','-h','/workspace']),runtime='Python '+__import__('sys').version,stop_or_destroy_performed=False)
(root/'audit.json').write_text(json.dumps(record,indent=2));print(json.dumps(record,indent=2))
