# Radeon analysis service

> Owns: the standalone Python service, its pinned runtime/assets, startup and HTTP verification.
> Does not own: the app or the wire contract; see [the GPU contract](../plan/gpu-contract.md) and [GP2 evidence](../plan/evidence/GP2-return.md).

One Python process serves HTTP on `127.0.0.1:8789` and holds the models on the AMD Radeon GPU.
It uses the platform's existing PyTorch ROCm image and the GP0/GP1 overlay; GP2 installs no Python packages.
`requirements.txt` records the exact existing packages used, and must not be used to replace the platform's torch/ROCm installation.
The client contract test needs only Python and Pillow.

Models:

| Stage | Model | Reason |
| --- | --- | --- |
| Depth | Depth Anything V2 Small, FP32 | GP1 found no visible gain from MoGe-2; this preserves the model family used by the app. |
| Segmentation | SAM 2.1 Hiera Large, FP32 | GP1 found improved group selection without a worse result in its comparison set. |
| Default fill | MI-GAN 512 Places2, FP32 | Uses the app's model family, crop, resize, normalization and feathering. |
| `?fill=lama` | big-LaMa TorchScript, FP32 | Rehearsal comparison option; GP1 observed gray silhouettes behind hair. |

All model forwards execute through PyTorch's `cuda:0` API on ROCm.
Startup checks HIP, the GPU, source and weight hashes, then warms synthetic inputs before opening the listener.
SAM returns its three multimask candidates in model order, with bilinear logit resizing and sigmoid soft bytes; zero logits map to 128.
The default health answer names depth, segment and MI-GAN; LaMa is the explicit optional fill.

The MI-GAN checkpoint mirror was verified byte for byte against the official project's linked checkpoint.
Its source, checkpoint hashes and URLs are in `migan.py`; the upstream code and weights are MIT licensed.
Depth/SAM assets and their pinned source manifests are reused from the GP0/GP1 prepared workspace.
LaMa is the GP1 pinned TorchScript artifact; its publisher declares Apache-2.0, while the original pretrained-weight permission remains unresolved in GP1's evidence.

## Prepared instance and start

The prepared instance contains:

- `/workspace/GP0/Depth-Anything-V2-a561b849ebae10a6f5ef49e26c83cbbcd36c71bf/`, `code-manifest.json`, and `depth_anything_v2_vits.pth`.
- `/workspace/gp1/sam/`, its checkpoint and `/workspace/gp1/source.json`.
- `/workspace/gp1/lama/lama.pt`.
- `/workspace/pydeps/`, the existing isolated dependency overlay.
- `/workspace/gp2/`, this directory's Python files, assets, process IDs and operational logs.

Copy `gpu/*.py` into `/workspace/gp2/`; tar uploads to the NFS workspace need `--no-same-owner`.
With the GP0/GP1 assets present, the additional asset preparation command is:

```sh
/opt/venv/bin/python /workspace/gp2/prepare.py
```

It inherits only the platform's allowlisted network variables from PID 1 and never prints their values.
It verifies pinned MI-GAN source/weights, using the platform Hugging Face mirror for the checkpoint.
If GitHub downloads time out on the instance, fetch the exact URLs in `prepare.py` on the Mac, verify their listed SHA-256 values, and stage them under `/workspace/gp2/assets/` before repeating preparation.
Do not install another PyTorch build.

Install the official connector once using the provider's mounted installer, `/var/run/secrets/frp-self-service/install`.
The restart script verifies the already tested `rc-tunnel` 0.3.0 binary SHA-256 before changing any process.

Start or restart from the instance:

```sh
/opt/venv/bin/python /workspace/gp2/start.py
```

From this Mac worktree, the current one-line restart is:

```sh
ssh -o UserKnownHostsFile=.local/gpu/GP0/known_hosts -o StrictHostKeyChecking=accept-new -i ~/.ssh/radeon_cloud_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 -p <port> root@<instance-address> '/opt/venv/bin/python /workspace/gp2/start.py'
```

Then run this second command on the Mac, replacing the placeholder with the public URL printed above:

```sh
curl --fail --show-error --silent --max-time 20 'https://<assigned-id>.radeon.firstdg.ai/v1/health'
```

`start.py` serializes restarts, checks ownership before stopping its recorded model process, and waits for local health after the models warm.
It preserves an active native connector for port 8789 and its hostname when the broker still accepts it; otherwise it cleans up stale local connector state and allocates through the official CLI.
It checks local health only, then prints the allocated public URL and `NOISY_GPU_URL`.
The instance cannot reach its own public URL, so the Mac's second command verifies public health with normal TLS verification.
The service and connector survive the SSH connection closing; service output is in `/workspace/gp2/service.log` and native diagnostics use `rc-tunnel logs`.
The allocated public base URL is also recorded in `/workspace/gp2/public-url`.
Append `--keep-service` to the Python command to recover the connector while retaining the resident models and sessions.
For a foreground service, use `PYTHONPATH=/workspace/pydeps /opt/venv/bin/python /workspace/gp2/server.py`.

