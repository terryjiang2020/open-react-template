import { cosineSimilarity } from '@/src/utils/cosineSimilarity';
import fs from 'fs';
import path from 'path';

const jaison = require('jaison');

// Request-scoped context to prevent race conditions between concurrent requests
export interface RequestContext {
  ragEntity?: string;
  flatUsefulDataMap: Map<string, any>;
  usefulDataArray: Array<{ key: string; data: string; timestamp: number }>;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// Load vectorized data
const vectorizedDataPath = path.join(process.cwd(), 'src/doc/vectorized-data/vectorized-data.json');
const vectorizedDataTablePath = path.join(process.cwd(), 'src/doc/vectorized-data/table/vectorized-data.json');
const vectorizedDataApiPath = path.join(process.cwd(), 'src/doc/vectorized-data/api/vectorized-data.json');
const vectorizedData = JSON.parse(fs.readFileSync(vectorizedDataPath, 'utf-8'));
const vectorizedDataTable = JSON.parse(fs.readFileSync(vectorizedDataTablePath, 'utf-8'));
const vectorizedDataApi = JSON.parse(fs.readFileSync(vectorizedDataApiPath, 'utf-8'));

// Function to find the top-k most similar API vectors
function findTopKSimilarApi(queryEmbedding: number[], topK: number = 3, context?: RequestContext) {
  return vectorizedDataApi
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

// Multi-entity embedding retrieval and API filtering
export async function getAllMatchedApis({
  entities,
  intentType,
  apiKey,
  context,
}: {
  entities: string[];
  intentType: 'FETCH' | 'MODIFY';
  apiKey: string;
  context?: RequestContext;
}): Promise<Map<string, any>> {
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

    const tableResults = findTopKSimilarTable(entityEmbedding, 10, context);
    console.log(`Found ${tableResults.length} tables for entity "${entity}"`);
    tableResults.forEach((result: any) => {
      const existing = allMatchedApis.get(result.id);
      if (!existing || result.similarity > existing.similarity) {
        allMatchedApis.set(result.id, result);
      }
    });

    if (intentType === 'MODIFY') {
      const apiResults = findTopKSimilarApi(entityEmbedding, 10, context);
      console.log(`Found ${apiResults.length} APIs for entity "${entity}"`);
      apiResults.forEach((result: any) => {
        const existing = allMatchedApis.get(result.id);
        if (!existing || result.similarity > existing.similarity) {
          allMatchedApis.set(result.id, result);
        }
      });
    }
  }

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
        requestBody: { query: '' },
      },
      similarity: 0,
    });
  }

  return allMatchedApis;
}

export async function getTopKResults(allMatchedApis: Map<string, any>, topK: number): Promise<any[]> {
  let topKResults = Array.from(allMatchedApis.values())
    .sort((a: any, b: any) => b.similarity - a.similarity)
    .slice(0, topK);

  console.log('topKResults.length: ', topKResults.length);

  console.log(`\n✅ Combined Results: Found ${allMatchedApis.size} unique APIs across all entities`);
  console.log(
    `📋 Top ${topKResults.length} APIs selected:`,
    topKResults.map((item: any) => ({
      id: item.id,
      similarity: item.similarity.toFixed(3),
    }))
  );

  if (topKResults.length === 0) {
    return [];
  }

  const sqlEntry = allMatchedApis.get('sql-query');
  const hasSqlEntry = topKResults.some((item: any) => item.id === 'sql-query');
  if (!hasSqlEntry && sqlEntry) {
    topKResults.push(sqlEntry);
  }

  topKResults = topKResults.map((item: any) => {
    const topK = {
      id: item.id,
      summary: item.summary,
      tags: item.tags,
      content: item.content,
    };
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
}

export function detectEntityName(refinedQuery: string): string | undefined {
  const text = refinedQuery || '';
  const quoted = text.match(/['"]([^'"]+)['"]/);
  if (quoted) return quoted[1];
  const verbNoun = text.match(/\b(?:add|remove|delete|drop|clear)\s+([A-Za-z0-9_-]+)/i);
  if (verbNoun) return verbNoun[1];
  const lastToken = text.trim().split(/\s+/).pop();
  return lastToken && lastToken.length > 1 ? lastToken : undefined;
}

export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj || {}));
}

export function replaceInObject(obj: any, search: string, replacement: string) {
  if (typeof obj !== 'object' || obj === null) return;
  Object.keys(obj).forEach((key) => {
    if (typeof obj[key] === 'string') {
      obj[key] = obj[key].replace(new RegExp(search, 'gi'), replacement);
    } else if (typeof obj[key] === 'object') {
      replaceInObject(obj[key], search, replacement);
    }
  });
}

