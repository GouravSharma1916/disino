"use client";

import { useEffect, useRef, useState } from "react";

type Stage = "idle" | "investigating" | "analyzing" | "ready" | "acting" | "verifying" | "done" | "error";
type Source = "notion" | "github" | "slack";

type Evidence = {
  id: string;
  source: Source;
  type: string;
  content: string;
  timestamp: string;
  person?: { name?: string; handle?: string };
  availability: "available" | "missing" | "conflicting";
  missingReason?: string;
};

type Decision = {
  plannedOwner?: { name?: string; handle?: string };
  operationalOwner?: { name?: string; handle?: string };
  confidence: number;
  safetyLevel: "HIGH" | "MEDIUM" | "LOW";
  supportingEvidence: Evidence[];
  conflictingEvidence: Evidence[];
  missingEvidence: Evidence[];
  reasoning: string;
  challenge: string;
  recommendedAction?: { id: string; type: string; status: string };
};

type Investigation = {
  investigationId: string;
  taskId: string;
  status: string;
  evidence: Evidence[];
  ownershipDecision: Decision;
};

type ActionResult = { actionId: string; source: Source; status: string; message: string };
type VerificationResult = { actionId: string; source: Source; status: string; expectedState: string; actualState: string; verified: boolean };

const stages = ["Understand", "Investigate", "Detect", "Challenge", "Decide", "Act", "Verify"];
const investigationStages = [
  "Understanding project context",
  "Investigating engineering activity",
  "Checking team communication",
  "Resolving evidence",
  "Evaluating safe action",
];

const liveDemoEnabled = process.env.NEXT_PUBLIC_DISINO_LIVE_DEMO === "true";

function ownerName(owner?: { name?: string; handle?: string }) {
  return owner?.name ?? owner?.handle ?? "Unassigned";
}

