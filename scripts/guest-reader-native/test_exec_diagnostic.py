"""Pure record and injected bootstrap tests: no fork, mount, chroot or exec."""
from contextlib import ExitStack
import ctypes
import errno
import os
import struct
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import producer as p


class Tests(unittest.TestCase):
    def test_records_require_closed_exact_shape_and_eof_is_not_exec_proof(self):
        empty=p.decode_bootstrap_record(b'')
        self.assertEqual(empty,{'recordObserved':False,'step':'unknown','errno':0})
        self.assertNotIn('execConfirmed',empty)
        for index,name in enumerate(p.BOOTSTRAP_STEPS,1):
            self.assertEqual(p.decode_bootstrap_record(p.bootstrap_record(index,errno.EBADF)),
                             {'recordObserved':True,'step':name,'errno':errno.EBADF})
        for raw in (b'x',b'x'*7,b'x'*9,struct.pack('<II',0,0),struct.pack('<II',13,0),struct.pack('<II',1,4095)):
            with self.subTest(raw=raw),self.assertRaises(p.Refusal):p.decode_bootstrap_record(raw)
        for step,code in ((True,0),(1,True),(1,-1),(1,1.0)):
            with self.assertRaises(p.Refusal):p.bootstrap_record(step,code)

    def test_added_errno_codes_remain_observed_without_raw_error_text(self):
        added=(3,7,8,14,16,18,19,21,26,36,75,80,87)
        for code in added:
            with self.subTest(code=code):
                raw=p.bootstrap_record(9,code)
                self.assertEqual(p.decode_bootstrap_record(raw)['errno'],code)
                with patch.object(p.os,'write',return_value=8) as write:
                    p.emit_bootstrap_failure(90,9,OSError(code,'private path'))
                self.assertEqual(write.call_args.args[1],raw)
        with patch.object(p.os,'write',return_value=8) as write:
            p.emit_bootstrap_failure(90,9,OSError(4095,'private path'))
        self.assertEqual(p.decode_bootstrap_record(write.call_args.args[1]),
            {'recordObserved':True,'step':'exec','errno':0})

    def test_failure_writes_only_fixed_record_no_exception_rendering(self):
        class Hidden(OSError):
            def __str__(self):raise AssertionError('no raw text')
        writes=[]
        with patch.object(p.os,'write',side_effect=lambda fd,raw:writes.append((fd,raw)) or len(raw)):
            self.assertTrue(p.emit_bootstrap_failure(90,9,Hidden(errno.ENOENT,'secret path')))
        self.assertEqual(writes,[(90,struct.pack('<II',9,errno.ENOENT))])
        with patch.object(p.os,'write',return_value=0):self.assertFalse(p.emit_bootstrap_failure(90,2,ValueError('secret')))
        with patch.object(p.os,'write',side_effect=BlockingIOError):
            with self.assertRaises(BlockingIOError):p.emit_bootstrap_failure(90,2,ValueError('secret'))

    def test_ctypes_errno_used_only_for_the_two_ctypes_syscall_steps(self):
        with patch.object(p.os,'write',return_value=8) as write,patch.object(p.ctypes,'get_errno',return_value=errno.EPERM):
            p.emit_bootstrap_failure(90,5,p.Refusal('private bootstrap mount namespace'))
            self.assertEqual(struct.unpack('<II',write.call_args.args[1]),(5,errno.EPERM))
            p.emit_bootstrap_failure(90,3,p.Refusal('root guard'))
            self.assertEqual(struct.unpack('<II',write.call_args.args[1]),(3,0))

    def bootstrap(self,failed=None):
        events=[]
        class Function:
            def __init__(self,name):self.name=name
            def __call__(self,*args):
                events.append(self.name)
                if failed==self.name:ctypes.set_errno(errno.EPERM);return -1
                return 0
        libc=SimpleNamespace(unshare=Function('unshare'),mount=Function('mount'))
        def effect(name):
            def call(*args):
                events.append((name,args))
                if failed==name:raise OSError(errno.EBADF,'private source path')
            return call
        class ExecReached(BaseException):pass
        def execute(*args):
            events.append(('exec',args))
            if failed=='exec':raise OSError(errno.ENOENT,'private source path')
            raise ExecReached
        with ExitStack() as stack:
            for target,name,value in ((p,'root_linux',lambda:None),(p,'validate_stdio',lambda *_:None),(p.ctypes,'CDLL',lambda *_ ,**kw:libc),(p,'install_reopened_inputs',effect('reopen_inputs')),(p,'reopen_protected_path',lambda _:80),(p.os,'close',effect('close')),(p.os,'fstat',lambda _:SimpleNamespace(st_dev=1,st_ino=10,st_mode=0o40555,st_uid=0,st_gid=0,st_nlink=2,st_size=0,st_mtime_ns=1,st_ctime_ns=2)),(p.os,'dup2',effect('dup2')),(p.os,'fchdir',effect('fchdir')),(p.os,'chroot',effect('chroot')),(p.os,'chdir',effect('chdir')),(p.os,'closerange',effect('close_range')),(p.os,'set_inheritable',effect('inheritable')),(p.os,'execve',execute)):
                stack.enter_context(patch.object(target,name,value))
            try:p.child_bootstrap(10,('/launcher','unchanged'),(100,101),(40,41,42),error_fd=90,stage=lambda value:events.append(('step',value)),reopen_inputs=((10,'/run/inert/root',(1,10,0o40555,0,0,2,0,1,2)),))
            except (ExecReached,p.Refusal,OSError) as error:return events,error,libc
        self.fail('inert exec must not return')

    def test_error_writer_stays_cloexec_and_never_enters_public_argv(self):
        events,error,libc=self.bootstrap()
        self.assertEqual([event[1] for event in events if isinstance(event,tuple) and event[0]=='step'],[3,4,5,6,11,12,7,8,9])
        self.assertIn(('inheritable',(90,False)),events)
        self.assertIn(('inheritable',(100,True)),events)
        self.assertIn(('exec',('/launcher',('/launcher','unchanged'),p.ENV)),events)
        for event in events:
            if isinstance(event,tuple) and event[0]=='close_range':
                begin,end=event[1];self.assertFalse(begin<=90<end)
        self.assertIn('unshare',events);self.assertIn('mount',events)

    def test_failure_stage_is_set_before_each_effect_without_native_execution(self):
        for effect,step in (('dup2',4),('unshare',5),('mount',6),('reopen_inputs',12),('fchdir',7),('close_range',8),('exec',9)):
            with self.subTest(effect=effect):
                events,error,_=self.bootstrap(effect)
                self.assertEqual([event[1] for event in events if isinstance(event,tuple) and event[0]=='step'][-1],step)
                self.assertIsInstance(error,(p.Refusal,OSError))

    def test_error_writer_collisions_refuse_before_stdio_or_libc_effect(self):
        with patch.object(p,'root_linux'),patch.object(p,'validate_stdio') as stdio,patch.object(p.ctypes,'CDLL') as libc:
            for fd in (10,40,100,False):
                with self.assertRaises(p.Refusal):p.child_bootstrap(10,('/launcher',),(100,101),(40,41,42),error_fd=fd)
            stdio.assert_not_called();libc.assert_not_called()


if __name__=='__main__':unittest.main()
