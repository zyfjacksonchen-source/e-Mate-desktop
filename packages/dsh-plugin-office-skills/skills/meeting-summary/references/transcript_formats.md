# Supported Transcript Formats and Ingestion Guide

This reference document outlines the common meeting transcript formats processed by the skill, their typical structural characteristics, and preprocessing normalization rules.

---

## 1. Supported Input Formats

### 1.1 Google Meet (Google Docs / Google Drive Transcript)
- **Format:** Plain text or exported document.
- **Structure:**
  ```text
  Jane Doe
  10:02 AM
  Let's review the architectural migration plan for Q3.

  John Smith
  10:03 AM
  I prepared the latency benchmarks comparing the two message queue approaches.
  ```
- **Parsing Strategy:** Normalize speaker names by grouping consecutive utterances by the same speaker. Discard clock timestamps when reconstructing topical flow.

---

### 1.2 WebVTT (.vtt) - Zoom, Microsoft Teams, Cisco Webex
- **Format:** Standard Web Video Text Tracks format.
- **Structure:**
  ```text
  WEBVTT

  1
  00:00:01.000 --> 00:00:04.500
  Jane Doe: Welcome everyone. Today we decide on the message broker.

  2
  00:00:05.100 --> 00:00:10.200
  John Smith: Based on our latency tests, Pub/Sub handled 45k QPS with sub-15ms p99.
  ```
- **Parsing Strategy:** Strip track index numbers, millisecond timestamp ranges (`-->`), and VTT headers. Parse `Speaker Name:` prefixes and concatenate adjacent cues from the same speaker.

---

### 1.3 SubRip (.srt)
- **Format:** Standard SubRip caption format.
- **Structure:**
  ```text
  1
  00:00:01,000 --> 00:00:04,500
  Jane Doe: Let's begin the review.

  2
  00:00:05,000 --> 00:00:09,000
  John Smith: I will share the architectural diagrams.
  ```
- **Parsing Strategy:** Strip subtitle numbers and timecode markers. Retain speaker markers if present.

---

### 1.4 Microsoft Teams Meeting Transcript (.docx / plain text export)
- **Format:** Exported meeting transcript.
- **Structure:**
  ```text
  0:0:1.0 -> 0:0:4.0
  Jane Doe
  We need to finalize the Q3 infrastructure budget.

  0:0:5.0 -> 0:0:11.0
  Alex Johnson
  The primary cost driver is the multi-region database replication.
  ```
- **Parsing Strategy:** Extract speaker name headers and consolidate associated text segments.

---

### 1.5 Otter.ai / Descript / Third-Party AI Transcribers
- **Format:** Text export with speaker diarization and running timestamps.
- **Structure:**
  ```text
  Jane Doe 00:00
  Let's walk through the schema evolution strategy.

  John Smith 00:45
  We are proposing Protocol Buffers over JSON Schema for backwards compatibility.
  ```
- **Parsing Strategy:** Extract speaker names, strip minutes/seconds timestamps, and consolidate paragraph blocks.

---

### 1.6 Raw Text Without Timestamps
- **Format:** Plain text logs or pasted chat records.
- **Structure:**
  ```text
  Jane: We should deploy to staging on Tuesday.
  John: Agreed, provided the smoke tests pass on Monday.
  ```
- **Parsing Strategy:** Ingest directly, parsing speaker identities from leading tokens.

---

## 2. Ingestion Edge Cases and Handling Rules

### Missing Speaker Labels
When the transcript contains no speaker names (e.g., automated raw transcription without diarization):
- Identify context shifts and dialogue exchanges.
- Attribute statements to `[Speaker A]`, `[Speaker B]`, or `[Participant]` consistently throughout the summary.
- Focus the narrative on the arguments, facts, and consensus rather than personal attribution.

### Overlapping or Fragmented Speech
Spoken dialogue often contains false starts, mid-sentence corrections, and interruptions:
- Synthesize the final intended statement rather than recording conversational hesitation.
- Discard verbal fillers ("um", "uh", "you know", "like") and audio connectivity checks ("can you hear me?").

### Conflicting Statements or Pivot Decisions
When a team considers Option A initially, debates it, and later reverses to Option B:
- Explicitly chronicle this progression in Section 2 (Detailed Discussion Record).
- Document why Option A was initially considered, what risks or counter-arguments were raised, and why Option B was chosen as the final decision.
