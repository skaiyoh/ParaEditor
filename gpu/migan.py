"""MI-GAN on ROCm with the browser's pinned ONNX pipeline preprocessing.

The inference architecture is downloaded separately from the official upstream
at SOURCE_URL and verified before import. It needs only NumPy and PyTorch.
"""

from __future__ import annotations

import hashlib
import importlib.util
import math
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F


SOURCE_COMMIT = "2b793c5ece43f4253e32d4afc257120a5deed6f5"
SOURCE_URL = (
    "https://raw.githubusercontent.com/Picsart-AI-Research/MI-GAN/"
    f"{SOURCE_COMMIT}/lib/model_zoo/migan_inference.py"
)
SOURCE_SHA256 = "1e35a181e516742ae32af935848e6a9a4382f528ea7096db6658f14cd8b9ace0"
CHECKPOINT_URL = (
    "https://huggingface.co/vietnqai/Face-Service/resolve/"
    "cb1ff9ab23e7f15c332bd09461d1176fd2515b50/"
    "remove_object/removal/models/migan_512_places2.pt"
)
# Verified byte-for-byte against the checkpoint linked by the official README:
# https://drive.google.com/file/d/1D_YCuCgo20S2256sqpedsmENNm2WMtVY/view
CHECKPOINT_SHA256 = "1d6087eee0aac8923ad2606be5d8caeb4824d3e4de331995e420c74e124a466a"
MODEL_ID = f"migan-512-places2@{CHECKPOINT_SHA256}"


def _verified(path: Path, expected: str) -> Path:
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != expected:
        raise RuntimeError(f"MI-GAN asset hash mismatch: {path.name}")
    return path


def _crop(hole: np.ndarray) -> tuple[int, int, int, int]:
    """Reproduce get_masked_bbox in the pinned pipeline, including its offsets."""
    height, width = hole.shape
    ys, xs = np.nonzero(hole)
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    center_x, center_y = (x0 + x1) // 2, (y0 + y1) // 2
    side = max(max(x1 - x0, y1 - y0) + 256, 512)
    offset = side // 2
    x0, x1 = max(center_x - offset, 0), min(center_x + offset, width)
    y0, y1 = max(center_y - offset, 0), min(center_y + offset, height)
    excess_x, excess_y = max(side - (x1 - x0), 0), max(side - (y1 - y0), 0)
    x0, x1 = max(x0 - excess_x, 0), min(x1 + excess_x, width)
    y0, y1 = max(y0 - excess_y, 0), min(y1 + excess_y, height)
    return x0, x1, y0, y1


class Migan:
    def __init__(self, workspace: Path):
        assets = workspace / "gp2" / "assets"
        source = _verified(assets / "migan_inference.py", SOURCE_SHA256)
        checkpoint = _verified(assets / "migan_512_places2.pt", CHECKPOINT_SHA256)
        spec = importlib.util.spec_from_file_location("gp2_migan_inference", source)
        if spec is None or spec.loader is None:
            raise RuntimeError("MI-GAN architecture could not be loaded.")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.model = module.Generator(resolution=512)
        state = torch.load(checkpoint, map_location="cpu", weights_only=True)
        self.model.load_state_dict(state, strict=True)
        self.model.eval().requires_grad_(False).to("cuda:0")

        # Match upstream GaussianSmoothing exactly, including its exponent.
        # A generic sigma=1 Gaussian has a different exponent and changes edges.
        grid = torch.meshgrid(torch.arange(5, dtype=torch.float32),
                              torch.arange(5, dtype=torch.float32), indexing="ij")
        kernel = torch.ones((5, 5), dtype=torch.float32)
        for axis in grid:
            kernel *= (1 / math.sqrt(2 * math.pi)) * torch.exp(-((axis - 2) / 2) ** 2)
        self.kernel = (kernel / kernel.sum()).reshape(1, 1, 5, 5).to("cuda:0")

    @torch.inference_mode()
    def infer(self, rgb: np.ndarray, hole: np.ndarray) -> np.ndarray:
        if (rgb.dtype != np.uint8 or rgb.ndim != 3 or rgb.shape[2] != 3
                or min(rgb.shape[:2]) < 1 or hole.shape != rgb.shape[:2]
                or hole.dtype != np.bool_):
            raise ValueError("MI-GAN expects RGB bytes and a matching boolean hole.")
        if not hole.any():
            return rgb.copy()
        x0, x1, y0, y1 = _crop(hole)
        source = rgb[y0:y1, x0:x1]
        image = torch.from_numpy(np.ascontiguousarray(source.transpose(2, 0, 1)))
        image = image.unsqueeze(0).to(device="cuda:0", dtype=torch.float32)
        keep = torch.from_numpy(np.ascontiguousarray(~hole[y0:y1, x0:x1]))
        keep = keep.unsqueeze(0).unsqueeze(0).to(device="cuda:0", dtype=torch.float32) * 255

        # The locked ONNX performs half-pixel bilinear resize, then rounds RGB
        # back to uint8 before normalizing. No antialiasing is present in it.
        resized = F.interpolate(image, size=(512, 512), mode="bilinear",
                                align_corners=False, antialias=False).round()
        normalized = resized * 2 / 255 - 1
        mask = F.interpolate(keep, size=(512, 512), mode="nearest") / 255
        model_input = torch.cat((mask - 0.5, normalized * mask), dim=1)
        generated = ((self.model(model_input) * 0.5 + 0.5) * 255).clamp(0, 255)
        if not torch.isfinite(generated).all():
            raise RuntimeError("MI-GAN returned nonfinite pixels.")
        generated = F.interpolate(generated, size=source.shape[:2], mode="bilinear",
                                  align_corners=False, antialias=False)

        blend = F.max_pool2d(keep, kernel_size=3, stride=1, padding=1)
        # Upstream reflect-padding is undefined for a 1- or 2-pixel side.
        # Replication gives these valid tiny inputs a defined result.
        padding_mode = "reflect" if min(source.shape[:2]) > 2 else "replicate"
        blend = F.conv2d(F.pad(blend, (2, 2, 2, 2), mode=padding_mode), self.kernel) / 255
        generated = (image * blend + generated * (1 - blend)).clamp(0, 255).to(torch.uint8)
        generated = generated[0].permute(1, 2, 0).contiguous().cpu().numpy()
        plate = rgb.copy()
        region = plate[y0:y1, x0:x1]
        selected = hole[y0:y1, x0:x1]
        region[selected] = generated[selected]
        return plate
