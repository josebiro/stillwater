"""Local protocol worker for validating PCM transport."""

import hashlib
import json
import sys

MAX_HEADER = 4096
MAX_AUDIO = 32000


def emit(kind, request=None, **fields):
    print(json.dumps({"version": 1, "type": kind, "request": request, **fields}), flush=True)


def main():
    source = sys.stdin.buffer
    emit("ready")
    session = None
    while line := source.readline(MAX_HEADER + 1):
        request = None
        try:
            if len(line) > MAX_HEADER or not line.endswith(b"\n"):
                raise ValueError("Invalid header length")
            header = json.loads(line)
            request = header["request"]
            if header["version"] != 1 or not isinstance(request, str):
                raise ValueError("Invalid envelope")
            kind = header["type"]
            if kind == "shutdown":
                emit("stopped", request)
                return 0
            if kind == "start" and session is None:
                session = header["session"]
                if not isinstance(session, str) or not session:
                    raise ValueError("Invalid session")
                sequence = 0
                emit("started", request, session=session)
                continue
            if not session or header["session"] != session:
                raise ValueError("Invalid session")
            if kind in ("cancel", "finish"):
                emit("cancelled" if kind == "cancel" else "finished", request, session=session)
                session = None
                continue
            size = header["bytes"]
            offset = header["offsetSamples"]
            if (kind != "audio" or header["sequence"] != sequence
                    or type(size) is not int or not 0 < size <= MAX_AUDIO or size % 2
                    or type(offset) is not int or offset < 0
                    or header["source"] not in ("microphone", "system")):
                raise ValueError("Invalid PCM frame")
            pcm = source.read(size)
            if len(pcm) != size:
                raise ValueError("Truncated PCM frame")
            emit("accepted", request, session=session, sequence=sequence, bytes=size,
                 offsetSamples=offset, source=header["source"],
                 sha256=hashlib.sha256(pcm).hexdigest())
            sequence += 1
        except (KeyError, ValueError, TypeError) as error:
            emit("error", request, code="INVALID_FRAME", message=str(error))
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
