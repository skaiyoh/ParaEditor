# Phone demo from the Mac

The production build must exist before starting the server.
Run `npm run build:production` on the Mac if it has not been built.

1. On the Mac, run `node tools/make-cert.mjs`.
   It creates `.local/tls/ca.pem` once and refreshes the 825-day server certificate with the Bonjour name, localhost, loopback and the Mac's current IPv4 addresses.
2. AirDrop `.local/tls/ca.pem` to the iPhone and accept it.
3. Open Settings and install the downloaded certificate profile under General > VPN & Device Management.
4. Open Settings > General > About > Certificate Trust Settings and enable full trust for **noisy local phone CA**.
5. Join the same Wi-Fi network on the Mac and the iPhone.
   If the venue network blocks devices from reaching each other, enable the iPhone's Personal Hotspot with **Maximize Compatibility** and join it from the Mac.
   When changing networks, rerun `node tools/make-cert.mjs` to include the new addresses, then restart the server if it is already running.
   The server reads its certificate at startup; the CA stays the same, so the installed trust does not need repeating.
6. On the Mac, start `node tools/serve.mjs --mode production --host 0.0.0.0 --tls .local/tls`.
7. In Safari on the iPhone, open `https://nathans-macbook-air.local:8790/`.
   If Bonjour lookup fails, use the Mac's current IPv4 address printed by the certificate tool, such as `https://172.31.84.5:8790/` on today's venue network.
8. Tap **Try a sample** first and wait for **Ready to tap**.
   Record the elapsed time from tapping to readiness and the Depth and Encoder timings shown under Scene.
9. Tap **Take a photo**, use the rear camera, accept the photo, and wait for **Ready to tap**.
   Record the elapsed time from accepting the photo to readiness, the Scene timings, the photo dimensions, and any crash, reload or stalled page.
10. Hold the phone comfortably below vertical and tap **Tilt**.
    Allow motion/orientation access when Safari asks.
    The first orientation event captures this rest pose; lean left/right and forward/back to move the picture.
    About 20 degrees reaches the full parallax travel.
    Toggle Tilt off and on to recenter.
    With no sensor data for two seconds after permission, the status reads **Tilt unavailable** and Tilt turns off.
11. Tap **Window**, allow camera access, and lean in front of the phone's front camera.
    Window stops Tilt; enabling Tilt stops Window and releases its camera.
    Record whether each mode moves the picture and any memory-related crash or reload.
12. Stop the Mac server with Ctrl-C when finished.

`--host` defaults to `127.0.0.1`.
Without `--tls`, the server uses HTTP as before.
`--tls <dir>` reads `server.pem` and `server-key.pem` from that directory.
Take a photo and Tilt appear only on touch devices; Open remains available.

Apple documents the [certificate requirements](https://support.apple.com/en-us/103769) and [full-trust setting](https://support.apple.com/en-us/102390).
