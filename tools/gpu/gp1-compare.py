#!/usr/bin/env python3
"""GP1 shared-product GPU batches, validation and still/parallax proxy comparisons.

Weights/install preparation is explicit and external. No CPU inference fallback.
Raw contract files: depth.f32 LE normalized inverse depth at depthInputSize;
mask-N.u8 soft bytes and hole.u8 at master size; plate.rgb interleaved RGB.
Run --batch on Radeon; --validate or --render with the existing Pillow.
"""
import time
ENTRY = time.perf_counter()
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def depth_size(width, height):
    scale = 518 / min(width, height)
    # JS Math.round rounds half upward, unlike Python's round.
    w = max(14, math.floor(width * scale / 14 + .5) * 14)
    h = max(14, math.floor(height * scale / 14 + .5) * 14)
    patches = w * h / 196
    if patches > 1813:
        shrink = math.sqrt(1813 / patches)
        w, h = max(14, math.floor(w * shrink / 14) * 14), max(14, math.floor(h * shrink / 14) * 14)
    return w, h


def normalize(depth):
    import numpy as np
    depth = np.asarray(depth, dtype='<f4')
    if not np.isfinite(depth).all():
        raise ValueError('Nonfinite inverse depth')
    low, high = float(depth.min()), float(depth.max())
    return ((depth - low) / (high - low)).astype('<f4') if high > low else np.zeros_like(depth)


def hole_mask(masks):
    import numpy as np
    import cv2
    union = np.logical_or.reduce([m >= 128 for m in masks]).astype(np.uint8) * 255
    radius = math.ceil(max(union.shape) / 100)
    y, x = np.ogrid[-radius:radius+1, -radius:radius+1]
    kernel = (x*x + y*y <= radius*radius).astype(np.uint8)
    return cv2.dilate(union, kernel, borderType=cv2.BORDER_CONSTANT, borderValue=0)


def save_plane(out, name, data, kind):
    import numpy as np
    from PIL import Image
    out.mkdir(parents=True, exist_ok=True)
    array = np.asarray(data, dtype='<f4' if kind == 'depth' else np.uint8)
    array.tofile(out / (name + ('.f32' if kind == 'depth' else '.rgb' if kind == 'rgb' else '.u8')))
    preview = np.rint(np.clip(array, 0, 1) * 255).astype(np.uint8) if kind == 'depth' else array
    Image.fromarray(preview).save(out / (name + '.png'))


def gpu_check():
    import torch
    gp0 = module('gp0', Path(__file__).with_name('gp0-smoke.py'))
    gp0.require(bool(torch.version.hip) and torch.cuda.is_available(), 'ROCm required; no CPU fallback')
    gp0.require(torch.cuda.device_count() == 1, 'Expected exactly one GPU')
    torch.cuda.set_device(0)
    with torch.inference_mode():
        matrix = torch.tensor([[1.,2.],[3.,4.]], device='cuda:0')
        output = matrix @ matrix
        torch.cuda.synchronize()
        gp0.require(str(output.device) == 'cuda:0' and output.cpu().tolist() == [[7.,10.],[15.,22.]], 'GP0 matrix check failed')
    torch.manual_seed(0)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    return gp0


