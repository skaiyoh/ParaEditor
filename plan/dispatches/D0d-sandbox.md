# D0d: sandbox check (no code changes)

Run exactly these two commands and report their last five lines each as your final message, then stop. Do not change any file.

1. `node -e "require('fs').mkdtempSync(require('os').tmpdir()+'/noisy-'); require('net').createServer().listen(0,'127.0.0.1',function(){console.log('listen ok', this.address().port); this.close()})"`
2. `npm test -- test/start.test.ts test/depth-size.test.ts`