function formatTime(timestamp: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

function sourceLabel(source: Source) {
  return source[0].toUpperCase() + source.slice(1);
}

export default function Home() {
  const [stage, setStage] = useState<Stage>("idle");
  const [investigation, setInvestigation] = useState<Investigation>();
  const [actions, setActions] = useState<ActionResult[]>([]);
  const [verification, setVerification] = useState<VerificationResult[]>([]);
  const [approved, setApproved] = useState(false);
  const [progressStages, setProgressStages] = useState<string[]>([]);
  const [currentProgress, setCurrentProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const resultsRef = useRef<HTMLElement>(null);

  const decision = investigation?.ownershipDecision;
  const allowed = decision && decision.safetyLevel === "HIGH";
  const rescueComplete = stage === "done" && actions.length > 0 && actions.every((item) => item.status === "succeeded") && verification.length > 0 && verification.every((item) => item.verified);

  useEffect(() => {
    if (rescueComplete) resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [rescueComplete]);

  async function investigate() {
    setStage("investigating");
    setError(undefined);
    setActions([]);
    setVerification([]);
    setInvestigation(undefined);
    setProgressStages([]);
    setCurrentProgress(undefined);
    try {
      const response = await fetch("/api/investigate", { method: "POST" });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? "Investigation failed.");
      }
      if (!response.body) throw new Error("Investigation did not return a progress stream.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line) as { type: string; stage?: string; payload?: Investigation; error?: string };
          if (event.type === "progress" && event.stage) {
            setCurrentProgress(event.stage);
            setProgressStages((completed) => completed.includes(event.stage!) ? completed : [...completed, event.stage!]);
          } else if (event.type === "result" && event.payload) {
            setInvestigation(event.payload);
            setCurrentProgress(undefined);
            setStage("ready");
          } else if (event.type === "error") {
            throw new Error(event.error ?? "Investigation failed.");
          }
        }
        if (chunk.done) break;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Investigation failed.");
      setStage("error");
    }
  }

  async function rescue(explicitApproval = approved) {
    setStage("acting");
    setError(undefined);
    try {
      const actionResponse = await fetch("/api/actions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ investigationId: investigation?.investigationId, decision, approved: explicitApproval }) });
      const actionPayload = await actionResponse.json();
      setActions(actionPayload.results ?? []);
      if (!actionResponse.ok || actionPayload.status === "blocked" || actionPayload.status === "failed") throw new Error("Corrective action was not confirmed.");
      setStage("verifying");
      const verificationResponse = await fetch("/api/verification", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actionExecution: actionPayload, rescueRequestId: actionPayload.rescueRequestId, verification: actionPayload.verification }) });
      const verificationPayload = await verificationResponse.json();
      setVerification(verificationPayload.results ?? []);
      if (!verificationResponse.ok || verificationPayload.status !== "succeeded") throw new Error("Verification did not confirm every required change.");
      setStage("done");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Rescue was not confirmed.");
      if (stage !== "acting") setStage("error");
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">D</span><span>DISINO</span><small>PROJECT RESCUE AGENT</small></div>
        <div className="connection"><span className="pulse" /> Evidence system ready</div>
      </header>

      <section className="launch-hero">
        <div className="launch-copy">
          <p className="eyebrow"><span className="live-dot" /> AI PROJECT RESCUE / PRIVATE PREVIEW</p>
          <h1>Keep critical work<br /><em>from going quiet.</em></h1>
          <p className="hero-text">Disino connects the signals across GitHub, Slack, and Notion to spot when the work has moved on, but the plan hasn’t.</p>
          <div className="launch-actions">
            <a className="primary-button" href="#early-access"><span>Get early access</span><b>↗</b></a>
            <a className="text-link" href="#live-demo">See how it works <span>↓</span></a>
          </div>
          <p className="launch-footnote">Evidence first. Human approval when it matters.</p>
        </div>
        <div className="signal-board" aria-label="Illustration of ownership evidence across project tools">
          <div className="signal-board-head"><span>RELEASE R1 <i>OWNERSHIP CHECK</i></span><span className="board-status">ILLUSTRATIVE</span></div>
          <div className="signal-route"><div className="route-node notion-node">N</div><span className="route-line" /><div className="route-node github-node">G</div><span className="route-line" /><div className="route-node slack-node">S</div><span className="route-line route-line-active" /><div className="route-owner"><small>OPERATIONAL OWNER</small><strong>Maya Chen</strong></div></div>
          <div className="signal-note"><span className="note-mark">↗</span><div><small>SAMPLE SLACK HANDOFF</small><p>“I’ve picked up the release checks. I’ll take this through Friday.”</p></div></div>
          <div className="signal-footer"><span><i className="signal-check">✓</i> Example evidence</span><span className="confidence-label">SAMPLE CONFIDENCE <b>92%</b></span></div>
          <div className="board-orbit orbit-a" /><div className="board-orbit orbit-b" />
        </div>
      </section>

      <section className="source-ribbon" aria-label="Connected sources"><span>ONE CLEAR VIEW OF OWNERSHIP</span><b><i className="source-glyph notion-glyph">N</i> Notion</b><b><i className="source-glyph github-glyph">G</i> GitHub</b><b><i className="source-glyph slack-glyph">S</i> Slack</b><span>Plans · activity · handoffs</span></section>

      <section className="early-access" id="early-access">
        <div><p className="eyebrow">A SMALL, THOUGHTFUL FIRST GROUP</p><h2>Early access is opening soon.</h2><p>We’re getting the first Disino preview ready. The connected integration demo is private while we prepare access.</p></div>
        <a className="access-link" href="#live-demo">How Disino works <b>↘</b></a>
      </section>

      <section className="demo-intro" id="live-demo"><div><p className="eyebrow">{liveDemoEnabled ? "PRIVATE WORKING PREVIEW" : "PRODUCT OVERVIEW"}</p><h2>{liveDemoEnabled ? "See the evidence behind a rescue." : "Evidence before action. Verification after."}</h2></div>{liveDemoEnabled ? <button className="primary-button demo-button" onClick={investigate} disabled={stage === "investigating" || stage === "acting" || stage === "verifying"}><span>{stage === "investigating" ? "Investigating..." : "Investigate Release"}</span><b>↗</b></button> : <span className="private-demo-badge">PRIVATE PREVIEW</span>}</section>

      {liveDemoEnabled && <section className="flow-panel">
        <div className="section-label"><span>01</span> INVESTIGATION FLOW</div>
        <div className="stage-track">{stages.map((item, index) => <div className={`stage-item ${index < (stage === "idle" ? 0 : stage === "investigating" ? 2 : stage === "ready" ? 5 : stage === "acting" ? 6 : 7) ? "complete" : ""}`} key={item}><span>{String(index + 1).padStart(2, "0")}</span>{item}</div>)}</div>
      </section>}

      {liveDemoEnabled && stage === "investigating" && <section className="progress-panel panel"><div className="section-label"><span>02</span> LIVE INVESTIGATION</div><h2>Following the evidence trail</h2><div className="investigation-progress">{investigationStages.map((item, index) => { const complete = progressStages.includes(item); const active = currentProgress === item; return <div className={`progress-step ${complete ? "complete" : ""} ${active ? "active" : ""}`} key={item}><span className="progress-marker">{complete ? "✓" : active ? "·" : String(index + 1).padStart(2, "0")}</span><div><strong>{item}</strong><small>{complete ? "Confirmed phase complete" : active ? "Working from live API responses..." : "Waiting for the previous phase"}</small></div></div>; })}</div></section>}

      {error && <div className="error-banner"><strong>Could not confirm the flow.</strong><span>{error}</span></div>}

      {liveDemoEnabled && stage === "idle" && <section className="empty-state"><span className="empty-icon">⌁</span><div><p className="eyebrow">Ready when you are</p><h2>One release. Three sources. No guesswork.</h2><p>Run the preview to collect source-labelled evidence and see how Disino pauses whenever the evidence is unsafe.</p></div></section>}

      {liveDemoEnabled && investigation && <>
        <section className="overview-grid">
          <div className="panel identity-panel"><div className="section-label"><span>02</span> RELEASE IN VIEW</div><div className="release-title"><div className="release-badge">R1</div><div><h2>Critical task</h2><p>task-1 · active ownership check</p></div></div><div className="owners"><div><small>PLANNED OWNER</small><strong>{ownerName(decision?.plannedOwner)}</strong></div><div className="arrow">→</div><div><small>OPERATIONAL OWNER</small><strong className={decision?.operationalOwner ? "accent-text" : "muted"}>{ownerName(decision?.operationalOwner)}</strong></div></div></div>
          <div className={`panel decision-panel safety-${decision?.safetyLevel.toLowerCase()}`}><div className="section-label"><span>03</span> DECISION SIGNAL</div><div className="signal-row"><div><small>CONFIDENCE</small><strong>{Math.round((decision?.confidence ?? 0) * 100)}<sup>%</sup></strong></div><div className="safety-pill">{decision?.safetyLevel}<span>{decision?.safetyLevel === "HIGH" ? "action permitted" : decision?.safetyLevel === "MEDIUM" ? "approval required" : "no action"}</span></div></div><div className="meter"><i style={{ width: `${(decision?.confidence ?? 0) * 100}%` }} /></div>{allowed && <button className="rescue-button" onClick={() => void rescue()} disabled={stage !== "ready"}>Rescue Project <b>↗</b></button>}{decision?.safetyLevel === "MEDIUM" && <><button className="rescue-button" onClick={() => { setApproved(true); void rescue(true); }} disabled={stage !== "ready"}>Approve &amp; Rescue <b>↗</b></button><p className="approval-note">This explicit approval is required before any change can be made.</p></>}{decision?.safetyLevel === "LOW" && <p className="approval-note">Insufficient or conflicting evidence. No corrective action is available.</p>}</div>
        </section>

        <section className="panel evidence-panel"><div className="panel-heading"><div><div className="section-label"><span>04</span> EVIDENCE LEDGER</div><h2>What the sources actually say</h2></div><span className="demo-label">DISINO DEMO EVIDENCE</span></div><div className="evidence-grid">{(["supportingEvidence", "conflictingEvidence", "missingEvidence"] as const).map((kind) => <div className={`evidence-column ${kind}`} key={kind}><h3>{kind === "supportingEvidence" ? "Supporting" : kind === "conflictingEvidence" ? "Conflicting" : "Missing"}<span>{decision?.[kind].length ?? 0}</span></h3>{(decision?.[kind] ?? []).map((item) => <article className="evidence-card" key={item.id}><div className="evidence-meta"><span className={`source-dot ${item.source}`} />{sourceLabel(item.source)}<time>{formatTime(item.timestamp)}</time></div><p>{item.content || item.missingReason || "No content returned."}</p><small>{item.person ? ownerName(item.person) : item.type.replaceAll("_", " ")}</small></article>)}</div>)}</div></section>

        <section className="reasoning-grid"><div className="panel reasoning-panel"><div className="section-label"><span>05</span> AI ANALYSIS</div><h2>Reasoning</h2><p>{decision?.reasoning}</p></div><div className="panel challenge-panel"><div className="section-label"><span>06</span> CHALLENGE</div><h2>What could prove this wrong?</h2><p>{decision?.challenge}</p></div></section>
      </>}

      {liveDemoEnabled && (actions.length > 0 || verification.length > 0) && <section className="results-section" ref={resultsRef}><div className="section-label"><span>07</span> RESCUE TRACE</div><div className="results-grid"><div className="panel result-panel"><h2>Action results</h2>{actions.map((item) => <div className="result-row" key={item.actionId}><span className={`result-icon ${item.status}`}>{item.status === "succeeded" ? "✓" : "!"}</span><div><strong>{sourceLabel(item.source)}</strong><p>{item.message}</p></div><b>{item.status}</b></div>)}</div><div className="panel result-panel"><h2>Read-back verification</h2>{verification.map((item) => <div className="result-row" key={item.actionId}><span className={`result-icon ${item.verified ? "succeeded" : "failed"}`}>{item.verified ? "✓" : "!"}</span><div><strong>{sourceLabel(item.source)}</strong><p><b>Expected:</b> {item.expectedState}<br /><b>Actual:</b> {item.actualState}</p></div></div>)}</div></div>{rescueComplete && <div className="success-banner"><span>✓</span><div><strong>Project Rescued</strong><p>Every required action was confirmed and read back from the source APIs.</p></div></div>}</section>}
    </main>
  );
}
