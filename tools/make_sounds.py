"""Generate small, distinct notification WAV files for the DSH notify-sound plugin.

Additive synthesis with an exponential envelope: short, clearly audible,
pleasant tones that stay well below clipping.
"""

import math
import os
import struct
import wave

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")

# Semitone helper: MIDI note -> frequency
def midi(note: float) -> float:
    return 440.0 * (2.0 ** ((note - 69) / 12.0))


def render(notes, length, gain=0.42, decay=5.5):
    """notes: list of (midi_note, start_s, dur_s, amp_scale)."""
    total = int(SR * length)
    buf = [0.0] * total
    for note, start, dur, scale in notes:
        f0 = midi(note)
        i0 = int(start * SR)
        n = int(dur * SR)
        for i in range(n):
            idx = i0 + i
            if idx >= total:
                break
            t = i / SR
            env = (1.0 - math.exp(-t / 0.006)) * math.exp(-decay * t)
            phase = 2.0 * math.pi * f0 * t
            s = (
                math.sin(phase)
                + 0.28 * math.sin(2.0 * phase)
                + 0.10 * math.sin(3.0 * phase)
                + 0.05 * math.sin(4.0 * phase)
            )
            buf[idx] += s * env * scale
    peak = max((abs(v) for v in buf), default=0.0) or 1.0
    norm = gain / peak
    frames = bytearray()
    for v in buf:
        x = max(-1.0, min(1.0, v * norm))
        frames += struct.pack("<h", int(x * 32767))
    return bytes(frames)


def write(name, data):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data)
    print(f"{name:16} {len(data) // 2 / SR:5.2f}s  {len(data) + 44:>7} bytes")


# finished — 工作完成：上行三音，明亮、收束
write("finished.wav", render([
    (79, 0.00, 0.34, 0.85),   # G5
    (84, 0.13, 0.34, 0.90),   # C6
    (88, 0.26, 0.60, 1.00),   # E6
], length=0.90, decay=5.0))

# interrupted — 工作中断：下行两音，短促、明确
write("interrupted.wav", render([
    (76, 0.00, 0.30, 1.00),   # E5
    (68, 0.16, 0.55, 0.95),   # G#4
], length=0.72, decay=6.0))

# error — 出错：低频双响，警示
write("error.wav", render([
    (55, 0.00, 0.26, 1.00),   # G3
    (55, 0.30, 0.42, 0.85),   # G3
], length=0.78, decay=6.5, gain=0.40))

# question — Agent 提问：三声高音催问，穿透力强
write("question.wav", render([
    (93, 0.00, 0.20, 0.90),   # A6
    (93, 0.20, 0.20, 0.95),   # A6
    (100, 0.40, 0.42, 1.00),  # E7
], length=0.85, decay=7.5, gain=0.34))
