---
name: meeting-transcript-summary
description: >-
  Analyzes raw meeting transcripts from Google Meet, Zoom, Microsoft Teams, WebVTT,
  or plain text. Produces a three-tier deliverable: an Executive Summary, a
  Detailed Discussion Record preserving arguments, technical explanations, and a
  structured Action Items table, followed by a strict 5-Sentence Summary.
---

# Meeting Transcript Summary Skill

## Purpose

This skill transforms raw, messy meeting transcripts into structured, high-fidelity documentation. It synthesizes discussions into three distinct sections tailored for different stakeholder needs, while strictly preserving technical rationale, decision logic, and accountability.

## Operating Principles

- Absolute Tone: Deliver factual, direct, and unambiguous synthesis. Eliminate conversational transitions, pleasantries, filler phrases, emotional framing, and closing remarks.
- Pure Factual Grounding (Zero Opinion): Include solely the factual information, decisions, and arguments directly stated in the transcript. Never introduce external opinions, editorial analysis, subjective interpretations, or speculative commentary.
- Zero Extrapolation or Implication: Do not imply, infer, or assume anything that is not explicitly stated in the transcript. When information is incomplete, unassigned, or unstated, record it explicitly as `[Unassigned]` or `[Not Specified]`.
- No Decorative Elements: Never use emojis, emoticons, graphical icons, or visual placeholder tokens (such as `[image]`, `[icon]`, or decorative symbols).
- Zero Preamble and Postamble: Begin output immediately with the document header. End immediately after the final sentence of the third section. Do not include introductory text ("Here is the summary...") or conversational closings ("Let me know if you need changes...").
- Missing Input Handling: If the user requests a summary without providing transcript text or an accessible transcript file path, respond with a single prompt requesting the transcript input and terminate.

## Processing Workflow

Follow these four steps sequentially:

```
1. Ingestion & Preprocessing
   ├── Parse speaker tags, timestamps, and diarization markers
   ├── Filter out small talk, greetings, logistics (audio checks), and off-topic banter
   └── Map main discussion topics, distinct arguments, technical concepts, and decisions

2. Section 1 Synthesis: Executive Summary
   ├── Identify primary meeting objective
   ├── Extract strategic decisions and core outcomes
   └── Summarize major organizational or product impacts

3. Section 2 Synthesis: Detailed Discussion Record & Action Items
   ├── Structure by logical topic (not chronological transcript stream)
   ├── Capture full explanations, background context, and technical architectures
   ├── Document the "Why": debate points, trade-offs, rejected alternatives, rationale
   └── Compile and format the Action Items table with exact column sizing

4. Section 3 Synthesis: Five-Sentence Summary
   ├── Draft exactly five grammatically complete, high-density sentences
   └── Verify sentence count equals five before finalizing
```

---

## Output Structure Specification

Format the generated document using standard Markdown as specified below:

# Meeting Summary: [Insert Meeting Topic / Project Name]

**Date:** [YYYY-MM-DD or As Stated in Transcript]  
**Participants:** [Comma-separated list of active participants identified in transcript]

---

## 1. Executive Summary

Provide a concise, high-level overview for leadership and key stakeholders:
- **Meeting Objective:** State the primary goal and context of the meeting in 1-2 direct sentences.
- **Key Decisions Made:** Bulleted list of definitive choices, approved proposals, and agreed paths forward.
- **Strategic Outcomes & Impact:** Bulleted list detailing what this means for the project, timeline, architecture, or organization.
- **Critical Risks & Blockers:** Any unresolved blockers, dependencies, or high-severity concerns raised during the call.

---

## 2. Detailed Discussion Record and Action Items

Create a comprehensive narrative record organized by topic. This section must allow any absent team member to fully grasp the depth of technical discussions, background context, and decision rationale.

### Topic 1: [Descriptive Topic Title]

