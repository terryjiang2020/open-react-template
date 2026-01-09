import { cosineSimilarity } from "@/src/utils/cosineSimilarity";
import { SavedTask } from "./taskService";
import fs from 'fs';
import path from 'path';
import { RequestContext } from "./chatPlannerService";

export interface ReferenceTaskMatch {
  task?: SavedTask;
  score?: number;
}

const vectorizedDataTablePath = path.join(process.cwd(), 'src/doc/vectorized-data/table/vectorized-data.json');
const vectorizedDataApiPath = path.join(process.cwd(), 'src/doc/vectorized-data/api/vectorized-data.json');
const vectorizedDataTable = JSON.parse(fs.readFileSync(vectorizedDataTablePath, 'utf-8'));
const vectorizedDataApi = JSON.parse(fs.readFileSync(vectorizedDataApiPath, 'utf-8'));

// Function to find the top-k most similar API vectors
function findTopKSimilarApi(queryEmbedding: number[], topK: number = 3, context?: RequestContext) {
  return vectorizedDataApi
    .map((item: any) => {
      let tags: string[] = item.tags || [];
      let summary = (item.summary || '').toLowerCase();
      // 计算embedding相似度
      let similarity = cosineSimilarity(queryEmbedding, item.embedding);
      // 加强tag和summary权重
      const entityText = (context?.ragEntity || '').toLowerCase();
      const tagHit = tags.some(t => entityText.includes(t.toLowerCase()) || t.toLowerCase().includes(entityText));
      const summaryHit = summary && (entityText.includes(summary) || summary.includes(entityText));
      if (tagHit) similarity += 0.15;
      if (summaryHit) similarity += 0.10;
      return {
        ...item,
        similarity,
      };
    })
    .sort((a: any, b: any) => b.similarity - a.similarity)
    .slice(0, topK);
}

// Function to find the top-k most similar table vectors
function findTopKSimilarTable(queryEmbedding: number[], topK: number = 3, context?: RequestContext) {
  return vectorizedDataTable
    .map((item: any) => {
      let tags: string[] = item.tags || [];
      let summary = (item.summary || '').toLowerCase();
      let similarity = cosineSimilarity(queryEmbedding, item.embedding);
      const entityText = (context?.ragEntity || '').toLowerCase();
      const tagHit = tags.some(t => entityText.includes(t.toLowerCase()) || t.toLowerCase().includes(entityText));
      const summaryHit = summary && (entityText.includes(summary) || summary.includes(entityText));
      if (tagHit) similarity += 0.15;
      if (summaryHit) similarity += 0.10;
      return {
        ...item,
        similarity,
      };
    })
    .sort((a: any, b: any) => b.similarity - a.similarity)
    .slice(0, topK);
}

export async function selectReferenceTask(
  refinedQuery: string,
  tasks: SavedTask[],
  apiKey: string,
  intentType?: 'FETCH' | 'MODIFY'
): Promise<ReferenceTaskMatch> {
  if (!tasks || tasks.length === 0) return {};

  const shortlist = tasks.slice(0, 20).map(t => ({
    id: t.id,
    taskName: t.taskName,
    taskType: t.taskType,
    taskSteps: t.taskSteps || t.steps || [],
    taskContent: t.taskContent,
  }));

  const intentStr = intentType ? `Intent: ${intentType === 'FETCH' ? 'FETCH/READ (query, retrieve, check state)' : 'MODIFY (create, update, delete, add, remove)'}\n` : '';
  const prompt = `You are selecting a reusable task for the current user request.

Return STRICT JSON only:
{
  "taskId": number | null,
  "score": number, // 0.0-1.0 similarity
  "reason": string
}

Rules:
- Primary match: intent (${intentType || 'unspecified'}) MUST align with task type.
- Secondary match: query semantics (entities, actions, operations).
- Pick the closest task only if similarity >= 0.6.
- If nothing is close enough, return taskId=null and score=0.
- Strongly favor tasks with matching intent over semantic similarity alone.
- Use task steps/content semantically; do not rely on exact strings.

${intentStr}User request: ${refinedQuery}

Candidate tasks:
${JSON.stringify(shortlist, null, 2)}
`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Respond with JSON only. No prose.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 200,
    }),
  });

  if (!res.ok) {
    console.warn('Task similarity LLM failed:', await res.text());
    return {};
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim() || '';
  try {
    const parsed = JSON.parse(content.replace(/```json|```/g, ''));
    const taskId = parsed.taskId;
    const score = parsed.score;
    if (typeof taskId === 'number' && typeof score === 'number' && score >= 0.6) {
      const task = tasks.find(t => t.id === taskId);
      if (task) return { task, score };
    }
  } catch (e) {
    console.warn('Failed to parse task similarity response:', content);
  }
  return {};
}


