# ANDON/DCI Windows Wi-Fi Watchdog R2.4.4

Windows-side network watchdog for the shared Raspberry Pi at `10.138.43.217`.

The Raspberry Pi remains on the shared ANDON/DCI Network Core 2.2.0:
- UDP registration on port 8788
- per-client return routes
- rp_filter=2
- NetworkManager dispatcher
- Nginx/Avahi

R2.4.4 is Windows-only. It removes the legacy route repair that could restore
`10.138.43.217/32 -> 10.138.95.1 -> Ethernet` and keeps the working route via
the active corporate Wi-Fi gateway.

Verified working example:
- Windows: 10.138.41.140
- Gateway: 10.138.40.1
- RPi: 10.138.43.217
- UDP: ANDON_DCI_OK 10.138.41.140
- TCP/80: successful

No ANDON/DCI application version bump or new RPi payload is required.
