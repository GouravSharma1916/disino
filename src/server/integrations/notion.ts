import type { ActorReference, Evidence } from "@/domain/contracts";
import type {
  ExternalActionResult,
  ExternalVerificationResult,
  IntegrationResult,
} from "./types";

const NOTION_API_URL = "https://api.notion.com/v1";

type NotionRecord = Record<string, unknown>;

function asRecord(value: unknown): NotionRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as NotionRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function propertyText(property: unknown): string | undefined {
  const record = asRecord(property);
  if (!record) return undefined;

  const values = record.title ?? record.rich_text;
  if (Array.isArray(values)) {
    const text = values
      .map((item) => {
        const itemRecord = asRecord(item);
        const plainText = itemRecord ? asString(itemRecord.plain_text) : undefined;
        const nestedText = asRecord(itemRecord?.text);
        return plainText ?? (nestedText ? asString(nestedText.content) : undefined);
      })
      .filter((item): item is string => Boolean(item));

    if (text.length > 0) return text.join("");
  }

  const select = asRecord(record.select) ?? asRecord(record.status);
  return select ? asString(select.name) : undefined;
}

function propertyPerson(property: unknown): ActorReference | undefined {
  const record = asRecord(property);
  const people = record?.people;
  if (!Array.isArray(people) || people.length === 0) return undefined;

  const person = asRecord(people[0]);
  if (!person) return undefined;

  return {
    id: asString(person.id),
    name: asString(person.name),
    handle: asString(asRecord(person.person)?.email),
  };
}

function blockText(block: unknown): string | undefined {
  const record = asRecord(block);
  const blockType = asString(record?.type);
  if (!record || !blockType) return undefined;
  return propertyText(record[blockType]);
}

async function getPageContent(
  pageId: string,
  token: string,
  notionVersion: string,
): Promise<string[]> {
  const response = await fetch(
    `${NOTION_API_URL}/blocks/${encodeURIComponent(pageId)}/children`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": notionVersion,
      },
    },
  );
  if (!response.ok) return [];

  const payload = asRecord(await response.json());
  const blocks = payload?.results;
  if (!Array.isArray(blocks)) return [];
  return blocks
    .map(blockText)
    .filter((text): text is string => Boolean(text));
}

function missingEvidence(pageId: string, reason: string): Evidence {
  return {
    id: `notion-missing-${pageId}`,
    source: "notion",
    type: "missing_task_context",
    content: "",
    timestamp: new Date().toISOString(),
    relatedTask: pageId,
    confidence: 1,
    relevance: 1,
    availability: "missing",
    missingReason: reason,
  };
}