- **Context and Background:** Fully explain any underlying systems, business constraints, historical issues, or industry drivers introduced by participants.
- **Detailed Explanation:** When participants explain architectures, algorithms, workflows, policies, or technical mechanisms, document those explanations in complete, rigorous detail. Do not reduce detailed technical explanations to high-level bullet points.
- **Discussion and Rationale (The "Why"):** Chronicle the arguments exchanged. Detail why specific approaches were favored, what alternatives were evaluated and dismissed, what trade-offs were acknowledged, and how consensus was reached.
- **Key Conclusions:** The definitive agreement reached for this topic.

### Topic 2: [Descriptive Topic Title]
[Repeat structured format for each substantial topic discussed during the meeting.]

### Action Items

Conclude Section 2 with a Markdown table containing all concrete deliverables, tasks, and follow-ups assigned during the meeting. Adhere strictly to the column layout below:

| Action Item | Assigned To | Deadline | Acceptance Criteria / Target Deliverable |
| :--- | :--- | :--- | :--- |
| [Clear, actionable description of the task] | [Owner Name or Unassigned] | [Date / Milestone or Not Specified] | [Specific deliverable, link, or outcome required] |

#### Table Formatting Rules:
1. Always include all four columns.
2. If an action item has no designated owner in the transcript, write `Unassigned`. Do not guess names.
3. If no timeline or target date was agreed upon, write `Not Specified`.
4. Ensure Markdown table syntax is valid and cleanly aligned.

---

## 3. Five-Sentence Summary

A single paragraph containing exactly five complete, high-density sentences summarizing the critical information, key decisions, and next steps:

[Sentence 1: Context and primary purpose of the meeting.] [Sentence 2: Core technical or strategic challenge addressed.] [Sentence 3: Primary decision or consensus reached.] [Sentence 4: Major secondary outcome, resource commitment, or architectural shift.] [Sentence 5: Immediate next milestone and critical path timeline.]

---

## Output Format Modes

The skill supports four delivery modes based on user requirements:

1. **Rendered Markdown (Default):** Output standard Markdown directly to the chat stream. The host agent harness automatically parses and renders this into visual rich text with styled headers, structured bullet lists, and graphical tables. This format is optimized for non-technical users to select, copy, and paste directly into Google Docs, Microsoft Word, Confluence, or email without losing styling.
2. **Raw Markdown Code Block:** When prompted for "raw markdown", wrap the complete output inside a fenced code block (` ```markdown ... ``` `) with a one-click copy button, allowing immediate transfer into code repositories or `.md` files.
3. **Dual Output Mode:** When prompted for "dual output" or "both rendered and raw", deliver the complete rendered output first, followed by a divider and a fenced code block containing the exact raw Markdown.
4. **Interactive Canvas UI Mode:** When prompted for "canvas", "dashboard", "visual UI", or "interactive summary", generate a self-contained HTML/JS/CSS document (`meeting_dashboard.html` or ` ```html ... ``` ` code block) implementing the interactive Executive Overview, SVG Knowledge Graph with Topic Inspector, and Multi-View Action Items (Kanban board by owner and sortable data table) following the reference guide in `references/canvas_ui_guide.md` and template in `templates/meeting_dashboard_template.html`.

---

## Content Evaluation Rubric

Before outputting the response, verify compliance against these standards:

1. **Sentence Count:** Confirm that Section 3 contains exactly 5 terminal periods corresponding to 5 complete sentences.
2. **Completeness of Explanations:** Verify that in Section 2, complex explanations (e.g., system designs, numerical targets, workflow steps) are fully elaborated rather than condensed into generic summaries.
3. **Preservation of Rationale:** Confirm that the reasoning, trade-offs, and counter-arguments behind decisions are documented.
4. **Tone and Style Check:** Verify that zero emojis, zero conversational pleasantries, and zero meta-commentary are present.
5. **Pure Factual Grounding & Zero Opinion:** Verify that all facts, numbers, dates, technical claims, arguments, and deliverables derive solely from the transcript. Confirm that zero personal opinions, editorial interpretations, external advice, or unstated implications were added.
