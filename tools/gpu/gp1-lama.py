#!/usr/bin/env python3
"""GP1 big-LaMa TorchScript adapter; experiment only, no app integration.

Public API: Lama(weights).infer(rgb_u8, hole_u8) -> (plate_u8, measurement).
The caller owns process-start/cold timing and photo/mask provenance.
"""

import argparse
import hashlib
import json
from pathlib import Path
import time


SOURCE = {
    "name": "big-LaMa TorchScript",
    "repository": "JosephCatrambone/big-lama-torchscript",
    "revision": "7dfbdc6dc27602d370909e8688f8f84404a1f995",
    "filename": "lama.pt",
    "sha256": "79ed9fa18680ca19a269eb88fc4f708fb6580197b2220a51d3e000eb0ffdf33b",
    "bytes": 206134115,
    "declared_license": "Apache-2.0",
    "license_evidence": "Hugging Face model card; upstream code Apache-2.0",
    "license_uncertainty": "Upstream issue 366 asks whether separately distributed "
                           "pretrained weights inherit Apache-2.0; no maintainer reply observed",
    "upstream_license_question": "https://github.com/advimman/lama/issues/366",
    "precision": "FP32 weights, input and output; no autocast; TF32 disabled",
    "added_packages": [],
    "preprocessing": "RGB /255 NCHW; binary hole N1HW; reflect-pad right/bottom "
                     "to multiples of 8; no resolution reduction",
    "postprocessing": "Crop padded output; clamp 0..1; round to uint8; replace "
                      "inside hole only, preserve original RGB exactly outside",
}


class Lama:
    def __init__(self, weights):
        import numpy as np
        import torch

        self.np, self.torch = np, torch
        weights = Path(weights)
        with weights.open("rb") as source:
            actual = hashlib.file_digest(source, "sha256").hexdigest()
        if actual != SOURCE["sha256"] or weights.stat().st_size != SOURCE["bytes"]:
            raise RuntimeError("big-LaMa checkpoint hash/size mismatch")
        if not torch.version.hip or not torch.cuda.is_available():
            raise RuntimeError("ROCm GPU required; no CPU fallback")
        self.device = torch.device("cuda:0")
        torch.cuda.set_device(self.device)
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
        started = time.perf_counter()
        self.model = torch.jit.load(str(weights), map_location=self.device).eval()
        self.model = self.model.to(device=self.device, dtype=torch.float32)
        if not all(p.device == self.device and p.dtype == torch.float32
                   for p in self.model.parameters()):
            raise RuntimeError("All big-LaMa parameters must be FP32 on cuda:0")
        torch.cuda.synchronize(self.device)
        self.load_ms = (time.perf_counter() - started) * 1000
        self.first = True

    def infer(self, rgb, hole):
        torch, np = self.torch, self.np
        rgb, hole = np.asarray(rgb), np.asarray(hole)
        if rgb.dtype != np.uint8 or rgb.ndim != 3 or rgb.shape[2] != 3:
            raise ValueError("rgb must be HxWx3 uint8")
        if hole.shape != rgb.shape[:2]:
            raise ValueError("hole must have the same HxW as rgb")
        height, width = hole.shape
        if min(height, width) < 2 or max(height, width) > 2048:
            raise ValueError("master sides must be 2..2048")
        input_rgb = torch.from_numpy(np.ascontiguousarray(rgb.transpose(2, 0, 1)))
        input_rgb = input_rgb[None].to(device=self.device, dtype=torch.float32) / 255
        input_hole = torch.from_numpy(np.ascontiguousarray(hole > 0))[None, None]
        input_hole = input_hole.to(device=self.device, dtype=torch.float32)
        pad = (0, (-width) % 8, 0, (-height) % 8)
        # Reflect is the upstream convention; tiny masters need replicate instead.
        mode = "reflect" if pad[1] < width and pad[3] < height else "replicate"
        input_rgb = torch.nn.functional.pad(input_rgb, pad, mode=mode)
        input_hole = torch.nn.functional.pad(input_hole, pad, mode=mode)
        torch.cuda.synchronize(self.device)
        torch.cuda.reset_peak_memory_stats(self.device)
        started = time.perf_counter()
        with torch.inference_mode():
            output = self.model(input_rgb, input_hole)
            if output.device != self.device or output.dtype != torch.float32:
                raise RuntimeError("big-LaMa output must be FP32 on cuda:0")
            if output.shape != input_rgb.shape:
                raise RuntimeError(f"Unexpected big-LaMa output shape: {tuple(output.shape)}")
            torch.cuda.synchronize(self.device)
            forward_ms = (time.perf_counter() - started) * 1000
            peak = torch.cuda.max_memory_allocated(self.device)
            prediction = output[0, :, :height, :width].permute(1, 2, 0).cpu().numpy()
        if not np.isfinite(prediction).all():
            raise RuntimeError("big-LaMa output contains nonfinite values")
        generated = np.rint(np.clip(prediction, 0, 1) * 255).astype(np.uint8)
        plate = np.where((hole > 0)[..., None], generated, rgb)
        measurement = {
            "first_forward": self.first, "load_ms": self.load_ms,
            "synchronized_forward_ms": forward_ms,
            "peak_allocated_gpu_bytes": peak,
            "device": str(self.device), "device_name": torch.cuda.get_device_name(self.device),
            "input_tensor_nchw": list(input_rgb.shape), "output_hw": [height, width],
            "all_finite": True, "outside_hole_preserved": bool(np.array_equal(plate[hole == 0], rgb[hole == 0])),
            "timing_scope": "Forward only; synchronized; excludes preprocessing, CPU copy and writes",
        }
        self.first = False
        return plate, measurement


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--hole", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    started = time.perf_counter()
    import numpy as np
    from PIL import Image
    model = Lama(args.weights)
    rgb = np.array(Image.open(args.image).convert("RGB"))
    hole = np.array(Image.open(args.hole).convert("L"))
    plate, cold = model.infer(rgb, hole)
    cold["process_entry_to_first_result_ms"] = (time.perf_counter() - started) * 1000
    warm_plate, warm = model.infer(rgb, hole)
    args.out.mkdir(parents=True, exist_ok=True)
    Image.fromarray(plate).save(args.out / "plate.png")
    plate.tofile(args.out / "plate.rgb8")
    record = {"source": SOURCE, "cold": cold, "warm": warm,
              "warm_output_max_absolute_difference": int(np.abs(plate.astype(np.int16) - warm_plate).max())}
    (args.out / "measurements.json").write_text(json.dumps(record, indent=2, allow_nan=False) + "\n")
    print(json.dumps(record, allow_nan=False))


if __name__ == "__main__":
    main()
