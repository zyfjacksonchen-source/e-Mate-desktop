# Quality and Compliance Checklist

Use this checklist to audit generated meeting summaries against required quality, structure, and style criteria.

---

## 1. Content and Fidelity Standards

| Criterion | Requirement | Verification Check |
| :--- | :--- | :--- |
| **Pure Factual Grounding** | All statements, numbers, names, and conclusions derive strictly from the transcript. | Zero extrapolated facts, unmentioned tools, or invented deadlines. |
| **Zero Opinion & Editorializing** | No external commentary, personal opinions, editorial assessments, or unstated implications are injected. | All content reports purely what participants stated, proposed, and decided. |
| **Full Technical Depth** | Technical explanations (architectures, protocols, calculations, workflows) are preserved in complete detail. | Technical mechanisms are explained in depth rather than summarized in vague high-level terms. |
| **Preservation of the "Why"** | Debates, trade-offs, discarded alternatives, and reasoning behind decisions are explicitly documented. | The narrative explains why decisions were made, not merely what was decided. |
| **Topic-Based Organization** | Discussions are grouped by logical subject matter rather than chronological transcript order. | Related discussions across different time points in the meeting are consolidated cleanly under relevant topic headers. |
| **Explicit Metadata Fallbacks** | Missing owners or dates in action items are explicitly marked. | Owners marked as `Unassigned` and deadlines marked as `Not Specified` when unstated. |

---

## 2. Structural Standards

| Section | Mandatory Elements | Common Failures to Avoid |
| :--- | :--- | :--- |
| **Document Header** | Meeting Topic, Date, Participant List. | Missing participants or omitting date. |
| **1. Executive Summary** | Meeting Objective, Key Decisions Made, Strategic Outcomes & Impact, Critical Risks & Blockers. | Blending decisions into running paragraphs without clear structure. |
| **2. Detailed Discussion Record** | Subheadings per topic with Context & Background, Detailed Explanation, Discussion & Rationale ("Why"), and Key Conclusions. | Converting detailed technical explanations into superficial single-sentence bullet points. |
| **Action Items Table** | 4 columns: `Action Item`, `Assigned To`, `Deadline`, `Acceptance Criteria / Target Deliverable`. | Missing columns, broken table alignment, or hallucinating assignees/deadlines. |
| **3. Five-Sentence Summary** | Exactly five grammatically complete sentences in a single paragraph. | Generating 4 or 6 sentences, or using run-on compound sentences separated by semicolons. |

---

## 3. Formatting and Tone Standards

- **No Emojis or Icons:** No visual symbols, emoticons, or decorative markdown tags.
- **No Conversational Wrapper:** The output must not begin with introductory text ("Sure, here is your summary") and must not conclude with closing remarks ("Let me know if you would like any modifications").
- **Direct Business Language:** Professional, factual, and direct prose.
- **Valid Markdown Syntax:** Headers, tables, and lists must render cleanly across standard Markdown renderers.
