"""Compare local CUDA Whisper snapshots against one reference transcript."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


def word_errors(reference, transcript):
    expected = re.findall(r"\b[\w']+\b", reference.casefold())
    actual = re.findall(r"\b[\w']+\b", transcript.casefold())
    if not expected:
        raise ValueError("Reference must contain words")
    row = list(range(len(actual) + 1))
    for index, word in enumerate(expected, start=1):
        next_row = [index]
        for column, candidate in enumerate(actual, start=1):
            next_row.append(min(
                row[column] + 1, next_row[-1] + 1, row[column - 1] + (word != candidate)
            ))
        row = next_row
    return row[-1], len(expected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("models", type=Path, nargs="+")
    parser.add_argument("--language", default="en")
    parser.add_argument("--beam-size", type=int, choices=range(1, 11), default=1)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    reference_bytes = args.reference.read_bytes()
    reference = reference_bytes.decode("utf-8")
    reference_sha256 = hashlib.sha256(reference_bytes).hexdigest()
    word_errors(reference, "")
    results = []
    for model in args.models:
        process = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("cuda_probe.py")),
             str(args.audio), str(model), "--language", args.language, "--beam-size", str(args.beam_size)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
        )
        try:
            result = json.loads(process.stdout)
        except json.JSONDecodeError:
            result = {"ok": False, "error": process.stderr.strip() or "No probe result"}
        result["model"] = str(model)
        result["reference_sha256"] = reference_sha256
        result["exit_code"] = process.returncode
        if result["ok"]:
            transcript = " ".join(segment["text"] for segment in result["segments"])
            errors, count = word_errors(reference, transcript)
            result.update(word_errors=errors, reference_words=count, wer=errors / count,
                          real_time_factor=result["inference_seconds"] / result["audio_seconds"])
        else:
            print(f"{model.name}: {result['error']}", file=sys.stderr)
        results.append(result)
    args.output.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print("| Model | Word error rate | Real-time factor | Peak RAM |")
    print("| --- | ---: | ---: | ---: |")
    for model, result in zip(args.models, results):
        if result["ok"]:
            peak = result.get("peak_working_set_bytes")
            ram = f"{peak / 1024**2:.0f} MiB" if peak is not None else "Unavailable"
            print(f"| {model.name} | {result['wer']:.1%} | {result['real_time_factor']:.3f} | {ram} |")
        else:
            print(f"| {model.name} | Failed | | |")
    return int(not all(result["ok"] for result in results))


if __name__ == "__main__":
    raise SystemExit(main())
