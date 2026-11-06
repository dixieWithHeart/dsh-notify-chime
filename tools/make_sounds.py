"""Generate notification WAV files for the dsh-notify-chime plugin.

Additive synthesis with an exponential envelope: short, clearly audible, pleasant
tones well below clipping. 全部音效由本脚本合成，无任何外部采样素材。

目录约定：
  assets/<kind>.wav          default 套（44.1 kHz，与 1.0 起发布的音效逐字节一致）
  assets/<set>/<kind>.wav    其余预设套（22.05 kHz，体积减半；提示音听不出差别）

用法：
  python tools/make_sounds.py            # 生成全部
  python tools/make_sounds.py chime      # 只生成一套
"""

import math
import os
import struct
import sys
import wave

SR_DEFAULT = 44100
SR_PRESET = 22050
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")


def midi(note: float) -> float:
    """MIDI note -> frequency."""
    return 440.0 * (2.0 ** ((note - 69) / 12.0))


def render_legacy(notes, length, gain=0.42, decay=5.5, sr=SR_DEFAULT):
    """1.0 起的默认音效。浮点运算顺序刻意保持原样，重跑后文件哈希不变。"""
    total = int(sr * length)
    buf = [0.0] * total
    for note, start, dur, scale in notes:
        f0 = midi(note)
        i0 = int(start * sr)
        n = int(dur * sr)
        for i in range(n):
            idx = i0 + i
            if idx >= total:
                break
            t = i / sr
            env = (1.0 - math.exp(-t / 0.006)) * math.exp(-decay * t)
            phase = 2.0 * math.pi * f0 * t
            s = (
                math.sin(phase)
                + 0.28 * math.sin(2.0 * phase)
                + 0.10 * math.sin(3.0 * phase)
                + 0.05 * math.sin(4.0 * phase)
            )
            buf[idx] += s * env * scale
    return normalize(buf, gain)


def render(notes, length, gain, decay, attack, harmonics, sr):
    """通用合成：attack 控制起音软硬，harmonics 是各次谐波权重。"""
    total = int(sr * length)
    buf = [0.0] * total
    for note, start, dur, scale in notes:
        f0 = midi(note)
        i0 = int(start * sr)
        n = int(dur * sr)
        for i in range(n):
            idx = i0 + i
            if idx >= total:
                break
            t = i / sr
            env = (1.0 - math.exp(-t / attack)) * math.exp(-decay * t)
            phase = 2.0 * math.pi * f0 * t
            s = 0.0
            for k, weight in enumerate(harmonics, start=1):
                if weight:
                    s += weight * math.sin(k * phase)
            buf[idx] += s * env * scale
    return normalize(buf, gain)


def normalize(buf, gain):
    peak = max((abs(v) for v in buf), default=0.0) or 1.0
    norm = gain / peak
    frames = bytearray()
    for v in buf:
        x = max(-1.0, min(1.0, v * norm))
        frames += struct.pack("<h", int(x * 32767))
    return bytes(frames)


def write(name, data, sr, subdir=""):
    outdir = os.path.join(OUT, subdir) if subdir else OUT
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, name)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(data)
    label = f"{subdir}/{name}" if subdir else name
    print(f"{label:28} {len(data) // 2 / sr:5.2f}s  {len(data) + 44:>7} bytes")


# ── 各套定义 ────────────────────────────────────────────────────────────────
# 语义保持一致：finished 上行、interrupted 下行、error 低频双响、question 高音催问。

