"""Replay Stillwater's two-stream workload against a local Moonshine snapshot."""

import argparse
import json
import math
from pathlib import Path
import time
import wave

import numpy as np
from moonshine_voice import LineCompleted, LineTextChanged, ModelArch, Transcriber

from benchmark_asr import word_errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("model", type=Path)
    parser.add_argument("--update-frames", type=int, choices=(0, 1, 2, 4), default=0,
                        help="Frames between manual updates. Zero uses automatic stream events.")
    args = parser.parse_args()
    with wave.open(str(args.audio)) as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16000):
            parser.error("Audio must be mono 16 kHz PCM16 WAV")
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2")
    recognizer = Transcriber(args.model, ModelArch.MEDIUM_STREAMING, options={"return_audio_data": False})
    system = recognizer.create_stream()
    microphone = recognizer.create_stream()
    system.start()
    microphone.start()
    finals = {}
    delays = []
    first_text = None
    started = time.perf_counter()
    cpu_started = time.process_time()
    silence = [0.0] * 2048

    live = True

    def collect(event):
        nonlocal first_text
        if not isinstance(event, (LineCompleted, LineTextChanged)) or not event.line.text.strip():
            return
        now = time.perf_counter() - started
        line = event.line
        if first_text is None:
            first_text = now
        if isinstance(event, LineCompleted) and line.line_id not in finals:
            finals[line.line_id] = line
            if live:
                delays.append(now - line.start_time - line.duration)

    system.add_listener(collect)

    for offset in range(0, len(samples), len(silence)):
        chunk = samples[offset:offset + len(silence)]
        due = started + (offset + len(chunk)) / 16000
        time.sleep(max(0, due - time.perf_counter()))
        system.add_audio((chunk.astype(np.float32) / 32768).tolist())
        microphone.add_audio(silence[:len(chunk)])
        if args.update_frames and (offset // len(silence) + 1) % args.update_frames == 0:
            system.update_transcription()
            microphone.update_transcription()
    drain_started = time.perf_counter()
    live = False
    assert system.stop() is not None
    assert not any(line.text.strip() for line in microphone.stop().lines)
    drain = time.perf_counter() - drain_started
    transcript = " ".join(line.text for line in sorted(finals.values(), key=lambda line: line.start_time))
    errors, words = word_errors(args.reference.read_text(encoding="utf-8-sig"), transcript)
    print(json.dumps({
        "update_frames": args.update_frames,
        "first_text_seconds": first_text,
        "final_delay_p95_seconds": sorted(delays)[math.ceil(len(delays) * 0.95) - 1] if delays else None,
        "live_lines": len(delays),
        "drained_lines": len(finals) - len(delays),
        "drain_seconds": drain,
        "word_error_rate": errors / words,
        "wall_seconds": time.perf_counter() - started,
        "cpu_seconds": time.process_time() - cpu_started,
    }, indent=2))


if __name__ == "__main__":
    main()
