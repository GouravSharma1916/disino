# Disino

Disino is an AI-first engineering project-rescue agent that connects GitHub, Slack, and Notion to detect ownership drift on critical engineering work, reason over evidence, safely intervene, and verify that the rescue actually happened.

## A. PROJECT OVERVIEW

### What We Built

Disino owns the workflow from user goal to verified outcome: it investigates a release or task, gathers evidence from multiple systems, evaluates what evidence matters, detects contradictions, challenges its own conclusion, assigns confidence, applies a safety decision, performs a permitted corrective action, and verifies the resulting state.

### The Problem

Critical work can quietly change hands while the planning system still points to the original owner. That creates stalled releases, unclear accountability, and unsafe automated changes. Disino builds an evidence trail before deciding whether any rescue is safe.

### Core Workflow

`UNDERSTAND -> INVESTIGATE -> DETECT -> CHALLENGE -> DECIDE -> ACT -> VERIFY`

This lifecycle is the foundation we built. It represents an agent workflow, not a UI sequence around a one-shot model response.

The web demo follows this flow:

`Investigate Release -> evidence ledger -> AI analysis -> safety decision -> Rescue Project -> action results -> fresh read-back verification`

## B. EXTERNAL APPS USED

Disino connects to all three external apps. Each provides a different part of the ownership picture:

- **GitHub:** Reads the issue or pull request and timeline activity. GitHub shows engineering activity and contributors, but activity alone never proves ownership. When approved, Disino can update the issue assignee.
- **Slack:** Searches ownership and handoff messages. Explicit recent handoff evidence is the strongest operational ownership signal. When approved, Disino can send a clearly identified `[Disino]` notification.
- **Notion:** Reads the planned task or release context and planned owner. Notion is the planning source of record and can receive updated task context after an approved correction.

## How Disino Works

The adapters normalize API responses into the shared `Evidence` contract. Every item keeps its source, timestamp, content, related task, person when available, confidence, relevance, and missing/conflicting state.

The investigation engine combines evidence deterministically. The agent decides what evidence matters, while every claim remains grounded to actual source records with source, timestamp, content, and actor data where available. Recent explicit Slack handoffs can identify an operational owner. GitHub activity supplies engineering context but cannot establish ownership by itself. Missing, stale, or contradictory evidence lowers confidence and blocks unsafe rescue.

## AI-First Reasoning Approach

The optional server-side OpenAI layer receives collected evidence and must reference collected evidence IDs. Its structured response identifies supporting, conflicting, and missing evidence, provides reasoning, and answers: "What evidence could prove this conclusion wrong?"

The response is runtime-validated before use. The AI can reference only evidence IDs returned by the investigation, cannot invent source records or owners, and must explicitly state what could prove its conclusion wrong. If the model is unavailable or returns invalid evidence references or unsupported source claims, Disino falls back to the deterministic investigation decision and reports the AI error.

## Why This Is AI-First

Disino is not an LLM wrapper or chatbot. The model participates in the decision-making loop by reasoning over grounded evidence and contradictions, while deterministic server-side systems enforce evidence contracts, safety gates, external actions, response validation, and fresh verification. Confidence determines whether the agent can act; an external write is never assumed successful, so Disino reads the source systems again to verify the result.

The complete loop is: user goal -> investigation -> evidence gathering -> evidence evaluation -> contradiction detection -> self-challenge -> confidence -> safety decision -> action -> fresh verification.

## Architecture

- Next.js App Router and TypeScript
- Server API routes for investigation, corrective actions, and verification
- Native `fetch` adapters for GitHub, Slack, Notion, and OpenAI
- Shared domain contracts in `src/domain/contracts.ts`
- Deterministic investigation and safety logic in `src/server/`
- Single responsive demo page in `src/app/page.tsx`

## Confidence And Safety Model

- **HIGH:** action is permitted by the safety policy.
- **MEDIUM:** explicit approval is required before execution.
- **LOW:** no corrective action may execute.

The UI only shows Rescue controls for permitted HIGH decisions or an explicit MEDIUM approval flow. The server enforces the same rule independently. No decision is treated as safe merely because GitHub contains activity.

## Actions And Verification

Permitted actions can update GitHub issue ownership, send a Slack ownership-correction notification, and update Notion task context. Each action returns a per-source success or failure result.

Verification is separate from action execution. GitHub is re-read to confirm the assignee, Slack is read again to confirm the returned Disino message, and Notion is re-read to verify the requested owner state in the page content. Disino reports `Project Rescued` only when every required action succeeds and every required verification returns `verified: true`.

## C. SETUP INSTRUCTIONS

### Prerequisites

- Node.js 22 or newer
- npm
- Credentials with the required read/write permissions for GitHub, Slack, and Notion
- An OpenAI API key for model-assisted reasoning; without it, the deterministic engine still reports its result

