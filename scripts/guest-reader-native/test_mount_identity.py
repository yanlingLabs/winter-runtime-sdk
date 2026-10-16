"""Mount-namespace contract DATA and injected statx checks. No proc/native effects."""
from contextlib import ExitStack
import ctypes
import os
import struct
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import producer as p


def info(ids=(21,22)):
    return b''.join(str(value).encode()+b' 1 0:1 / /fixture rw - tmpfs tmpfs rw\n' for value in ids)


def result(value=21,mask=p.STATX_MNT_ID,attributes=0,supported=0):
    raw=bytearray(256);struct.pack_into('<I',raw,0,mask);struct.pack_into('<Q',raw,0x90,value)
    struct.pack_into('<Q',raw,8,attributes);struct.pack_into('<Q',raw,56,supported)
    return bytes(raw)


class Tests(unittest.TestCase):
    def test_preserved_fds_refuse_copied_namespace_ids_but_original_namespace_passes(self):
        held={100:21,101:22,102:21}
        # Model the kernel invariant: unshare copies mounts with different IDs;
        # already-open descriptors still refer to old mount objects.
        with self.assertRaisesRegex(p.Refusal,'outside current mount namespace'):
            p.require_mount_membership((100,101,102),info((31,32)),held.__getitem__)
        p.require_mount_membership((100,101,102),info(),held.__getitem__)
        observed=[]
        p.require_mount_membership(tuple(held),info(),lambda fd:observed.append(fd) or held[fd])
        self.assertEqual(observed,[100,101,102])

    def test_statx_mask_ordinary_id_width_and_exact_struct_bounds(self):
        self.assertEqual(p.statx_mount_id(result()),21)
        for raw in (result(mask=0),result(mask=0x4000),result(mask=0x5000),result(value=0),result(value=1<<31),result()[:-1],result()+b'x'):
            with self.subTest(bytes=len(raw)),self.assertRaises(p.Refusal):p.statx_mount_id(raw)

    def test_mountinfo_and_descriptor_type_bounds_refuse_without_fallback(self):
        for raw in (b'',info()[:-1],info((0,)),info((1,1)),b'x y z\n',b'1'*11+b' 1 0:1 / /fixture rw - tmpfs tmpfs rw\n',b'x'*(p.MOUNTINFO_MAX+1)):
            with self.subTest(raw=raw[:12]),self.assertRaises(p.Refusal):p.mount_ids(raw)
        for fds in ((),[100],(100,100),(True,),([100],),tuple(range(3,20))):
            with self.assertRaises(p.Refusal):p.require_mount_membership(fds,info(),lambda _:21)
        for value in (True,None,'21',21.0,23):
            with self.assertRaises(p.Refusal):p.require_mount_membership((100,),info(),lambda _:value)

    def observe(self,*,mask=p.STATX_MNT_ID,code=0,reads=None,attributes=0,supported=0,root_fd=None):
        calls=[];closed=[]
        class Statx:
            def __call__(self,fd,path,flags,wanted,pointer):
                calls.append((fd,path,flags,wanted))
                ctypes.memmove(pointer,result(mask=mask,attributes=attributes,supported=supported),256)
                return code
        call=Statx();libc=SimpleNamespace(statx=call)
        chunks=iter([info(),b'',info(),b''] if reads is None else reads)
        with patch.object(p.ctypes,'CDLL',return_value=libc),patch.object(p.os,'open',return_value=90),patch.object(p.os,'read',side_effect=lambda *_:next(chunks)),patch.object(p.os,'close',side_effect=closed.append):
            error=None
            try:p.verify_mount_namespace((100,101),mount_root_fd=root_fd)
            except BaseException as caught:error=caught
        return calls,closed,call,error

    def test_actual_statx_recipe_uses_empty_fd_lookup_and_explicit_prototypes(self):
        calls,closed,call,error=self.observe()
        self.assertIsNone(error)
        self.assertEqual(calls,[(100,b'',0x1000,p.STATX_MNT_ID),(101,b'',0x1000,p.STATX_MNT_ID)])
        self.assertEqual(call.argtypes,[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_uint,ctypes.c_void_p])
        self.assertEqual(call.restype,ctypes.c_int);self.assertEqual(closed,[90,90])

    def test_unsupported_statx_read_failure_and_namespace_change_close_handles(self):
        for kwargs in ({'mask':0},{'code':-1},{'reads':[info(),b'',info((31,32)),b'']},{'reads':[b'x'*(p.MOUNTINFO_MAX+1)]}):
            with self.subTest(kwargs=kwargs):
                _,closed,_,error=self.observe(**kwargs)
                self.assertIsInstance(error,p.Refusal);self.assertGreater(len(closed),0)
        with patch.object(p.ctypes,'CDLL',return_value=SimpleNamespace()),patch.object(p.os,'open') as opened:
            with self.assertRaisesRegex(p.Refusal,'statx unavailable'):p.verify_mount_namespace((100,))
            opened.assert_not_called()
        with patch.object(p.ctypes,'CDLL',return_value=SimpleNamespace(statx=SimpleNamespace())),patch.object(p.os,'open',return_value=90),patch.object(p.os,'read',side_effect=OSError),patch.object(p.os,'close') as close:
            with self.assertRaises(OSError):p.verify_mount_namespace((100,))
            close.assert_called_once_with(90)

    def test_root_mount_attribute_must_be_supported_and_set(self):
        for attrs,supported in ((0,0),(0x2000,0),(0,0x2000)):
            with self.subTest(attrs=attrs,supported=supported):
                _,closed,_,error=self.observe(attributes=attrs,supported=supported,root_fd=100)
                self.assertIsInstance(error,p.Refusal);self.assertEqual(closed,[90])
        _,closed,_,error=self.observe(attributes=0x2000,supported=0x2000,root_fd=100)
        self.assertIsNone(error);self.assertEqual(closed,[90,90])


if __name__=='__main__':unittest.main()