The platform can expire or destroy an instance independently of these processes.
If SSH fails, Nathan relaunches the `noisy GP0 PyTorch ROCm SSH` console template, updates the SSH host/port/known-hosts file, and checks that the prepared workspace survived before running the restart command.
The script does not relaunch instances or purchase credits.

## Native connector and hostname

The connector's child environment inherits the provider's `FRP_*` settings from PID 1 and removes `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and their lowercase variants.
The model service keeps its own network environment; no system environment or provider-managed configuration is changed.
Use the official CLI's `status`, `stop` and `logs` commands with that same isolated environment:

```sh
cd /workspace/gp2
/opt/venv/bin/python -c 'import os; from start import CLI, connector_environment; os.execve(str(CLI), [str(CLI), "status"], connector_environment())'
```

Replace `status` with `stop` to deliberately revoke the connector, or `logs` to inspect it.
Do not edit or publish the provider's managed connector state or credentials.

[The provider documents](https://amd-aim.github.io/radeon-cloud-docs/guides/tunnel/) one exposed port per notebook and a randomly assigned `rc-<id>.radeon.firstdg.ai` hostname.
Its `--prefix` flag is for operations compatibility, not a supported stable-hostname reservation; custom domains are unsupported.
An official stop revokes the old hostname and freezes its prefix for 24 hours, so recovery allocates a different URL.
The URL changes on every connector restart; update the app build's `gpu` setting to the printed URL before an export.
A missing broker reservation was observed after an origin interruption during model startup; the cause is unconfirmed, and even a model restart may require a new URL.
The script prints the allocated `NOISY_GPU_URL`; verify its public health from the Mac before using it.
The running app has no automatic URL discovery, and this service restart does not modify or publish an app build.

## Sessions and limits

Decoded RGB masters, depth and per-session SAM embeddings stay in memory.
Each request clones any mutable MI-GAN inputs; every returned plate restores the original RGB outside the thresholded hole.
No request photo or mask is written to disk, and access logging is disabled.
Errors log only their exception class, never the body, session identifier, client address or full exception text.
Request metrics log a random request identifier, a fixed operation label, status, stage durations and byte counts; they never contain URLs or image data.
`Server-Timing` and `X-Request-Id` correlate client measurements with these metadata-only logs.

Sessions expire 30 minutes after their last accepted request or two hours after creation; deletion makes the ID immediately unavailable.
A page reload can use the same ID from a new connection.
The service and models remain resident when all sessions expire.
There are at most 32 retained/creating sessions, 32 HTTP connections, two active analyses, and a 30-second combined wait for a session lock and analysis slot.
Creation is limited to ten accepted reservations per client address per minute.
The HTTP service binds only to loopback; the native connector supplies public ingress.
Capacity/queue failures return 503; rate failures return 429.
No new authentication policy is introduced for the hackathon.

Responses use `Cache-Control: no-store` and gzip for binary planes when the client supports it.
The fixed CORS allowlist follows the app contract.
The service does not persist sessions across process restart.

## Verification

```sh
python gpu/contract_test.py https://<assigned-id>.radeon.firstdg.ai --require-timings
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s gpu -p 'test_*.py'
```

Use the public URL printed by the restart command.
The contract test defaults to `src/assets/sample.jpg`; `--photo` selects a different file, and `--long-edge 1024` runs a smaller comparison.
It checks health, CORS, master-sized little-endian normalized f32 depth, the three soft-u8 candidates and scores, repeated taps, both fills, exact outside-hole preservation, concurrent clients, a new connection retaining a session, malformed/oversized input, and deletion.
It prints client-observed timings separately; `--require-timings` enforces the hybrid targets: session creation below three seconds and each warm plate fill below two seconds over the route.
Taps remain functionally checked and measured, with no public tap timing gate because the hybrid app runs taps on the device.
Only the header-only oversized-upload probe permits a connection closure instead of JSON 413 for a non-loopback URL; every other error check remains strict.
The probe always closes the client connection so the subsequent DELETE opens a fresh one; loopback still requires JSON 413.
Instance-local timings are useful diagnostics and do not establish the Mac-over-tunnel targets.
The lifecycle tests exercise the actual HTTP handler and the expiry, capacity, rate and queue policies without loading models.
