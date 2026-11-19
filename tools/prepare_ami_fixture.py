"""Prepare an excerpt from an AMI headset mix and its manual annotations."""

import argparse
from pathlib import Path
import wave
from xml.etree import ElementTree
from zipfile import ZipFile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("headset_mix", type=Path)
    parser.add_argument("annotations", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("--meeting", default="ES2004a", help="AMI meeting ID matching the headset mix")
    parser.add_argument("--start", type=int, default=0, help="Excerpt start in seconds")
    args = parser.parse_args()
    if args.start < 0:
        parser.error("--start must be nonnegative")
    seconds = 180
    end = args.start + seconds
    meeting = args.meeting
    if not meeting.isascii() or not meeting.isalnum():
        parser.error("--meeting must be an alphanumeric AMI meeting ID")
    stem = f"ami-{meeting.lower()}-180s" if not args.start else f"ami-{meeting.lower()}-{args.start}-{end}s"
    words = []
    with ZipFile(args.annotations) as annotations:
        for speaker in "ABCD":
            root = ElementTree.fromstring(annotations.read(f"words/{meeting}.{speaker}.words.xml"))
            for word in root.iter("w"):
                if (word.text and "starttime" in word.attrib
                        and args.start <= float(word.attrib["starttime"])
                        and float(word.attrib["endtime"]) <= end):
                    words.append((float(word.attrib["starttime"]), word.text))

    args.output_directory.mkdir(parents=True, exist_ok=True)
    with wave.open(str(args.headset_mix), "rb") as source:
        frames = source.getframerate() * seconds
        if source.getnframes() < source.getframerate() * end:
            raise ValueError("The headset mix does not cover the requested excerpt")
        source.setpos(source.getframerate() * args.start)
        with wave.open(str(args.output_directory / f"{stem}.wav"), "wb") as excerpt:
            excerpt.setparams(source.getparams())
            excerpt.writeframes(source.readframes(frames))
    reference = " ".join(word for _, word in sorted(words))
    (args.output_directory / f"{stem}.txt").write_text(reference, encoding="utf-8")


if __name__ == "__main__":
    main()
