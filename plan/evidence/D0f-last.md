1. Exit code: **1** (Chrome: **134**). Only two output lines:
```text
exit=134
ls: /var/folders/6n/28db3_lx6q98rrtzm9jc39w00000gn/T/tmp.Pj3YsV7F1B/a.png: No such file or directory
```

2. Exit code: **1** (Chrome: **134**). Only two output lines:
```text
exit=134
ls: /var/folders/6n/28db3_lx6q98rrtzm9jc39w00000gn/T/tmp.hQAqCAPWSi/b.png: No such file or directory
```

3. Pipeline exit code: **0** (`tail`; test output reports failure). Last three lines:
```text
      at async TestContext.<anonymous> (file:///Users/nathandavis/dev/sandbox/noisy-demo/test/drive-chrome.test.ts:189:21)
      at async Test.run (node:internal/test_runner/test:1102:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:777:7)
```