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
It verifies pinned MI-GAN source/weights and `cloudflared` 2026.10.0, using the platform Hugging Face mirror for the checkpoint.
If GitHub downloads time out on the instance, fetch the exact URLs in `prepare.py` on the Mac, verify their listed SHA-256 values, and stage them under `/workspace/gp2/assets/` before repeating preparation.
Do not install another PyTorch build.

Start or restart both processes from the instance:

```sh
/opt/venv/bin/python /workspace/gp2/start.py
```

From this Mac worktree, the current one-line restart is:

```sh
ssh -o UserKnownHostsFile=.local/gpu/GP0/known_hosts -o StrictHostKeyChecking=accept-new -i ~/.ssh/radeon_cloud_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 -p 31109 root@36.150.116.206 '/opt/venv/bin/python /workspace/gp2/start.py'
```

`start.py` serializes restarts, stops only its recorded processes after checking their commands, waits for the models/health endpoint, and starts the connector.
It leaves the service independent of the SSH connection and writes `service.log` and `tunnel.log` on the instance.
Verify the public health URL after startup; successful local startup alone does not prove tunnel reachability.
For a foreground service, use `PYTHONPATH=/workspace/pydeps /opt/venv/bin/python /workspace/gp2/server.py`.

The platform can expire or destroy an instance independently of these processes.
If SSH fails, Nathan relaunches the `noisy GP0 PyTorch ROCm SSH` console template, updates the SSH host/port/known-hosts file, and checks that the prepared workspace survived before running the restart command.
The script does not relaunch instances or purchase credits.

## Tunnel and hostname

The connector uses HTTP/2 to the Cloudflare edge.
If `/workspace/gp2/tunnel.token` exists, it must contain only the tunnel token, be readable only by its owner, and remain on the instance.
The Cloudflare API credential and database connection string must never be copied into that file or the public repository.
Without a tunnel token, startup runs a quick tunnel and its generated public URL appears in `tunnel.log`.
Quick URLs change on connector restart.

The API setup requires `Account > Cloudflare Tunnel > Edit` and `Zone > DNS > Edit` for `nathan.fish`.
It creates a remotely managed tunnel, configures `gpu.nathan.fish` to `http://127.0.0.1:8789` with a terminal `http_status:404` ingress rule, then creates the proxied CNAME to `<tunnel-id>.cfargotunnel.com`.
Do not overwrite an unrelated existing DNS record.
See [Cloudflare's API setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/).

If the token cannot create the tunnel, the dashboard path is:

1. Cloudflare dashboard > Zero Trust > Networks > Connectors > Cloudflare Tunnels > Create a tunnel > Cloudflared.
2. Name it `noisy-radeon-gp2`, save it, and choose Linux/Debian, 64-bit.
3. Take only the token from the displayed connector command and securely place it in `/workspace/gp2/tunnel.token` on the instance; set permissions to `600`.
4. Add a published application route: subdomain `gpu`, domain `nathan.fish`, service type `HTTP`, URL `127.0.0.1:8789`; save.
5. Run the restart command and check `https://gpu.nathan.fish/v1/health`.

The connector still needs outbound access to Cloudflare; creating DNS alone cannot fix a platform egress restriction.

## Sessions and limits

Decoded RGB masters, depth and per-session SAM embeddings stay in memory.
Each request clones any mutable MI-GAN inputs; every returned plate restores the original RGB outside the thresholded hole.
No request photo or mask is written to disk, and access logging is disabled.
Errors log only their exception class, never the body, session identifier, client address or full exception text.

Sessions expire 30 minutes after their last request; deletion makes the ID immediately unavailable.
A page reload can use the same ID from a new connection.
The service and models remain resident when all sessions expire.
There are at most 32 retained/creating sessions, 32 HTTP connections, two active analyses, and a 30-second combined wait for a session lock and analysis slot.
Creation is limited to ten attempts per client address per minute, using Cloudflare's client IP header through the loopback-only ingress.
Capacity/queue failures return 503; rate failures return 429.
No new authentication policy is introduced for the hackathon.

Responses use `Cache-Control: no-store` and gzip for binary planes when the client supports it.
The fixed CORS allowlist follows the app contract.
The service does not persist sessions across process restart.

## Verification

```sh
python gpu/contract_test.py https://gpu.nathan.fish
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s gpu -p 'test_*.py'
```

Pass a quick-tunnel base URL in place of the hostname when necessary.
The contract test defaults to `src/assets/sample.jpg`; `--photo` selects a different file, and `--long-edge 1024` runs a smaller comparison.
It checks health, CORS, master-sized little-endian normalized f32 depth, the three soft-u8 candidates and scores, repeated taps, both fills, exact outside-hole preservation, concurrent clients, a new connection retaining a session, malformed/oversized input, and deletion.
It prints client-observed timings separately; add `--require-timings` to fail when session creation reaches two seconds or a warm tap reaches 300 ms.
Instance-local timings are useful diagnostics and do not establish the Mac-over-tunnel targets.
The lifecycle tests exercise the actual HTTP handler and the expiry, capacity, rate and queue policies without loading models.
