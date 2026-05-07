import type { Sql } from "postgres";
import { defaultBoard, type BoardMember } from "./members";
import { getChatProvider } from "../llm";
import { loadCredentials } from "@/credentials/manager";
import type { ChatProvider, ProviderId } from "../llm/types";

/**
 * Run one board deliberation end-to-end.
 *
 * Each member gets:
 *   - their own systemPrompt
 *   - the owner's question
 *   - a transcript of every preceding member's contribution
 *
 * The recommendation field on board_sessions holds the Chair's output.
 */

export interface DeliberateInput {
  hiveId: string;
  question: string;
  hiveContext?: string;
}

export interface DeliberateResult {
  sessionId: string;
  recommendation: string;
  turns: Array<{ memberSlug: string; memberName: string; content: string }>;
}

export async function runDeliberation(
  sql: Sql,
  input: DeliberateInput,
  overrideProvider?: ChatProvider,
  overrideModel?: string,
): Promise<DeliberateResult> {
  const [session] = await sql<{ id: string }[]>`
    INSERT INTO board_sessions (hive_id, question, status)
    VALUES (${input.hiveId}::uuid, ${input.question}, 'running')
    RETURNING id
  `;
  const sessionId = session.id;

  const providerId = ((process.env.BOARD_PROVIDER as ProviderId) ??
    "openrouter") as ProviderId;

  let openrouterApiKey = "";
  if (!overrideProvider && providerId === "openrouter") {
    const encryptionKey = process.env.ENCRYPTION_KEY || "";
    if (!encryptionKey) {
      const errText = "ENCRYPTION_KEY is not configured on the server";
      await sql`
        UPDATE board_sessions
        SET status = 'error', error_text = ${errText}, completed_at = NOW()
        WHERE id = ${sessionId}::uuid
      `;
      throw new Error(errText);
    }
    const creds = await loadCredentials(sql, {
      hiveId: input.hiveId,
      requiredKeys: ["OPENROUTER_API_KEY"],
      roleSlug: "board",
      encryptionKey,
    });
    openrouterApiKey =
      (creds as unknown as Record<string, string>).OPENROUTER_API_KEY ?? "";
    if (!openrouterApiKey) {
      const errText =
        "OPENROUTER_API_KEY credential not found in credentials DB (hive-scoped or system-wide)";
      await sql`
        UPDATE board_sessions
        SET status = 'error', error_text = ${errText}, completed_at = NOW()
        WHERE id = ${sessionId}::uuid
      `;
      throw new Error(errText);
    }
  }

  const provider =
    overrideProvider ??
    getChatProvider(providerId, {
      openrouterApiKey,
      ollamaEndpoint: process.env.OLLAMA_ENDPOINT,
    });
  if (!provider) {
    await sql`
      UPDATE board_sessions
      SET status = 'error', error_text = 'no chat provider available',
          completed_at = NOW()
      WHERE id = ${sessionId}::uuid
    `;
    throw new Error(`No chat provider available for id=${providerId}`);
  }

  const modelForBoard =
    overrideModel ??
    process.env.BOARD_MODEL ??
    (providerId === "ollama"
      ? process.env.OLLAMA_GENERATION_MODEL ?? "gemma2:27b"
      : "openrouter/free");

  const members = defaultBoard();
  const turns: Array<{ memberSlug: string; memberName: string; content: string }> = [];

  try {
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const content = await askMember(provider, m, input, turns, modelForBoard);
      turns.push({ memberSlug: m.slug, memberName: m.name, content });
      await sql`
        INSERT INTO board_turns (session_id, member_slug, member_name, content, order_index)
        VALUES (${sessionId}::uuid, ${m.slug}, ${m.name}, ${content}, ${i})
      `;
    }

    const recommendation = turns[turns.length - 1]?.content ?? "";
    await sql`
      UPDATE board_sessions
      SET status = 'done', recommendation = ${recommendation}, completed_at = NOW()
      WHERE id = ${sessionId}::uuid
    `;
    return { sessionId, recommendation, turns };
  } catch (e) {
    await sql`
      UPDATE board_sessions
      SET status = 'error', error_text = ${e instanceof Error ? e.message : String(e)},
          completed_at = NOW()
      WHERE id = ${sessionId}::uuid
    `;
    throw e;
  }
}

async function askMember(
  provider: ChatProvider,
  m: BoardMember,
  input: DeliberateInput,
  priorTurns: Array<{ memberName: string; content: string }>,
  model: string,
): Promise<string> {
  const transcript = priorTurns
    .map((t) => `### ${t.memberName}\n\n${t.content}`)
    .join("\n\n");
  const userPrompt = [
    `## Owner's question\n\n${input.question}`,
    input.hiveContext ? `## Hive context\n\n${input.hiveContext}` : "",
    priorTurns.length > 0 ? `## Board so far\n\n${transcript}` : "",
    `## Your contribution as the ${m.name}\n\nRespond in your role.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await provider.chat({
    system: m.systemPrompt,
    user: userPrompt,
    model,
    temperature: 0.4,
    maxTokens: 700,
  });
  return (res.text ?? "").trim();
}
