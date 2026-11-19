"""Score a local Sherpa ONNX Parakeet export on the AMI fixture."""

import argparse
import json
import math
from pathlib import Path
import time
import wave

import numpy as np
import sherpa_onnx

from benchmark_asr import word_errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("--streaming", action="store_true")
    parser.add_argument("--provider", default="cpu")
    args = parser.parse_args()
    paths = {key: str(args.model / f"{key}.int8.onnx") for key in ("encoder", "decoder", "joiner")}
    paths["tokens"] = str(args.model / "tokens.txt")
    with wave.open(".probe/ami-es2004a-180s.wav") as audio:
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(np.float32) / 32768
    report = {"provider_requested": args.provider}
    if args.streaming:
        recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            **paths, num_threads=4, provider=args.provider, enable_endpoint_detection=True
        )
        stream = recognizer.create_stream()
        lines, delays = [], []
        first_text = None
        started = time.perf_counter()
        for offset in range(0, len(samples), 2048):
            chunk = samples[offset:offset + 2048]
            due = started + (offset + len(chunk)) / 16000
            time.sleep(max(0, due - time.perf_counter()))
            stream.accept_waveform(16000, chunk)
            while recognizer.is_ready(stream):
                recognizer.decode_stream(stream)
            result = recognizer.get_result_all(stream)
            now = time.perf_counter() - started
            if result.text and first_text is None:
                first_text = now
            if recognizer.is_endpoint(stream):
                if result.text:
                    lines.append(result.text)
                    if result.timestamps:
                        delays.append(now - result.start_time - result.timestamps[-1])
                recognizer.reset(stream)
        stream.input_finished()
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        lines.append(recognizer.get_result(stream))
        transcript = " ".join(lines)
        report.update(first_text_from_file_start=first_text, live_endpoint_count=len(delays),
                      endpoint_delay_p95=sorted(delays)[math.ceil(len(delays) * .95) - 1] if delays else None)
    else:
        recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            **paths, num_threads=4, provider=args.provider, model_type="nemo_transducer"
        )
        stream = recognizer.create_stream()
        started = time.perf_counter()
        stream.accept_waveform(16000, samples)
        recognizer.decode_stream(stream)
        transcript = stream.result.text
    errors, words = word_errors(Path(".probe/ami-es2004a-180s.txt").read_text(encoding="utf-8-sig"), transcript)
    report.update(seconds=time.perf_counter() - started, errors=errors, reference_words=words, wer=errors / words)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
