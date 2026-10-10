#!/usr/bin/env python3
"""GP0: pinned Depth Anything V2 Small on ROCm, with no CPU fallback/install.

Run: python3 gp0-smoke.py --workspace /designated/workspace/GP0 --out outputs
Relative --out paths resolve inside --workspace. Downloads are public and hashed.
"""

import argparse
import hashlib
import importlib
import json
import logging
import os
from pathlib import Path
import platform
import shutil
import socket
import sys
import time
import urllib.request
import zipfile
from datetime import datetime, timezone


CODE_COMMIT = "a561b849ebae10a6f5ef49e26c83cbbcd36c71bf"
CODE_URL = f"https://codeload.github.com/DepthAnything/Depth-Anything-V2/zip/{CODE_COMMIT}"
CODE_SHA256 = "0022639d5b23499329ca4fd29a92993e86b52fdfe9aaf21df683383136e91b65"
CODE_MANIFEST_SHA256 = "bcd75d6e51d3b6129e9b3644794a7c3a432b48bb0f084064abda7eab40abf513"
WEIGHT_REVISION = "03876f8651c73a60fe4c2c48294e09fcb6838fcf"
WEIGHT_NAME = "depth_anything_v2_vits.pth"
WEIGHT_URL = ("https://huggingface.co/depth-anything/Depth-Anything-V2-Small/resolve/"
              f"{WEIGHT_REVISION}/{WEIGHT_NAME}")
WEIGHT_SHA256 = "715fade13be8f229f8a70cc02066f656f2423a59effd0579197bbf57860e1378"


def now():
    return datetime.now(timezone.utc).isoformat()


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def download(url, path, expected):
    if not path.exists():
        logging.info("Downloading public artifact: %s", path.name)
        partial = path.with_suffix(path.suffix + ".partial")
        try:
            with urllib.request.urlopen(url, timeout=60) as source, partial.open("wb") as target:
                shutil.copyfileobj(source, target)
            require(sha256(partial) == expected, f"SHA-256 mismatch: {path.name}")
            partial.replace(path)
        finally:
            partial.unlink(missing_ok=True)
    require(sha256(path) == expected, f"SHA-256 mismatch: {path.name}")
    return path


def load_code(workspace):
    code = workspace / f"Depth-Anything-V2-{CODE_COMMIT}"
    manifest_path = workspace / "code-manifest.json"
    if manifest_path.exists():
        require(sha256(manifest_path) == CODE_MANIFEST_SHA256, "Code manifest SHA-256 mismatch")
        manifest = json.loads(manifest_path.read_text())
        require(manifest["code_commit"] == CODE_COMMIT
                and manifest["source_archive_sha256"] == CODE_SHA256, "Code source pin mismatch")
        for name, expected in manifest["files"].items():
            relative = Path(name)
            require(not relative.is_absolute() and ".." not in relative.parts,
                    "Unsafe code manifest path")
            require(sha256(code / relative) == expected, f"Code SHA-256 mismatch: {name}")
        sys.path.insert(0, str(code))
        return importlib.import_module("depth_anything_v2.dpt").DepthAnythingV2
    archive = download(CODE_URL, workspace / "upstream-source.zip", CODE_SHA256)
    prefix = code.name + "/"
    # Extract only reviewed model Python sources and license, never archive paths.
    with zipfile.ZipFile(archive) as source:
        for member in source.namelist():
            if not member.startswith(prefix):
                continue
            relative = Path(member[len(prefix):])
            if ".." in relative.parts or relative.is_absolute():
                raise RuntimeError("Unsafe upstream archive path")
            if (relative.parts and relative.parts[0] == "depth_anything_v2"
                    and relative.suffix == ".py") or str(relative) == "LICENSE":
                target = code / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read(member))
    sys.path.insert(0, str(code))
    return importlib.import_module("depth_anything_v2.dpt").DepthAnythingV2


