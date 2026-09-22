"""
OCRProxy VM True Dual-Stack (IPv4 / IPv6) Server Runner
Binds an AF_INET6 socket with IPV6_V6ONLY=0 so a single port can receive both
IPv6 public/direct traffic and IPv4 local/NAT traffic.
"""
import os
import sys
import socket
from pathlib import Path
from dotenv import load_dotenv
import uvicorn

# Ensure project root is in sys.path
PROJECT_DIR = Path(__file__).resolve().parent
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

# Load .env file
env_file = os.environ.get("ENV_FILE", str(PROJECT_DIR / ".env"))
if os.path.exists(env_file):
    load_dotenv(env_file)
else:
    load_dotenv()

APP_PORT = int(os.environ.get("APP_PORT", "8787"))
APP_HOST = os.environ.get("APP_HOST", "").strip()


def create_dual_stack_socket(port: int, backlog: int = 2048) -> socket.socket:
    """Create and bind a socket. If APP_HOST is set to IPv4 (e.g. 127.0.0.1 for reverse proxy), bind AF_INET. Otherwise bind dual-stack AF_INET6."""
    host = APP_HOST or "::"
    if host in ("127.0.0.1", "0.0.0.0") or (":" not in host):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
    else:
        sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            # Enable dual-stack: allow IPv4-mapped IPv6 addresses (v6only=0)
            sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (AttributeError, OSError):
            pass
        sock.bind((host, port))

    sock.listen(backlog)
    return sock


def main():
    sock = create_dual_stack_socket(APP_PORT)
    config = uvicorn.Config(
        "app.main:app",
        log_level="info",
        access_log=True,
        limit_concurrency=150,
        timeout_keep_alive=30,
        timeout_graceful_shutdown=10,
    )
    server = uvicorn.Server(config)
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
