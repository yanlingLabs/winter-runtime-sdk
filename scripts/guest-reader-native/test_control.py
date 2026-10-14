"""Pure control data tests; no descriptor, native or process operation."""
import struct
import unittest

from control import ControlRefusal, decode, wait_exit_code


class ControlTests(unittest.TestCase):
    def test_init_requires_one_opaque_descriptor(self):
        self.assertEqual(decode(b"I", (7,)), ("init", 7))
        # These are opaque integers, not claimed live descriptors.
        self.assertEqual(decode(b"I", (0,)), ("init", 0))
        for rights in ((), (7, 8), (7, 7), (-1,), (True,), (1.0,), (2**31,)):
            with self.subTest(rights=rights), self.assertRaises(ControlRefusal):
                decode(b"I", rights)

    def test_every_normal_exit_code_has_exact_little_endian_receipt(self):
        for code in range(256):
            status = code << 8
            self.assertEqual(decode(b"R" + struct.pack("<I", status), ()), ("reaped", status))
            self.assertEqual(wait_exit_code(status), code)

    def test_signals_and_core_flag_map_to_monitor_exit(self):
        for signal in range(1, 65):
            for core in (0, 0x80):
                status = signal | core
                self.assertEqual(decode(b"R" + struct.pack("<I", status), ()), ("reaped", status))
                self.assertEqual(wait_exit_code(status), 128 + signal)

    def test_stopped_continued_reserved_and_high_bits_refuse(self):
        for status in (0x7F, 0x137F, 0xFFFF, 0x80, 65, 0x0109, 0x10000, 0xFFFFFFFF):
            with self.subTest(status=status), self.assertRaises(ControlRefusal):
                decode(b"R" + struct.pack("<I", status), ())

    def test_terminal_receipt_never_accepts_a_descriptor(self):
        with self.assertRaises(ControlRefusal):
            decode(b"R\0\0\0\0", (7,))

    def test_truncated_extra_unknown_and_coalesced_messages_refuse(self):
        for data in (b"", b"I\0", b"R", b"R\0", b"R\0\0\0", b"R\0\0\0\0\0", b"X\0\0\0\0", b"IR\0\0\0\0"):
            with self.subTest(data=data), self.assertRaises(ControlRefusal):
                decode(data, ())

    def test_only_plain_bytes_and_tuple_are_accepted(self):
        for data, rights in ((bytearray(b"I"), (7,)), (memoryview(b"I"), (7,)), ("I", (7,)), (b"I", [7])):
            with self.subTest(data=type(data).__name__), self.assertRaises(ControlRefusal):
                decode(data, rights)
        for status in (True, -1, 0.0, "0", None):
            with self.subTest(status=status), self.assertRaises(ControlRefusal):
                wait_exit_code(status)


if __name__ == "__main__":
    unittest.main()
