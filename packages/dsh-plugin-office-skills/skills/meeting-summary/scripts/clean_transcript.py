#!/usr/bin/env python3
"""Transcript Cleaner and Normalizer.

Preprocesses raw meeting transcripts (WebVTT, SRT, Google Meet, Zoom, MS Teams, Otter.ai)
into a clean, normalized text stream suitable for skill processing.

Usage:
    python clean_transcript.py <input_file> [--output <output_file>]
"""

# e-Mate modification (2026-09-07): preserve standalone numeric facts; only
# discard a numeric subtitle cue when the following line is a timestamp.

import argparse
import re
import sys
from typing import List, Tuple


def clean_vtt_srt(content: str) -> str:
    """Removes WebVTT/SRT headers, timestamps, and sequence numbers."""
    lines = content.splitlines()
    cleaned_lines = []
    
    # Matches VTT timestamp lines: 00:00:01.000 --> 00:00:04.000
    # Matches SRT timestamp lines: 00:00:01,000 --> 00:00:04,000
    # Matches Teams timestamp lines: 0:0:1.0 -> 0:0:4.0
    timestamp_pattern = re.compile(
        r'^\s*(\d{1,2}:)?\d{1,2}:\d{2}[\.,]\d{3}\s*-+>\s*(\d{1,2}:)?\d{1,2}:\d{2}[\.,]\d{3}'
    )
    teams_timestamp_pattern = re.compile(
        r'^\s*\d{1,2}:\d{1,2}:\d{1,2}(\.\d+)?\s*->\s*\d{1,2}:\d{1,2}:\d{1,2}(\.\d+)?'
    )
    inline_timestamp_pattern = re.compile(
        r'\[\d{1,2}:\d{2}(:\d{2})?\]|\(\d{1,2}:\d{2}(:\d{2})?\)'
    )

    skip_next = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        
        # Skip WebVTT header or metadata
        if stripped.startswith("WEBVTT") or stripped.startswith("NOTE") or stripped.startswith("STYLE"):
            continue
        
        # Standalone numbers can be meeting facts, not subtitle cue numbers.
        if (stripped.isdigit() and index + 1 < len(lines)
                and timestamp_pattern.search(lines[index + 1])):
            continue
        
        # Skip timestamp lines
        if timestamp_pattern.search(stripped) or teams_timestamp_pattern.search(stripped):
            continue
            
        # Remove inline timestamps like [00:01:23]
        cleaned_line = inline_timestamp_pattern.sub('', stripped).strip()
        
        if cleaned_line:
            cleaned_lines.append(cleaned_line)

    return "\n".join(cleaned_lines)


def consolidate_speaker_blocks(text: str) -> str:
    """Consolidates consecutive lines from the same speaker."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return ""

    speaker_colon_pattern = re.compile(r'^([A-Z][A-Za-z0-9\s\.\-_]+?):\s*(.*)$')
    
    consolidated: List[Tuple[str, str]] = []
    current_speaker = "Unknown"
    current_text: List[str] = []

    for line in lines:
        match = speaker_colon_pattern.match(line)
        if match:
            speaker_name, dialogue = match.group(1).strip(), match.group(2).strip()
            # If same speaker continues
            if speaker_name == current_speaker and consolidated:
                if dialogue:
                    current_text.append(dialogue)
            else:
                if current_text:
                    consolidated.append((current_speaker, " ".join(current_text)))
                current_speaker = speaker_name
                current_text = [dialogue] if dialogue else []
        else:
            current_text.append(line)

    if current_text:
        consolidated.append((current_speaker, " ".join(current_text)))

    output_lines = []
    for speaker, content in consolidated:
        if speaker != "Unknown":
            output_lines.append(f"{speaker}: {content}")
        else:
            output_lines.append(content)

    return "\n\n".join(output_lines)


def clean_transcript(raw_text: str) -> str:
    """Executes full cleaning pipeline on raw transcript text."""
    stage1 = clean_vtt_srt(raw_text)
    stage2 = consolidate_speaker_blocks(stage1)
    return stage2


def main():
    parser = argparse.ArgumentParser(description="Clean and normalize meeting transcripts.")
    parser.add_argument("input_file", help="Path to raw transcript file (.txt, .vtt, .srt)")
    parser.add_argument("--output", "-o", help="Path to write cleaned transcript", default=None)
    args = parser.parse_args()

    try:
        with open(args.input_file, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except Exception as e:
        print(f"Error reading {args.input_file}: {e}", file=sys.stderr)
        sys.exit(1)

    cleaned = clean_transcript(content)

    if args.output:
        try:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(cleaned + "\n")
            print(f"Cleaned transcript written to {args.output}")
        except Exception as e:
            print(f"Error writing to {args.output}: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        print(cleaned)


if __name__ == "__main__":
    main()
