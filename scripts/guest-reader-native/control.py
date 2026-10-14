"""Decode the reader monitor's two control messages as data only.

The caller owns every received descriptor, even on refusal. Before this call it
must reject truncated recvmsg payload/control and unexpected ancillary types.
This decoder does not check descriptor type, peer credentials, ordering, process
ownership or termination. A decoded R message is not proof of reap/drain/cleanup.
"""
import struct


class ControlRefusal(ValueError):
    pass


def wait_exit_code(status: int) -> int:
    """Validate a terminal Linux waitpid status; return the C monitor exit code."""
    if type(status) is not int or not 0 <= status <= 0xFFFF:
        raise ControlRefusal("terminal wait status required")
    low = status & 0xFF
    if low == 0:
        return status >> 8
    signal = low & 0x7F
    if status >> 8 or not 1 <= signal <= 64:
        raise ControlRefusal("terminal wait status required")
    return 128 + signal


def decode(data: bytes, rights: tuple[int, ...]) -> tuple[str, int]:
    """Return ('init', opaque_fd) or ('reaped', raw_wait_status), never authority.

    ARM64 little-endian is the exact admitted packet target. Only the caller's
    explicit SCM_RIGHTS tuple is accepted; no descriptor is opened or closed.
    """
    if type(data) is not bytes or type(rights) is not tuple:
        raise ControlRefusal("control packet types")
    if len(rights) > 1 or any(type(fd) is not int or not 0 <= fd <= 0x7FFFFFFF for fd in rights):
        raise ControlRefusal("control descriptor envelope")
    if data == b"I" and len(rights) == 1:
        return "init", rights[0]
    if len(data) == 5 and data[:1] == b"R" and not rights:
        status = struct.unpack_from("<I", data, 1)[0]
        wait_exit_code(status)
        return "reaped", status
    raise ControlRefusal("control message envelope")
