"""Injected namespace/mount/reopen checks. No mount, chroot, fork or native role."""
from contextlib import ExitStack
import ctypes
import os
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import producer as p


def metadata(inode=10,directory=True):
    return SimpleNamespace(st_dev=1,st_ino=inode,st_mode=(stat.S_IFDIR if directory else stat.S_IFREG)|0o555,
        st_uid=0,st_gid=0,st_nlink=2 if directory else 1,st_size=0,st_mtime_ns=1,st_ctime_ns=2)


class Tests(unittest.TestCase):
    def install(self,*,change=None,alias=None,fail_verify=False,close_fail=False):
        before={10:metadata(),100:metadata(100,False)}
        after={200:metadata(),201:metadata(100,False)}
        if change: setattr(after[201],change[0],change[1])
        events=[];closed=[];returns=iter([200,201] if alias is None else [200,alias])
        records=tuple((fd,'/run/inert/'+str(fd),p.immutable_identity(info)) for fd,info in before.items())
        def verify(fds,**kwargs):
            events.append(('verify',fds,kwargs))
            if fail_verify:raise p.Refusal('inert mount root refused')
        def close(fd):
            closed.append(fd)
            if close_fail and fd==200:raise OSError('inert close refusal')
        error=None
        with patch.object(p,'reopen_protected_path',side_effect=lambda _:next(returns)),patch.object(p.os,'fstat',side_effect=lambda fd:(before|after)[fd]),patch.object(p.fcntl,'fcntl',return_value=os.O_RDONLY),patch.object(p.os,'dup2',side_effect=lambda *args:events.append(('dup2',args))),patch.object(p.os,'close',side_effect=close):
            try:p.install_reopened_inputs(records,10,verify=verify)
            except BaseException as caught:error=caught
        return events,closed,error

    def test_verify_all_reopened_fds_and_mount_root_before_original_number_install(self):
        events,closed,error=self.install()
        self.assertIsNone(error)
        self.assertEqual(events,[('verify',(200,201),{'mount_root_fd':200}),('dup2',(200,10)),('dup2',(201,100))])
        self.assertEqual(closed,[200,201])

    def test_parental_immutable_identity_changes_refuse_without_install(self):
        fields=(('st_dev',2),('st_ino',101),('st_mode',stat.S_IFDIR|0o555),('st_uid',1000),('st_gid',1000),('st_nlink',2),('st_size',1),('st_mtime_ns',3),('st_ctime_ns',3))
        for change in fields:
            with self.subTest(change=change):
                events,closed,error=self.install(change=change)
                self.assertIsInstance(error,p.Refusal);self.assertEqual(events,[])
                self.assertEqual(closed,[200,201])

    def test_original_or_duplicate_alias_is_never_closed_as_a_new_fd(self):
        for alias,expected in ((10,[200]),(200,[200])):
            events,closed,error=self.install(alias=alias)
            self.assertIsInstance(error,p.Refusal);self.assertEqual(events,[]);self.assertEqual(closed,expected)

    def test_mount_root_failure_and_close_failure_preserve_debt_no_repair(self):
        events,closed,error=self.install(fail_verify=True)
        self.assertIsInstance(error,p.Refusal);self.assertEqual(closed,[200,201])
        self.assertFalse(any(event[0]=='dup2' for event in events))
        _,closed,error=self.install(fail_verify=True,close_fail=True)
        self.assertEqual(closed,[200,201]);self.assertEqual(error.retained_fds,[200])
        self.assertFalse(hasattr(error,'cleanupConfirmed'))

    def test_nofollow_ancestor_walk_closes_new_handles_once_on_open_or_close_failure(self):
        for failure in ('leaf','close'):
            closed=[];opened=[];seq=iter([200,201,202])
            def open_path(name,flags,**kwargs):
                opened.append((name,flags,kwargs))
                if failure=='leaf' and name=='input':raise OSError('inert open failure')
                return next(seq)
            def close(fd):
                closed.append(fd)
                if failure=='close' and fd==200:raise OSError('inert close failure')
            with patch.object(p.os,'open',side_effect=open_path),patch.object(p.os,'fstat',return_value=metadata()),patch.object(p.os,'close',side_effect=close):
                with self.assertRaises((OSError,p.Refusal)):p.reopen_protected_path('/run/input')
            self.assertEqual(len(closed),len(set(closed)))
            self.assertTrue(all(flags&os.O_NOFOLLOW for _,flags,_ in opened))
            self.assertNotIn('/proc/self/fd',str(opened))

    def test_private_real_root_then_nonrecursive_bind_reopen_chroot_exec_order(self):
        events=[];info=metadata();records=((10,'/run/loader',p.immutable_identity(info)),)
        class Function:
            def __init__(self,name):self.name=name
            def __call__(self,*args):events.append((self.name,args));return 0
        libc=SimpleNamespace(unshare=Function('unshare'),mount=Function('mount'))
        class Ended(BaseException):pass
        selected=p.selected_host_exec_environment()
        def exec_role(*args):
            self.assertIs(args[2],selected)
            events.append(('exec',args));raise Ended
        def effect(name):return lambda *args:events.append((name,args))
        with ExitStack() as stack:
            for target,name,value in ((p,'root_linux',lambda:None),(p,'validate_stdio',lambda *_:None),(p.ctypes,'CDLL',lambda *_ ,**kw:libc),(p,'reopen_protected_path',lambda _:200),(p,'install_reopened_inputs',effect('reopen')),(p.os,'fstat',lambda _:info),(p.os,'close',effect('close')),(p.os,'dup2',effect('dup2')),(p.os,'fchdir',effect('fchdir')),(p.os,'chroot',effect('chroot')),(p.os,'chdir',effect('chdir')),(p.os,'closerange',effect('close_range')),(p.os,'set_inheritable',effect('inheritable')),(p.os,'execve',exec_role)):
                stack.enter_context(patch.object(target,name,value))
            with self.assertRaises(Ended):p.child_bootstrap(10,('/launcher',),(100,101),(40,41,42),error_fd=90,reopen_inputs=records,stage=lambda value:events.append(('step',value)),exec_environment=selected)
        ordering=[name for name,_ in events]
        self.assertLess(ordering.index('unshare'),ordering.index('mount'))
        mounts=[args for name,args in events if name=='mount']
        self.assertEqual(mounts,[(None,b'/',None,0x4000|0x40000,None),(b'/run/loader',b'/run/loader',None,0x1000,None)])
        self.assertLess(ordering.index('reopen'),ordering.index('chroot'))
        self.assertLess(ordering.index('chroot'),ordering.index('exec'))
        self.assertIn(('inheritable',(90,False)),events)
        self.assertEqual(libc.mount.argtypes[3],ctypes.c_ulong)


if __name__=='__main__':unittest.main()
