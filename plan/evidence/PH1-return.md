# PH1 return

## What changed

- `tools/make-cert.mjs`: generates a P-256 local CA once, retains it on refresh, and signs an 825-day server certificate with current IPv4 SANs; prints the CA path and phone trust steps; supports `--outdir` for isolated CLI tests.
- `tools/serve.mjs`: adds `--host` and `--tls`, shares the existing handler between HTTP and HTTPS, and records the transport scheme in dev request rows.
- `src/session/view-driver.ts`: owns generation cancellation, disposal, the 120 ms smoother, camera mapping and motion clock for either input source.
- `src/session/window.ts`: supplies the existing front-camera face target, capture cadence and tracker lifecycle to the shared driver.
- `src/session/tilt.ts`: requests permission in the click stack, captures the first valid rest pose, clamps beta/gamma travel at 20 degrees, and turns off with `Tilt unavailable` after two seconds without a valid first event.
- `src/session/scene.ts`: makes Window and Tilt mutually exclusive and shares their plate requests, tap zoom, frame selection and stop paths.
- `src/session/test-hooks.ts`: adds dev-only `injectOrientation` and accounts for either view in the plate probe.
- `src/ui/app.tsx`: adds touch-only Take a photo and Tilt, using the existing rails; the hidden environment capture input imports through the existing `importFile` path.
- `test/make-cert.test.ts`: exercises the real certificate CLI, OpenSSL verification, SANs, lifetime, key permissions, CA retention, leaf refresh and incomplete-CA refusal.
- `test/serve.test.ts`: exercises CA-verified HTTPS in both modes, LAN binding, existing routes and headers, scheme logging, and missing-TLS-file refusal.
- `test/browser/scenarios/phone.scenario.ts`: registers `phone.tilt` coverage for orientation, mutual exclusion, restoration, timeout, permission cancellation, camera input import and desktop gating; writes `phone-desktop.png` and `phone.png` when the lead runs it.
- `test/browser/scenarios/index.ts`: registers the phone scenario file.
- `test/browser/page-globals.d.ts`: declares the orientation injection surface.
- `plan/phone.md`: gives ordered phone setup and observation steps, including certificate refresh plus server restart when changing networks.
- `.gitignore`: clarifies that the existing `/.local/` exclusion covers the CA and TLS keys.
- `docs/ARCHITECTURE.md`: updates only the Dev server binding, startup output and flag descriptions.

Generated `.local/tls/ca.pem`, `ca-key.pem`, `server.pem` and `server-key.pem` locally.
Regenerated the dev and production builds.
No runtime dependency, branch or commit was added.
No CSS, portrait layout, render, core, analysis or photo source was changed.

## Acceptance

1. **PASS** - `npm run typecheck`, `npm run build`, `npm run build:production` and the prescribed non-Chrome node suite passed.
   The full suite reports 826 passed, zero failed and zero skipped.
   The focused certificate/server run reports 33 passed, including CA-verified HTTPS in dev and production modes.

2. **PASS** - `node tools/make-cert.mjs` generated the required files under `.local/tls/`.
   `openssl x509 -in .local/tls/server.pem -noout -text` was run; the SAN extension is:

   ```text
   X509v3 Subject Alternative Name:
       DNS:Nathans-MacBook-Air.local, DNS:localhost, IP Address:127.0.0.1, IP Address:169.254.204.138, IP Address:172.31.84.5
   ```

3. **PASS** - started the exact production command:

   ```sh
   node tools/serve.mjs --mode production --host 0.0.0.0 --tls .local/tls --port 8797
   ```

   `curl -sk https://127.0.0.1:8797/` returned HTTP 200 with the isolation headers.
   `curl -sk https://127.0.0.1:8797/assets-static/app.css` returned HTTP 200 with `text/css; charset=utf-8`.
   Relevant observed response lines:

   ```text
   root HTTP 200
   HTTP/1.1 200 OK
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   Cross-Origin-Resource-Policy: same-origin
   Content-Type: text/html; charset=utf-8

   css HTTP 200
   HTTP/1.1 200 OK
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   Content-Type: text/css; charset=utf-8

   CA-verified root HTTP 200
   ```

   The last line is an additional curl request using `--cacert .local/tls/ca.pem`, with verification enabled.
   Stopped the server with SIGINT; its process exited 0.
   A subsequent connection check returned `stopped server HTTP 000`, confirming no response on port 8797.

