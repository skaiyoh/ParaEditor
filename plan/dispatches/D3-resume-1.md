# D3 resume: the plate scenario failed in the lead's run

The lead ran your three scenarios in headless Chrome 155 against the real models:
`driver.import` PASS in 12.7 s (depth 1959 ms, the rest in `driver-initial-timeline.json`), `driver.failure` PASS, `driver.plate` FAIL:

```
timed out after 5000 ms waiting for plate reports preparing; last value null
    at Object.waitFor (test/browser/driver/chrome.ts:489:17)
```

No console errors, no `driver-plate-timeline.json` was written (the scenario died before writing anything), so there is no further evidence.
`last value null` is what the polled expression returned every time.

Do these, in order, and nothing else:

1. Work out from the code why `preparing` was never observed and why the probe returned null: whether `injectMask` fails to make `plateNeeded(doc)` true, whether `setMotion` or `requestPlate` returns before the status is published, whether the status is published to a different field than the probe reads, or whether the plate finished (or failed) within one poll. Say which it was, with the lines.
2. Fix the cause in the session or driver if it is a product defect, or the probe if it is a scenario defect.
3. Make the scenario write `driver-plate-timeline.json` before each wait (status, analysis snapshot, products summary, `plateNeeded`) so a failure leaves evidence, and make the `preparing` check accept the case where the plate completes within one poll: assert that either `preparing` was seen or `plate` became true with `plateNeeded` false, and record which.
4. Run `npm run typecheck`, `npm run build`, and the node-test command from `AGENTS.md`; update the Return's Acceptance 4 and add a "Resume 1" note with the cause; stop.
