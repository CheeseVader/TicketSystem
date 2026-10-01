#!/usr/bin/env bash
set -u
SERVICE_IP="${ANDON_DCI_SERVICE_IP:-10.138.43.217}"

echo "======================================================================"
echo " ANDON/DCI NETWORK DIAGNOSTIC - READ ONLY"
echo "======================================================================"
date -Is
echo

echo "--- IPv4 ---"
ip -br -4 addr || true
echo

echo "--- ROUTES ---"
ip -4 route show table main || true
echo

echo "--- ROUTE TO SAMPLE CLIENTS ---"
for ipx in 10.138.40.21 10.138.41.21 10.138.42.21 10.138.43.21; do
  printf '%-16s ' "$ipx"
  ip -4 route get "$ipx" 2>/dev/null | head -n1 || true
done
echo

echo "--- LEGACY /32 VIA GATEWAY ---"
ip -4 route show table main 2>/dev/null |
  awk '$1 ~ /^10\.138\.(40|41|42|43)\.[0-9]+\/32$/ && $0 ~ / via / {print}' || true
echo

echo "--- SERVICES ---"
for unit in andon.service dci.service nginx.service avahi-daemon.service andon-network-fix.service andon-client-register.service dci-mdns.service; do
  printf '%-34s enabled=%-12s active=%s\n' \
    "$unit" \
    "$(systemctl is-enabled "$unit" 2>/dev/null || true)" \
    "$(systemctl is-active "$unit" 2>/dev/null || true)"
done
echo

echo "--- PORTS ---"
ss -lntup 2>/dev/null | grep -E ':80\b|:3000\b|:3100\b|:5353\b' || true
echo

echo "--- AVAHI ---"
grep -Ev '^\s*(#|$)' /etc/avahi/avahi-daemon.conf 2>/dev/null || true
echo
cat /etc/avahi/hosts 2>/dev/null || true
echo
avahi-resolve-host-name -4 andon.local 2>/dev/null || true
avahi-resolve-host-name -4 dci.local 2>/dev/null || true
echo

echo "--- NGINX ---"
nginx -t 2>&1 || true
echo
curl -sS -o /dev/null -H 'Host: andon.local' -w 'ANDON via nginx HTTP %{http_code}\n' --max-time 5 http://127.0.0.1/ || true
curl -sS -o /dev/null -H 'Host: dci.local' -w 'DCI via nginx HTTP %{http_code}\n' --max-time 5 http://127.0.0.1/datacenter/ || true
echo

echo "--- CORE VERSION ---"
cat /var/lib/andon-dci-network-core.version 2>/dev/null || echo "not installed"
echo

echo "NOTA: si un peer esta dentro del CIDR real de la RPi, 'ip route get' no debe forzarlo por 'via gateway'."
echo "mDNS/Bonjour no cruza VLANs por si solo; para otra VLAN se requiere reflector/ACL de infraestructura."