def run(workspace, out, record):
    # GPU checks precede all model imports, downloads and generated pixels.
    torch = importlib.import_module("torch")
    record.update(torch_version=str(torch.__version__), hip_version=torch.version.hip,
                  cuda_available=torch.cuda.is_available(), gpu_count=torch.cuda.device_count())
    require(bool(torch.version.hip), "ROCm required: torch.version.hip is absent; no CPU fallback")
    require(record["cuda_available"], "ROCm required: torch.cuda.is_available() is false; no CPU fallback")
    require(record["gpu_count"] == 1, f"Expected one GPU; observed {record['gpu_count']}")
    torch.cuda.set_device(0)
    device = torch.device("cuda:0")
    properties = torch.cuda.get_device_properties(device)
    record["gpu"] = {"name": properties.name, "total_memory_bytes": properties.total_memory,
                     "device": str(device), "properties": str(properties)}
    record["torch_config"] = torch.__config__.show()
    with torch.inference_mode():
        matrix = torch.tensor([[1., 2.], [3., 4.]], device=device)
        product = matrix @ matrix
        torch.cuda.synchronize(device)
        observed = product.cpu().tolist()
        require(product.device == device and observed == [[7., 10.], [15., 22.]],
                f"GPU tensor check failed: {product.device}, {observed}")
    record["tensor_check"] = {"operation": "[[1,2],[3,4]] @ itself", "device": str(product.device),
                              "observed": observed, "synchronized": True}
    logging.info("ROCm tensor check PASS: %s on %s (%s)", observed, device, properties.name)
    del matrix, product
    write_json(out / "environment.json", record)

    np = importlib.import_module("numpy")
    cv2 = importlib.import_module("cv2")
    torchvision = importlib.import_module("torchvision")
    record["packages"] = {"numpy": np.__version__, "opencv": cv2.__version__,
                          "torchvision": torchvision.__version__}
    model_class = load_code(workspace)
    weights = download(WEIGHT_URL, workspace / WEIGHT_NAME, WEIGHT_SHA256)
    record["model_source"] = {"name": "Depth Anything V2 Small", "encoder": "vits",
                              "code_commit": CODE_COMMIT, "code_url": CODE_URL,
                              "code_archive_sha256": CODE_SHA256,
                              "code_manifest_sha256": (CODE_MANIFEST_SHA256
                                                       if (workspace / "code-manifest.json").exists()
                                                       else None),
                              "weight_revision": WEIGHT_REVISION, "weight_url": WEIGHT_URL,
                              "weight_sha256": sha256(weights), "weight_bytes": weights.stat().st_size}

    # Deterministic synthetic scene: sky, perspective floor, two occluding objects.
    height, width = 480, 640
    image = np.zeros((height, width, 3), dtype=np.uint8)
    image[:220] = (220, 180, 120)  # BGR
    image[220:] = (100, 120, 140)
    for x in range(-640, 1281, 160):
        cv2.line(image, (320, 220), (x, 479), (60, 70, 80), 3)
    for y in (250, 295, 360, 450):
        cv2.line(image, (0, y), (639, y), (60, 70, 80), 3)
    cv2.rectangle(image, (380, 120), (490, 300), (70, 150, 70), -1)
    cv2.ellipse(image, (215, 392), (112, 24), 0, 0, 360, (50, 60, 70), -1)
    cv2.rectangle(image, (140, 200), (285, 385), (60, 70, 220), -1)
    cv2.rectangle(image, (155, 215), (270, 365), (80, 100, 245), 5)
    require(cv2.imwrite(str(out / "synthetic-input.png"), image), "Input PNG write failed")

    torch.manual_seed(0)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    model = model_class(encoder="vits", features=64, out_channels=[48, 96, 192, 384])
    model.load_state_dict(torch.load(weights, map_location="cpu", weights_only=True), strict=True)
    model = model.to(device=device, dtype=torch.float32).eval()
    require(all(p.device == device and p.dtype == torch.float32 for p in model.parameters()),
            "Model parameters must all be float32 on cuda:0")
    input_tensor, original_size = model.image2tensor(image, input_size=518)
    require(input_tensor.device == device and input_tensor.dtype == torch.float32,
            "Preprocessed input must be float32 on cuda:0")
    torch.cuda.synchronize(device)
    torch.cuda.reset_peak_memory_stats(device)
    started = time.perf_counter()
    with torch.inference_mode():
        prediction = model(input_tensor)
        require(prediction.device == device, "Model forward output is not on GPU")
        depth_gpu = torch.nn.functional.interpolate(prediction[:, None], original_size,
                                                    mode="bilinear", align_corners=True)[0, 0]
        torch.cuda.synchronize(device)
        inference_ms = (time.perf_counter() - started) * 1000
        peak_bytes = torch.cuda.max_memory_allocated(device)
        depth = depth_gpu.cpu().numpy()
    forward_device, depth_device = str(prediction.device), str(depth_gpu.device)
    del prediction, depth_gpu
    torch.cuda.synchronize(device)
    torch.cuda.reset_peak_memory_stats(device)
    started = time.perf_counter()
    with torch.inference_mode():
        warm_prediction = model(input_tensor)
        require(warm_prediction.device == device, "Warm forward output is not on GPU")
        warm_depth_gpu = torch.nn.functional.interpolate(warm_prediction[:, None], original_size,
                                                         mode="bilinear", align_corners=True)[0, 0]
        torch.cuda.synchronize(device)
        warm_ms = (time.perf_counter() - started) * 1000
        warm_peak_bytes = torch.cuda.max_memory_allocated(device)
        warm_depth = warm_depth_gpu.cpu().numpy()
    require(bool(np.isfinite(warm_depth).all()) and float(warm_depth.max()) > float(warm_depth.min()),
            "Warm depth must be finite and nonconstant")
    require(depth.shape == (height, width), f"Unexpected depth shape: {depth.shape}")
    require(bool(np.isfinite(depth).all()), "Depth contains nonfinite values")
    minimum, maximum = float(depth.min()), float(depth.max())
    require(maximum > minimum, f"Depth is constant: {minimum}..{maximum}")
    np.save(out / "depth-f32.npy", depth, allow_pickle=False)
    preview = np.rint((depth - minimum) / (maximum - minimum) * 65535).astype(np.uint16)
    require(cv2.imwrite(str(out / "depth-normalized-u16.png"), preview), "Depth PNG write failed")
    record["inference"] = {
        "input_image_hw": [height, width], "input_tensor_nchw": list(input_tensor.shape),
        "preprocessing": "Upstream image2tensor: BGR to RGB /255; OpenCV cubic aspect-preserving "
                         "lower-bound 518 resize, multiples of 14; ImageNet mean [.485,.456,.406] "
                         "and std [.229,.224,.225]; contiguous float32 NCHW",
        "precision": "float32 weights/input/output; no autocast; TF32 disabled",
        "model_parameter_device": str(next(model.parameters()).device),
        "input_device": str(input_tensor.device), "forward_output_device": forward_device,
        "depth_device": depth_device, "output_hw": list(depth.shape),
        "output_dtype": str(depth.dtype), "minimum": minimum, "maximum": maximum,
        "std": float(depth.std()), "all_finite": True, "nonconstant": True,
        "synchronized_inference_ms": inference_ms, "peak_allocated_gpu_bytes": peak_bytes,
        "cold_synchronized_inference_ms": inference_ms,
        "warm_synchronized_inference_ms": warm_ms,
        "warm_peak_allocated_gpu_bytes": warm_peak_bytes,
        "warm_forward_output_device": str(warm_prediction.device),
        "warm_all_finite": True, "warm_nonconstant": True,
        "warm_max_absolute_difference": float(np.abs(warm_depth - depth).max()),
        "timing_scope": "First forward plus GPU bilinear resize; excludes download, load, "
                        "preprocessing, CPU copy and file writes; no warmup",
        "warm_timing_scope": "One immediate repeat forward plus the same GPU bilinear resize; "
                             "synchronized; excludes CPU copy and file writes",
        "postprocessing": "GPU bilinear resize align_corners=True to original HxW; raw relative "
                          "depth in NPY; min-max normalized 16-bit PNG preview, larger brighter",
        "comparison": "Same family as browser baseline; no parity, quality or speed benefit established",
    }
    logging.info("Model inference PASS: %s, range %.6f..%.6f, %.3f ms, peak %d bytes",
                 depth.shape, minimum, maximum, inference_ms, peak_bytes)
    logging.info("Warm inference PASS: %.3f ms, peak %d bytes, output on %s",
                 warm_ms, warm_peak_bytes, warm_prediction.device)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path("outputs"))
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    out = args.out.resolve() if args.out.is_absolute() else (workspace / args.out).resolve()
    if not out.is_relative_to(workspace):
        parser.error("--out must be inside --workspace")
    out.mkdir(parents=True, exist_ok=True)
    # Keep Python bytecode in the designated workspace too.
    sys.pycache_prefix = str(workspace / "pycache")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.FileHandler(out / "runner.log", mode="w"),
                                  logging.StreamHandler(sys.stdout)])
    record = {"started_utc": now(), "status": "RUNNING", "python": sys.version,
              "python_executable": sys.executable, "platform": platform.platform(),
              "hostname": socket.gethostname(), "uid": os.getuid(),
              "workspace": str(workspace), "out": str(out), "runner_sha256": sha256(Path(__file__))}
    try:
        run(workspace, out, record)
        record["status"] = "PASS"
        code = 0
    except Exception as error:
        record.update(status="FAILED", error=f"{type(error).__name__}: {error}")
        logging.error("GP0 FAILED: %s", record["error"])
        code = 1
    record["ended_utc"] = now()
    write_json(out / "environment.json", record)
    logging.info("GP0 %s; environment record: %s", record["status"], out / "environment.json")
    artifacts = {p.name: {"bytes": p.stat().st_size, "sha256": sha256(p)}
                 for p in [out / "environment.json", out / "runner.log"]}
    if code == 0:
        for name in ["synthetic-input.png", "depth-f32.npy", "depth-normalized-u16.png"]:
            path = out / name
            artifacts[name] = {"bytes": path.stat().st_size, "sha256": sha256(path)}
    write_json(out / "artifacts.json", artifacts)
    return code


if __name__ == "__main__":
    sys.exit(main())
