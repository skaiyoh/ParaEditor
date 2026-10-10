# D0f: can headless Chrome start here? (no code changes)

Run these commands in order and report, as your final message, each one's exit code and last three lines of output, then stop. Change no file in the repository.

1. `D=$(mktemp -d); "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --user-data-dir="$D" --screenshot="$D/a.png" --window-size=400,300 about:blank; echo "exit=$?"; ls -la "$D"/a.png`
2. `D=$(mktemp -d); "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-sandbox --disable-gpu --user-data-dir="$D" --screenshot="$D/b.png" --window-size=400,300 about:blank; echo "exit=$?"; ls -la "$D"/b.png`
3. `node --test --test-timeout=60000 test/drive-chrome.test.ts 2>&1 | tail -12`