export async function getTaskContext(pageId: string): Promise<IntegrationResult> {
  const token = process.env.NOTION_API_KEY;
  const notionVersion = process.env.NOTION_VERSION;
  if (!token || !notionVersion) {
    return {
      evidence: [],
      errors: ["Notion credentials are not configured."],
    };
  }

  if (!pageId) {
    return { evidence: [], errors: ["A Notion page ID is required."] };
  }

  try {
    const response = await fetch(`${NOTION_API_URL}/pages/${encodeURIComponent(pageId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": notionVersion,
      },
    });

    if (!response.ok) {
      return {
        evidence: [],
        errors: [`Notion returned HTTP ${response.status}.`],
      };
    }

    const page = asRecord(await response.json());
    const properties = asRecord(page?.properties);
    if (!page || !properties) {
      return {
        evidence: [missingEvidence(pageId, "Notion returned no task properties.")],
        errors: [],
      };
    }

    const lines: string[] = [];
    let plannedOwner: ActorReference | undefined;
    let release: string | undefined;

    for (const [name, property] of Object.entries(properties)) {
      const value = propertyText(property);
      if (value) lines.push(`${name}: ${value}`);

      const normalizedName = name.toLowerCase();
      if (normalizedName.includes("owner")) plannedOwner = propertyPerson(property);
      if (normalizedName.includes("release")) release = value;
    }

    const lastEditedTime = asString(page.last_edited_time) ?? new Date().toISOString();
    const evidence: Evidence[] = [
      {
        id: `notion-task-${pageId}`,
        source: "notion",
        type: "planned_task_context",
        content: lines.join("\n"),
        timestamp: lastEditedTime,
        relatedTask: pageId,
        relatedRelease: release,
        person: plannedOwner,
        confidence: 1,
        relevance: 1,
        availability: "available",
      },
    ];

    if (!plannedOwner) {
      const contentLines = await getPageContent(pageId, token, notionVersion);
      const content = contentLines.join("\n");
      const plannedOwnerMatch = content.match(/^\s*Planned owner:\s*(\S[^\r\n]*)\s*$/im);
      if (plannedOwnerMatch) {
        plannedOwner = { name: plannedOwnerMatch[1].trim() };
        lines.push(...contentLines);
      }
    }

    if (!plannedOwner) {
      evidence.push(missingEvidence(pageId, "No explicit planned owner was found."));
    } else {
      evidence[0].person = plannedOwner;
      if (!evidence[0].content && lines.length > 0) {
        evidence[0].content = lines.join("\n");
      }
    }

    return { evidence, errors: [] };
  } catch {
    return { evidence: [], errors: ["Notion request failed before a response was received."] };
  }
}

export interface NotionContextUpdateRequest {
  pageId: string;
  properties: Record<string, unknown>;
}

function requestedOwner(properties: Record<string, unknown>): string | undefined {
  for (const property of Object.values(properties)) {
    const value = propertyText(property);
    if (value) return value;
  }
  return undefined;
}

async function updateOwnerBlocks(
  pageId: string,
  owner: string,
  token: string,
  notionVersion: string,
): Promise<ExternalActionResult> {
  const response = await fetch(
    `${NOTION_API_URL}/blocks/${encodeURIComponent(pageId)}/children`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": notionVersion,
      },
    },
  );
  if (!response.ok) return { success: false, message: `Notion returned HTTP ${response.status}.` };

  const payload = asRecord(await response.json());
  const blocks = payload?.results;
  if (!Array.isArray(blocks)) return { success: false, message: "Notion returned no page blocks." };

  const ownerBlocks = blocks.filter((block) => {
    const text = blockText(block);
    return Boolean(text && /^(?:Planned owner|Owner):\s*/i.test(text));
  });
  if (ownerBlocks.length === 0) {
    return { success: false, message: "Notion returned no owner content block to update." };
  }

  for (const block of ownerBlocks) {
    const blockRecord = asRecord(block);
    const blockId = asString(blockRecord?.id);
    const blockType = asString(blockRecord?.type);
    if (!blockId || blockType !== "paragraph") {
      return { success: false, message: "Notion owner content block has an unsupported type." };
    }
    const currentText = blockText(block) ?? "Owner:";
    const label = currentText.toLowerCase().startsWith("planned owner")
      ? "Planned owner"
      : "Owner";
    const updateResponse = await fetch(`${NOTION_API_URL}/blocks/${encodeURIComponent(blockId)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Notion-Version": notionVersion,
      },
      body: JSON.stringify({
        paragraph: {
          rich_text: [{ type: "text", text: { content: `${label}: ${owner}` } }],
        },
      }),
    });
    if (!updateResponse.ok) return { success: false, message: `Notion returned HTTP ${updateResponse.status}.` };
    const updatedBlock = asRecord(await updateResponse.json());
    if (!updatedBlock?.id) return { success: false, message: "Notion did not confirm the owner block update." };
  }

  return { success: true, message: "Notion confirmed the planned owner content update." };
}

export async function updateTaskContext(
  request: NotionContextUpdateRequest,
): Promise<ExternalActionResult> {
  const token = process.env.NOTION_API_KEY;
  const notionVersion = process.env.NOTION_VERSION;
  if (!token || !notionVersion) {
    return { success: false, message: "Notion credentials are not configured." };
  }
  if (!request.pageId || Object.keys(request.properties).length === 0) {
    return { success: false, message: "A Notion page and properties are required." };
  }

  try {
    const owner = requestedOwner(request.properties);
    if (!owner) return { success: false, message: "A planned owner value is required." };
    return await updateOwnerBlocks(request.pageId, owner, token, notionVersion);
  } catch {
    return { success: false, message: "Notion action failed before confirmation." };
  }
}

export async function verifyTaskContext(
  request: NotionContextUpdateRequest,
): Promise<ExternalVerificationResult> {
  const token = process.env.NOTION_API_KEY;
  const notionVersion = process.env.NOTION_VERSION;
  const owner = requestedOwner(request.properties);
  const expectedState = `Notion page ${request.pageId} contains owner text ${owner ?? "from the action"}`;
  if (!token || !notionVersion) {
    return { verified: false, expectedState, actualState: "Notion credentials are not configured." };
  }
  if (!owner) {
    return { verified: false, expectedState, actualState: "The requested owner could not be determined." };
  }

  try {
    const contentLines = await getPageContent(request.pageId, token, notionVersion);
    const ownerLines = contentLines.filter((line) => /^(?:Planned owner|Owner):\s*/i.test(line));
    const verified = ownerLines.some((line) => {
      const actualOwner = line.replace(/^(?:Planned owner|Owner):\s*/i, "").trim();
      return actualOwner.localeCompare(owner.trim(), undefined, { sensitivity: "accent" }) === 0;
    });
    return {
      verified,
      expectedState,
      actualState: verified
        ? "Notion returned the requested owner text block."
        : `Notion returned owner text: ${ownerLines.join(" | ") || "none"}.`,
    };
  } catch {
    return { verified: false, expectedState, actualState: "Notion verification failed before a response." };
  }
}