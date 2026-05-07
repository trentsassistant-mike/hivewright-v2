import type { Sql } from "postgres";
import { callGenerationModel, type ModelCallerConfig, getDefaultConfig } from "./model-caller";

export interface ExtractedEntity {
  name: string;
  type: string;
  attributes?: Record<string, string>;
}

export interface ExtractedRelationship {
  fromEntity: string;
  toEntity: string;
  relationshipType: string;
  confidence: number;
}

export interface EntityExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

export function buildEntityExtractionPrompt(workProductContent: string): string {
  return `Extract entities and relationships from this work product.

Content:
${workProductContent.slice(0, 2000)}

For each entity, provide: name, type (person|company|product|service|location|concept), and key attributes.
For each relationship, provide: from entity name, to entity name, relationship type (uses|competes_with|depends_on|part_of|provides|integrates_with|owned_by), and confidence (0-1).

Respond with ONLY JSON:
{
  "entities": [{"name": "...", "type": "...", "attributes": {"key": "value"}}],
  "relationships": [{"fromEntity": "...", "toEntity": "...", "relationshipType": "...", "confidence": 0.8}]
}

If no entities or relationships found, return {"entities": [], "relationships": []}`;
}

export function parseEntityExtractionResponse(response: string): EntityExtractionResult {
  let cleaned = response.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
    };
  } catch {
    return { entities: [], relationships: [] };
  }
}

export async function extractAndStoreEntities(
  sql: Sql,
  hiveId: string,
  workProductContent: string,
  sourceTaskId: string | null,
  modelConfig: ModelCallerConfig = getDefaultConfig(),
): Promise<{ entitiesStored: number; relationshipsStored: number }> {
  const prompt = buildEntityExtractionPrompt(workProductContent);
  const response = await callGenerationModel(prompt, modelConfig);
  const result = parseEntityExtractionResponse(response);

  let entitiesStored = 0;
  let relationshipsStored = 0;

  // Upsert entities (by name + hive_id)
  const entityIdMap: Record<string, string> = {};
  for (const entity of result.entities) {
    if (!entity.name || !entity.type) continue;
    const [existing] = await sql`
      SELECT id FROM entities WHERE hive_id = ${hiveId} AND LOWER(name) = ${entity.name.toLowerCase()}
    `;
    if (existing) {
      entityIdMap[entity.name] = existing.id as string;
      // Update attributes if provided
      if (entity.attributes && Object.keys(entity.attributes).length > 0) {
        await sql`
          UPDATE entities SET attributes = ${sql.json(entity.attributes)}, updated_at = NOW()
          WHERE id = ${existing.id}
        `;
      }
    } else {
      const [row] = await sql`
        INSERT INTO entities (hive_id, name, type, attributes, source_task_ids)
        VALUES (${hiveId}, ${entity.name}, ${entity.type}, ${sql.json(entity.attributes || {})}, ${sql.json(sourceTaskId ? [sourceTaskId] : [])})
        RETURNING id
      `;
      entityIdMap[entity.name] = row.id as string;
      entitiesStored++;
    }
  }

  // Store relationships
  for (const rel of result.relationships) {
    const fromId = entityIdMap[rel.fromEntity];
    const toId = entityIdMap[rel.toEntity];
    if (!fromId || !toId) continue;

    // Check for existing relationship
    const [existing] = await sql`
      SELECT id FROM entity_relationships
      WHERE from_entity_id = ${fromId} AND to_entity_id = ${toId} AND relationship_type = ${rel.relationshipType}
    `;
    if (!existing) {
      await sql`
        INSERT INTO entity_relationships (hive_id, from_entity_id, to_entity_id, relationship_type, confidence)
        VALUES (${hiveId}, ${fromId}, ${toId}, ${rel.relationshipType}, ${rel.confidence || 0.8})
      `;
      relationshipsStored++;
    }
  }

  return { entitiesStored, relationshipsStored };
}

/**
 * Query all entities and relationships connected to a given entity name.
 */
interface EntityNode {
  id: string;
  name: string;
  type: string;
  attributes: Record<string, string>;
}

interface EntityConnection {
  name: string;
  type: string;
  relationship: string;
  confidence: number;
}

export async function queryEntityGraph(
  sql: Sql,
  hiveId: string,
  entityName: string,
): Promise<{ entity: EntityNode | null; connections: EntityConnection[] }> {
  const [entity] = await sql`
    SELECT * FROM entities WHERE hive_id = ${hiveId} AND LOWER(name) = ${entityName.toLowerCase()}
  `;
  if (!entity) return { entity: null, connections: [] };

  const connections = await sql`
    SELECT er.relationship_type, er.confidence,
           e2.name AS connected_name, e2.type AS connected_type
    FROM entity_relationships er
    JOIN entities e2 ON (er.to_entity_id = e2.id OR er.from_entity_id = e2.id) AND e2.id != ${entity.id}
    WHERE (er.from_entity_id = ${entity.id} OR er.to_entity_id = ${entity.id})
      AND er.hive_id = ${hiveId}
  `;

  return {
    entity: { id: entity.id, name: entity.name, type: entity.type, attributes: entity.attributes },
    connections: connections.map(c => ({
      name: c.connected_name, type: c.connected_type,
      relationship: c.relationship_type, confidence: c.confidence,
    })),
  };
}