4. **LEAD** - run `phone.tilt` against the dev HTTP target on loopback.
   The scenario dispatches a browser orientation event for the rest pose, then injects gamma +15/-15 and beta changes through the dev surface.
   It checks that the near object moves left for positive gamma and right for negative gamma, clamps at 20 degrees, restores frame zero at four opaque sampled points including the object edges, excludes Window in both directions, stops camera tracks, and times out after two seconds without an event.
   It also checks permission call ordering, denial, late grants, recentering, motion/plate sharing, the capture input and JPEG import.
   Neither the scenario nor its screenshots was executed here.

   ```sh
   node tools/drive-chrome.mjs phone.tilt window.track
   ```

5. **LEAD** - Nathan's iPhone 16 Pro Safari run is pending.
   The phone was not exercised here; readiness, sensor behavior and memory behavior are unobserved.
   Timings to fill from that run:

   | Observation | Result |
   | --- | --- |
   | HTTPS page opens with the installed CA trusted | Not observed |
   | Try a sample to Ready to tap, elapsed milliseconds | Not observed |
   | Sample Depth / Encoder timings | Not observed |
   | Accept camera photo to Ready to tap, elapsed milliseconds | Not observed |
   | Camera photo dimensions and Depth / Encoder timings | Not observed |
   | Tilt moves the picture | Not observed |
   | Window works with the front camera | Not observed |
   | Crash, reload, stalled page or other memory behavior | Not observed; no phone run performed |

   Record an observed crash or reload as a finding, as the dispatch specifies.
   Phone steps, in order:

   1. Run `node tools/make-cert.mjs` on the Mac.
   2. AirDrop `.local/tls/ca.pem` to the iPhone.
   3. Install its downloaded profile in Settings > General > VPN & Device Management.
   4. Enable full trust for noisy local phone CA in General > About > Certificate Trust Settings.
   5. Join the same network; use the iPhone hotspot with Maximize Compatibility if the venue network isolates clients.
      After switching networks, refresh the certificate and restart a running server; the CA remains installed and trusted.
   6. Start `node tools/serve.mjs --mode production --host 0.0.0.0 --tls .local/tls` with the production build present.
   7. Open `https://nathans-macbook-air.local:8790/` in Safari.
      The current IPv4 fallback is `https://172.31.84.5:8790/`.
   8. Try a sample first, then Take a photo; wait for Ready to tap and record both elapsed and Scene timings.
      Enable Tilt from a comfortable pose below vertical, then test Window with the front camera and record memory behavior.

   The complete checklist is in `plan/phone.md`.

6. **LEAD** - every existing browser scenario still needs running on the changed build.
   Run `node tools/drive-chrome.mjs` for the full registry.
   `phone.tilt` additionally checks that setting touch capability to zero removes both new controls and leaves the existing desktop action and mode rails.
   Both new buttons are gated on `navigator.maxTouchPoints > 0`, without a dev-build exception.
   The source preserves Try a sample as the second action-rail button.
   No current desktop browser behavior or screenshot is claimed as verified here.

7. **PASS** - the impeccable detector reports no blocking findings on `src/ui/app.tsx`.
   Its last manual report, from `/Users/nathandavis/.agents/skills/impeccable/scripts/impeccable detect --json src/ui/app.tsx`, exited 0:

   ```json
   []
   ```

   The edit hook also reported no deterministic design-quality issues.
   This mechanical result does not replace the LEAD visual checks.