SETS = {
    "default": {
        "sr": SR_DEFAULT,
        "legacy": True,
        "sounds": {
            "finished": dict(notes=[(79, 0.00, 0.34, 0.85), (84, 0.13, 0.34, 0.90), (88, 0.26, 0.60, 1.00)],
                             length=0.90, gain=0.42, decay=5.0),
            "interrupted": dict(notes=[(76, 0.00, 0.30, 1.00), (68, 0.16, 0.55, 0.95)],
                                length=0.72, gain=0.42, decay=6.0),
            "error": dict(notes=[(55, 0.00, 0.26, 1.00), (55, 0.30, 0.42, 0.85)],
                          length=0.78, gain=0.40, decay=6.5),
            "question": dict(notes=[(93, 0.00, 0.20, 0.90), (93, 0.20, 0.20, 0.95), (100, 0.40, 0.42, 1.00)],
                             length=0.85, gain=0.34, decay=7.5),
        },
    },
    # 柔和：低八度、慢起音、谐波少，适合安静环境
    "soft": {
        "sr": SR_PRESET, "attack": 0.025, "harmonics": (1.0, 0.10, 0.03),
        "sounds": {
            "finished": dict(notes=[(67, 0.00, 0.38, 0.85), (72, 0.15, 0.38, 0.90), (76, 0.30, 0.70, 1.00)],
                             length=1.05, gain=0.30, decay=3.2),
            "interrupted": dict(notes=[(64, 0.00, 0.34, 1.00), (56, 0.18, 0.60, 0.95)],
                                length=0.85, gain=0.30, decay=3.6),
            "error": dict(notes=[(43, 0.00, 0.30, 1.00), (43, 0.34, 0.50, 0.85)],
                          length=0.92, gain=0.30, decay=3.8),
            "question": dict(notes=[(81, 0.00, 0.24, 0.90), (81, 0.24, 0.24, 0.95), (88, 0.48, 0.50, 1.00)],
                             length=1.05, gain=0.30, decay=3.4),
        },
    },
    # 钟声：长尾、泛音密集、金属感
    "chime": {
        "sr": SR_PRESET, "attack": 0.002, "harmonics": (1.0, 0.45, 0.30, 0.20, 0.12),
        "sounds": {
            "finished": dict(notes=[(84, 0.00, 0.50, 0.90), (88, 0.12, 0.50, 0.95), (91, 0.24, 0.90, 1.00)],
                             length=1.30, gain=0.30, decay=2.0),
            "interrupted": dict(notes=[(79, 0.00, 0.50, 1.00), (72, 0.14, 0.90, 0.95)],
                                length=1.10, gain=0.30, decay=2.2),
            "error": dict(notes=[(52, 0.00, 0.50, 1.00), (52, 0.28, 0.80, 0.85)],
                          length=1.20, gain=0.30, decay=2.4),
            "question": dict(notes=[(93, 0.00, 0.30, 0.90), (93, 0.25, 0.30, 0.95), (96, 0.50, 0.90, 1.00)],
                             length=1.35, gain=0.30, decay=2.0),
        },
    },
    # 复古：方波（奇次谐波）、短促、8-bit 味
    "retro": {
        "sr": SR_PRESET, "attack": 0.001, "harmonics": (1.0, 0.0, 0.33, 0.0, 0.20),
        "sounds": {
            "finished": dict(notes=[(76, 0.00, 0.12, 0.90), (79, 0.10, 0.12, 0.95), (84, 0.20, 0.22, 1.00)],
                             length=0.46, gain=0.34, decay=9.0),
            "interrupted": dict(notes=[(72, 0.00, 0.12, 1.00), (64, 0.10, 0.20, 0.95)],
                                length=0.38, gain=0.34, decay=9.0),
            "error": dict(notes=[(48, 0.00, 0.12, 1.00), (48, 0.16, 0.16, 0.85)],
                          length=0.38, gain=0.34, decay=10.0),
            "question": dict(notes=[(88, 0.00, 0.10, 0.90), (88, 0.12, 0.10, 0.95), (91, 0.24, 0.18, 1.00)],
                             length=0.46, gain=0.34, decay=9.0),
        },
    },
    # 电子：极硬起音、极短衰减，像设备提示音
    "digital": {
        "sr": SR_PRESET, "attack": 0.0008, "harmonics": (1.0, 0.50, 0.0, 0.15),
        "sounds": {
            "finished": dict(notes=[(81, 0.00, 0.09, 0.90), (85, 0.07, 0.09, 0.95), (88, 0.14, 0.16, 1.00)],
                             length=0.34, gain=0.36, decay=14.0),
            "interrupted": dict(notes=[(77, 0.00, 0.08, 1.00), (72, 0.07, 0.14, 0.95)],
                                length=0.28, gain=0.36, decay=14.0),
            "error": dict(notes=[(57, 0.00, 0.08, 1.00), (57, 0.12, 0.12, 0.85)],
                          length=0.30, gain=0.36, decay=16.0),
            "question": dict(notes=[(93, 0.00, 0.07, 0.90), (93, 0.10, 0.07, 0.95), (96, 0.20, 0.14, 1.00)],
                             length=0.38, gain=0.36, decay=14.0),
        },
    },
    # 木质：低频、极快衰减，敲击感，不刺耳
    "wood": {
        "sr": SR_PRESET, "attack": 0.001, "harmonics": (1.0, 0.70, 0.35, 0.20),
        "sounds": {
            "finished": dict(notes=[(67, 0.00, 0.10, 0.90), (71, 0.08, 0.10, 0.95), (74, 0.16, 0.18, 1.00)],
                             length=0.40, gain=0.42, decay=20.0),
            "interrupted": dict(notes=[(64, 0.00, 0.10, 1.00), (57, 0.09, 0.16, 0.95)],
                                length=0.32, gain=0.42, decay=20.0),
            "error": dict(notes=[(45, 0.00, 0.10, 1.00), (45, 0.14, 0.12, 0.85)],
                          length=0.34, gain=0.42, decay=22.0),
            "question": dict(notes=[(79, 0.00, 0.09, 0.90), (79, 0.11, 0.09, 0.95), (83, 0.22, 0.14, 1.00)],
                             length=0.42, gain=0.42, decay=20.0),
        },
    },
}


def build(set_name, spec):
    subdir = "" if set_name == "default" else set_name
    sr = spec["sr"]
    for kind, sound in spec["sounds"].items():
        if spec.get("legacy"):
            data = render_legacy(sound["notes"], sound["length"], sound["gain"], sound["decay"], sr)
        else:
            data = render(sound["notes"], sound["length"], sound["gain"], sound["decay"],
                          spec["attack"], spec["harmonics"], sr)
        write(f"{kind}.wav", data, sr, subdir)


def main(argv):
    wanted = [name for name in argv[1:] if name in SETS]
    unknown = [name for name in argv[1:] if name not in SETS]
    if unknown:
        print(f"unknown set: {', '.join(unknown)}（可用：{', '.join(SETS)}）")
        return 2
    for set_name in (wanted or list(SETS)):
        build(set_name, SETS[set_name])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
