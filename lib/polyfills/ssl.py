"""SSL module shim for WASI.

Provides constants and classes needed by httpx, anyio, and other
networking packages to import without errors. Actual TLS operations
are handled by the Cloudflare Workers runtime, not Python.
"""

import enum

# Protocol versions
PROTOCOL_TLS = 2
PROTOCOL_TLS_CLIENT = 16
PROTOCOL_TLS_SERVER = 17

# Verify modes
CERT_NONE = 0
CERT_OPTIONAL = 1
CERT_REQUIRED = 2

# Options
OP_NO_SSLv2 = 0x01000000
OP_NO_SSLv3 = 0x02000000
OP_NO_TLSv1 = 0x04000000

# Alert/error
SSL_ERROR_EOF = 6
SSL_ERROR_SSL = 1
SSL_ERROR_WANT_READ = 2
SSL_ERROR_WANT_WRITE = 3

HAS_SNI = True
HAS_ECDH = True
HAS_NPN = False
HAS_ALPN = True

OPENSSL_VERSION = "PyMode-WASI (no real OpenSSL)"
OPENSSL_VERSION_NUMBER = 0


class SSLError(OSError):
    pass

class SSLCertVerificationError(SSLError):
    pass

class SSLZeroReturnError(SSLError):
    pass

class CertificateError(SSLError):
    pass


class Purpose(enum.Enum):
    SERVER_AUTH = "1.3.6.1.5.5.7.3.1"
    CLIENT_AUTH = "1.3.6.1.5.5.7.3.2"


class SSLContext:
    """SSLContext for PyMode WASI runtime.

    In Cloudflare Workers, TLS is handled by the runtime itself via fetch().
    This provides the interface that packages like httpx and anyio check
    at import time for TLS capability detection.
    """
    def __init__(self, protocol=PROTOCOL_TLS):
        self.protocol = protocol
        self.verify_mode = CERT_NONE
        self.check_hostname = False
        self.options = 0
        self._alpn_protocols = []
        self._ciphers = None

    def load_default_certs(self, purpose=None):
        pass

    def load_cert_chain(self, certfile, keyfile=None, password=None):
        pass

    def load_verify_locations(self, cafile=None, capath=None, cadata=None):
        pass

    def set_ciphers(self, ciphers):
        self._ciphers = ciphers

    def set_alpn_protocols(self, protocols):
        self._alpn_protocols = list(protocols)

    def wrap_socket(self, sock, server_side=False, do_handshake_on_connect=True,
                    suppress_ragged_eofs=True, server_hostname=None):
        raise SSLError("TLS not available in WASI - use Cloudflare Workers fetch() for HTTPS")


def create_default_context(purpose=Purpose.SERVER_AUTH, cafile=None, capath=None, cadata=None):
    ctx = SSLContext(PROTOCOL_TLS_CLIENT)
    ctx.verify_mode = CERT_REQUIRED
    ctx.check_hostname = True
    return ctx


def _create_unverified_context(protocol=PROTOCOL_TLS, cert_reqs=CERT_NONE):
    ctx = SSLContext(protocol)
    ctx.verify_mode = cert_reqs
    return ctx

_create_default_https_context = create_default_context
