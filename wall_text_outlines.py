"""Extract local Windows TrueType outlines; no model download or font redistribution.

GDI expands composite glyphs and returns the font's curves, including counters
(holes). Only the three UI font families are accepted; callers cannot supply paths.
"""
import ctypes
from ctypes import wintypes as wt
from functools import lru_cache
import os
import struct
import threading

FAMILIES = {'yahei': 'Microsoft YaHei', 'hei': 'SimHei', 'song': 'SimSun'}
ALIASES = {'yahei': {'microsoft yahei', '微软雅黑'},
           'hei': {'simhei', '黑体'}, 'song': {'simsun', '宋体'}}
FONT_LOCK = threading.Lock()
ERROR = 0xffffffff


def validate_text(font, text):
    if not isinstance(font, str) or font not in FAMILIES:
        raise ValueError('请选择系统支持的字体。')
    if not isinstance(text, str) or not text.strip():
        raise ValueError('请输入需要生成的立体文字。')
    if len(text) > 500 or len(text.split('\n')) > 10 or sum(not c.isspace() for c in text) > 120:
        raise ValueError('单组立体文字最多 120 个非空白字符、10 行；长段落可使用平面文字。')
    unsupported = [c for c in text if ord(c) > 0xffff or (ord(c) < 32 and c not in '\n\t') or 0xd800 <= ord(c) <= 0xdfff]
    if unsupported:
        raise ValueError('立体文字暂不支持表情符号或此类特殊字符，请改用中文、英文或数字。')


def _point(data, offset):
    # FIXED is a 16-bit fraction followed by a signed 16-bit integer.
    xf, xv, yf, yv = struct.unpack_from('<HhHh', data, offset)
    return [round(xv + xf / 65536, 4), round(yv + yf / 65536, 4)]


def _contours(data):
    paths = []
    offset = 0
    while offset < len(data):
        size, kind = struct.unpack_from('<II', data, offset)
        end = offset + size
        if kind != 24 or size < 16 or end > len(data):
            raise RuntimeError('字体轮廓数据无效。')
        path = [['M', *_point(data, offset + 8)]]
        cursor = offset + 16
        while cursor < end:
            curve, count = struct.unpack_from('<HH', data, cursor)
            cursor += 4
            if not count or cursor + count * 8 > end:
                raise RuntimeError('字体曲线数据无效。')
            points = [_point(data, cursor + 8 * i) for i in range(count)]
            cursor += count * 8
            if curve == 1:
                path.extend(['L', *p] for p in points)
            elif curve == 2 and count >= 2:
                for i in range(count - 1):
                    endpoint = points[i + 1] if i == count - 2 else [(a + b) / 2 for a, b in zip(points[i], points[i + 1])]
                    path.append(['Q', *points[i], *endpoint])
            elif curve == 3 and count % 3 == 0:
                for i in range(0, count, 3):
                    path.append(['C', *points[i], *points[i + 1], *points[i + 2]])
            else:
                raise RuntimeError('不支持的字体曲线类型。')
        path.append(['Z'])
        paths.append(path)
        offset = end
    return paths


class Fixed(ctypes.Structure):
    _fields_ = [('fract', wt.WORD), ('value', ctypes.c_short)]


class Mat2(ctypes.Structure):
    _fields_ = [('eM11', Fixed), ('eM12', Fixed), ('eM21', Fixed), ('eM22', Fixed)]


class GlyphMetrics(ctypes.Structure):
    _fields_ = [('blackX', wt.UINT), ('blackY', wt.UINT), ('origin', wt.POINT),
                ('advanceX', ctypes.c_short), ('advanceY', ctypes.c_short)]


