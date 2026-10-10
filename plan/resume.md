# Resume: the noisy hackathon demo

> Owns: the pickup point for any session that leads this clone from here. Read it first, then `plan/demo.md` sections 0 and 0.1.
> Does not own: the plan (`plan/demo.md`), the rules (`CLAUDE.md`, `AGENTS.md`), the runs (`plan/log.tsv`), the findings (`plan/findings.tsv`), the script (`plan/rehearsal.md`), the design record (`DESIGN.md`, `.impeccable/`).

Rewritten 2026-10-10 00:35 EDT by the build session as it closed on low context, updated 01:22 after PH1 merged and 09:15 after its open check closed. Clock note: earlier Linear comments from that session carry times up to two hours ahead of real time; the comment timestamps are right, the text is not.

## Update 2026-10-10 11:25 EDT (read this before the rest; it supersedes what it contradicts)

- Nathan's decisions at C2 (10:05 to 11:10): the iPad Pro (M-series) is the judge's device, the phone a fallback; the phone frame is essentials only (PRODUCT.md revised); projects (the photo, the scene JSON and the masks) autosave to a hosted store on Neon only, one shared space, no login, listed in a Projects panel on every device; the Mac-served store and the phone-to-Mac handoff are declined.
- PH2 is built and committed on the analysis lane only (`../noisy-demo-analysis`, branch `demo-analysis`, `eaf8cd4`): the phone frame (`src/ui/phone.tsx`, the tier in `app.css` at or under 760 px wide, 500 px tall, or 1100 px wide in portrait), `phone.layout` passes at 402 x 874, 390 x 844 and 834 x 1194 with the desktop set. Not merged into `demo` yet, on purpose.
- A second Codex session, driven by Nathan, runs CF1 (`plan/dispatches/CF1-hosting.md`: Cloudflare Pages advanced mode with an R2 binding, the editor at https://nathan.fish/) uncommitted in the main clone on `demo`: `tools/cloudflare/`, `test/cloudflare-hosting.test.ts`, `test/browser/scenarios/hosted.scenario.ts`, and the registration in `index.ts`. A remote `origin` (github.com/skaiyoh/noisy-demo, private) exists; nothing is pushed. Hold every merge into `demo` until Nathan says CF1 is done, read its diff first, then merge `demo-analysis` (conflict only in `plan/log.tsv`, union the rows).
- Servers: port 8790 serves the analysis lane's production build over TLS on the LAN (the iPad and phone; certificate `../noisy-demo/.local/tls`); port 8792 the main clone's production build for the Mac; port 8795 the lane's dev build for scenarios. None outlives its shell; restart from these notes.
- Next: PS1a, the project model, the store client, autosave and the Projects panel against a dev fixture in `tools/serve.mjs`, dispatched on top of PH2 in the analysis lane; PS1b, the same API on CF1's Worker with Neon and R2, after CF1 lands (Nathan creates the Neon project). Then the merge, the hosted verification, the rehearsal and the video (C3 20:30). Demo day now needs the internet on for the store.
- Budget: Fable at 21% of the week at 09:20; the 25% rule is in force.

## Where things are

- Clone: `~/dev/sandbox/noisy-demo`, branch `demo` at `9c756ba` plus the commits below. No git remote; nothing has left this machine. Devpost (Sunday 10:00) needs a public GitHub repository; its history (orphan commit, or the source history) is Nathan's open decision.
- Merged and verified on `demo` (verification of `b0499b5` at 00:25: 820 node tests, all eighteen dev scenarios, the three production scenarios): D1 to D6, D8a, R1 (a camera the page supplies), D7 (the page as a working editor; finish review scored resolved; `DESIGN.md` and `.impeccable/design.json` written), S1 (the stereo MPO export through the session, no page button), E1 (the surface pass: bars, cracks, scales), H1 (the window: UltraFace in a resident worker, the Window mode, the model count from the lock).
- PH1, the phone plumbing, returned at 01:18 and is merged on `demo` at `422f0a6` (826 node tests pass after the merge). Its one open check closed on 2026-10-10 at 09:08: `phone.tilt` failed only because the scenario forced its re-render with an empty style patch, which the reducer reports as unchanged, so nothing published and the rails never re-rendered; the page itself already gated Tilt and Take a photo on `navigator.maxTouchPoints > 0`. The scenario now makes a real grain change, and `phone.tilt` and `window.track` pass on `demo` (`test-results/chrome-20261010T130440Z-7b65/`). The TLS certificate is generated in the main clone (`.local/tls/`, SANs for the Bonjour name and today's addresses) and the production build is current. `plan/phone.md` holds Nathan's phone steps.
- Lanes: `../noisy-demo-render` (branch `demo-render`) and `../noisy-demo-analysis` (branch `demo-analysis`), both behind `demo`; fast-forward with `git merge --ff-only demo` before any use; `../noisy-demo-driver` (stale, holds one uncommitted duplicate line in `AGENTS.md`; leave it or let Nathan remove it).
- `../noisy-demo-3ds-lab` (detached at `dd3fb8f`): Nathan's X3 emulation lab, all untracked (`experiments/3ds-lab/`, `plan/dispatches/X3-emulation-lab.md`, `plan/evidence/X3-return.md`). Its `REPORT.md` says do not merge the worktree and do not copy the prototype wholesale: a Node bridge and host-side tests are proven on the Mac, no `.3dsx` was ever built (the devkitPro hosts answered 403), nothing ran on a console. A post-hackathon starting point under priority 3, not a C3 candidate.
- The face model sits at `models/face-34cd7e60.onnx` and is in the lock.
- Budget at C2 (09:20): Fable at 21% of the week, all models 31%. The 25% rule in `CLAUDE.md` is in force: no independent Claude review from here; Claude dispatches, judges and commits. The scenario fix is `f97a690` on `demo`.
- Priorities (Nathan, 2026-10-09 23:45; `plan/demo.md` 0.1): the desktop first, done; the phone second (PH1 plumbing, then PH2 the portrait layout); the 3DS a parked companion (F11); the gallery with Neon (G1) stays; Databricks has no identified use.
- Linear: NATE-258 (the demo; briefings as comments), NATE-259 (actions waiting on Nathan), project noisy.

## Mechanics that bit this session

- Dispatch ids must be unique across `plan/dispatches/`: the runner takes the first `<id>-*.md`, and `M1`/`M2` already name the planning session's merge dispatches (a mistaken M1 run is in the log). Check with `ls plan/dispatches | rg '^<id>-'` before naming.
- `plan/codex-resume.sh <id> <message-file>` takes a file, not a string.
- Run lane scenarios on side ports (render 8793 dev, 8794 production; analysis 8795, 8796): Codex may start its own server on 8790 during a dispatch.
- Merging a lane into `demo` conflicts in `plan/log.tsv` every time; resolve by the union of both sides' rows (a six-line Python regex over the conflict markers), then `git commit --no-edit`.
- The screenshot capture for finish reviews is `plan/tools/review.scenario.ts`: copy it to `test/browser/scenarios/`, register it in `index.ts`, run `review.shots`, then remove both; never commit it in the tree. The captures go to `.impeccable/review/` (gitignored), which the reviewer reads.
- The impeccable hook's deep pass keeps flagging the nine declined decision sketches under `.impeccable/mocks/decision/`; per-rule per-file ignores are recorded in `.impeccable/config.json`. A folder-level ignore needs Nathan's explicit yes (asked, not answered).
- `impeccable concept-seed --help` runs a roll instead of printing help.
- The node floor can hang: one serve test (F13 in `plan/findings.tsv`) times out when `test/serve.test.ts` runs whole and its spawned `tools/check-headers.mjs` outlives the timeout, so the runner never finishes. Run `test/serve.test.ts` apart from the rest, and `pkill -f check-headers.mjs` if a run stalls; the test passes alone, and the hang predates today.

## How to verify and run

```sh
npm run typecheck && node --test --test-timeout=60000 $(ls test/*.test.ts | grep -v drive-chrome)
npm run build && node tools/serve.mjs --mode dev            # port 8790
node tools/drive-chrome.mjs --base-url http://127.0.0.1:8790/ --target dev \
  demo.import demo.download render.first-look render.outline render.camera-stage render.depth-edge render.symbols \
  driver.import driver.plate driver.failure objects.tap objects.two-subjects render.loop render.loop-objects \
  render.view export.stereo render.surface window.track
npm run build:production && node tools/serve.mjs --mode production --port 8792
node tools/drive-chrome.mjs --base-url http://127.0.0.1:8792/ --target production story.production story.production-errors render.surface-controls-production
```

Hands on: `npm run serve`, open `http://127.0.0.1:8790/` in Chrome, drop a JPEG or click `Try a sample`; Window needs the webcam prompt accepted.

## Next, in order

1. The phone: `plan/phone.md` steps 2 to 11 are Nathan's (AirDrop and trust `.local/tls/ca.pem`, same Wi-Fi, Safari on `https://nathans-macbook-air.local:8790/`); the first import on the iPhone 16 Pro is the memory test. The servers started at 09:10 (`--mode production --host 0.0.0.0 --tls .local/tls` on 8790 for the phone; plain production on 8792 for the Mac sitting) do not outlive the session that started them; restart them from the commands in `plan/phone.md` step 6 and the verify block above.
2. C2, Saturday 08:30, Nathan's sitting: the look, the effects and the window on three real photos (`OUTLINE_SLOPE_PER_WORKING_TEXEL` in `src/render/shaders/outline.ts` is the likeliest knob, finding F6); he starts making his finished pieces (PNG stills through Download; screen recordings for loops and the window); the `/usage` figure into a checkpoint row of `plan/log.tsv`; the public-repository decision; the PH2 structure decision below.
3. PH2, the portrait layout: a surface brief of its own under `DESIGN.md` (`impeccable surface-brief write` for the phone surface with a FIRST VIEWPORT at 390 x 844), after Nathan picks a structure through the structured question tool. Candidates, conventional end first: (a) stage on top, the inspector as a scrolling column below, the mode rail fixed at the bottom; (b) stage on top, one node at a time in a horizontal strip under it, swipe between nodes; (c) full-screen stage with a floating bottom toolbar and the nodes as a sheet that slides up; (d) two pages, Photo and Tools, switched by bottom tabs; (e) the layers as a horizontal strip between stage and tools. Then a dispatch like D7's, scoped to `src/ui` and `app.css` with `@media` tiers, verified by captures at 390 x 844 through `page.emulate({ mobile: true })`.
4. G1, the gallery with Neon on the hosted site (Cloudflare Pages, the models in R2); needs Nathan's accounts; `plan/demo.md` section 9 has the shape.
5. V1 and D8b: rewrite `plan/rehearsal.md` for six minutes (the live creation, the window, the phone if it lands, the finished pieces from Finder); C3 Saturday 20:30 rehearsal recorded as the Devpost video; the write-up; the public repository; the Figma board from `plan/figma.md`; the demo-day checklist in `plan/demo.md` section 10 plus the pieces folder.
6. The one big commit when Nathan says (`git reset --soft 177d329`, or an orphan root if he chooses no source history), and the push only when he says.

## Still waiting on Nathan (NATE-259)

- The public repository's history.
- Cloudflare (and Neon) accounts for the hosted site and the gallery.
- A Databricks use, or dropping that track.
- A real photo for `src/assets/sample.jpg`; the iPhone camera on Most Compatible; the Figma board; `/usage` at each checkpoint; the PH2 structure pick.

## After the hackathon

`plan/findings.tsv` (F1 to F12) goes to one replan session in the source project (`~/dev/skaiyoh/noisy`), per `plan/demo.md` section 8: no code merges back; keepers go to the source's `decisions.tsv` and ADRs.