## Checks run

`npm run typecheck` - exit 0, including the final scenario changes:

```text
> noisy@0.0.0 typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.test.json
```

`npm run build` - exit 0:

```text
> noisy@0.0.0 build
> node tools/build.mjs --mode dev
build: dev 9c756ba95033-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo-analysis/build/dev (45 files)
```

`npm run build:production` - exit 0:

```text
> noisy@0.0.0 build:production
> node tools/build.mjs --mode production
build: production 9c756ba95033-20261010 -> /Users/nathandavis/dev/sandbox/noisy-demo-analysis/build/production (14 files)
```

`node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)` - passed:

```text
ℹ tests 826
ℹ suites 0
ℹ pass 826
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37513.770334
```

`node --test --test-timeout=60000 test/make-cert.test.ts test/serve.test.ts` - passed:

```text
ℹ tests 33
ℹ suites 0
ℹ pass 33
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4370.36875
```

`node tools/drive-chrome.mjs --list phone.tilt window.track` - exit 0; registry discovery only, no browser launched:

```text
window.track  dev  H1        Local webcam window tracks a smoothed face and restores still/loop
phone.tilt    dev  PH1       Touch photo capture and orientation share the Window view driver
```

The certificate CLI, OpenSSL SAN inspection, production curl checks, verified-CA curl, server shutdown and detector were exercised as recorded above.
`git diff --check` restricted to PH1's changed tracked files exited 0.
Browser scenarios, current browser screenshots and the iPhone workflow were skipped under the sandbox instructions, and remain LEAD.

Claude performed a planning review and a final static correctness review.
The final verdict was: `no static correctness blockers found`.
Applied its scoped handoff fixes: certificate refresh/restart instructions, below-vertical pose guidance, a dispatched orientation event, and capture-attribute inspection.
Confirmed its selector and timing-shape uncertainties directly against the UI and analysis driver source.
The source also confirms that the existing analysis `windowEnabled` callback is used only to decide plate need, and the header contract does not disable orientation sensors through Permissions-Policy.

The shipped impeccable finish reviewer returned `disposition: recapture` because finished-build captures do not exist here.
Its source notes found both controls consistent with the existing system and keyboard/focus patterns; visual approval remains LEAD.
The shipped documenter performed a read-only comparison and reported that PH1 needs no visual-system documentation changes.

## Noticed, not done

- Pre-existing `plan/log.tsv` remains untouched.
  An unrestricted `git diff --check` reports its trailing whitespace; the PH1-restricted check passes.
  Exact unrelated output:

  ```text
  plan/log.tsv:42: trailing whitespace.
  +M1\tdispatch\t2026-10-10T00:25\t2026-10-10T00:28\tcodex\tgpt-6.1-sol\txhigh\t180\t3\t575476\t518656\t5658\t\texit-0\t
  ```

- Impeccable reports a pre-existing stale `design.json` sidecar and an unset `buildPath`.
  Refreshing the sidecar through `document` and reviewing the build-path setting are outside PH1; neither was changed.
- The UI review raised sticky touch hover as an unconfirmed device observation to inspect in the phone capture.
  It also suggested expanded Tilt error copy; the dispatch's exact `Tilt unavailable` status was retained.
- Portrait reflow and surface-brief changes remain M2's work.

## Findings

- **VERIFIED** - `.local/` was already gitignored; no duplicate exclusion was needed.
- **VERIFIED** - a server loads its certificate once at startup, so refreshed address SANs require restarting it; the phone guide now says so.
- **VERIFIED** - no static correctness blocker was found in the Claude review; browser and phone evidence remains absent.
- **INFERRED** - orientation behavior near vertical and the existing detached front-camera video path still require the real Safari run.
  No phone failure or memory result was observed here.

## Time

- Start, from `date`: `2026-10-10 00:28:44 EDT`.
- End, from `date`: `2026-10-10 01:15:56 EDT`.