@lru_cache(maxsize=64)
def _extract(font, characters):
    if os.name != 'nt':
        raise RuntimeError('当前立体文字使用 Windows 本地字体服务，请在 Windows 上运行 render_server.py。')
    gdi = ctypes.WinDLL('gdi32', use_last_error=True)
    gdi.CreateCompatibleDC.argtypes = [wt.HDC]
    gdi.CreateCompatibleDC.restype = wt.HDC
    gdi.CreateFontW.argtypes = [ctypes.c_int] * 5 + [wt.DWORD] * 8 + [wt.LPCWSTR]
    gdi.CreateFontW.restype = wt.HANDLE
    gdi.SelectObject.argtypes = [wt.HDC, wt.HANDLE]
    gdi.SelectObject.restype = wt.HANDLE
    gdi.GetTextFaceW.argtypes = [wt.HDC, ctypes.c_int, wt.LPWSTR]
    gdi.GetTextFaceW.restype = ctypes.c_int
    gdi.GetGlyphIndicesW.argtypes = [wt.HDC, wt.LPCWSTR, ctypes.c_int, ctypes.POINTER(wt.WORD), wt.DWORD]
    gdi.GetGlyphIndicesW.restype = wt.DWORD
    gdi.GetGlyphOutlineW.argtypes = [wt.HDC, wt.UINT, wt.UINT, ctypes.POINTER(GlyphMetrics), wt.DWORD, ctypes.c_void_p, ctypes.POINTER(Mat2)]
    gdi.GetGlyphOutlineW.restype = wt.DWORD
    gdi.DeleteObject.argtypes = [wt.HANDLE]
    gdi.DeleteDC.argtypes = [wt.HDC]
    dc = gdi.CreateCompatibleDC(None)
    face = gdi.CreateFontW(-1000, 0, 0, 0, 400, 0, 0, 0, 1, 7, 0, 0, 0, FAMILIES[font])
    old = None
    try:
        if not dc or not face:
            raise RuntimeError('无法初始化本地字体服务。')
        old = gdi.SelectObject(dc, face)
        name = ctypes.create_unicode_buffer(128)
        if not gdi.GetTextFaceW(dc, 128, name) or name.value.lower() not in ALIASES[font]:
            raise RuntimeError('电脑未安装所选字体：' + FAMILIES[font])
        transform = Mat2(Fixed(0, 1), Fixed(0, 0), Fixed(0, 0), Fixed(0, 1))
        glyphs = {}
        for char in characters:
            index = wt.WORD()
            if gdi.GetGlyphIndicesW(dc, char, 1, ctypes.byref(index), 1) == ERROR or index.value == 0xffff:
                raise ValueError('所选字体不包含字符“' + char + '”，请更换字体或改用平面文字。')
            metrics = GlyphMetrics()
            flags = 2 | 0x100 | 0x80  # GGO_NATIVE | GGO_UNHINTED | GGO_GLYPH_INDEX
            size = gdi.GetGlyphOutlineW(dc, index.value, flags, ctypes.byref(metrics), 0, None, ctypes.byref(transform))
            if size == ERROR or size > 2 * 1024 * 1024:
                raise ValueError('无法读取字符“' + char + '”的立体轮廓。')
            paths = []
            if size:
                data = ctypes.create_string_buffer(size)
                if gdi.GetGlyphOutlineW(dc, index.value, flags, ctypes.byref(metrics), size, data, ctypes.byref(transform)) == ERROR:
                    raise RuntimeError('字体轮廓读取失败。')
                paths = _contours(data.raw)
            glyphs[char] = {'advance': metrics.advanceX, 'paths': paths}
        if not any(glyph['paths'] for glyph in glyphs.values()):
            raise ValueError('文字中没有可生成的可见字形。')
        return {'font': font, 'family': name.value, 'resolution': 1000, 'glyphs': glyphs}
    finally:
        if old:
            gdi.SelectObject(dc, old)
        if face:
            gdi.DeleteObject(face)
        if dc:
            gdi.DeleteDC(dc)


def text_outlines(font, text):
    validate_text(font, text)
    characters = ''.join(sorted(set(text.replace('\n', '').replace('\t', '    '))))
    # Each request owns its GDI objects; serialize cache misses and keep a bounded cache.
    with FONT_LOCK:
        return _extract(font, characters)
