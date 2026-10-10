1.
```text
listen ok 56280
```

2.
```text
  Error [EnvironmentError]: Chrome did not answer over the DevTools pipe (Browser.getVersion: Chrome closed the DevTools pipe); see /var/folders/6n/28db3_lx6q98rrtzm9jc39w00000gn/T/noisy-drive-chrome-Bq1PlZ/run/chrome.log
      at launchChrome (file:///Users/nathandavis/dev/sandbox/noisy-demo/test/browser/driver/chrome.ts:676:11)
      at async TestContext.<anonymous> (file:///Users/nathandavis/dev/sandbox/noisy-demo/test/drive-chrome.test.ts:189:21)
      at async Test.run (node:internal/test_runner/test:1102:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:777:7)
```