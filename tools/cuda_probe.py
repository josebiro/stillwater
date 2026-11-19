"""Run one local speech fixture on CUDA and emit a JSON result."""

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import subprocess
from importlib.metadata import version
from pathlib import Path
from time import perf_counter


def gpu_memory_snapshot():
    try:
        output = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=index,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            text=True, stderr=subprocess.DEVNULL, timeout=3,
        )
        return [
            {"index": index, "used_mib": used, "total_mib": total}
            for index, used, total in (map(int, row.split(",")) for row in output.splitlines())
        ]
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def peak_working_set():
    if os.name != "nt":
        return None

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("size", wintypes.DWORD),
            ("page_faults", wintypes.DWORD),
            ("peak_working_set", ctypes.c_size_t),
            ("working_set", ctypes.c_size_t),
            ("peak_paged_pool", ctypes.c_size_t),
            ("paged_pool", ctypes.c_size_t),
            ("peak_nonpaged_pool", ctypes.c_size_t),
            ("nonpaged_pool", ctypes.c_size_t),
            ("pagefile", ctypes.c_size_t),
            ("peak_pagefile", ctypes.c_size_t),
        ]

    process = ctypes.windll.kernel32.GetCurrentProcess
    process.restype = wintypes.HANDLE
    counters = ProcessMemoryCounters()
    counters.size = ctypes.sizeof(counters)
    memory_info = ctypes.windll.psapi.GetProcessMemoryInfo
    memory_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessMemoryCounters), wintypes.DWORD]
    return counters.peak_working_set if memory_info(process(), ctypes.byref(counters), counters.size) else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path, help="Short synthetic or consented speech file")
    parser.add_argument("model", type=Path, help="Local CTranslate2 model snapshot directory")
    parser.add_argument("--language", default="en")
    parser.add_argument("--beam-size", type=int, choices=range(1, 11), default=1)
    parser.add_argument("--allow-empty", action="store_true")
    args = parser.parse_args()
    result = {"device": "cuda", "compute_type": "float16", "language": args.language, "beam_size": args.beam_size}
    os.environ["HF_HUB_OFFLINE"] = "1"
    try:
        result["stage"] = "runtime"
        import ctranslate2
        from faster_whisper import WhisperModel

        result["versions"] = {
            name: version(name) for name in ("faster-whisper", "ctranslate2", "av")
        }
        result["cuda_devices"] = ctranslate2.get_cuda_device_count()
        if not result["cuda_devices"]:
            raise RuntimeError("CTranslate2 found no CUDA device")

        result["stage"] = "input"
        for name in ("model.bin", "config.json", "tokenizer.json"):
            if not (args.model / name).is_file():
                raise FileNotFoundError(args.model / name)
        result["model_snapshot"] = args.model.name
        result["model_sha256"] = {}
        for path in sorted(args.model.iterdir()):
            if path.is_file() and (path.suffix in {".bin", ".json", ".txt"}):
                with path.open("rb") as snapshot_file:
                    result["model_sha256"][path.name] = hashlib.file_digest(snapshot_file, "sha256").hexdigest()
        with args.audio.open("rb") as audio:
            result["audio_sha256"] = hashlib.file_digest(audio, "sha256").hexdigest()

        result["stage"] = "load"
        result["gpu_memory_before_model"] = gpu_memory_snapshot()
        started = perf_counter()
        model = WhisperModel(str(args.model), device="cuda", compute_type="float16",
                             local_files_only=True)
        if args.language != "en" and not model.model.is_multilingual:
            raise ValueError("Choose a multilingual Whisper model for this language")
        result["load_seconds"] = perf_counter() - started
        result["stage"] = "inference"
        started = perf_counter()
        segments, info = model.transcribe(
            str(args.audio), language=None if args.language == "auto" else args.language, beam_size=result["beam_size"]
        )
        result["detected_language"] = info.language
        result["segments"] = [
            {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
            for segment in segments
        ]
        result["inference_seconds"] = perf_counter() - started
        result["gpu_memory_after_inference"] = gpu_memory_snapshot()
        result["audio_seconds"] = info.duration
        if not args.allow_empty and not any(segment["text"] for segment in result["segments"]):
            raise RuntimeError("Speech fixture produced no text")
        result["stage"] = "complete"
        result["ok"] = True
    except Exception as error:
        result.update(ok=False, error_type=type(error).__name__, error=str(error))
    result["peak_working_set_bytes"] = peak_working_set()
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
