"""Portable data/injected lifecycle tests, no native effects or output execution."""
import importlib.util
from pathlib import Path
import struct
import stat
import os
from types import SimpleNamespace
from unittest.mock import patch
import selectors
import socket
import array
import sys
import unittest

path = Path(__file__).with_name('producer.py')
spec = importlib.util.spec_from_file_location('reader_producer', path)
p = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = p
spec.loader.exec_module(p)


class Tests(unittest.TestCase):
    def test_exact_closed_launcher_recipe(self):
        libs = tuple((i + 10, name) for i, name in enumerate(p.LIBRARIES))
        argv = p.launcher_argv(3, 4, 5, 6, libs)
        self.assertEqual(argv[:12], ['/artifacts/instructionReaderLauncher',
            'instruction-reader-v1', '3', p.VIEW, '4', str(p.UID), str(p.GROUP),
            '5', p.SOURCE, p.SOURCE, '6', '6'])
        self.assertEqual(len(argv), 24)
        for wrong in (libs[:-1], tuple(reversed(libs)), ((3, libs[0][1]), *libs[1:])):
            with self.assertRaises(p.Refusal): p.launcher_argv(3, 4, 5, 6, wrong)

    def test_registered_before_start_and_no_failure_cleanup_claim(self):
        r = p.Registry()
        class Op:
            def __init__(self,debt):self.debt=debt
            def start(self):
                assert len(r.debts) == 1 and r.debts[0].phase == 'registered'
                raise OSError('inert setup failure')
        with self.assertRaises(OSError): p.start_registered(r, Op)
        self.assertTrue(r.debts[0].uncertain)
        self.assertFalse(r.debts[0].complete())
        with self.assertRaises(p.Refusal): r.register()

    def test_native_operation_uses_registered_debt_identity(self):
        registry=p.Registry();observed=[]
        class Op:
            def __init__(self,debt):self.debt=debt;observed.append(debt)
            def start(self):self.debt.pid=123;return 123
        debt,op=p.start_registered(registry,Op)
        self.assertIs(debt,op.debt);self.assertIs(debt,observed[0]);self.assertIs(debt,registry.debts[0])
        wrong=p.Registry()
        class Foreign(Op):
            def __init__(self,debt):self.debt=p.Debt()
        with self.assertRaises(p.Refusal):p.start_registered(wrong,Foreign)
        self.assertTrue(wrong.debts[0].uncertain)

    def test_failed_lambda_factory_operation_remains_explicitly_owned(self):
        registry = p.Registry()
        class Op:
            def __init__(self, debt):
                self.debt = debt
                self.cleanup_handles = {90, 91}  # Inert owned resources.
            def start(self):
                self.debt.pid = 123
                raise OSError('injected uncertain start')
        with self.assertRaises(OSError):
            p.start_registered(registry, lambda debt: Op(debt))
        self.assertIs(registry.operation.debt, registry.debts[0])
        self.assertEqual(registry.operation.cleanup_handles, {90, 91})
        self.assertEqual(registry.operation.debt.pid, 123)
        self.assertTrue(registry.operation.debt.uncertain)

    def test_exact_receipt_and_all_drain_observations_required(self):
        d = p.Debt(phase='running', pid=123)
        p.observe_native(d, b'I', (80,))
        with self.assertRaises(p.Refusal): p.observe_native(d, b'I', (81,))
        p.observe_native(d, b'R' + struct.pack('<I', 0), ())
        self.assertFalse(p.finish_registered(d, launcher_reaped=True,
            output_drained=False, descriptor_drained=True))
        self.assertTrue(p.finish_registered(d, launcher_reaped=True,
            output_drained=True, descriptor_drained=True))
        self.assertEqual(d.phase, 'drained')

    def test_unknown_receipts_and_reap_without_init_refuse(self):
        for data, fds in ((b'', ()), (b'I', ()), (b'Ix', (80,)), (b'R0000', (80,))):
            with self.assertRaises(p.Refusal): p.parse_receipt(data, fds)
        with self.assertRaises(p.Refusal): p.observe_native(p.Debt(phase='running'), b'R0000', ())

    def test_cancel_is_terminal_idempotent_and_error_retains_debt(self):
        d = p.Debt(phase='running', pid=123)
        class Op:
            calls = 0
            def cancel(self): self.calls += 1; raise OSError('inert cancel failure')
        op = Op()
        with self.assertRaises(OSError): p.cancel_registered(d, op)
        p.cancel_registered(d, op)
        self.assertEqual(op.calls, 1)
        self.assertTrue(d.uncertain)
        self.assertFalse(p.finish_registered(d, launcher_reaped=True,
            output_drained=True, descriptor_drained=True))

    def test_stdio_sources_validate_before_remapping(self):
        pipes=(40,41,42);roles=(3,4,5)
        get_stat=lambda fd: SimpleNamespace(st_mode=stat.S_IFIFO)
        get_flags=lambda fd: os.O_RDONLY if fd==40 else os.O_WRONLY
        p.validate_stdio(pipes,roles,get_stat=get_stat,get_flags=get_flags)
        for wrong in ((40,40,42),(3,41,42)):
            with self.assertRaises(p.Refusal): p.validate_stdio(wrong,roles,get_stat=get_stat,get_flags=get_flags)
        with self.assertRaises(p.Refusal): p.validate_stdio(pipes,roles,get_stat=lambda fd: SimpleNamespace(st_mode=stat.S_IFREG),get_flags=get_flags)
        with self.assertRaises(p.Refusal): p.validate_stdio(pipes,roles,get_stat=get_stat,get_flags=lambda fd: os.O_RDONLY)

    def collector_fixture(self, messages):
        class Socket:
            closed = False
            def fileno(self): return 26
            def setblocking(self, value): pass
            def recvmsg(self, *args): return messages.pop(0)
            def close(self): self.closed = True
        class Poll:
            def __init__(self): self.keys = {}; self.closed = False
            def register(self, fd, events, data=None):
                key = fd.fileno() if hasattr(fd,'fileno') else fd
                self.keys[key] = SimpleNamespace(fd=key,data=data)
            def unregister(self, fd): self.keys.pop(fd.fileno() if hasattr(fd,'fileno') else fd)
            def get_map(self): return self.keys
            def select(self, timeout): return [(next(iter(self.keys.values())),1)] if self.keys else []
            def close(self): self.closed=True
        op=p.NativeOperation(p.Debt(phase='running',pid=123),None,5,6,lambda _:None,lambda _:None,
                             pidfd_validator=lambda fd,pid: 456)
        op.control=Socket();op.pidfd=27;op.input_fd=23;op.output_fd=24;op.error_fd=25;op.fds={23,24,25,27}
        op.cancel=lambda: setattr(op,'cancelled',True)
        return op,Poll

    def test_control_refusal_closes_all_installed_rights(self):
        for flags, raw in ((socket.MSG_CTRUNC,array.array('i',[70]).tobytes()),(0,array.array('i',[70,71]).tobytes())):
            op,Poll=self.collector_fixture([(b'I',[(socket.SOL_SOCKET,socket.SCM_RIGHTS,raw)],flags,None)])
            closed=[]
            with patch.object(selectors,'DefaultSelector',Poll),patch.object(p.os,'set_blocking'),patch.object(p.os,'close',side_effect=closed.append):
                with self.assertRaises(p.Refusal): op.collect(b'{}')
            self.assertIn(70,closed)
            if len(raw)==8:self.assertIn(71,closed)
            self.assertTrue(op.cancelled);self.assertTrue(op.debt.uncertain)

    def test_blocked_stdin_uses_absolute_deadline_and_closes_owned_fds(self):
        op,Poll=self.collector_fixture([])
        op.init_pidfd=70;op.debt.init_pidfd=70  # Injected already-validated I.
        class InputFirst(Poll):
            def select(self,timeout): return [(self.keys[23],1)]
        ticks=iter([0,0,7]);closed=[]
        with patch.object(selectors,'DefaultSelector',InputFirst),patch.object(p.time,'monotonic',side_effect=lambda:next(ticks)),patch.object(p.os,'set_blocking'),patch.object(p.os,'write',side_effect=BlockingIOError),patch.object(p.os,'close',side_effect=closed.append):
            with self.assertRaisesRegex(p.Refusal,'deadline'): op.collect(b'{}')
        self.assertTrue(op.cancelled);self.assertEqual(set(closed),{23})
        self.assertEqual(op.fds,{24,25,27});self.assertFalse(op.debt.descriptor_drained)
        self.assertFalse(op.debt.launcher_reaped)

    def test_control_eof_waits_for_pidfd_readiness_before_reap(self):
        op,Poll=self.collector_fixture([(b'I',[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[70]).tobytes())],0,None),(b'R'+struct.pack('<I',0),[],0,None),(b'',[],0,None)])
        events=[]
        class Observed(Poll):
            def select(self,timeout):
                if set(self.keys)=={27}:events.append('pidfd-ready')
                return super().select(timeout)
        def write(fd,data): return len(data)
        def wait(pid,flags):
            self.assertIn('pidfd-ready',events);events.append('reap');return(pid,0)
        real_read=p.os.read;real_close=p.os.close
        def read(fd,length): return b'' if fd in (24,25) else real_read(fd,length)
        def close(fd):
            if fd not in (23,24,25,27,70):real_close(fd)
        with patch.object(selectors,'DefaultSelector',Observed),patch.object(p.os,'set_blocking'),patch.object(p.os,'write',side_effect=write),patch.object(p.os,'read',side_effect=read),patch.object(p.os,'waitpid',side_effect=wait),patch.object(p.os,'close',side_effect=close):
            self.assertEqual(op.collect(b'{}'),(b'',b''))
        self.assertEqual(events,['pidfd-ready','reap']);self.assertTrue(op.debt.complete())

    def test_bounded_capture(self):
        self.assertEqual(p.bounded_capture([b'hello', b'\n']), b'hello\n')
        for chunks in ([b'x' * (p.IO_MAX + 1)], ['wrong']):
            with self.assertRaises(p.Refusal): p.bounded_capture(chunks)

    def test_init_pidfd_observations_are_not_arbitrary_rights(self):
        good=b'pos:\t0\nPid:\t456\nNSpid:\t456\t1\n'
        self.assertEqual(p.init_pid_identity(good,b'Name:\treader\nPPid:\t123\n',123),456)
        for wrong in (good.replace(b'456\t1',b'456\t2'),good.replace(b'456\t1',b'456'),
                      good.replace(b'Pid:\t456',b'Pid:\t-1'),good+b'Pid:\t456\n'):
            with self.assertRaises(p.Refusal):p.init_pid_identity(wrong,b'PPid:\t123\n',123)
        with self.assertRaises(p.Refusal):p.init_pid_identity(good,b'PPid:\t124\n',123)


if __name__ == '__main__': unittest.main()
