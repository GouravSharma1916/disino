import type { ActorReference, Evidence } from "@/domain/contracts";
import type {
  ExternalActionResult,
  ExternalVerificationResult,
  IntegrationResult,
} from "./types";

const SLACK_HISTORY_API_URL = "https://slack.com/api/conversations.history";

type SlackRecord = Record<string, unknown>;

function asRecord(value: unknown): SlackRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as SlackRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function actor(value: unknown): ActorReference | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    id: asString(record.id),
    name: asString(record.name) ?? asString(record.user_name),
    handle: asString(record.username) ?? asString(record.user),
  };
}

function missingEvidence(taskId: string | undefined, reason: string): Evidence {
  return {
    id: `slack-missing-${taskId ?? "query"}`,
    source: "slack",
    type: "missing_handoff_evidence",
    content: "",
    timestamp: new Date().toISOString(),
    relatedTask: taskId,
    confidence: 1,
    relevance: 1,
    availability: "missing",
    missingReason: reason,
  };
}

export interface SlackSearchRequest {
  query: string;
  taskId?: string;
}

const HANDOFF_PATTERN =
  /\b(hand(?:ed|ing)?\s+off|handoff|take(?:n|ing)?\s+over|owns?|owner\s+is|assigned\s+to|picked\s+up)\b/i;

function messageMatchesQuery(content: string, query: string): boolean {
  const terms = query
    .split(/\s+/)
    .filter((term) => !term.startsWith("in:") && term.length > 1)
    .map((term) => term.replace(/^['"]|['"]$/g, "").toLowerCase());
  const normalizedContent = content.toLowerCase();
  return HANDOFF_PATTERN.test(content) || terms.every((term) => normalizedContent.includes(term));
}

async function getChannelMessages(
  channel: string,
  token: string,
): Promise<{ ok: boolean; messages: unknown[]; error?: string }> {
  const url = new URL(SLACK_HISTORY_API_URL);
  url.searchParams.set("channel", channel);
  url.searchParams.set("limit", "100");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return { ok: false, messages: [], error: `Slack returned HTTP ${response.status}.` };

  const result = asRecord(await response.json());
  const messages = result?.messages;
  if (!result?.ok || !Array.isArray(messages)) {
    return {
      ok: false,
      messages: [],
      error: `Slack API error: ${asString(result?.error) ?? "invalid history response"}.`,
    };
  }
  return { ok: true, messages };
}

export async function searchOwnershipEvidence(
  request: SlackSearchRequest,
): Promise<IntegrationResult> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return { evidence: [], errors: ["Slack credentials are not configured."] };
  }

  if (!request.query) {
    return { evidence: [], errors: ["A Slack search query is required."] };
  }

  const channel = process.env.DISINO_SLACK_CHANNEL;
  if (!channel) {
    return { evidence: [], errors: ["Slack channel is not configured."] };
  }

  try {
    const history = await getChannelMessages(channel, token);
    if (!history.ok) return { evidence: [], errors: [history.error ?? "Slack history request failed."] };

    const evidence = history.messages
      .filter((message) => {
        const record = asRecord(message);
        return Boolean(record && messageMatchesQuery(asString(record.text) ?? "", request.query));
      })
      .flatMap((message, index): Evidence[] => {
      const record = asRecord(message);
      if (!record) return [];
      const timestamp = asString(record.ts);
      const content = asString(record.text);
      if (!timestamp || !content) return [];

      return [
        {
          id: `slack-message-${index}-${timestamp}`,
          source: "slack",
          type: "ownership_or_handoff_message",
          content,
          timestamp: new Date(Number(timestamp) * 1000).toISOString(),
          relatedTask: request.taskId,
          person: actor(record),
          confidence: 1,
          relevance: 0.9,
          availability: "available",
        },
      ];
      });

    if (evidence.length === 0) {
      evidence.push(missingEvidence(request.taskId, "No usable Slack messages matched the query."));
    }

    return { evidence, errors: [] };
  } catch {
    return { evidence: [], errors: ["Slack request failed before a response was received."] };
  }
}

export interface SlackNotificationRequest {
  channel: string;
  text: string;
}

export async function sendOwnershipNotification(
  request: SlackNotificationRequest,
): Promise<ExternalActionResult> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { success: false, message: "Slack credentials are not configured." };
  if (!request.channel || !request.text) {
    return { success: false, message: "A Slack channel and notification text are required." };
  }

  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: request.channel, text: request.text }),
    });
    if (!response.ok) return { success: false, message: `Slack returned HTTP ${response.status}.` };

    const result = asRecord(await response.json());
    if (!result?.ok || !asString(result.ts)) {
      return { success: false, message: `Slack did not confirm the notification: ${asString(result?.error) ?? "unknown error"}.` };
    }

    return { success: true, message: "Slack confirmed the Disino notification." };
  } catch {
    return { success: false, message: "Slack action failed before confirmation." };
  }
}

export async function verifyOwnershipNotification(
  request: SlackNotificationRequest,
): Promise<ExternalVerificationResult> {
  const token = process.env.SLACK_BOT_TOKEN;
  const expectedText = `[Disino] Ownership correction: ${request.text}`;
  const expectedState = `Slack channel ${request.channel} contains the Disino notification`;
  if (!token) {
    return { verified: false, expectedState, actualState: "Slack credentials are not configured." };
  }

  try {
    const history = await getChannelMessages(request.channel, token);
    if (!history.ok) {
      return { verified: false, expectedState, actualState: history.error ?? "Slack history request failed." };
    }
    const found = history.messages.some((item) => asString(asRecord(item)?.text) === expectedText);
    return {
      verified: found,
      expectedState,
      actualState: found ? "Slack returned the notification message." : "Slack did not return the notification message.",
    };
  } catch {
    return { verified: false, expectedState, actualState: "Slack verification failed before a response." };
  }
}