### Installation

```bash
npm install
```

### Environment Variables

Copy the template and fill it with local values. `.env.example` contains variable names only and no credentials.

```powershell
Copy-Item .env.example .env.local
```

Required integration variables:

```text
NOTION_API_KEY=
NOTION_VERSION=
GITHUB_TOKEN=
SLACK_BOT_TOKEN=
OPENAI_API_KEY=
OPENAI_MODEL=
```

The `DISINO_*` target variables configure the specific release/task used for the hackathon demonstration:

```text
DISINO_TASK_ID=
DISINO_NOTION_PAGE_ID=
DISINO_GITHUB_OWNER=
DISINO_GITHUB_REPOSITORY=
DISINO_GITHUB_ISSUE=
DISINO_SLACK_QUERY=
DISINO_SLACK_CHANNEL=
DISINO_NOTION_OWNER_PROPERTY=
DISINO_GITHUB_OPERATIONAL_OWNER=
```

The connected demo is disabled by default. For a trusted local demo only, set both `DISINO_ENABLE_LIVE_DEMO=true` and `NEXT_PUBLIC_DISINO_LIVE_DEMO=true`. The server flag gates investigation, action, and verification routes; the public flag only controls whether the browser shows the demo controls. Do not enable the live demo on a public deployment: authentication and per-user authorization are not implemented, and enabled actions can write to connected GitHub, Slack, and Notion resources.

Use actual resource IDs, repository names, channel names, property names, and the actual GitHub login to assign. Keep `.env.local` private; it is ignored by git. A future production version can replace these fixed targets with connected-account and project discovery.

### Run

```bash
npm run dev
```

Open `http://localhost:3000`. The public-facing page shows a product overview while the connected demo remains disabled unless explicitly enabled for a trusted local run. A real connected environment is required for external API actions and read-back verification.

## Demo Flow

1. Select **Investigate Release**.
2. Watch the server-backed investigation return Notion, GitHub, and Slack evidence.
3. Review planned owner, operational owner, confidence, safety, supporting/conflicting/missing evidence, reasoning, and challenge.
4. Rescue only when the displayed safety decision permits it. MEDIUM requires explicit approval.
5. Review each GitHub, Slack, and Notion action result.
6. Review fresh expected-versus-actual verification results.
7. `Project Rescued` appears only after all required actions and verifications succeed.

Any synthetic or fixture evidence used in a local demo must be clearly labeled **DISINO DEMO EVIDENCE**. The UI includes that label on the evidence ledger; no synthetic evidence is presented as a live API confirmation.

## D. RELIABILITY & EVALUATION

The deterministic suite runs against the real investigation, safety, action, and verification entry points, with `fetch` mocked only at the external API boundary. It reports actual Node test-runner results.

The suite covers these eight ownership scenarios:

1. Clear recent handoff: HIGH and action allowed.
2. Handoff with weak GitHub support: cautious investigation without overclaiming.
3. GitHub activity only: no automatic ownership assignment.
4. Conflicting Slack evidence: no unsafe action.
5. Old handoff with new planned-owner activity: lower confidence and no unsafe action.
6. No ownership evidence: LOW and no action.
7. Multiple active contributors: uncertain and no unsafe action.
8. Planned owner still clearly owns the work: no rescue.

The suite covers eight core ownership scenarios plus integration-unavailability, failed-action, failed-verification, and duplicate-request cases. External actions are never treated as verified from the action response alone; each required state is checked with a fresh API read-back.

Actual result from the final evaluation run:

```text
13 passed
0 failed
```

## Future Direction

This is the first AI-first foundation of a broader engineering-agent product. Future versions can expand from the current configured hackathon scenario toward connected-account and project discovery, broader engineering workflows, persistent task context, and additional autonomous engineering actions. Those capabilities are not part of the current implementation.

## Limitations / Demo Notes

- The demo targets one configured release/task rather than providing a multi-project dashboard.
- The duplicate rescue guard is process-local and intended for the hackathon demo, not distributed coordination.
- External API permissions, Slack search visibility, Notion property formats, and rate limits affect live results.
- The model layer is optional; deterministic evidence and safety behavior remain the controlling fallback.
- No authentication, persistent workflow store, UI settings, or production retry queue is included.

## E. DEMO VIDEO

**Live Demo:** [Open Disino](https://disino.vercel.app/)

**Demo Video:** [Watch the 2-minute Disino demo](https://drive.google.com/file/d/1YyaDxF_tD9ZMXGJ1BGTiWoo0yL0pNzI8/view?usp=sharing)

The demo demonstrates the complete investigation, rescue, and verification flow using the configured hackathon scenario.