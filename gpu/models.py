"""Pinned FP32 PyTorch models, reused across memory-only sessions on ROCm."""
import hashlib
import io
import json
import math
from pathlib import Path
import sys
import time

import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError
import torch
import torch.nn.functional as F

DEPTH_CODE = "a561b849ebae10a6f5ef49e26c83cbbcd36c71bf"
DEPTH_SHA = "715fade13be8f229f8a70cc02066f656f2423a59effd0579197bbf57860e1378"
SAM_SHA = "2647878d5dfa5098f2f8649825738a9345572bae2d4350a2468587ece47dd318"
LAMA_SHA = "79ed9fa18680ca19a269eb88fc4f708fb6580197b2220a51d3e000eb0ffdf33b"


def verify(path, expected):
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != expected:
        raise RuntimeError("Pinned model asset does not match: " + path.name)
    return path


def depth_size(w, h):
    scale = 518 / min(w, h)
    w = max(14, math.floor(w * scale / 14 + .5) * 14)
    h = max(14, math.floor(h * scale / 14 + .5) * 14)
    patches = w * h / 196
    if patches > 1813:
        scale = math.sqrt(1813 / patches)
        w, h = max(14, math.floor(w * scale / 14) * 14), max(14, math.floor(h * scale / 14) * 14)
    return w, h


