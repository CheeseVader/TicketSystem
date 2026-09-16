#!/usr/bin/env bash
set +e
echo "============================================================"
echo " ANDON RPI - DIAGNOSTICO R1"
echo "============================================================"
echo
echo "[HOST]"
hostname
hostname -I
ip -br addr
echo
echo "[RUTAS]"
ip route
echo
echo "[SERVICIOS]"
systemctl --no-pager --full status andon.service | tail -n 25
echo
systemctl --no-pager --full status avahi-daemon.service | tail -n 12
echo
systemctl --no-pager --full status cloudflared-andon.service | tail -n 20
echo
echo "[PUERTOS]"
ss -lntp | grep -E '(:3000|:5432)' || true
echo
echo "[HTTP]"
curl -i --max-time 5 http://127.0.0.1:3000/api/build
echo
echo "[VERSION]"
cat /opt/andon/app/VERSION 2>/dev/null || true
node -v
npm -v
psql --version
cloudflared --version 2>/dev/null || true
echo
echo "[ESPACIO/RAM]"
df -h /
free -h
echo
echo "[ULTIMOS LOGS ANDON]"
journalctl -u andon.service -n 40 --no-pager
echo
echo "[ULTIMOS LOGS CLOUDFLARED]"
journalctl -u cloudflared-andon.service -n 30 --no-pager
