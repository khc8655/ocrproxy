#!/usr/bin/env python3
"""
Test suite for OCRProxy VM Server Runner (Dual-Stack IPv6 / IPv4 Socket & Graceful Fallback).
Guarantees that run_server.py NEVER crashes regardless of IPv6 availability in host OS kernel.
Runs both locally and during release pre-flight gates.
"""
import os
import sys
import socket
import unittest
from pathlib import Path
from unittest.mock import patch

# Add vm-app root to sys.path
SCRIPT_DIR = Path(__file__).resolve().parent
VM_APP_ROOT = SCRIPT_DIR.parent
if str(VM_APP_ROOT) not in sys.path:
    sys.path.insert(0, str(VM_APP_ROOT))

from run_server import create_dual_stack_socket


class TestRunServerDualStack(unittest.TestCase):
    def setUp(self):
        self.allocated_sockets = []

    def tearDown(self):
        for s in self.allocated_sockets:
            try:
                s.close()
            except Exception:
                pass
        self.allocated_sockets.clear()

    def _get_free_port(self) -> int:
        temp_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        temp_sock.bind(("127.0.0.1", 0))
        port = temp_sock.getsockname()[1]
        temp_sock.close()
        return port

    def test_ipv4_explicit_bind(self):
        """When host is IPv4 (e.g. 127.0.0.1), bind AF_INET directly."""
        port = self._get_free_port()
        sock = create_dual_stack_socket(port, host_override="127.0.0.1")
        self.allocated_sockets.append(sock)

        self.assertEqual(sock.family, socket.AF_INET)
        # Verify it can accept connections
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            client.connect(("127.0.0.1", port))
            accepted, addr = sock.accept()
            self.allocated_sockets.append(accepted)
            self.assertEqual(addr[0], "127.0.0.1")
        finally:
            client.close()

    def test_ipv6_unsupported_fallback_errno_97(self):
        """Simulate kernel where IPv6 is completely disabled (Errno 97 EAFNOSUPPORT).
        Must gracefully fall back to IPv4 0.0.0.0 without raising an exception."""
        port = self._get_free_port()
        real_socket = socket.socket

        def mock_socket(family, type=socket.SOCK_STREAM, proto=0, fileno=None):
            if family == socket.AF_INET6:
                raise OSError(97, "Address family not supported by protocol")
            return real_socket(family, type, proto, fileno=fileno)

        with patch("socket.socket", side_effect=mock_socket):
            sock = create_dual_stack_socket(port, host_override="::")
            self.allocated_sockets.append(sock)

            self.assertEqual(sock.family, socket.AF_INET)
            self.assertEqual(sock.getsockname()[0], "0.0.0.0")
            self.assertEqual(sock.getsockname()[1], port)

            # Test actual client connect over IPv4
            client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                client.connect(("127.0.0.1", port))
                accepted, _ = sock.accept()
                self.allocated_sockets.append(accepted)
            finally:
                client.close()

    def test_ipv6_bind_failure_fallback_errno_99(self):
        """Simulate kernel where IPv6 socket can be created but bind('::') fails (Errno 99 EADDRNOTAVAIL).
        Must catch exception and gracefully fall back to IPv4 0.0.0.0."""
        port = self._get_free_port()
        real_socket = socket.socket

        class MockAFINET6Socket:
            def __init__(self, family, *args, **kwargs):
                self.family = family

            def setsockopt(self, *args, **kwargs):
                pass

            def bind(self, address):
                # Throw Errno 99 on IPv6 bind
                raise OSError(99, "Cannot assign requested address")

            def close(self):
                pass

        def mock_socket(family, type=socket.SOCK_STREAM, proto=0, fileno=None):
            if family == socket.AF_INET6:
                return MockAFINET6Socket(family, type, proto)
            return real_socket(family, type, proto, fileno=fileno)

        with patch("socket.socket", side_effect=mock_socket):
            sock = create_dual_stack_socket(port, host_override="::")
            self.allocated_sockets.append(sock)

            self.assertEqual(sock.family, socket.AF_INET)
            self.assertEqual(sock.getsockname()[0], "0.0.0.0")
            self.assertEqual(sock.getsockname()[1], port)

    def test_ipv6_loopback_fallback_to_127_0_0_1(self):
        """When host is ::1 and fails, it must fall back to 127.0.0.1 rather than 0.0.0.0."""
        port = self._get_free_port()
        real_socket = socket.socket

        def mock_socket(family, type=socket.SOCK_STREAM, proto=0, fileno=None):
            if family == socket.AF_INET6:
                raise OSError(97, "Address family not supported by protocol")
            return real_socket(family, type, proto, fileno=fileno)

        with patch("socket.socket", side_effect=mock_socket):
            sock = create_dual_stack_socket(port, host_override="::1")
            self.allocated_sockets.append(sock)

            self.assertEqual(sock.family, socket.AF_INET)
            self.assertEqual(sock.getsockname()[0], "127.0.0.1")
            self.assertEqual(sock.getsockname()[1], port)


if __name__ == "__main__":
    unittest.main()
