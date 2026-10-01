#!/usr/bin/env bash
set +e
echo "======================================================================"
echo " ANDON/DCI NETWORK DIAGNOSTIC R2.1"
echo "======================================================================"
echo
echo "[IP]"
ip -br -4 addr
echo
echo "[ROUTES 10.138]"
ip -4 route | grep -E '^10\.138\.|^default' || true
echo
echo "[ROUTE TEST]"
for ip in 10.138.40.21 10.138.41.140 10.138.42.21 10.138.43.21; do
  echo "$ip:"
  ip -4 route get "$ip" 2>/dev/null | head -n1
done
echo
echo "[SERVICES]"
for u in andon.service dci.service nginx.service avahi-daemon.service andon-dci-vlan-routing.service; do
  printf '%-36s enabled=%-12s active=%s\n' "$u" \
    "$(systemctl is-enabled "$u" 2>/dev/null)" \
    "$(systemctl is-active "$u" 2>/dev/null)"
done
echo
echo "[HTTP LOCAL]"
curl -sS -o /dev/null -w 'ANDON backend %{http_code}\n' --max-time 4 http://127.0.0.1:3000/api/build || true
curl -sS -o /dev/null -w 'DCI backend   %{http_code}\n' --max-time 4 http://127.0.0.1:3100/datacenter/ || true
curl -sS -o /dev/null -H 'Host: andon.local' -w 'ANDON nginx   %{http_code}\n' --max-time 4 http://127.0.0.1/ || true
curl -sS -o /dev/null -H 'Host: dci.local' -w 'DCI nginx     %{http_code}\n' --max-time 4 http://127.0.0.1/datacenter/ || true
echo
echo "[MDNS]"
avahi-resolve-host-name -4 andon.local 2>/dev/null || true
avahi-resolve-host-name -4 dci.local 2>/dev/null || true
echo
echo "[CORE VERSION]"
cat /var/lib/andon-dci-network-core.version 2>/dev/null || true