def load_candidate(name, root):
    import torch
    gp0 = gpu_check()
    if name == 'depth-small-fp32':
        old = Path('/workspace/GP0')
        model_class = gp0.load_code(old)
        weight = old / gp0.WEIGHT_NAME
        gp0.require(digest(weight) == gp0.WEIGHT_SHA256, 'GP0 checkpoint pin mismatch')
        model = model_class(encoder='vits', features=64, out_channels=[48,96,192,384])
        model.load_state_dict(torch.load(weight, map_location='cpu', weights_only=True), strict=True)
        model = model.to(device='cuda:0', dtype=torch.float32).eval()
        metadata = dict(source=gp0.WEIGHT_URL, revision=gp0.WEIGHT_REVISION, code_revision=gp0.CODE_COMMIT,
                        license='Apache-2.0', weight_bytes=weight.stat().st_size, weight_sha256=digest(weight),
                        precision='FP32', preprocessing='RGB OpenCV cubic direct resize to depthInputSize; ImageNet mean/std; NCHW. Browser canvas resampler may differ.',
                        postprocessing='Model relative inverse depth, per-image min-max normalization 0..1')
        return model, metadata
    if name == 'moge2':
        helper = module('moge_adapter', Path(__file__).with_name('gp1-moge.py'))
        return helper.load(root / 'moge'), helper.metadata(root / 'moge')
    if name == 'sam21-large':
        import numpy as np
        code = root / 'sam'
        source = json.loads((root / 'source.json').read_text())
        for file, expected in source['files'].items():
            gp0.require(digest(code / file) == expected, 'SAM source pin mismatch: ' + file)
        sys.path.insert(0, str(code))
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        weights = code / 'sam2.1_hiera_large.pt'
        weight_record = json.loads((code / 'weight-source.json').read_text())
        gp0.require(digest(weights) == weight_record['sha256'], 'SAM checkpoint pin mismatch')
        model = build_sam2('configs/sam2.1/sam2.1_hiera_l.yaml', str(weights), device='cuda:0', apply_postprocessing=False)
        model = model.to(dtype=torch.float32).eval()
        gp0.require(all(p.device == torch.device('cuda:0') and p.dtype == torch.float32 for p in model.parameters()), 'SAM must run FP32 on GPU')
        predictor = SAM2ImagePredictor(model, max_hole_area=0, max_sprinkle_area=0)
        metadata = dict(weight_record, code=source, precision='FP32; no autocast/TF32',
                        preprocessing='Official predictor: RGB /255, bilinear stretch 1024x1024; ImageNet mean/std',
                        prompt_policy='Primary single positive point, same as baseline. Supplemental point+box separately saved.',
                        postprocessing='Choose highest IoU multimask; master-size logits -> rounded sigmoid soft bytes; no optional CUDA connected-components extension')
        return predictor, metadata
    if name == 'lama':
        helper = module('lama_adapter', Path(__file__).with_name('gp1-lama.py'))
        return helper.Lama(root / 'lama' / 'lama.pt'), helper.SOURCE
    raise ValueError('Unknown candidate ' + name)


