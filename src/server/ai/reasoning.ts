import type {
  Action,
  ActorReference,
  Evidence,
  InvestigationResult,
  OwnershipDecision,
  SafetyLevel,
} from "@/domain/contracts";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";

interface ModelDecision {
  plannedOwner: ActorReference | null;
  operationalOwner: ActorReference | null;
  confidence: number;
  safetyLevel: SafetyLevel;
  supportingEvidenceIds: string[];
  conflictingEvidenceIds: string[];
  missingEvidenceIds: string[];
  reasoning: string;
  challenge: string;
  recommendedAction: Action | null;
  verificationRequirements: string[];
}

export interface AiReasoningResult {
  decision?: OwnershipDecision;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isActor(value: unknown): value is ActorReference | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return ["id", "name", "handle"].every(
    (key) => value[key] === undefined || typeof value[key] === "string",
  );
}

function isSafetyLevel(value: unknown): value is SafetyLevel {
  return value === "HIGH" || value === "MEDIUM" || value === "LOW";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAction(value: unknown): value is Action | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    typeof value.target === "string" &&
    typeof value.reason === "string" &&
    typeof value.status === "string" &&
    typeof value.requiresApproval === "boolean"
  );
}

function isModelDecision(value: unknown): value is ModelDecision {
  if (!isRecord(value)) return false;
  return (
    isActor(value.plannedOwner) &&
    isActor(value.operationalOwner) &&
    typeof value.confidence === "number" &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    isSafetyLevel(value.safetyLevel) &&
    isStringArray(value.supportingEvidenceIds) &&
    isStringArray(value.conflictingEvidenceIds) &&
    isStringArray(value.missingEvidenceIds) &&
    typeof value.reasoning === "string" &&
    typeof value.challenge === "string" &&
    isAction(value.recommendedAction) &&
    isStringArray(value.verificationRequirements)
  );
}

function evidenceById(evidence: Evidence[]): Map<string, Evidence> {
  return new Map(evidence.map((item) => [item.id, item]));
}

function resolveEvidence(
  ids: string[],
  evidence: Map<string, Evidence>,
): Evidence[] | undefined {
  const resolved = ids.map((id) => evidence.get(id));
  return resolved.every((item): item is Evidence => Boolean(item)) ? resolved : undefined;
}

function actorKey(actor: ActorReference | undefined): string | undefined {
  if (!actor) return undefined;
  return (actor.id ?? actor.handle ?? actor.name)?.trim().toLowerCase();
}

function ownerIsGrounded(
  owner: ActorReference | null,
  supportingEvidence: Evidence[],
): boolean {
  if (!owner) return true;
  const ownerId = actorKey(owner);
  return Boolean(
    ownerId &&
      supportingEvidence.some((item) => actorKey(item.person) === ownerId),
  );
}

function sourceClaimIsGrounded(
  text: string,
  source: Evidence["source"],
  evidence: Evidence[],
): boolean {
  const available = evidence.some(
    (item) => item.source === source && item.availability === "available",
  );
  if (available) return true;

  const sourcePattern = new RegExp(
    `\\b${source}\\b.{0,80}\\b(evidence|activity|handoff|message|context|owner|contributor|confirms?|shows?|indicates?|lists?)\\b`,
    "i",
  );
  return !sourcePattern.test(text);
}

function decisionEvidenceIsGrounded(
  decision: ModelDecision,
  supportingEvidence: Evidence[],
  conflictingEvidence: Evidence[],
  missingEvidence: Evidence[],
  evidence: Evidence[],
): boolean {
  return (
    supportingEvidence.every((item) => item.availability === "available") &&
    conflictingEvidence.every(
      (item) => item.availability === "available" || item.availability === "conflicting",
    ) &&
    missingEvidence.every((item) => item.availability === "missing") &&
    ownerIsGrounded(decision.plannedOwner, supportingEvidence) &&
    ownerIsGrounded(decision.operationalOwner, supportingEvidence) &&
    ["notion", "github", "slack"].every((source) =>
      sourceClaimIsGrounded(
        `${decision.reasoning} ${decision.challenge}`,
        source as Evidence["source"],
        evidence,
      ),
    )
  );
}

