#!/usr/bin/env bash
set +e
echo "=== ANDON/DCI NETWORK DIAGNOSTIC 2.2 ==="
echo "[IP]"; ip -br -4 addr
echo "[ROUTES]"; ip -4 route | grep -E '^default|^10\.138\.' || true
echo "[CLIENTS]"; cat /var/lib/andon-network-fix/clients.txt 2>/dev/null || true
echo "[SERVICES]"
for u in andon.service dci.service nginx.service avahi-daemon.service andon-network-fix.service andon-client-register.service; do
  printf '%-36s enabled=%-12s active=%s\n' "$u" "$(systemctl is-enabled "$u" 2>/dev/null)" "$(systemctl is-active "$u" 2>/dev/null)"
done
echo "[PORTS]"; ss -lunp | grep ':8788 ' || true; ss -lntp | grep -E ':80 |:3000 |:3100 ' || true
echo "[HTTP]"
curl -sS -o /dev/null -w 'ANDON backend %{http_code}\n' --max-time 4 http://127.0.0.1:3000/api/build || true
curl -sS -o /dev/null -w 'DCI backend   %{http_code}\n' --max-time 4 http://127.0.0.1:3100/datacenter/ || true
curl -sS -o /dev/null -H 'Host: andon.local' -w 'ANDON nginx %{http_code}\n' --max-time 4 http://127.0.0.1/ || true
curl -sS -o /dev/null -H 'Host: dci.local' -w 'DCI nginx %{http_code}\n' --max-time 4 http://127.0.0.1/datacenter/ || true
echo "[CORE]"; cat /var/lib/andon-dci-network-core.version 2>/dev/null || true
