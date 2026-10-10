"""Dependency-free GP1 validation and one shared Pillow parallax proxy.

Uses the existing Pillow, standard-library float arrays, and a four-pixel mesh.
This is a comparison proxy, not the app renderer. No inference runs here.
"""
import array
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFont


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def raw_depth(path, size):
    values = array.array('f')
    values.frombytes(path.read_bytes())
    if sys.byteorder != 'little':
        values.byteswap()
    assert len(values) == size[0] * size[1], path
    assert all(math.isfinite(x) and 0 <= x <= 1 for x in values), path
    return Image.frombytes('F', size, path.read_bytes(), 'raw', 'F;32F')


def move(image, x, y):
    result = Image.new(image.mode, image.size, 0)
    result.paste(image, (x, y))
    return result


def disc_hole(masks):
    union = Image.new('L', masks[0].size)
    for mask in masks:
        union = ImageChops.lighter(union, mask.point([0] * 128 + [255] * 128))
    radius = math.ceil(max(union.size) / 100)
    cache = {}
    result = Image.new('L', union.size)
    for dy in range(-radius, radius + 1):
        dx = math.isqrt(radius * radius - dy * dy)
        if dx not in cache:
            horizontal = Image.new('L', (union.width + 2*dx, union.height))
            horizontal.paste(union, (dx, 0))
            length = 1
            while length < 2 * dx + 1:
                step = min(length, 2 * dx + 1 - length)
                horizontal = ImageChops.lighter(horizontal, move(horizontal, step, 0))
                length += step
            cache[dx] = horizontal.crop((2*dx, 0, union.width + 2*dx, union.height))
        result = ImageChops.lighter(result, move(cache[dx], 0, dy))
    return result


def validate(root, depth_size, candidates_only=False):
    photos = json.loads((root / 'prompts.json').read_text())['photos']
    assert len(photos) == 11
    groups = []
    baseline_times = []
    for photo in photos:
        size = photo['width'], photo['height']
        assert all(x % 2 == 0 and 2 <= x <= 2048 for x in size)
        master = Image.open(root / 'masters' / (photo['id'] + '.png')).convert('RGB')
        assert master.size == size
        assert hashlib.sha256(master.tobytes()).hexdigest() == photo['master_rgb_sha256']
        names = ['depth-small-fp32', 'moge2', 'sam21-large', 'lama']
        if not candidates_only:
            names += ['baseline']
        if (root / 'candidates/lama-baseline-hole' / photo['id']).exists():
            names += ['lama-baseline-hole']
        for name in names:
            group = root / ('baseline' if name == 'baseline' else 'candidates/' + name) / photo['id']
            meta = json.loads((group / 'metadata.json').read_text())
            if name == 'baseline':
                assert (group / 'master.rgb').read_bytes() == master.tobytes(), 'Browser master pixels differ: ' + photo['id']
                assert meta['size'] == {'width': size[0], 'height': size[1]}
                assert meta['depthSize'] == dict(zip(['width', 'height'], depth_size(*size)))
                assert meta['promptMode'] == 'point-only'
                baseline_times.append({'photo': photo['id'], 'total_ms': meta['totalMs'], 'worker': meta['workerTimings']})
            else:
                assert meta['device'] == 'cuda:0' and 'Radeon' in meta['device_name'] and meta['hip']
                assert meta['master_rgb_sha256'] == photo['master_rgb_sha256']
            if name in {'baseline', 'depth-small-fp32', 'moge2'}:
                depth = raw_depth(group / 'depth.f32', depth_size(*size))
                assert Image.open(group / 'depth.png').size == depth.size
            if name in {'baseline', 'sam21-large'}:
                masks = []
                for i in range(len(photo['subjects'])):
                    data = (group / f'mask-{i}.u8').read_bytes()
                    assert len(data) == size[0] * size[1]
                    mask = Image.frombytes('L', size, data)
                    preview = Image.open(group / f'mask-{i}.png')
                    assert preview.size == size and preview.convert('L').tobytes() == data
                    masks.append(mask)
                assert disc_hole(masks).tobytes() == (group / 'hole.u8').read_bytes(), 'Disc hole differs: ' + str(group)
            if name in {'baseline', 'lama', 'lama-baseline-hole', 'sam21-large'}:
                hole = (group / 'hole.u8').read_bytes()
                assert len(hole) == size[0] * size[1]
                preview = Image.open(group / 'hole.png')
                assert preview.size == size and preview.convert('L').tobytes() == hole
            if name in {'baseline', 'lama', 'lama-baseline-hole'}:
                plate = (group / 'plate.rgb').read_bytes()
                assert len(plate) == size[0] * size[1] * 3
                preview = Image.open(group / 'plate.png')
                assert preview.size == size and preview.convert('RGB').tobytes() == plate
            if name == 'lama-baseline-hole':
                assert hole == (root / 'baseline' / photo['id'] / 'hole.u8').read_bytes()
                assert meta['plate_comparison'] == 'Same baseline hole'
                diff = ImageChops.difference(Image.frombytes('RGB', size, plate), master)
                outside = ImageChops.invert(Image.frombytes('L', size, hole))
                assert Image.composite(diff, Image.new('RGB', size), outside).getbbox() is None
            groups.append(str(group.relative_to(root)))
    report = {'status': 'PASS', 'group_count': len(groups), 'checked': groups,
              'baseline': 'LEAD' if candidates_only else 'PASS', 'baseline_timings': baseline_times,
              'checks': 'Required raw/PNG files, dimensions, finite 0..1 depth, preview equality, exact disc hole, master pixel identity, Radeon proof, same-hole LaMa and preserved outside pixels'}
    (root / 'validation.json').write_text(json.dumps(report, indent=2) + '\n')
    print('Validated complete product groups:', len(groups), 'baseline', report['baseline'], flush=True)


