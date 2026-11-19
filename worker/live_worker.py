"""Read paired PCM frames and emit timestamped local recognition results."""

import json
import os
import sys
from pathlib import Path

RATE = 16000
STEP = 8 * RATE
CONTEXT = RATE
SOURCES = ("microphone", "system")


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}), flush=True)


def run(model_path, language="en", engine="whisper"):
    os.environ["HF_HUB_OFFLINE"] = "1"
    import numpy as np
    path = Path(model_path)
    moonshine = engine == "moonshine"
    if moonshine:
        from moonshine_voice import LineCompleted, LineStarted, LineTextChanged, LineUpdated, ModelArch, Transcriber

        model = Transcriber(path, ModelArch.MEDIUM_STREAMING, options={"return_audio_data": False})
        channels = [model.create_stream() for _ in SOURCES]
        events = [[] for _ in SOURCES]
        published = [set() for _ in SOURCES]
        for channel, stream_events in zip(channels, events):
            channel.add_listener(stream_events.append)
            channel.start()
    else:
        from faster_whisper import WhisperModel

        if not all((path / name).is_file() for name in ("config.json", "model.bin", "tokenizer.json")):
            raise ValueError("Local Whisper snapshot is incomplete")
        model = WhisperModel(str(path), device="cuda", compute_type="float16", local_files_only=True)
        if language != "en" and not model.model.is_multilingual:
            raise ValueError("Choose a multilingual Whisper model for this language")
    stream = sys.stdin.buffer
    buffers = [bytearray(), bytearray()]
    offset = committed = origin = 0
    emit("ready")

    previews = ["", ""]

    def publish_preview(index, text):
        if text != previews[index]:
            previews[index] = text
            emit("preview", source=SOURCES[index], text=text)

    def publish_moonshine(index):
        for event in events[index]:
            line = event.line
            if isinstance(event, LineCompleted):
                publish_preview(index, "")
                if not line.text.strip() or line.line_id in published[index]:
                    continue
                published[index].add(line.line_id)
                start = max(0, min(round(offset / 16), round(line.start_time * 1000)))
                end = min(round(offset / 16), round((line.start_time + line.duration) * 1000))
                emit("segment", source=SOURCES[index], startMs=start,
                     endMs=max(start, end), text=line.text.strip())
            elif isinstance(event, (LineStarted, LineUpdated, LineTextChanged)) and not line.is_complete:
                publish_preview(index, line.text.strip())
        events[index].clear()

    def recognize(end):
        for index, (source, pcm) in enumerate(zip(SOURCES, buffers)):
            samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
            segments, _ = model.transcribe(
                samples, language=None if language == "auto" else language,
                beam_size=1, vad_filter=True, word_timestamps=True
            )
            preview_words = []
            for segment in segments:
                words = []
                for word in segment.words or ():
                    start = origin + round(word.start * RATE)
                    stop = min(offset, origin + round(word.end * RATE))
                    if committed <= (start + stop) // 2 < end:
                        words.append((start, stop, word.word))
                    elif end <= (start + stop) // 2 < offset:
                        preview_words.append(word.word)
                if words:
                    emit("segment", source=source, startMs=round(words[0][0] / 16),
                         endMs=round(words[-1][1] / 16), text="".join(word[2] for word in words).strip())
            publish_preview(index, "".join(preview_words).strip())

    while line := stream.readline(4097):
        if len(line) > 4096 or not line.endswith(b"\n"):
            raise ValueError("Invalid PCM header")
        message = json.loads(line)
        kind = message["type"]
        if kind == "cancel":
            emit("cancelled")
            return
        if kind == "finish":
            if moonshine:
                for index, channel in enumerate(channels):
                    if channel.stop() is None:
                        raise RuntimeError("Moonshine did not return a final transcript")
                    publish_moonshine(index)
                    publish_preview(index, "")
            elif committed < offset:
                recognize(offset)
            emit("finished", samples=offset)
            return
        size = message["samples"]
        if kind != "audio" or message["offset"] != offset or type(size) is not int or not 0 < size <= 2048:
            raise ValueError("Invalid PCM frame")
        for index, pcm in enumerate(buffers):
            frame = stream.read(size * 2)
            if len(frame) != size * 2:
                raise ValueError("Incomplete PCM frame")
            if moonshine:
                samples = np.frombuffer(frame, dtype="<i2").astype(np.float32) / 32768
                channels[index].add_audio(samples.tolist())
            else:
                pcm.extend(frame)
        offset += size
        if moonshine:
            for index in range(len(channels)):
                publish_moonshine(index)
        elif offset >= committed + STEP + CONTEXT:
            end = committed + STEP
            recognize(end)
            committed = end
            keep_from = committed - CONTEXT
            for pcm in buffers:
                del pcm[:(keep_from - origin) * 2]
            origin = keep_from
        emit("accepted", samples=offset)
    raise ValueError("Recognition input closed before finish")


if __name__ == "__main__":
    try:
        run(*sys.argv[1:])
    except Exception as error:
        emit("error", message=str(error))
        sys.exit(1)