function promptEvidence(evidence: Evidence[]): string {
  return JSON.stringify(
    evidence.map((item) => ({
      id: item.id,
      source: item.source,
      type: item.type,
      content: item.content,
      timestamp: item.timestamp,
      relatedTask: item.relatedTask,
      relatedRelease: item.relatedRelease,
      person: item.person,
      confidence: item.confidence,
      relevance: item.relevance,
      availability: item.availability,
      missingReason: item.missingReason,
    })),
  );
}

function responseFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "disino_ownership_decision",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          plannedOwner: { type: ["object", "null"] },
          operationalOwner: { type: ["object", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          safetyLevel: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
          supportingEvidenceIds: { type: "array", items: { type: "string" } },
          conflictingEvidenceIds: { type: "array", items: { type: "string" } },
          missingEvidenceIds: { type: "array", items: { type: "string" } },
          reasoning: { type: "string" },
          challenge: { type: "string" },
          recommendedAction: { type: ["object", "null"] },
          verificationRequirements: { type: "array", items: { type: "string" } },
        },
        required: [
          "plannedOwner",
          "operationalOwner",
          "confidence",
          "safetyLevel",
          "supportingEvidenceIds",
          "conflictingEvidenceIds",
          "missingEvidenceIds",
          "reasoning",
          "challenge",
          "recommendedAction",
          "verificationRequirements",
        ],
      },
    },
  };
}

export async function reasonAboutInvestigation(
  investigation: InvestigationResult,
): Promise<AiReasoningResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: "OpenAI credentials are not configured." };

  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const systemPrompt = [
    "You are Disino's evidence-bound ownership analyst.",
    "Use only the supplied evidence. Never invent people, events, timestamps, or content.",
    "GitHub activity alone cannot establish ownership.",
    "Treat explicit recent Slack handoffs as strong ownership evidence, but consider recency and conflicts.",
    "Identify evidence that could prove your conclusion wrong in challenge.",
    "Use LOW when evidence is insufficient or contradictory. LOW must not recommend execution.",
    "Return evidence IDs from the input only.",
  ].join(" ");
  const userPrompt = JSON.stringify({
    taskId: investigation.taskId,
    currentEvidence: promptEvidence(investigation.evidence),
    currentMissingEvidenceIds: investigation.missingEvidence.map((item) => item.id),
  });

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: responseFormat(),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) return { error: `OpenAI returned HTTP ${response.status}.` };
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.choices)) {
      return { error: "OpenAI returned an invalid response envelope." };
    }

    const choice = isRecord(payload.choices[0]) ? payload.choices[0] : undefined;
    const message = choice && isRecord(choice.message) ? choice.message : undefined;
    const content = message?.content;
    if (typeof content !== "string") return { error: "OpenAI returned no decision content." };

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { error: "OpenAI returned non-JSON decision content." };
    }
    if (!isModelDecision(parsed)) return { error: "OpenAI returned an invalid decision shape." };

    const evidence = evidenceById(investigation.evidence);
    const supportingEvidence = resolveEvidence(parsed.supportingEvidenceIds, evidence);
    const conflictingEvidence = resolveEvidence(parsed.conflictingEvidenceIds, evidence);
    const missingEvidence = resolveEvidence(parsed.missingEvidenceIds, evidence);
    if (!supportingEvidence || !conflictingEvidence || !missingEvidence) {
      return { error: "OpenAI referenced evidence that was not collected." };
    }
    if (
      !decisionEvidenceIsGrounded(
        parsed,
        supportingEvidence,
        conflictingEvidence,
        missingEvidence,
        investigation.evidence,
      )
    ) {
      return { error: "OpenAI returned evidence claims that are not grounded in the investigation." };
    }

    return {
      decision: {
        plannedOwner: parsed.plannedOwner ?? undefined,
        operationalOwner: parsed.operationalOwner ?? undefined,
        confidence: parsed.confidence,
        safetyLevel: parsed.safetyLevel,
        supportingEvidence,
        conflictingEvidence,
        missingEvidence,
        reasoning: parsed.reasoning,
        challenge: parsed.challenge,
        recommendedAction: parsed.recommendedAction ?? undefined,
        verificationRequirements: parsed.verificationRequirements,
      },
    };
  } catch {
    return { error: "OpenAI request failed before a valid decision was received." };
  }
}