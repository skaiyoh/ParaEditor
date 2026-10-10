#!/usr/bin/env python3
"""GP1 MoGe-2 ViT-L, pinned official v2 code/checkpoint on Radeon only.

The comparison runner imports load(workspace=...) and infer(model, RGB uint8).
All source/checkpoint downloads and optional imports are staged separately; this
module never installs packages and never falls back to CPU model inference.
"""
from pathlib import Path
import hashlib
import json
import sys

CODE_REVISION = '07444410f1e33f402353b99d6ccd26bd31e469e8'
WEIGHT_REVISION = '39c4d5e957afe587e04eec59dc2bcc3be5ecd968'
WEIGHT_SHA256 = '3eefd4abb2102f38f12b2d1992e5ff15e4923e5431c67dd494afe157e0111cd5'
UTILS3D_REVISION = '3fab839f0be9931dac7c8488eb0e1600c236e183'


def _verify_manifest(directory, manifest_file, revision):
    manifest = json.loads(manifest_file.read_text())
    if manifest['code_commit'] != revision:
        raise RuntimeError('Unexpected upstream code revision')
    for name, expected in manifest['files'].items():
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise RuntimeError('Unsafe upstream source manifest path')
        path = directory / relative
        with path.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != expected:
            raise RuntimeError('Upstream source hash mismatch: ' + name)


def load(workspace=Path('/workspace/gp1/moge')):
    """Return eval FP32 model on cuda:0; pinned files must already exist."""
    import torch
    workspace = Path(workspace)
    if not torch.version.hip or not torch.cuda.is_available():
        raise RuntimeError('MoGe-2 requires ROCm GPU; no CPU fallback')
    torch.cuda.set_device(0)
    device = torch.device('cuda:0')
    _verify_manifest(workspace / 'v2-code', workspace / 'code-manifest.json', CODE_REVISION)
    _verify_manifest(workspace / 'utils3d-source', workspace / 'utils3d-manifest.json', UTILS3D_REVISION)
    sys.path.insert(0, str(workspace / 'v2-code'))
    sys.path.insert(0, str(workspace / 'utils3d-source'))
    weight = workspace / 'model.pt'
    with weight.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != WEIGHT_SHA256:
            raise RuntimeError('MoGe-2 checkpoint SHA-256 mismatch')
    from moge.model.v2 import MoGeModel
    checkpoint = torch.load(workspace / 'model.pt', map_location='cpu', weights_only=True)
    model = MoGeModel(**checkpoint['model_config'])
    model.load_state_dict(checkpoint['model'], strict=True)
    model = model.to(device=device, dtype=torch.float32).eval()
    model.enable_pytorch_native_sdpa()
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    if any(parameter.device != device or parameter.dtype != torch.float32
           for parameter in model.parameters()):
        raise RuntimeError('MoGe-2 parameters must be FP32 on cuda:0')
    return model


def infer(model, rgb):
    """Return finite float32 inverse depth at master size, larger is nearer.

    Upstream validity mask defines invalid sky/unreliable pixels as far (zero
    inverse depth). The common runner resizes to depthInputSize and min-max
    normalizes identically to its other candidates. No subject mask is involved.
    """
    import numpy as np
    import torch
    if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8:
        raise ValueError('Expected HxWx3 RGB uint8 master')
    tensor = torch.from_numpy(np.ascontiguousarray(rgb.transpose(2, 0, 1))).to(
        device='cuda:0', dtype=torch.float32) / 255
    with torch.inference_mode():
        output = model.infer(tensor, resolution_level=9, use_fp16=False,
                             force_projection=False, apply_mask=True)
        depth = output['depth']
        if depth.device != torch.device('cuda:0'):
            raise RuntimeError('MoGe-2 depth output is not on GPU')
        valid = torch.isfinite(depth) & (depth > 0)
        inverse = torch.where(valid, depth.clamp_min(1e-6).reciprocal(), 0)
        torch.cuda.synchronize()
        result = inverse.cpu().numpy().astype(np.float32, copy=False)
    if result.shape != rgb.shape[:2] or not np.isfinite(result).all():
        raise RuntimeError('MoGe-2 inverse depth must be finite at master size')
    if float(result.max()) <= float(result.min()):
        raise RuntimeError('MoGe-2 inverse depth is constant')
    return result


def metadata(workspace=Path('/workspace/gp1/moge')):
    workspace = Path(workspace)
    checkpoint = workspace / 'model.pt'
    with checkpoint.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {
        'model': 'MoGe-2 ViT-L', 'code_source': 'https://github.com/microsoft/MoGe',
        'code_revision': CODE_REVISION, 'code_license': 'MIT; bundled DINOv2 Apache-2.0',
        'weights_source': 'https://huggingface.co/Ruicheng/moge-2-vitl',
        'weights_revision': WEIGHT_REVISION, 'weights_license': 'MIT (model card)',
        'weights_sha256': digest, 'weights_bytes': checkpoint.stat().st_size,
        'utils3d_revision': UTILS3D_REVISION, 'utils3d_license': 'MIT',
        'precision': 'FP32 weights, input, forward and depth; no FP16 or TF32',
        'preprocessing': 'RGB uint8 /255 CHW; upstream aspect-preserving 3600-token '
            'level-9 bilinear antialiased resize to multiples of 14; ImageNet '
            'mean [.485,.456,.406], std [.229,.224,.225]',
        'postprocessing': 'Upstream recovered focal/shift and metric scale; '
            'invalid predicted geometry mask set to far (zero inverse depth); '
            'reciprocal positive metric depth, common runner resizes/normalizes',
    }
