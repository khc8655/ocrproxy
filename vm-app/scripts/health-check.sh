#!/bin/bash
# Health check for ocrproxy — called by systemd timer every 60s.
# If the HTTP health endpoint doesn't respond within 10s, the service
# is considered hung and gets restarted.  This catches the "soft hang"
# scenario where the process is alive (so Restart=on-failure doesn't
# trigger) but stuck in GC thrashing or cgroup memory pressure.

PORT=8787
if [ -f /opt/ocrproxy/.env ]; then
    ENV_PORT=$(grep -oP 'APP_PORT=\K\d+' /opt/ocrproxy/.env 2>/dev/null)
    [ -n "$ENV_PORT" ] && PORT=$ENV_PORT
fi

timeout 10 curl -sf http://127.0.0.1:${PORT}/health > /dev/null 2>&1
if [ $? -ne 0 ]; then
    logger -t ocrproxy-health "Health check FAILED on port ${PORT} — restarting ocrproxy.service"
    systemctl restart ocrproxy.service
fi
