"""
OCRProxy VM True Dual-Stack (IPv4 / IPv6) Server Runner
Binds an AF_INET6 socket with IPV6_V6ONLY=0 so a single port can receive both
IPv6 public/direct traffic and IPv4 local/NAT traffic.
Gracefully falls back to IPv4 (0.0.0.0 / 127.0.0.1) if IPv6 is not available.
"""
import os
import sys
import socket
import logging
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("ocrproxy.runner")

# Ensure project root is in sys.path
PROJECT_DIR = Path(__file__).resolve().parent
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

# Load .env file
try:
    from dotenv import load_dotenv
    env_file = os.environ.get("ENV_FILE", str(PROJECT_DIR / ".env"))
    if os.path.exists(env_file):
        load_dotenv(env_file)
    else:
        load_dotenv()
except ImportError:
    pass

APP_PORT = int(os.environ.get("APP_PORT", "8787"))
APP_HOST = os.environ.get("APP_HOST", "").strip()


def create_dual_stack_socket(port: int, backlog: int = 2048, host_override: str = None) -> socket.socket:
    """Create and bind a socket. If APP_HOST is set to IPv4 (e.g. 127.0.0.1 for reverse proxy), bind AF_INET.
    Otherwise attempt dual-stack AF_INET6 (:: with IPV6_V6ONLY=0); if IPv6 is not supported or binding fails,
    gracefully fall back to IPv4 (0.0.0.0 / 127.0.0.1) so the server never crashes on IPv4-only cloud hosts.
    """
    host = host_override if host_override is not None else (APP_HOST or "::")

    # 1. Explicit IPv4 or non-IPv6 address: bind AF_INET directly
    if host in ("127.0.0.1", "0.0.0.0") or (":" not in host and host != ""):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
        sock.listen(backlog)
        logger.info("Bound IPv4 socket on %s:%d", host, port)
        return sock

    # 2. Attempt true dual-stack IPv6 socket
    try:
        sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            # Enable dual-stack: allow IPv4-mapped IPv6 addresses (v6only=0)
            sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (AttributeError, OSError) as opt_err:
            logger.debug("IPV6_V6ONLY socket option could not be set: %s", opt_err)
        sock.bind((host, port))
        sock.listen(backlog)
        logger.info("Bound dual-stack IPv6 socket on [%s]:%d (v6only=0)", host, port)
        return sock
    except OSError as e:
        # Graceful fallback: If IPv6 is disabled in kernel, not supported, or :: cannot be bound
        fallback_host = "127.0.0.1" if host in ("::1", "localhost") else "0.0.0.0"
        logger.warning(
            "Dual-stack IPv6 bind on [%s]:%d failed (%s); gracefully falling back to IPv4 (%s:%d)",
            host, port, e, fallback_host, port
        )
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((fallback_host, port))
        sock.listen(backlog)
        logger.info("Bound fallback IPv4 socket on %s:%d", fallback_host, port)
        return sock


def main():
    import uvicorn
    sock = create_dual_stack_socket(APP_PORT)
    config = uvicorn.Config(
        "app.main:app",
        log_level="info",
        access_log=True,
        # Max simultaneous client connections before uvicorn answers 503.
        # Agent mode keeps long-lived SSE streams open, so 150 was easy to hit
        # with several IDE agents in parallel.  Override with UVICORN_LIMIT_CONCURRENCY.
        limit_concurrency=int(os.environ.get("UVICORN_LIMIT_CONCURRENCY", "512")),
        timeout_keep_alive=30,
        timeout_graceful_shutdown=10,
    )
    server = uvicorn.Server(config)
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()

