"""Reconstruct exact GP1 masters from hash-verified JPEG inputs if SSH PNG upload is slow."""
import base64,hashlib,json,tarfile
from pathlib import Path
from PIL import Image,ImageOps
root=Path('/workspace/gp1')
with tarfile.open(root/'photo-inputs.tar.gz') as t:t.extractall(root,filter='data')
(root/'masters').mkdir(exist_ok=True)
records=[]
manifest=json.loads((root/'remote-photo-manifest.json').read_text())
for row in manifest:
 path=root/'photos'/f"{row['id']}.jpg"
 assert hashlib.file_digest(path.open('rb'),'sha256').hexdigest()==row['sha256'],'JPEG hash differs'
 image=ImageOps.exif_transpose(Image.open(path)).convert('RGB').resize((row['width'],row['height']),Image.Resampling.LANCZOS)
 assert hashlib.sha256(image.tobytes()).hexdigest()==row['master_rgb_sha256'],'Master pixels differ across Pillow versions'
 target=root/'masters'/f"{row['id']}.png";image.save(target,icc_profile=base64.b64decode(row['icc_base64']))
 actual=hashlib.file_digest(target.open('rb'),'sha256').hexdigest()
 print(row['id'],'PNG encoding differs' if actual!=row['master_sha256'] else 'PNG bytes identical',actual)
 print(row['id'],'exact RGB pixel hash PASS')

 records.append(dict(id=row['id'],width=row['width'],height=row['height'],pixel_sha256=row['master_rgb_sha256'],local_png_sha256=row['master_sha256'],remote_png_sha256=actual))
prompts=json.loads((root/'prompts.json').read_text())
for row in prompts['photos']:
 expected=next(item for item in manifest if item['id']==row['id'])
 row['master_rgb_sha256']=expected['master_rgb_sha256']
(root/'prompts.json').write_text(json.dumps(prompts,indent=2)+'\n')
(root/'master-identity.json').write_text(json.dumps(records,indent=2)+'\n')