export function substituteApiPlaceholders(
  api: any,
  refinedQuery: string,
  fallback: { path: string; method: string }
) {
  const entityName = detectEntityName(refinedQuery);
  const method = (api?.method || fallback.method || 'post').toLowerCase();
  let path = api?.path || fallback.path || '/general/sql/query';
  const parameters = deepClone(api?.parameters || {});
  const requestBody = deepClone(api?.requestBody || {});

  const namePlaceholder = path.includes('team') ? '{TEAM_NAME}' : '{POKEMON_NAME}';

  if (entityName) {
    path = path.replace(new RegExp(namePlaceholder, 'g'), entityName);
    replaceInObject(parameters, namePlaceholder, entityName);
    replaceInObject(requestBody, namePlaceholder, entityName);
  }

  return { path, method, parameters, requestBody };
}

export function serializeUsefulDataInOrder(context: RequestContext): string {
  if (!context.usefulDataArray || context.usefulDataArray.length === 0) {
    return '{}';
  }

  const orderedEntries: Array<[string, string]> = context.usefulDataArray
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((item) => [item.key, item.data]);

  const orderedObj = Object.fromEntries(orderedEntries);
  return JSON.stringify(orderedObj, null, 2);
}

export function extractJSON(content: string): { json: string; text: string } | null {
  try {
    const trimmed = content.trim();

    let jsonStart = -1;
    let jsonEnd = -1;

    const objStart = trimmed.indexOf('{');
    const arrStart = trimmed.indexOf('[');

    if (objStart === -1 && arrStart === -1) {
      return null;
    }

    if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
      jsonStart = objStart;
      let depth = 0;
      for (let i = objStart; i < trimmed.length; i++) {
        if (trimmed[i] === '{') depth++;
        if (trimmed[i] === '}') depth--;
        if (depth === 0) {
          jsonEnd = i + 1;
          break;
        }
      }
    } else if (arrStart !== -1) {
      jsonStart = arrStart;
      let depth = 0;
      for (let i = arrStart; i < trimmed.length; i++) {
        if (trimmed[i] === '[') depth++;
        if (trimmed[i] === ']') depth--;
        if (depth === 0) {
          jsonEnd = i + 1;
          break;
        }
      }
    }

    if (jsonStart === -1 || jsonEnd === -1) {
      return null;
    }

    const json = trimmed.substring(jsonStart, jsonEnd);
    const text = trimmed.substring(0, jsonStart).trim();

    JSON.parse(json);

    return { json, text };
  } catch {
    return null;
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function sanitizePlannerResponse(response: string): string {
  try {
    console.log('response to sanitize:', response);
    const firstMatch = response.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!firstMatch) {
      throw new Error('No JSON object or array found in the response.');
    }
    console.log('firstMatch:', firstMatch[0]);
    let cleaned = firstMatch[0];

    const jsonFixed = jaison(cleaned);
    console.log('jsonFixed:', jsonFixed);
    if (jsonFixed) {
      return JSON.stringify(jsonFixed);
    }

    throw new Error('No valid JSON found in the response.');
  } catch (error) {
    console.error('Error sanitizing planner response:', error);
    throw error;
  }
}

export function containsPlaceholderReference(obj: any): boolean {
  const placeholderPattern = /resolved_from_step_\d+/i;

  const checkValue = (value: any): boolean => {
    if (typeof value === 'string') {
      return placeholderPattern.test(value);
    }
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        return value.some(checkValue);
      }
      return Object.values(value).some(checkValue);
    }
    return false;
  };

  return checkValue(obj);
}