def load(root, photo, name, depth_size):
    size = photo['width'], photo['height']
    baseline = root / 'baseline' / photo['id']
    masks = root / 'candidates/sam21-large' / photo['id'] if name in {'sam21-large', 'combined-moge2'} else baseline
    depth = root / 'candidates' / (name if name in {'moge2', 'depth-small-fp32'} else 'moge2') / photo['id'] if name in {'moge2', 'depth-small-fp32', 'combined-moge2'} else baseline
    plate = root / 'candidates' / ('lama' if name in {'sam21-large', 'combined-moge2'} else 'lama-baseline-hole') / photo['id'] if name in {'lama', 'sam21-large', 'combined-moge2'} else baseline
    return {'master': Image.open(root / 'masters' / (photo['id'] + '.png')).convert('RGB'),
            'depth': raw_depth(depth / 'depth.f32', depth_size(*size)),
            'masks': [Image.frombytes('L', size, (masks / f'mask-{i}.u8').read_bytes()) for i in range(len(photo['subjects']))],
            'plate': Image.frombytes('RGB', size, (plate / 'plate.rgb').read_bytes())}


def colors(depth):
    gray = depth.point(lambda x: x * 255).convert('L')
    channels = [[], [], []]
    for value in range(256):
        x = value / 255
        for channel, v in zip(channels, [3*x-1, 1.5-abs(3*x-1.5), 2-3*x]):
            channel.append(int(255 * max(0, min(1, v))))
    return Image.merge('RGB', tuple(gray.point(table) for table in channels))


def overlay(products):
    result = products['master'].copy()
    for i, mask in enumerate(products['masks']):
        color = [(255, 70, 100), (70, 220, 255), (245, 200, 60)][i % 3]
        result = Image.composite(Image.new('RGB', result.size, color), result, mask.point(lambda x: round(x * .45)))
    return result


def prepare(products, width=400):
    size = width, round(products['master'].height * width / products['master'].width)
    result = {k: products[k].resize(size, Image.Resampling.BILINEAR) for k in ['master', 'plate', 'depth']}
    result['masks'] = [m.resize(size, Image.Resampling.BILINEAR) for m in products['masks']]
    depths = list(result['depth'].getdata())
    layers = []
    for mask in result['masks']:
        values = [z for z, m in zip(depths, mask.tobytes()) if m >= 128]
        layers.append((statistics.median(values) if values else .5, mask))
    result['layers'] = sorted(layers, key=lambda x: x[0])
    return result


def proxy(products, phase):
    width, height = products['master'].size
    camera = -math.cos(phase * math.tau) * width * .02
    depth = products['depth']
    # The same four-pixel depth mesh warps the plate in both pipelines.
    # Border reflection via a small padded plate avoids black edge artifacts.
    padding = 12
    plate = Image.new('RGB', (width + padding*2, height))
    plate.paste(products['plate'], (padding, 0))
    plate.paste(products['plate'].crop((0, 0, padding, height)).transpose(Image.Transpose.FLIP_LEFT_RIGHT), (0, 0))
    plate.paste(products['plate'].crop((width-padding, 0, width, height)).transpose(Image.Transpose.FLIP_LEFT_RIGHT), (width+padding, 0))
    mesh = []
    def sx(x, y):
        return x + padding - (depth.getpixel((min(x, width-1), min(y, height-1))) - .5) * camera
    for y in range(0, height, 4):
        for x in range(0, width, 4):
            x1, y1 = min(x+4, width), min(y+4, height)
            mesh.append(((x, y, x1, y1), (sx(x,y),y,sx(x,y1),y1,sx(x1,y1),y1,sx(x1,y),y)))
    frame = plate.transform((width, height), Image.Transform.MESH, mesh, Image.Resampling.BILINEAR)
    for z, mask in products['layers']:
        offset = (z - .5) * camera
        coefficients = (1, 0, -offset, 0, 1, 0)
        alpha = mask.transform((width,height), Image.Transform.AFFINE, coefficients, Image.Resampling.BILINEAR)
        color = products['master'].transform((width,height), Image.Transform.AFFINE, coefficients, Image.Resampling.BILINEAR)
        frame = Image.composite(color, frame, alpha)
    return frame