def infer_depth(name, model, rgb, size):
    import torch
    import numpy as np
    import cv2
    w, h = size
    if name == 'depth-small-fp32':
        resized = cv2.resize(rgb, (w,h), interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255
        resized = (resized - np.array([.485,.456,.406],dtype=np.float32)) / np.array([.229,.224,.225],dtype=np.float32)
        tensor = torch.from_numpy(np.ascontiguousarray(resized.transpose(2,0,1)))[None].to('cuda:0')
        with torch.inference_mode():
            output = model(tensor)
            if output.device != torch.device('cuda:0'): raise RuntimeError('Depth is not GPU output')
            torch.cuda.synchronize()
            depth = output[0].cpu().numpy()
    else:
        helper = module('moge_adapter', Path(__file__).with_name('gp1-moge.py'))
        depth = helper.infer(model, rgb)
        depth = cv2.resize(depth, (w,h), interpolation=cv2.INTER_LINEAR)
    return normalize(depth)


def run_model(args):
    import torch
    import numpy as np
    from PIL import Image
    photos = json.loads((args.root / 'prompts.json').read_text())['photos']
    if args.limit: photos = photos[:args.limit]
    candidate, source = load_candidate(args.model, args.root)
    torch.cuda.synchronize()
    load_ms = (time.perf_counter() - args.started) * 1000
    records = []
    for index, photo in enumerate(photos):
        start = time.perf_counter()
        rgb = np.array(Image.open(args.root / 'masters' / (photo['id']+'.png')).convert('RGB'))
        if rgb.shape != (photo['height'],photo['width'],3): raise RuntimeError('Master shape mismatch')
        if hashlib.sha256(rgb.tobytes()).hexdigest() != photo['master_rgb_sha256']: raise RuntimeError('Master pixel SHA mismatch')
        output_name = 'lama-baseline-hole' if args.model == 'lama' and args.baseline_holes else args.model
        out = args.root / 'candidates' / output_name / photo['id']
        out.mkdir(parents=True, exist_ok=True)
        torch.cuda.reset_peak_memory_stats()
        torch.cuda.synchronize()
        infer_start = time.perf_counter()
        extra = {}
        with torch.inference_mode():
            if args.model in {'depth-small-fp32','moge2'}:
                depth = infer_depth(args.model,candidate,rgb,depth_size(photo['width'],photo['height']))
                torch.cuda.synchronize()
                infer_ms = (time.perf_counter()-infer_start)*1000
                save_plane(out,'depth',depth,'depth')
                extra['depthSize'] = dict(zip(['width','height'],depth_size(photo['width'],photo['height'])))
            elif args.model == 'sam21-large':
                candidate.set_image(rgb)
                torch.cuda.synchronize()
                encode_ms=(time.perf_counter()-infer_start)*1000
                primary_decode_ms=0.0;box_decode_ms=0.0
                masks, boxes = [], []
                for prompt in photo['subjects']:
                    point = np.array([prompt['point']],dtype=np.float32)
                    decode_start=time.perf_counter()
                    logits,scores,_=candidate.predict(point_coords=point,point_labels=np.array([1]),multimask_output=True,return_logits=True)
                    torch.cuda.synchronize()
                    primary_decode_ms+=(time.perf_counter()-decode_start)*1000
                    if not np.isfinite(logits).all() or not np.isfinite(scores).all():raise RuntimeError('SAM returned nonfinite values')
                    chosen=int(np.argmax(scores))
                    mask=np.rint(255/(1+np.exp(-np.clip(logits[chosen],-32,32)))).astype(np.uint8)
                    masks.append(mask)
                    box_start=time.perf_counter()
                    box_logits,box_scores,_=candidate.predict(point_coords=point,point_labels=np.array([1]),box=np.array(prompt['box'],dtype=np.float32),multimask_output=True,return_logits=True)
                    torch.cuda.synchronize()
                    box_decode_ms+=(time.perf_counter()-box_start)*1000
                    if not np.isfinite(box_logits).all() or not np.isfinite(box_scores).all():raise RuntimeError('SAM box returned nonfinite values')
                    boxes.append(np.rint(255/(1+np.exp(-np.clip(box_logits[int(np.argmax(box_scores))],-32,32)))).astype(np.uint8))
                torch.cuda.synchronize()
                infer_ms=(time.perf_counter()-infer_start)*1000
                for i,mask in enumerate(masks): save_plane(out,f'mask-{i}',mask,'mask')
                for i,mask in enumerate(boxes): save_plane(out,f'box-mask-{i}',mask,'mask')
                save_plane(out,'hole',hole_mask(masks),'mask')
                extra.update(primary_prompt='single-point',supplemental_prompt='point-plus-box',timing_includes_supplemental_decodes=True,encode_ms=encode_ms,primary_decode_ms=primary_decode_ms,primary_infer_ms=encode_ms+primary_decode_ms,supplemental_box_infer_ms=box_decode_ms)
            else:
                source_root = args.root / ('baseline' if args.baseline_holes else 'candidates/sam21-large') / photo['id']
                hole = np.fromfile(source_root / 'hole.u8',dtype=np.uint8).reshape(rgb.shape[:2])
                plate, measurement = candidate.infer(rgb,hole)
                torch.cuda.synchronize()
                infer_ms=(time.perf_counter()-infer_start)*1000
                save_plane(out,'plate',plate,'rgb')
                save_plane(out,'hole',hole,'mask')
                extra.update(measurement=measurement,hole_source=str(source_root),hole_sha256=digest(source_root/'hole.u8'),
                             plate_comparison='Same baseline hole' if args.baseline_holes else 'SAM Large hole; confounded until Stage 2 rerun')
        torch.cuda.synchronize()
        peak=torch.cuda.max_memory_allocated()
        result_ms=(time.perf_counter()-start)*1000
        record=dict(photo=photo['id'],size={'width':photo['width'],'height':photo['height']},infer_ms=infer_ms,end_to_end_ms=result_ms,
                    process_start_to_first_result_ms=(time.perf_counter()-args.started)*1000 if index==0 else None,
                    peak_allocated_gpu_bytes=peak,device='cuda:0',device_name=torch.cuda.get_device_name(0),torch=str(torch.__version__),hip=torch.version.hip,
                    precision='FP32',master_rgb_sha256=hashlib.sha256(rgb.tobytes()).hexdigest(),master_png_sha256=digest(args.root/'masters'/(photo['id']+'.png')),reference_master_png_sha256=photo['master_sha256'],source=source,**extra)
        write_json(out/'metadata.json',record)
        records.append(record)
        print(json.dumps({k:v for k,v in record.items() if k not in {'source'}}),flush=True)
        write_json(args.root / 'timings' / (output_name+'.json'),dict(model=args.model,status='RUNNING',load_and_process_start_ms=load_ms,records=records))
    timing=dict(model=args.model,status='PASS',source=source,device=torch.cuda.get_device_name(0),load_and_process_start_ms=load_ms,
                cold_process_start_to_first_result_ms=records[0]['process_start_to_first_result_ms'],
                first_infer_ms=records[0]['infer_ms'],warm_median_end_to_end_ms=statistics.median(r['end_to_end_ms'] for r in records[1:]) if len(records)>1 else None,
                warm_median_infer_ms=statistics.median(r['infer_ms'] for r in records[1:]) if len(records)>1 else None,
                peak_allocated_gpu_bytes=max(r['peak_allocated_gpu_bytes'] for r in records),records=records,
                timing_scope='Fresh child process launch to first saved raw+PNG result; subsequent per-photo decode/preprocess/infer/copy/PNG writes. Downloads excluded, metadata writes excluded.')
    write_json(args.root/'timings'/(output_name+'.json'),timing)


def validate(root, candidates_only=False):
    helper = module('gp1_pictures', Path(__file__).with_name('gp1-pictures.py'))
    helper.validate(root, depth_size, candidates_only)


def batch(args):
    args.root.mkdir(parents=True,exist_ok=True)
    models=args.models.split(',')
    failures=[]
    for name in models:
        started=time.perf_counter()
        command=[sys.executable,str(Path(__file__).resolve()),'--root',str(args.root),'--model',name,'--started',str(started)]
        if args.baseline_holes:command.append('--baseline-holes')
        if args.limit:command+=['--limit',str(args.limit)]
        result=subprocess.run(command,capture_output=True,text=True)
        (args.root/'logs').mkdir(exist_ok=True)
        (args.root/'logs'/(name+'.log')).write_text(result.stdout+result.stderr)
        print(name,'exit',result.returncode,flush=True)
        if result.returncode:
            failures.append(name)
            write_json(args.root/'timings'/(name+'-failure.json'),dict(model=name,status='FAILED',exit=result.returncode,error=result.stdout+result.stderr))
    if failures: print('FAILED models:',','.join(failures));return 1
    return 0


def render(root):
    helper = module('gp1_pictures', Path(__file__).with_name('gp1-pictures.py'))
    helper.render(root, depth_size)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,default=Path('/workspace/gp1'));p.add_argument('--batch',action='store_true');p.add_argument('--model',choices=['depth-small-fp32','moge2','sam21-large','lama']);p.add_argument('--models',default='depth-small-fp32,moge2,sam21-large,lama');p.add_argument('--started',type=float,default=ENTRY);p.add_argument('--limit',type=int,default=0);p.add_argument('--baseline-holes',action='store_true');p.add_argument('--validate',action='store_true');p.add_argument('--candidates-only',action='store_true');p.add_argument('--render',action='store_true');args=p.parse_args()
    if args.batch:return batch(args)
    if args.model:run_model(args)
    elif args.validate:validate(args.root,args.candidates_only)
    elif args.render:render(args.root)
    else:p.error('Choose --batch, --model, --validate or --render')
    return 0

if __name__=='__main__':
    raise SystemExit(main())