export async function resolvePlaceholders(
  stepToExecute: any,
  executedSteps: any[],
  apiKey: string
): Promise<{ resolved: boolean; reason?: string }> {
  const placeholderPattern = /resolved_from_step_(\d+)/i;
  let foundPlaceholder = false;
  let placeholderStepNum: number | null = null;

  if (stepToExecute.api?.parameters) {
    for (const [key, value] of Object.entries(stepToExecute.api.parameters)) {
      if (typeof value === 'string') {
        const match = value.match(placeholderPattern);
        if (match) {
          foundPlaceholder = true;
          placeholderStepNum = parseInt(match[1]);
          console.log(
            `🔍 Detected placeholder in parameters.${key}: "${value}" (references step ${placeholderStepNum})`
          );
        }
      }
    }
  }

  if (stepToExecute.api?.requestBody) {
    const checkBody = (obj: any, path: string = ''): boolean => {
      for (const [key, value] of Object.entries(obj || {})) {
        const fullPath = path ? `${path}.${key}` : key;

        if (typeof value === 'string') {
          const match = value.match(placeholderPattern);
          if (match) {
            foundPlaceholder = true;
            placeholderStepNum = parseInt(match[1]);
            console.log(
              `🔍 Detected placeholder in requestBody.${fullPath}: "${value}" (references step ${placeholderStepNum})`
            );
            return true;
          }
        } else if (typeof value === 'object' && value !== null) {
          if (checkBody(value, fullPath)) return true;
        }
      }
      return false;
    };

    checkBody(stepToExecute.api.requestBody);
  }

  if (!foundPlaceholder || placeholderStepNum === null) {
    return { resolved: true };
  }

  const referencedStep = executedSteps.find(
    (s) =>
      s.step === placeholderStepNum ||
      s.stepNumber === placeholderStepNum ||
      s.step?.step_number === placeholderStepNum
  );

  if (!referencedStep) {
    const reason = `Referenced step ${placeholderStepNum} has not been executed yet`;
    console.error(`❌ ${reason}`);
    return { resolved: false, reason };
  }

  console.log(`\n📋 RESOLVING PLACEHOLDER: resolved_from_step_${placeholderStepNum}`);
  console.log(`   Referenced step response:`, JSON.stringify(referencedStep.response, null, 2));

  const apiKey_local = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
  if (!apiKey_local) {
    return { resolved: false, reason: 'OpenAI API key not configured' };
  }

  try {
    const llmResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey_local}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are a data extraction expert. Given a previous API response and the current step's requirements, extract the correct value to replace a "resolved_from_step_X" placeholder.

RULES:
1. Analyze the current step's API call to understand what value is needed
2. Look at the referenced step's response to find the matching data
3. Return ONLY the extracted value (no explanation, no JSON wrapping)
4. Common patterns:
   - If current step deletes by ID, extract the "id" field from previous step
   - If current step modifies a resource, extract the "id" that identifies that resource
   - If previous step returned multiple results, extract the first one's ID
5. If the data cannot be found, return "ERROR: [reason]"

Current Step Analysis:
- API Path: ${stepToExecute.api?.path}
- API Method: ${stepToExecute.api?.method}
- Parameters: ${JSON.stringify(stepToExecute.api?.parameters || {})}
- Request Body: ${JSON.stringify(stepToExecute.api?.requestBody || {})}

Previous Step (Step ${placeholderStepNum}) Response:
${JSON.stringify(referencedStep.response, null, 2)}

What value should replace "resolved_from_step_${placeholderStepNum}"? Return ONLY the value:`,
          },
        ],
        temperature: 0.2,
        max_tokens: 100,
      }),
    });

    if (!llmResponse.ok) {
      const errorText = await llmResponse.text();
      console.error('LLM extraction failed:', errorText);
      return { resolved: false, reason: `LLM extraction failed: ${errorText}` };
    }

    const data = await llmResponse.json();
    const extractedValue = data.choices[0]?.message?.content?.trim();

    console.log(`✅ LLM extracted value: "${extractedValue}"`);

    if (!extractedValue || extractedValue.startsWith('ERROR:')) {
      return { resolved: false, reason: `Failed to extract value: ${extractedValue}` };
    }

    if (stepToExecute.api?.parameters) {
      for (const [key, value] of Object.entries(stepToExecute.api.parameters)) {
        if (typeof value === 'string' && value.includes(`resolved_from_step_${placeholderStepNum}`)) {
          stepToExecute.api.parameters[key] = extractedValue;
          console.log(`   ✅ Replaced parameters.${key}: "${value}" → "${extractedValue}"`);
        }
      }
    }

    if (stepToExecute.api?.requestBody) {
      const replaceInBody = (obj: any): void => {
        for (const [key, value] of Object.entries(obj || {})) {
          if (typeof value === 'string' && value.includes(`resolved_from_step_${placeholderStepNum}`)) {
            obj[key] = obj[key].replace(`resolved_from_step_${placeholderStepNum}`, extractedValue);
            console.log(`   ✅ Replaced requestBody.${key}: "${value}" → "${extractedValue}"`);
          } else if (typeof value === 'object' && value !== null) {
            replaceInBody(value);
          }
        }
      };

      replaceInBody(stepToExecute.api.requestBody);
    }

    return { resolved: true };
  } catch (error: any) {
    console.error(`❌ Error resolving placeholder:`, error);
    return { resolved: false, reason: error.message };
  }
}