// 独立函数：多实体embedding检索与API过滤
export async function getAllMatchedApis({ entities, intentType, apiKey, context }: { entities: string[], intentType: "FETCH" | "MODIFY", apiKey: string, context?: RequestContext }): Promise<Map<string, any>> {
  // Always use TABLE embeddings for data fetch context, even when the overall task is MODIFY.
  const allMatchedApis = new Map();
  console.log(`🔎 Retrieval mode decision: intentType=${intentType}, always including TABLE/SQL for reads; adding API matches for MODIFY.`);

  for (const entity of entities) {
    console.log(`\n--- Embedding search for entity: "${entity}" ---`);
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-ada-002',
        input: entity,
      }),
    });
    if (!embeddingResponse.ok) {
      console.warn(`Failed to generate embedding for entity "${entity}"`);
      continue;
    }
    const embeddingData = await embeddingResponse.json();
    const entityEmbedding = embeddingData.data[0].embedding;

    // Table-first retrieval for all intents (used for read phases)
    const tableResults = findTopKSimilarTable(entityEmbedding, 10, context);
    console.log(`Found ${tableResults.length} tables for entity "${entity}"`);
    tableResults.forEach((result: any) => {
      const existing = allMatchedApis.get(result.id);
      if (!existing || result.similarity > existing.similarity) {
        allMatchedApis.set(result.id, result);
      }
    });

    if (intentType === 'MODIFY') {
      // API retrieval remains available (needed for mutation steps)
      const apiResults = findTopKSimilarApi(entityEmbedding, 10, context);
      console.log(`Found ${apiResults.length} APIs for entity "${entity}"`);
      // console.log(`Found ${apiResults.length} APIs for entity "${entity}":`,
      //   apiResults.map((item: any) => ({ id: item.id, similarity: item.similarity.toFixed(3) }))
      // );
      apiResults.forEach((result: any) => {
        const existing = allMatchedApis.get(result.id);
        if (!existing || result.similarity > existing.similarity) {
          allMatchedApis.set(result.id, result);
        }
      });
    }
  }

  // Always add a special API spec for POST /general/sql/query to support SQL reads
  if (!allMatchedApis.has('sql-query')) {
    allMatchedApis.set('sql-query', {
      id: 'sql-query',
      summary: 'Execute SQL query',
      tags: ['sql', 'query', 'table', 'database'],
      content: 'path: /general/sql/query\nmethod: POST\ntags: sql, query, table, database\nsummary: Execute SQL query\ndescription: Execute a SQL query and return results.\nparameters: query (body): string',
      api: {
        path: '/general/sql/query',
        method: 'POST',
        parameters: {},
        requestBody: { query: '' }
      },
      similarity: 0
    });
  }

  return allMatchedApis;
}

export async function getTopKResults(allMatchedApis: Map<string, any>, topK: number): Promise<any[]> {

    // Convert Map to array and sort by similarity
    let topKResults = Array.from(allMatchedApis.values())
      .sort((a: any, b: any) => b.similarity - a.similarity)
      .slice(0, topK); // Take top topK from combined results

    console.log('topKResults.length: ', topKResults.length);

    console.log(`\n✅ Combined Results: Found ${allMatchedApis.size} unique APIs across all entities`);
    console.log(`📋 Top ${topKResults.length} APIs selected:`,
      topKResults.map((item: any) => ({
        id: item.id,
        similarity: item.similarity.toFixed(3)
      }))
    );

    if (topKResults.length === 0) {
      return [];
    }

    // Ensure the SQL entry is always available for read-phase planning
    const sqlEntry = allMatchedApis.get('sql-query');
    const hasSqlEntry = topKResults.some((item: any) => item.id === 'sql-query');
    if (!hasSqlEntry && sqlEntry) {
      topKResults.push(sqlEntry);
    }

    topKResults = topKResults.map((item: any) => {
      // 拆分item.content，前面为tags，后面为json
      // let tags: string[] = [];
      // let jsonStr = item.content;
      // const jsonStartIdx = item.content.indexOf('{');
      // if (jsonStartIdx > 0) {
      //   const tagText = item.content.slice(0, jsonStartIdx).trim();
      //   tags = tagText.split(/\s+/).filter(Boolean);
      //   jsonStr = item.content.slice(jsonStartIdx);
      // }
      // console.log('jsonStr topK: ', jsonStr);
      // const content = JSON.parse(jsonStr);
      // content.tags = tags.length > 0 ? tags : (content.tags || []);
      // return content;
      const topK = {
        id: item.id,
        summary: item.summary,
        tags: item.tags,
        content: item.content
      };
      // console.log('item topK: ', topK.id);
      return topK;
    });

    return topKResults;
}

// Load prompt file content
export async function fetchPromptFile(fileName: string): Promise<string> {
  try {
    const response = fs.readFileSync(path.join(process.cwd(), 'src', 'doc', fileName), 'utf-8');
    return response;
  } catch (error: any) {
    throw new Error(`Error fetching prompt file: ${error.message}`);
  }
};