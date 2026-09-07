# Canvas UI and Interactive Visualizations Guide

This document outlines the architecture, design principles, and data contracts for rendering interactive Canvas UI dashboards in agent harnesses such as Gemini Enterprise App, Spark, and web-based artifact runtimes.

---

## 1. Canvas UI Architecture

Modern enterprise agent harnesses render dynamic user interfaces by executing self-contained HTML, CSS, and JavaScript inside a secure, sandboxed `<iframe>`. 

### Key Runtime Characteristics:
- **Zero-Dependency Self-Containment:** All styles (CSS) and logic (JavaScript) are embedded directly within a single `.html` document or code block. This avoids network timeouts, blocked external CDN requests, and version conflicts.
- **Client-Side Interactivity:** Supports full DOM manipulation, SVG/Canvas graphical rendering, tab switching, search filtering, and clipboard interactions.
- **Sandboxed Execution:** Scripts execute within standard iframe security constraints (`allow-scripts`, isolated local storage, no parent window cross-origin access).

---

## 2. Core Dashboard Components

The meeting intelligence dashboard comprises four primary interface modules:

### 2.1 Executive Overview & KPI Metrics
- **Metric Badges:** High-level counts for decisions made, topics analyzed, assigned action items, and target milestone dates.
- **Executive Summary Cards:** Structured cards displaying Meeting Objectives, Approved Decisions, Strategic Impacts, and Critical Risks. (Note: The strict Five-Sentence Summary is generated exclusively in the primary text/markdown output and omitted from the Canvas UI).

### 2.2 Interactive Topic Knowledge Graph
- **Visual Topology:** An interactive SVG node-link graph representing the central meeting objective, radiating outwards to distinct topic nodes labeled with concise, descriptive short titles (e.g. `Platform Migration`, `Protobuf Schemas`, `CMEK & Security`, `Staging & Cutover`).
- **Inter-Topic Relationships:** Explicit directed edges link interdependent topics with relationship badge pills (e.g. `Enforces`, `Requires`, `Tested in`, `Gates`), visualizing technical and operational workflows.
- **Dynamic Interaction:**
  - Clicking any node opens a slide-out Detail Inspector drawer.
  - Hover states highlight connected topics and dependencies.
  - Instant search input to filter and highlight matching nodes in real time.
- **Content Depth:** The inspector displays the full Context, In-Depth Technical Mechanism, the Rationale / Debates ("Why"), and Key Conclusions.

### 2.3 Action Items Visualizer (Multi-View & Filter Toolbar)
The dashboard delivers two clean views equipped with a unified filtering and export toolbar:
- **Filtering Toolbar:**
  - **Owner Dropdown Filter:** Filter deliverables by specific assignee, defaulting to `All Owners`.
  - **Live Search Input:** Instant keyword matching across task descriptions, assignees, deadlines, and acceptance criteria.
  - **Export Buttons:** One-click CSV and Markdown table export to clipboard.
  - **Live Item Count:** Real-time indicator displaying matched vs. total tasks.
- **Views:**
  1. **Kanban by Owner Board (Default):** Columns organized per participant (plus an `Unassigned` backlog column), presenting tasks, deadlines, and deliverables as actionable cards.
  2. **Structured Interactive Table:** A tabular view displaying all four standardized columns with zebra striping and hover highlights.

### 2.4 Detailed Narrative Discussion Explorer
- Collapsible topic accordions allowing deep reading of the complete meeting record with technical explanations preserved in full.

---

## 3. Dashboard Data Contract (JSON Schema)

The dashboard template is driven by a structured JavaScript object embedded in the document. Agents populate this object directly when generating a Canvas UI:

```json
{
  "meetingTitle": "string",
  "date": "YYYY-MM-DD",
  "participants": ["string"],
  "metrics": {
    "decisionsCount": 0,
    "topicsCount": 0,
    "actionsCount": 0,
    "targetCutover": "YYYY-MM-DD"
  },
  "executiveSummary": {
    "objective": "string",
    "decisions": ["string"],
    "impacts": ["string"],
    "risks": ["string"]
  },
  "topics": [
    {
      "id": "topic-1",
      "title": "string",
      "shortTitle": "string (2-3 words for node label)",
      "context": "string",
      "explanation": "string",
      "rationale": "string",
      "conclusion": "string"
    }
  ],
  "relationships": [
    {
      "from": "topic-1",
      "to": "topic-2",
      "label": "string (e.g. Enforces, Requires, Tested in, Gates)"
    }
  ],
  "actionItems": [
    {
      "id": "act-1",
      "description": "string",
      "assignee": "string",
      "deadline": "YYYY-MM-DD",
      "deliverable": "string",
      "status": "Assigned | In Progress | Unassigned"
    }
  ]
}
```

---

## 4. Design and Styling Standards

- **Color Palette:** High-contrast neutral slate background (`#0f172a`), clean card surfaces (`#1e293b`, `#334155`), cool blue accents (`#38bdf8`, `#0284c7`), and muted text hierarchy (`#94a3b8`, `#f8fafc`).
- **Typography:** Standard system sans-serif stack (`system-ui, -apple-system, Segoe UI, Roboto, sans-serif`).
- **No Decorative Emojis or Icons:** Visual hierarchy is communicated using geometric SVG glyphs, color badges, and clean typography tags (e.g. `[Pending]`, `[Assigned]`, `[Decision]`).
- **Responsive Layout:** CSS Grid and Flexbox layouts adapt seamlessly across full-width monitors, split-screen views, and mobile viewports.