def render(root, depth_size):
    photos = json.loads((root / 'prompts.json').read_text())['photos']
    out = root / 'comparisons'
    out.mkdir(exist_ok=True)
    sheets = []
    for photo in photos:
        products = {name: load(root, photo, name, depth_size) for name in [None, 'depth-small-fp32', 'moge2', 'sam21-large', 'lama', 'combined-moge2']}
        baseline = products[None]
        meta = json.loads((root / 'candidates/lama-baseline-hole' / photo['id'] / 'metadata.json').read_text())
        assert meta['plate_comparison'] == 'Same baseline hole'
        rows = [('MASTER - same RGB pixels', baseline['master'], baseline['master']),
                ('DEPTH: browser / DA2 Small FP32', colors(baseline['depth']), colors(products['depth-small-fp32']['depth'])),
                ('DEPTH: browser / MoGe-2 ViT-L', colors(baseline['depth']), colors(products['moge2']['depth'])),
                ('MASKS: browser / SAM2.1 Large POINT ONLY', overlay(baseline), overlay(products['sam21-large'])),
                ('PLATE: browser MI-GAN / LaMa SAME BASELINE HOLE', baseline['plate'], products['lama']['plate'])]
        sheet = Image.new('RGB', (1000, 1950), (24,24,28))
        draw = ImageDraw.Draw(sheet)
        for i, (label, left, right) in enumerate(rows):
            draw.text((15,i*390+8), photo['id'] + ' - ' + label, fill='white', font=ImageFont.load_default(size=15))
            for j, panel in enumerate([left, right]):
                panel = panel.copy()
                panel.thumbnail((490,350))
                sheet.paste(panel, (j*500+(500-panel.width)//2, i*390+32+(350-panel.height)//2))
        path = out / (photo['id'] + '.jpg')
        sheet.save(path, quality=94)
        sheets.append(path)
        prepared = {name: prepare(p) for name, p in products.items()}
        baseline_frames = [proxy(prepared[None], f/24) for f in range(24)]
        # SAM stage also needs a compatible plate: use the preserved SAM-hole LaMa.
        for name in ['depth-small-fp32', 'moge2', 'lama', 'sam21-large', 'combined-moge2']:
            frames = []
            for f in range(24):
                left = baseline_frames[f]
                right = proxy(prepared[name], f/24)
                pair = Image.new('RGB', (left.width*2,left.height+30), (24,24,28))
                pair.paste(left,(0,30)); pair.paste(right,(left.width,30))
                d = ImageDraw.Draw(pair)
                label = 'SAM Large + LaMa; same depth' if name == 'sam21-large' else name
                d.text((5,8),'PROXY - browser',fill='white',font=ImageFont.load_default(size=13))
                d.text((left.width+5,8),'PROXY - '+label,fill='white',font=ImageFont.load_default(size=13))
                frames.append(pair)
            frames[0].save(out/(photo['id']+'-'+name+'.webp'),save_all=True,append_images=frames[1:],duration=166,loop=0,quality=82,method=2)
            # Extract motion extremes and neutral view for visual review without Chrome.
            if name == 'combined-moge2':
                strip = Image.new('RGB',(frames[0].width,frames[0].height*3))
                for i,f in enumerate([0,6,12]):
                    strip.paste(frames[f],(0,i*frames[0].height))
                strip.save(out/(photo['id']+'-motion.jpg'),quality=94)
        print('Rendered', photo['id'], flush=True)
    for page in range(math.ceil(len(sheets)/6)):
        index = Image.new('RGB',(1500,1950),(24,24,28))
        for i,path in enumerate(sheets[page*6:(page+1)*6]):
            image=Image.open(path);image.thumbnail((500,975));index.paste(image,(i%3*500,i//3*975))
        index.save(out/f'index-{page+1}.jpg',quality=94)
    manifest = {str(p.relative_to(root)):{'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(out.iterdir()) if p.is_file() and p.name!='artifacts.json'}
    (out/'artifacts.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print('Rendered comparison artifacts:',len(manifest),flush=True)