class Engine:
    def __init__(self, assets, problem):
        self.problem = problem
        root = Path(assets)
        if not torch.version.hip or not torch.cuda.is_available():
            raise RuntimeError("A ROCm GPU is required; there is no CPU fallback.")
        torch.cuda.set_device(0)
        torch.set_num_threads(4)
        torch.manual_seed(0)
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
        depth_root = root / "GP0"
        code = depth_root / ("Depth-Anything-V2-" + DEPTH_CODE)
        manifest = json.loads((depth_root / "code-manifest.json").read_text())
        if manifest["code_commit"] != DEPTH_CODE:
            raise RuntimeError("Depth source revision does not match.")
        for name, sha in manifest["files"].items():
            verify(code / name, sha)
        sys.path.insert(0, str(code))
        from depth_anything_v2.dpt import DepthAnythingV2
        self.depth = DepthAnythingV2(encoder="vits", features=64, out_channels=[48, 96, 192, 384])
        weights = verify(depth_root / "depth_anything_v2_vits.pth", DEPTH_SHA)
        self.depth.load_state_dict(torch.load(weights, map_location="cpu", weights_only=True), strict=True)
        self.depth = self.depth.to(device="cuda:0", dtype=torch.float32).eval()
        sam_root = root / "gp1" / "sam"
        source = json.loads((root / "gp1" / "source.json").read_text())
        if source["revision"] != "2b90b9f5ceec907a1c18123530e92e794ad901a4":
            raise RuntimeError("SAM source revision does not match.")
        for name, sha in source["files"].items():
            verify(sam_root / name, sha)
        sys.path.insert(0, str(sam_root))
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        self.predictor_class = SAM2ImagePredictor
        weights = verify(sam_root / "sam2.1_hiera_large.pt", SAM_SHA)
        self.sam = build_sam2("configs/sam2.1/sam2.1_hiera_l.yaml", str(weights), device="cuda:0", apply_postprocessing=False).float().eval()
        self.lama = torch.jit.load(str(verify(root / "gp1" / "lama" / "lama.pt", LAMA_SHA)), map_location="cuda:0").float().eval()
        from migan import Migan
        self.migan = Migan(root)
        for model in (self.depth, self.sam, self.lama, self.migan.model):
            if not all(p.device == torch.device("cuda:0") for p in model.parameters()):
                raise RuntimeError("Every model must reside on the Radeon GPU.")

    def health(self):
        return {"ok": True, "gpu": torch.cuda.get_device_name(0), "models": {
            "depth": "depth-anything/Depth-Anything-V2-Small@03876f8651c73a60fe4c2c48294e09fcb6838fcf",
            "segment": "facebook/sam2.1-hiera-large@665f8e2ad61cf5f53d65644ff27c8ee525124610",
            "inpaint": "Picsart-AI-Research/MI-GAN:migan_512_places2@1d6087eee0aac8923ad2606be5d8caeb4824d3e4de331995e420c74e124a466a"}}

    def decode(self, body, w, h):
        try:
            with Image.open(io.BytesIO(body)) as image:
                if image.format not in {"PNG", "JPEG"} or image.size != (w, h) or getattr(image, "n_frames", 1) != 1:
                    raise self.problem(400, "The photo must be one JPEG or PNG matching its master dimensions.")
                return np.array(image.convert("RGB"), dtype=np.uint8)
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
            raise self.problem(400, "The photo cannot be decoded as a JPEG or PNG.")

    @torch.inference_mode()
    def create(self, rgb, metrics=None):
        metrics = metrics if metrics is not None else {}
        started = time.perf_counter()
        h, w = rgb.shape[:2]
        resized = cv2.resize(rgb, depth_size(w, h), interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255
        resized = (resized - np.array([.485, .456, .406], np.float32)) / np.array([.229, .224, .225], np.float32)
        tensor = torch.from_numpy(np.ascontiguousarray(resized.transpose(2, 0, 1)))[None].to("cuda:0")
        torch.cuda.synchronize()
        metrics["depth_prepare_ms"] = (time.perf_counter() - started) * 1000
        started = time.perf_counter()
        depth = self.depth(tensor)
        depth = F.interpolate(depth[:, None], size=(h, w), mode="bilinear", align_corners=False)[0, 0]
        low, high = depth.min(), depth.max()
        depth = (depth - low) / (high - low).clamp_min(1e-8)
        plane = depth.cpu().numpy().astype("<f4")
        if not np.isfinite(plane).all():
            raise RuntimeError("Depth is not finite.")
        metrics["depth_ms"] = (time.perf_counter() - started) * 1000
        # Predictor state/embeddings are session-owned; only model weights are shared.
        predictor = self.predictor_class(self.sam, max_hole_area=0, max_sprinkle_area=0)
        started = time.perf_counter()
        predictor.set_image(rgb)
        torch.cuda.synchronize()
        metrics["sam_encode_ms"] = (time.perf_counter() - started) * 1000
        return plane.tobytes(), predictor

    @torch.inference_mode()
    def taps(self, predictor, points, w, h):
        coords = np.array([[p["x"] * w, p["y"] * h] for p in points], np.float32)
        labels = np.array([int(p["label"] == "include") for p in points], np.int32)
        # Use the pinned predictor's tensor API to avoid copying three unused
        # full-master float masks to the CPU on every tap.
        mask_input, coords, labels, box = predictor._prep_prompts(coords, labels, None, None, True)
        _, scores, logits = predictor._predict(coords, labels, box, mask_input,
                                               multimask_output=True, return_logits=True)
        scores = scores[0].cpu().numpy()
        gw = max(1, math.floor(w * 1024 / max(w, h) + .5))
        gh = max(1, math.floor(h * 1024 / max(w, h) + .5))
        # Resize decoder logits directly, without a master-sized intermediate mask.
        logits = F.interpolate(logits, size=(gh, gw), mode="bilinear", align_corners=False)[0]
        masks = (255 * torch.sigmoid(logits)).round()
        masks = torch.where(logits < 0, masks.clamp_max(127), masks)
        if masks.shape != (3, gh, gw) or not np.isfinite(scores).all() or not torch.isfinite(logits).all():
            raise RuntimeError("SAM returned invalid candidates.")
        return masks.to(torch.uint8).cpu().numpy().tobytes(), scores, gw, gh

    @torch.inference_mode()
    def inpaint(self, rgb, body, fill):
        h, w = rgb.shape[:2]
        hole = np.frombuffer(body, dtype=np.uint8).reshape(h, w) >= 128
        if not hole.any():
            plate = rgb
        elif fill == "migan":
            plate = self.migan.infer(rgb, hole)
        else:
            image = torch.from_numpy(np.ascontiguousarray(rgb.transpose(2, 0, 1)))[None].to("cuda:0", torch.float32) / 255
            mask = torch.from_numpy(hole)[None, None].to("cuda:0", torch.float32)
            pad = (0, (-w) % 8, 0, (-h) % 8)
            mode = "reflect" if pad[1] < w and pad[3] < h else "replicate"
            image, mask = F.pad(image, pad, mode=mode), F.pad(mask, pad, mode=mode)
            # Profiling executor re-specialization caused GP1's delayed 8-18s calls.
            with torch.jit.optimized_execution(False):
                result = self.lama(image, mask)[0, :, :h, :w].permute(1, 2, 0)
            if not torch.isfinite(result).all():
                raise RuntimeError("LaMa returned nonfinite pixels.")
            plate = (result.clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
        plate = np.where(hole[..., None], plate, rgb)
        output = io.BytesIO()
        Image.fromarray(plate).save(output, format="PNG", compress_level=1)
        return output.getvalue()

    def warm(self):
        started = time.monotonic()
        # Synthetic warmups never leave memory. Cover common aspect/forward shapes.
        for h, w in [(768, 1024), (1024, 768), (1024, 1024), (1536, 2048), (2048, 1536), (2048, 2048)]:
            rgb = np.zeros((h, w, 3), np.uint8)
            rgb[:, :, 0] = np.arange(w, dtype=np.uint16)[None] % 256
            _, predictor = self.create(rgb)
            self.taps(predictor, [{"x": .5, "y": .5, "label": "include"}], w, h)
            hole = np.zeros((h, w), np.uint8)
            hole[h//3:h//2, w//3:w//2] = 255
            for fill in ("migan", "lama"):
                self.inpaint(rgb, hole.tobytes(), fill)
        torch.cuda.synchronize()
        print("Models warmed in %.3f seconds." % (time.monotonic() - started), flush=True)
