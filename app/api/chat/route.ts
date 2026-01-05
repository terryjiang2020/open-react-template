import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
const jaison = require('jaison');
import { cosineSimilarity } from '@/src/utils/cosineSimilarity';
import { dynamicApiRequest, FanOutRequest } from '@/services/apiService';
import { findApiParameters } from '@/services/apiSchemaLoader';
import { clarifyAndRefineUserInput, handleQueryConceptsAndNeeds } from '@/utils/queryRefinement';
import { SavedTask } from '@/services/taskService';
import { sendToPlanner } from './planner';

// In-memory plan storage for approval workflow
// Key: sessionId (generated from user conversation hash)
const pendingPlans = new Map<string, {
  plan: any;
  planResponse: string;
  refinedQuery: string;
  topKResults: any[];
  conversationContext: string;
  finalDeliverable: string;
  entities: any[];
  intentType: 'FETCH' | 'MODIFY';
  timestamp: number;
  referenceTask?: SavedTask;
}>();

// Clean up old pending plans (older than 1 hour)
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, data] of pendingPlans.entries()) {
    if (now - data.timestamp > 3600000) {
      pendingPlans.delete(sessionId);
    }
  }
}, 300000); // Run every 5 minutes

// Request-scoped context to prevent race conditions between concurrent requests
interface RequestContext {
  ragEntity?: string;
  flatUsefulDataMap: Map<string, any>;
  usefulDataArray: Array<{ key: string; data: string; timestamp: number }>;
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ReferenceTaskMatch {
  task?: SavedTask;
  score?: number;
}

export async function selectReferenceTask(refinedQuery: string, tasks: SavedTask[], apiKey: string, intentType?: 'FETCH' | 'MODIFY'): Promise<ReferenceTaskMatch> {
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

// Generate a session ID from messages to track pending plans
function generateSessionId(messages: Message[]): string {
  // Use all messages EXCEPT the last one to create a stable session ID
  // This way, the session ID remains the same when user sends "approve"
  const messagesForHash = messages.slice(0, -1);
  
  if (messagesForHash.length === 0) {
    // First message in conversation - use just the conversation start
    return `session_new_${Date.now()}`;
  }
  
  // Use first 3 messages + second-to-last message for stability
  const keyMessages = [
    ...messagesForHash.slice(0, Math.min(3, messagesForHash.length)),
    messagesForHash[messagesForHash.length - 1]
  ].filter(Boolean);
  
  const content = keyMessages.map(m => `${m.role}:${m.content}`).join('|');
  // Simple hash function
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `session_${Math.abs(hash)}`;
}

// Helper function to detect if a query/plan is for resolution (checking) vs execution (modifying)
async function detectResolutionVsExecution(
  refinedQuery: string,
  executionPlan: any,
  apiKey: string
): Promise<'resolution' | 'execution'> {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are a query intent classifier.

RESOLUTION queries are those that:
- Check, verify, or confirm the current state
- Ask "has X been done?", "is Y cleared?", "how many Z?"
- Retrieve information to verify a previous action
- Query the database to check current state
- Examples: "Has the watchlist been cleared?", "Did the deletion succeed?", "Show current state", "How many items in my team?"

EXECUTION queries are those that:
- Perform actions or modifications
- Add, delete, update, create data
- Directly call modification APIs
- Examples: "Clear the watchlist", "Delete this item", "Add to team"

Respond with ONLY ONE WORD: either "resolution" or "execution"`,
          },
          {
            role: 'user',
            content: `Query: ${refinedQuery}

Execution Plan: ${JSON.stringify(executionPlan, null, 2)}

Intent:`,
          },
        ],
        temperature: 0.1,
        max_tokens: 10,
      }),
    });

    if (!response.ok) {
      console.warn('Resolution detection failed, defaulting to execution');
      return 'execution';
    }

    const data = await response.json();
    const intent = data.choices[0]?.message?.content?.trim().toLowerCase();

    console.log(`🔍 Detected intent: ${intent} for query: "${refinedQuery}"`);

    if (intent === 'resolution') {
      return 'resolution';
    }
    return 'execution';
  } catch (error) {
    console.error('Error detecting resolution vs execution:', error);
    return 'execution'; // Default to execution on error
  }
}

// Helper function to serialize useful data in chronological order
function serializeUsefulDataInOrder(context: RequestContext): string {
  if (!context.usefulDataArray || context.usefulDataArray.length === 0) {
    return '{}';
  }

  // Create an object with chronologically ordered entries
  const orderedEntries: Array<[string, string]> = context.usefulDataArray
    .sort((a, b) => a.timestamp - b.timestamp) // Sort by timestamp (earliest first)
    .map(item => [item.key, item.data]);

  // Convert to object maintaining insertion order
  const orderedObj = Object.fromEntries(orderedEntries);
  return JSON.stringify(orderedObj, null, 2);
}

// 从混合响应中提取JSON部分
function extractJSON(content: string): { json: string; text: string } | null {
  try {
    const trimmed = content.trim();

    // 尝试找到JSON对象 {...} 或数组 [...]
    let jsonStart = -1;
    let jsonEnd = -1;

    // 查找JSON对象
    const objStart = trimmed.indexOf('{');
    const arrStart = trimmed.indexOf('[');

    if (objStart === -1 && arrStart === -1) {
      return null;
    }

    // 确定JSON的起始位置（取最先出现的）
    if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
      jsonStart = objStart;
      // 找到匹配的闭合括号
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
      // 找到匹配的闭合括号
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

    // 验证JSON是否有效
    JSON.parse(json);

    return { json, text };
  } catch {
    return null;
  }
}

// 估算JSON的token数量（粗略估计：1 token ≈ 4 字符）
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// 摘要用户消息以减少token使用
async function summarizeMessages(messages: Message[], apiKey: string): Promise<Message[]> {
  // 如果消息少于10条，不需要摘要
  if (messages.length <= 10) {
    return messages;
  }

  // 保留最近的5条消息，摘要之前的消息
  const recentMessages = messages.slice(-5);
  const oldMessages = messages.slice(0, -5);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: '请将以下对话历史总结成简洁的要点，保留关键信息和上下文。用英文回复。',
          },
          {
            role: 'user',
            content: `对话历史：\n${oldMessages.map(m => `${m.role}: ${m.content}`).join('\n')}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const summary = data.choices[0]?.message?.content || '';

      return [
        { role: 'system', content: `对话历史摘要：${summary}` },
        ...recentMessages,
      ];
    }
  } catch (error: any) {
    console.warn('Error summarizing messages:', error);
  }

  // 如果摘要失败，返回最近的消息
  return recentMessages;
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

// Load prompt file content
export async function fetchPromptFile(fileName: string): Promise<string> {
  try {
    const response = fs.readFileSync(path.join(process.cwd(), 'src', 'doc', fileName), 'utf-8');
    return response;
  } catch (error: any) {
    throw new Error(`Error fetching prompt file: ${error.message}`);
  }
};

function detectEntityName(refinedQuery: string): string | undefined {
  const text = refinedQuery || '';
  const quoted = text.match(/['"]([^'"]+)['"]/);
  if (quoted) return quoted[1];
  const verbNoun = text.match(/\b(?:add|remove|delete|drop|clear)\s+([A-Za-z0-9_-]+)/i);
  if (verbNoun) return verbNoun[1];
  const lastToken = text.trim().split(/\s+/).pop();
  return lastToken && lastToken.length > 1 ? lastToken : undefined;
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj || {}));
}

function replaceInObject(obj: any, search: string, replacement: string) {
  if (typeof obj !== 'object' || obj === null) return;
  Object.keys(obj).forEach((key) => {
    if (typeof obj[key] === 'string') {
      obj[key] = obj[key].replace(new RegExp(search, 'gi'), replacement);
    } else if (typeof obj[key] === 'object') {
      replaceInObject(obj[key], search, replacement);
    }
  });
}

function substituteApiPlaceholders(api: any, refinedQuery: string, fallback: { path: string, method: string }) {
  const entityName = detectEntityName(refinedQuery);
  const method = (api?.method || fallback.method || 'post').toLowerCase();
  let path = api?.path || fallback.path || '/general/sql/query';
  const parameters = deepClone(api?.parameters || {});
  const requestBody = deepClone(api?.requestBody || {});

  const namePlaceholder = path.includes('team') ? '{TEAM_NAME}' : '{POKEMON_NAME}';

  // Replace placeholders with available values
  if (entityName) {
    path = path.replace(new RegExp(namePlaceholder, 'g'), entityName);
    replaceInObject(parameters, namePlaceholder, entityName);
    replaceInObject(requestBody, namePlaceholder, entityName);
  }

  return { path, method, parameters, requestBody };
}

// 独立planner函数：负责准备输入、调用sendToPlanner、处理响应
async function runPlannerWithInputs({
  topKResults,
  refinedQuery,
  apiKey,
  usefulData,
  conversationContext,
  finalDeliverable,
  intentType,
  entities,
  requestContext,
  referenceTask
}: {
  topKResults: any[],
  refinedQuery: string,
  apiKey: string,
  usefulData: string,
  conversationContext?: string,
  finalDeliverable?: string,
  intentType: 'FETCH' | 'MODIFY',
  entities?: string[],
  requestContext?: RequestContext,
  referenceTask?: SavedTask
}): Promise<{ actionablePlan: any, planResponse: string }> {
  const hasSqlCandidate = topKResults.some((item: any) => item.id && typeof item.id === 'string' && (item.id.startsWith('table-') || item.id === 'sql-query'));
  const isSqlRetrieval = intentType === 'FETCH' && hasSqlCandidate;
  console.log(`🔀 Planner input routing: intentType=${intentType}, hasSqlCandidate=${hasSqlCandidate}, isSqlRetrieval=${isSqlRetrieval}`);
  
  // OPTIMIZATION: If a reference task exists, use its plan directly to reduce LLM calls
  if (referenceTask && referenceTask.steps && Array.isArray(referenceTask.steps) && referenceTask.steps.length > 0) {
    console.log(`\n✨ FAST PATH: Using reference task plan directly (${referenceTask.steps.length} steps)`);
    console.log(`🧭 Reference task: ${referenceTask.id} (${referenceTask.taskName}, type=${referenceTask.taskType})`);
    
    // Convert reference task steps into execution plan format
    // Steps have format: { stepOrder, stepType, stepContent: "Description — METHOD /path/with/{params}" }
    const executionPlan = referenceTask.steps.map((step: any) => {
      // Parse stepContent to extract API method and path
      // Format: "Description — METHOD /path"
      const contentMatch = step.stepContent?.match(/—\s*(\w+)\s+(.+?)$/);
      const method = contentMatch ? contentMatch[1].toLowerCase() : 'post';
      const path = contentMatch ? contentMatch[2].trim() : '/general/sql/query';
      
      return {
        step_number: step.stepOrder || 1,
        description: step.stepContent || `Step ${step.stepOrder}`,
        api: {
          path: path,
          method: method,
          parameters: {},
          requestBody: {}
        },
        stepType: step.stepType // 1=FETCH, 2=MODIFY
      };
    });
    
    const actionablePlan = {
      needs_clarification: false,
      phase: referenceTask.taskType === 1 ? 'resolution' : 'execution',
      final_deliverable: finalDeliverable || '',
      execution_plan: executionPlan,
      selected_tools_spec: [],
      _from_reference_task: true,
      _reference_task_id: referenceTask.id
    };
    
    console.log(`📋 Converted reference task to execution plan:`, JSON.stringify(executionPlan.map(s => ({
      step: s.step_number,
      description: s.description,
      api: `${s.api.method.toUpperCase()} ${s.api.path}`,
      type: s.stepType === 1 ? 'FETCH' : 'MODIFY'
    })), null, 2));

    const planResponse = JSON.stringify(actionablePlan);
    console.log('🪄 Using refetched reference plan:', planResponse);
    return { actionablePlan, planResponse };
  }
  
  const referenceTaskContext = referenceTask ? `\n\nReference task (reuse if similar):\n${JSON.stringify({ id: referenceTask.id, taskName: referenceTask.taskName, taskType: referenceTask.taskType, steps: referenceTask.steps }, null, 2)}\nIf this task fits, adapt its steps instead of creating a brand-new plan. If not a good fit, continue with normal planning.` : '';
  const mergedConversationContext = referenceTaskContext ? `${conversationContext || ''}${referenceTaskContext}` : conversationContext;
  if (referenceTask) {
    console.log(`🧭 Planner received reference task ${referenceTask.id} (${referenceTask.taskName}) for reuse consideration.`);
  }
  if (!isSqlRetrieval) {
    // 发送到planner（API模式）
    let planResponse = await sendToPlanner(refinedQuery, apiKey, usefulData, mergedConversationContext, intentType);

    let actionablePlan;
    try {
      // Remove comments and sanitize the JSON string
      let sanitizedPlanResponse = sanitizePlannerResponse(planResponse);
      // --- PATCH: Remove user_id from /pokemon/watchlist POST plan ---
      let planObj;
      try {
        planObj = JSON.parse(sanitizedPlanResponse);
        if (planObj && planObj.execution_plan && Array.isArray(planObj.execution_plan)) {
          planObj.execution_plan = planObj.execution_plan.map((step: any) => {
            if (
              step.api &&
              typeof step.api.path === 'string' &&
              step.api.path.replace(/^\/api/, '') === '/pokemon/watchlist' &&
              step.api.method && step.api.method.toLowerCase() === 'post'
            ) {
              // Remove user_id from requestBody if present
              if (step.api.requestBody && typeof step.api.requestBody === 'object') {
                const newBody = { ...step.api.requestBody };
                delete newBody.user_id;
                // Also handle possible snake/camel case
                delete newBody.userId;
                step.api.requestBody = newBody;
              }
            }
            return step;
          });
        }
        // Also patch selected_tools_spec
        if (planObj && planObj.selected_tools_spec && Array.isArray(planObj.selected_tools_spec)) {
          planObj.selected_tools_spec = planObj.selected_tools_spec.map((tool: any) => {
            if (
              tool.endpoint &&
              tool.endpoint.replace(/^POST \/api/, 'POST ') === 'POST /pokemon/watchlist'
            ) {
              // Remove user_id from derivations if present
              if (Array.isArray(tool.derivations)) {
                tool.derivations = tool.derivations.filter((d: string) => !d.toLowerCase().includes('user_id'));
              }
            }
            return tool;
          });
        }
        sanitizedPlanResponse = JSON.stringify(planObj);
      } catch (e) {
        // fallback: do nothing
      }
      console.log('Sanitized Planner Response:', sanitizedPlanResponse);
      actionablePlan = JSON.parse(sanitizedPlanResponse);
      // 强制保留原始finalDeliverable，不被plan覆盖
      if (actionablePlan && finalDeliverable) {
        actionablePlan.final_deliverable = finalDeliverable;
      }

      // Ensure no stale replan flags exist in fresh plans
      if (actionablePlan) {
        delete actionablePlan._replanned;
        delete actionablePlan._replan_reason;
      }

      if (actionablePlan?.impossible) {
        console.log('🚫 Planner marked task as impossible with current database resources.');
        return { actionablePlan, planResponse };
      }
    } catch (error) {
      console.warn('Failed to parse planner response as JSON:', error);
      console.warn('Original Planner Response:', planResponse);
      throw new Error('Failed to parse planner response');
    }
    // If modify intent returned only resolution phase, force a full-plan retry with MODIFY intent to get both resolution + modification steps
    if (intentType === 'MODIFY' && actionablePlan?.phase === 'resolution' && Array.isArray(entities) && entities.length > 0) {
      console.log('♻️ Plan is resolution-only for MODIFY intent; re-planning with forceFullPlan=true to get complete execution plan (resolution + modification steps)...');
      const tableMatchedApis = await getAllMatchedApis({ entities, intentType: 'MODIFY', apiKey, context: requestContext });
      const tableTopK = await getTopKResults(tableMatchedApis, 20);
      const tablePlanResponse = await sendToPlanner(refinedQuery, apiKey, usefulData, conversationContext, 'MODIFY', true);
      const sanitizedPlanResponse = sanitizePlannerResponse(tablePlanResponse);
      actionablePlan = JSON.parse(sanitizedPlanResponse);
      planResponse = tablePlanResponse;
      if (actionablePlan && finalDeliverable) {
        actionablePlan.final_deliverable = finalDeliverable;
      }
      // Note: This replanning happens BEFORE user approval, so no explanation message needed
      console.log('✅ Replanned with MODIFY intent and forceFullPlan=true for full execution plan.');
    }
    return { actionablePlan, planResponse };
  } else {
    // SQL/table检索，强制只允许POST /general/sql/query
    // Phase 1: Select relevant tables and columns
    const userQuestion = conversationContext
      ? `Previous context:\n${conversationContext}\n\nCurrent query: ${refinedQuery}`
      : refinedQuery;
    
    // Construct table selection prompt
    const tableSelectionPrompt = `You are a database schema analyst. Given a list of available tables and a user question, identify which tables and columns are most relevant.

Available Tables:
${JSON.stringify(topKResults, null, 2)}

User Question: ${userQuestion}

IMPORTANT RULES:
- Return ONLY a JSON object with the following structure:
{
  "selected_tables": ["table_name_1", "table_id_1", ...],
  "focus_columns": {
    "table_name_1": ["column1", "column2", ...],
    "table_name_2": ["column1", "column2", ...]
  },
  "reasoning": "Brief explanation of why these tables and columns were selected"
}

Output:`;

    // Call LLM for table selection
    const tableSelectionRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: tableSelectionPrompt },
        ],
        temperature: 0.3,
        max_tokens: 1024,
      }),
    });
    
    if (!tableSelectionRes.ok) {
      throw new Error('Failed to select tables');
    }
    
    const tableSelectionData = await tableSelectionRes.json();
    let tableSelectionText = tableSelectionData.choices[0]?.message?.content?.trim() || '';
    
    // Parse table selection response
    const jsonMatch = tableSelectionText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse table selection response');
    }
    
    const tableSelection = JSON.parse(jsonMatch[0]);
    console.log('📋 Table Selection Result:', tableSelection);

    if (!tableSelection.selected_tables || tableSelection.selected_tables.length === 0) {
      throw new Error('No tables selected for SQL generation', { cause: tableSelection.reasoning || 'No reasoning provided' });
    }
    
    // Filter topKResults to only include selected tables
    const shortlistedTables = topKResults.filter((table: any) => 
      tableSelection.selected_tables.some((selectedId: string) => 
        table.id === selectedId || table.id.includes(selectedId) || selectedId.includes(table.id)
      )
    );
    
    console.log('📊 Shortlisted Tables:', shortlistedTables.map((t: any) => t.id));
    
    // Phase 2: Generate SQL using shortlisted tables and focus columns
    const sqlSchema = `Relevant Tables:\n${JSON.stringify(shortlistedTables, null, 2)}

Focus Columns: ${JSON.stringify(tableSelection.focus_columns, null, 2)}

Selection Reasoning: ${tableSelection.reasoning}

- If a user ID is needed, always use CURRENT_USER_ID as the value.`;
    
    const sqlPrompt = `You are an expert SQL generator for PostgreSQL. Using the relevant tables and focus columns provided, generate a valid SQL query that answers the user question.

${sqlSchema}

User Question: ${userQuestion}

CRITICAL SQL RULES FOR POSTGRESQL:
1. Column aliases defined in SELECT cannot be used in HAVING clause
2. Must repeat the aggregate expression in HAVING instead of using the alias
3. Use single quotes (') for string literals, never smart quotes
4. Ensure proper GROUP BY clauses include all non-aggregated columns

Example:
❌ WRONG: SELECT SUM(x) as total ... HAVING total > 10
✅ CORRECT: SELECT SUM(x) as total ... HAVING SUM(x) > 10

Generate ONLY the SQL query (no explanations):

SQL:`;
    
    // Call LLM for SQL generation
    const sqlGenRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: sqlPrompt },
        ],
        temperature: 0.3,
        max_tokens: 512,
      }),
    });
    
    if (!sqlGenRes.ok) {
      throw new Error('Failed to generate SQL');
    }
    
    const sqlGenData = await sqlGenRes.json();
    let sqlText = sqlGenData.choices[0]?.message?.content?.trim() || '';
    
    // Extract SQL statement
    const sqlMatch = sqlText.match(/select[\s\S]+?;/i);
    if (sqlMatch) sqlText = sqlMatch[0];
    
    // Sanitize SQL: Replace smart quotes with regular quotes and normalize whitespace
    sqlText = sqlText
      .replace(/[\u2018\u2019]/g, "'")  // Replace smart single quotes
      .replace(/[\u201C\u201D]/g, '"')  // Replace smart double quotes
      .replace(/\\n/g, ' ')             // Replace literal \n with space
      .replace(/\\t/g, ' ')             // Replace literal \t with space
      .replace(/\s+/g, ' ')             // Normalize multiple spaces to single space
      .trim();
    
    // Fix common PostgreSQL errors: Replace alias references in HAVING with actual expressions
    // Pattern: HAVING alias_name operator value -> HAVING aggregate_expression operator value
    const selectMatch = sqlText.match(/SELECT\s+(.*?)\s+FROM/i);
    if (selectMatch) {
      const selectClause = selectMatch[1];
      // Extract all aliases and their expressions: "expression AS alias"
      const aliasPattern = /(\S+\([^)]+\)|[\w.]+)\s+(?:AS\s+)?(\w+)/gi;
      let match;
      const aliases = new Map<string, string>();
      
      while ((match = aliasPattern.exec(selectClause)) !== null) {
        const expression = match[1].trim();
        const alias = match[2].trim();
        // Only store aggregate expressions
        if (/^(SUM|COUNT|AVG|MAX|MIN|ARRAY_AGG)\(/i.test(expression)) {
          aliases.set(alias.toLowerCase(), expression);
        }
      }
      
      // Replace alias references in HAVING clause
      if (aliases.size > 0) {
        sqlText = sqlText.replace(/HAVING\s+(.+?)(?=\s+(?:ORDER|LIMIT|;|$))/gi, (havingClause: any) => {
          let modifiedHaving = havingClause;
          aliases.forEach((expression, alias) => {
            // Match alias used in comparisons (e.g., "total_stats = 100")
            const aliasRegex = new RegExp(`\\b${alias}\\b(?=\\s*[=<>!])`, 'gi');
            modifiedHaving = modifiedHaving.replace(aliasRegex, expression);
          });
          return modifiedHaving;
        });
      }
    }
    
    console.log('🔍 Generated SQL:', sqlText);
    if (!sqlText.toLowerCase().startsWith('select')) {
      
    }
    // 构造只包含POST /general/sql/query的plan
    const planObj = {
      needs_clarification: false,
      phase: 'execution',
      final_deliverable: finalDeliverable || '',
      execution_plan: [
        {
          step_number: 1,
          description: 'Execute SQL query to fulfill user request',
          api: {
            path: '/general/sql/query',
            method: 'post',
            requestBody: { query: sqlText }
          }
        }
      ],
      selected_tools_spec: [
        {
          endpoint: 'POST /general/sql/query',
          purpose: 'Execute SQL query',
          returns: 'SQL query result',
          derivations: [ `query = ${JSON.stringify(sqlText)}` ]
        }
      ]
    };
    const planResponse = JSON.stringify(planObj);
    return { actionablePlan: planObj, planResponse };
  }
}

// Enhanced JSON sanitization to handle comments and invalid trailing characters
function sanitizePlannerResponse(response: string): string {
  try {
    // // First, remove code block markers
    // let cleaned = response.replace(/```json|```/g, '').trim();

    // // Remove inline comments (// style)
    // cleaned = cleaned.replace(/\/\/.*(?=[\n\r])/g, '');

    // // Remove block comments (/* */ style) more carefully
    // // Replace comments with null to maintain valid JSON structure
    // cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, 'null');

    // // Replace angle bracket placeholders (e.g., <WATER_TYPE_ID>, <resolved_id>) with null
    // // These are not valid JSON and indicate the planner is using placeholders
    // cleaned = cleaned.replace(/<[^>]+>/g, 'null');

    // // Fix common issues after placeholder/comment removal
    // // Fix multiple commas: ,, or , null,
    // cleaned = cleaned.replace(/,\s*null\s*,/g, ',');
    // cleaned = cleaned.replace(/,\s*,/g, ',');
    // // Fix comma before closing bracket/brace
    // cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
    // // Fix missing values before comma (e.g., "key": ,)
    // cleaned = cleaned.replace(/:\s*,/g, ': null,');

    // // Patch known SQL string issues that break JSON parsing
    // // e.g., "ps.base_stat null 100" -> "ps.base_stat > 100"
    // cleaned = cleaned.replace(/base_stat\s+null\s+(\d+)/gi, 'base_stat > $1');
    // // e.g., stray escaped quotes before semicolon: ";\" -> ";
    // cleaned = cleaned.replace(/;\\"/g, ';');
    // // e.g., ORDER BY ...;\" -> ORDER BY ...;
    // cleaned = cleaned.replace(/(ORDER BY [^;]+);\\"/gi, '$1;');

    // Extract the first valid JSON object or array
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

// Helper function to detect placeholder references like "resolved_from_step_X"
function containsPlaceholderReference(obj: any): boolean {
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

// Helper function to resolve placeholder references and extract actual data from executed steps
async function resolvePlaceholders(
  stepToExecute: any,
  executedSteps: any[],
  apiKey: string
): Promise<{ resolved: boolean; reason?: string }> {
  const placeholderPattern = /resolved_from_step_(\d+)/i;
  let foundPlaceholder = false;
  let placeholderStepNum: number | null = null;
  
  // Check parameters for placeholders
  if (stepToExecute.api?.parameters) {
    for (const [key, value] of Object.entries(stepToExecute.api.parameters)) {
      if (typeof value === 'string') {
        const match = value.match(placeholderPattern);
        if (match) {
          foundPlaceholder = true;
          placeholderStepNum = parseInt(match[1]);
          console.log(`🔍 Detected placeholder in parameters.${key}: "${value}" (references step ${placeholderStepNum})`);
        }
      }
    }
  }
  
  // Check request body for placeholders
  if (stepToExecute.api?.requestBody) {
    const checkBody = (obj: any, path: string = ''): boolean => {
      for (const [key, value] of Object.entries(obj || {})) {
        const fullPath = path ? `${path}.${key}` : key;
        
        if (typeof value === 'string') {
          const match = value.match(placeholderPattern);
          if (match) {
            foundPlaceholder = true;
            placeholderStepNum = parseInt(match[1]);
            console.log(`🔍 Detected placeholder in requestBody.${fullPath}: "${value}" (references step ${placeholderStepNum})`);
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
  
  // If no placeholder found, return success
  if (!foundPlaceholder || placeholderStepNum === null) {
    return { resolved: true };
  }
  
  // Find the referenced step in executed steps
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
  
  // Extract the appropriate data from the referenced step's response
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
    
    // Replace placeholders in parameters
    if (stepToExecute.api?.parameters) {
      for (const [key, value] of Object.entries(stepToExecute.api.parameters)) {
        if (typeof value === 'string' && value.includes(`resolved_from_step_${placeholderStepNum}`)) {
          stepToExecute.api.parameters[key] = extractedValue;
          console.log(`   ✅ Replaced parameters.${key}: "${value}" → "${extractedValue}"`);
        }
      }
    }
    
    // Replace placeholders in request body
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

export async function POST(request: NextRequest) {
  // Create request-local context to prevent race conditions
  const requestContext: RequestContext = {
    ragEntity: undefined,
    flatUsefulDataMap: new Map(),
    usefulDataArray: []
  };

  let usefulData = new Map();
  let finalDeliverable = '';

  try {
    // Extract user token from Authorization header (optional)
    const authHeader = request.headers.get('Authorization') || '';
    const userToken = authHeader.startsWith('Bearer ') ? authHeader : '';

    const requestBody = await request.json();
    const { messages, sessionId: clientSessionId, isApproval: clientIsApproval } = requestBody;

    console.log('\n💬 Received messages:', messages);

    // Use client-provided session ID if available, otherwise generate one
    const sessionId = clientSessionId || generateSessionId(messages);
    console.log('📋 Session ID:', sessionId);
    console.log('📋 Client provided sessionId:', clientSessionId);
    console.log('📋 Pending plans:', Array.from(pendingPlans.keys()));

    // Check if user is approving a pending plan
    const userMessage = [...messages].reverse().find((msg: Message) => msg.role === 'user');
    const userInput = userMessage?.content?.trim().toLowerCase() || '';
    const isApproval = clientIsApproval === true || /^(approve|yes|proceed|ok|confirm|go ahead)$/i.test(userInput);
    
    console.log('🔍 User input:', userInput);
    console.log('🔍 Is approval:', isApproval);
    console.log('🔍 Has pending plan:', pendingPlans.has(sessionId));
    
    if (isApproval && pendingPlans.has(sessionId)) {
      console.log('✅ User approved pending plan, proceeding with execution...');
      
      const pendingData = pendingPlans.get(sessionId)!;
      pendingPlans.delete(sessionId); // Remove from pending
      
      const apiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
      if (!apiKey) {
        return NextResponse.json(
          { error: 'OpenAI API key not configured' },
          { status: 500 }
        );
      }

      // Execute the approved plan
      if (pendingData.plan.execution_plan && pendingData.plan.execution_plan.length > 0) {
        console.log('▶️ Executing approved plan...');
        
        const result = await executeIterativePlanner(
          pendingData.refinedQuery,
          pendingData.topKResults,
          pendingData.planResponse,
          apiKey,
          userToken,
          pendingData.finalDeliverable,
          usefulData,
          pendingData.conversationContext,
          pendingData.entities,
          requestContext
        );

        // Sanitize and return result
        const sanitizeForResponse = (obj: any): any => {
          const seen = new WeakSet();
          return JSON.parse(JSON.stringify(obj, (key, value) => {
            if (typeof value === 'object' && value !== null) {
              if (seen.has(value)) return '[Circular]';
              seen.add(value);
              if (key === 'request' || key === 'socket' || key === 'agent' || key === 'res') return '[Omitted]';
              if (key === 'config') return { method: value.method, url: value.url, data: value.data };
              if (key === 'headers' && value.constructor?.name === 'AxiosHeaders') {
                return Object.fromEntries(Object.entries(value));
              }
            }
            return value;
          }));
        };

        if (result.error) {
          return NextResponse.json({
            message: result.clarification_question || result.error,
            error: result.error,
            reason: result.reason,
            refinedQuery: pendingData.refinedQuery,
            topKResults: pendingData.topKResults,
            executedSteps: sanitizeForResponse(result.executedSteps || []),
            accumulatedResults: sanitizeForResponse(result.accumulatedResults || []),
          });
        }

        return NextResponse.json({
          message: result.message,
          refinedQuery: pendingData.refinedQuery,
          topKResults: pendingData.topKResults,
          executedSteps: sanitizeForResponse(result.executedSteps),
          accumulatedResults: sanitizeForResponse(result.accumulatedResults),
          iterations: result.iterations,
        });
      }
    }

    // Check if user is rejecting a pending plan
    const isRejection = userMessage && pendingPlans.has(sessionId) && !isApproval;
    if (isRejection) {
      console.log('❌ User rejected plan, clearing pending plan...');
      pendingPlans.delete(sessionId);
      
      // Return a message asking for modifications
      return NextResponse.json({
        message: 'Plan rejected. Please tell me what you would like to change, or ask a new question.',
        planRejected: true,
      });
    }

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: 'Invalid messages format' },
        { status: 400 }
      );
    }

    const apiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'OpenAI API key not configured' },
        { status: 500 }
      );
    }

    // userMessage already extracted above for approval check
    if (!userMessage) {
      return NextResponse.json(
        { error: 'No user message found' },
        { status: 400 }
      );
    }

    // Summarize conversation history for context (if messages > 10)
    const summarizedMessages = await summarizeMessages(messages, apiKey);

    // Build conversation context for query refinement
    let conversationContext = '';
    if (summarizedMessages.length > 1) {
      // Include previous messages for context (exclude the latest user message)
      const previousMessages = summarizedMessages.slice(0, -1);
      conversationContext = previousMessages
        .map(msg => `${msg.role}: ${msg.content}`)
        .join('\n');
    }

    // Clarify and refine user input WITH conversation context
    const queryWithContext = conversationContext
      ? `Previous context:\n${conversationContext}\n\nCurrent query: ${userMessage.content}`
      : userMessage.content;

    const { refinedQuery, language, concepts, apiNeeds, entities, intentType, referenceTask } = await clarifyAndRefineUserInput(queryWithContext, apiKey);
    // 设置原始finalDeliverable为refinedQuery，保证不被中间依赖覆盖
    if (!finalDeliverable) finalDeliverable = refinedQuery;
    console.log('\n📝 QUERY REFINEMENT RESULTS:');
    console.log('  Original:', userMessage.content);
    console.log('  Refined Query:', refinedQuery);
    console.log('  Language:', language);
    console.log('  Concepts:', concepts);
    console.log('  API Needs:', apiNeeds);
    console.log('  Extracted Entities:', entities);
    console.log('  Entity Count:', entities.length);

    // Handle concepts and API needs
    const { requiredApis, skippedApis } = handleQueryConceptsAndNeeds(concepts, apiNeeds);
    console.log('Required APIs:', requiredApis);
    console.log('Skipped APIs:', skippedApis);

    // Multi-entity RAG: Generate embeddings for each entity and combine results
    console.log(`\n🔍 Performing multi-entity RAG search for ${entities.length} entities`);


    // 获取所有实体的匹配API（embedding检索+过滤）
    const allMatchedApis = await getAllMatchedApis({ entities, intentType, apiKey, context: requestContext });

    // Convert Map to array and sort by similarity
    let topKResults = await getTopKResults(allMatchedApis, 20);

    // Serialize useful data in chronological order (earliest first)
    const str = serializeUsefulDataInOrder(requestContext);

    // 调用独立planner函数 (Phase 1: Always with APIs first)
    const planningStart = Date.now();
    let actionablePlan;
    let plannerRawResponse;

    try {
      const plannerResult = await runPlannerWithInputs({
        topKResults,
        refinedQuery,
        apiKey,
        usefulData: str,
        conversationContext,
        finalDeliverable,
        intentType,
        entities,
        requestContext,
        referenceTask
      });
      actionablePlan = plannerResult.actionablePlan;
      plannerRawResponse = plannerResult.planResponse;
    } catch (err: any) {
      console.error('❌ Error during planning phase:', err);
      
      // Handle "No tables selected for SQL generation" error
      if (err.message && err.message.includes('No tables selected for SQL generation')) {
        const reason = err.cause || 'No relevant tables found for this query';
        console.log('📝 Generating LLM response for no tables selected error:', reason);
        
        // Generate a human-friendly response via LLM
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: `You are a helpful assistant. The user asked a question, but the database doesn't have the necessary information to answer it. Politely explain why the database cannot fulfill their request.`
              },
              {
                role: 'user',
                content: `User's question: "${refinedQuery}"
                
The database schema analysis shows: "${reason}"

Please provide a friendly explanation of why this question cannot be answered with the current database.`
              }
            ],
            temperature: 0.7,
            max_tokens: 512,
          }),
        });
        
        if (response.ok) {
          const data = await response.json();
          const llmMessage = data.choices[0]?.message?.content || reason;
          return {
            actionablePlan: {
              impossible: true,
              needs_clarification: false,
              message: llmMessage,
              reason: reason,
              execution_plan: []
            },
            planResponse: JSON.stringify({
              impossible: true,
              needs_clarification: false,
              message: llmMessage,
              reason: reason,
              execution_plan: []
            })
          };
        } else {
          // Fallback if LLM call fails
          return {
            actionablePlan: {
              impossible: true,
              needs_clarification: false,
              message: reason,
              reason: reason,
              execution_plan: []
            },
            planResponse: JSON.stringify({
              impossible: true,
              needs_clarification: false,
              message: reason,
              reason: reason,
              execution_plan: []
            })
          };
        }
      }
      
      throw err;
    }

    const planningDurationMs = Date.now() - planningStart;
    console.log(`⏱️ Planning duration (initial): ${planningDurationMs}ms intent=${intentType} refined="${refinedQuery}"`);

    if (actionablePlan?.impossible) {
      console.log('🚫 Returning impossible response from planner (no relevant DB resources).');
      return NextResponse.json({
        message: actionablePlan.message,
        refinedQuery,
        final: true,
        reason: actionablePlan.reason || 'No relevant database resources found'
      });
    }

    // Phase 2: Detect if this is a resolution query
    const queryIntent = await detectResolutionVsExecution(refinedQuery, actionablePlan, apiKey);

    if (queryIntent === 'resolution') {
      console.log('🔄 Resolution query detected! Switching to table-only mode and re-planning...');

      // Re-fetch using only tables (filter out API results)
      const tableOnlyResults = topKResults.filter((item: any) =>
        item.id && typeof item.id === 'string' && (item.id.startsWith('table-') || item.id === 'sql-query')
      );

      console.log(`📊 Filtered to ${tableOnlyResults.length} table-only results for resolution`);

      // Re-run planner with table-only context
      const replanStart = Date.now();
      const replanResult = await runPlannerWithInputs({
        topKResults: tableOnlyResults,
        refinedQuery,
        apiKey,
        usefulData: str,
        conversationContext,
        finalDeliverable,
        intentType: 'FETCH', // Force FETCH mode for resolution
        entities,
        requestContext,
        referenceTask
      });
      const replanDurationMs = Date.now() - replanStart;

      actionablePlan = replanResult.actionablePlan;
      plannerRawResponse = replanResult.planResponse;

      if (actionablePlan?.impossible) {
        console.log('🚫 Replanned in table-only mode and still impossible (no relevant DB resources).');
        return NextResponse.json({
          message: actionablePlan.message,
          refinedQuery,
          final: true,
          reason: actionablePlan.reason || 'No relevant database resources found'
        });
      }

      console.log(`⏱️ Planning duration (replan resolution): ${replanDurationMs}ms refined="${refinedQuery}"`);
      console.log('✅ Re-planned with table-only context for resolution');
    } else {
      console.log('⚡ Execution query detected! Proceeding with API-based plan');
    }

    // 保留原始finalDeliverable，不被plan覆盖
    // finalDeliverable = actionablePlan.final_deliverable || finalDeliverable;
    const planResponse = plannerRawResponse;
    console.log('Generated Plan:', planResponse);

    // Note: Validation for multi-step dependencies is now handled in the sendToPlanner loop
    // via placeholder detection, which is more robust and handles step dependencies correctly

    // Handle clarification requests
    if (actionablePlan.needs_clarification) {
      return NextResponse.json({
        message: actionablePlan.clarification_question,
        refinedQuery,
        topKResults,
      });
    }

    // Execute the plan iteratively if execution_plan exists
    if (actionablePlan.execution_plan && actionablePlan.execution_plan.length > 0) {
      // All plans require user approval before execution
      console.log('📋 Plan generated, storing for user approval...');
      
      pendingPlans.set(sessionId, {
        plan: actionablePlan,
        planResponse,
        refinedQuery,
        topKResults,
        conversationContext,
        finalDeliverable,
        entities,
        intentType,
        timestamp: Date.now(),
        referenceTask
      });

      // Format plan for user review
      const planSummary = {
        goal: refinedQuery,
        phase: actionablePlan.phase,
        steps: actionablePlan.execution_plan.map((step: any) => ({
          step_number: step.step_number,
          description: step.description,
          api: `${step.api.method.toUpperCase()} ${step.api.path}`,
          parameters: step.api.parameters || {},
          requestBody: step.api.requestBody || {}
        })),
        selected_apis: actionablePlan.selected_tools_spec || []
      };

      console.log('📤 Returning plan for user approval.');

      // Create a human-readable summary for business operators
      const entityNameForSummary = detectEntityName(refinedQuery) || 'the item you mentioned';
      const humanReadableSteps = actionablePlan.execution_plan.map((step: any, index: number) => {
        // Extract meaningful description from step
        const stepDesc = step.description || `Execute step ${step.step_number}`;
        const apiPath = step.api.path || '';
        const apiMethod = step.api.method?.toUpperCase() || 'API CALL';
        
        // Create a simple business-friendly explanation using refined intent context
        let businessExplanation = stepDesc;
        
        if (apiPath.includes('watchlist')) {
          if (apiMethod === 'DELETE') businessExplanation = `Remove ${entityNameForSummary} from your watchlist`;
          else if (apiMethod === 'POST') businessExplanation = `Add ${entityNameForSummary} to your watchlist`;
          else if (apiMethod === 'GET') businessExplanation = 'See your watchlist';
        } else if (apiPath.includes('teams')) {
          if (apiMethod === 'DELETE') businessExplanation = `Delete the team for ${entityNameForSummary}`;
          else if (apiMethod === 'POST') businessExplanation = `Create or update a team involving ${entityNameForSummary}`;
          else if (apiMethod === 'GET') businessExplanation = 'Get team details';
        } else if (apiPath.includes('/general/sql/query')) {
          // SQL queries: make it intent-aware and natural
          businessExplanation = `Look up information about ${entityNameForSummary}`;
        } else if (apiPath.includes('search') || apiPath.includes('/pokemon/')) {
          businessExplanation = `Search details for ${entityNameForSummary}`;
        }
        
        return `**Step ${index + 1}:** ${businessExplanation}\n   *(Technical: ${apiMethod} ${apiPath})*`;
      }).join('\n\n');

      const humanReadableMessage = `## 📋 Execution Plan

    **Reference Task Used:** ${actionablePlan._from_reference_task ? 'Yes (reused saved plan)' : 'No (new plan)'}

${actionablePlan._replanned ? `
## ⚠️ Plan Updated

**Why the plan was regenerated:**
${actionablePlan._replan_reason}

**What changed:**
The plan now includes complete execution steps with both lookup and modification operations to fulfill your request.

---

` : ''}**What You're About To Do:**
${refinedQuery}

**Action Breakdown:**
${humanReadableSteps}

**Phase:** ${actionablePlan.phase.charAt(0).toUpperCase() + actionablePlan.phase.slice(1)} (${actionablePlan.phase === 'resolution' ? 'checking current state' : 'performing changes'})

---

## ✅ Next Steps
**Please review the plan above:**
- Reply with **"approve"** to proceed with the execution
- Reply with **"no"** or **"reject"** to cancel
- Or provide **specific feedback** if you'd like any adjustments

**Technical Details:**
${actionablePlan.execution_plan.map((step: any) => `
**Step ${step.step_number}:** ${step.description}
\`\`\`
${step.api.method.toUpperCase()} ${step.api.path}
\`\`\`
${step.api.parameters && Object.keys(step.api.parameters).length > 0 ? `Parameters: \`\`\`json\n${JSON.stringify(step.api.parameters, null, 2)}\n\`\`\`` : ''}
${step.api.requestBody && Object.keys(step.api.requestBody).length > 0 ? `Body: \`\`\`json\n${JSON.stringify(step.api.requestBody, null, 2)}\n\`\`\`` : ''}
`).join('\n')}`;

      return NextResponse.json({
        message: humanReadableMessage,
        planSummary,
        awaitingApproval: true,
        refinedQuery,
        sessionId,
        planningDurationMs,
        usedReferencePlan: actionablePlan._from_reference_task || false
      });
    }

    // 如果plan为GOAL_COMPLETED或无execution_plan，自动进入final answer生成
    if (
      actionablePlan &&
      (actionablePlan.message?.toLowerCase().includes('goal completed') ||
        (Array.isArray(actionablePlan.execution_plan) && actionablePlan.execution_plan.length === 0))
    ) {
      // 直接用usefulData和accumulatedResults生成最终答案
      const answer = await generateFinalAnswer(
        refinedQuery,
        [],
        apiKey,
        undefined,
        str // usefulData
      );
      return NextResponse.json({
        message: answer,
        refinedQuery,
        topKResults,
        planResponse,
        final: true,
        planningDurationMs,
        usedReferencePlan: actionablePlan._from_reference_task || false
      });
    }
    // 否则返回plan does not include an execution plan
    return NextResponse.json({
      message: 'Plan does not include an execution plan.',
      refinedQuery,
      topKResults,
      planResponse,
      planningDurationMs,
      usedReferencePlan: actionablePlan._from_reference_task || false
    });
  } catch (error: any) {
    console.warn('Error in chat API:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// Validator function to check if more actions are needed
async function validateNeedMoreActions(
  originalQuery: string,
  executedSteps: any[],
  accumulatedResults: any[],
  apiKey: string,
  lastExecutionPlan?: any
): Promise<{ 
  needsMoreActions: boolean,
  reason: string, 
  missing_requirements?: string[],
  suggested_next_action?: string,
  useful_data?: string 
  item_not_found?: boolean
}> {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are the VALIDATOR.

Your ONLY responsibility is to determine whether
the ORIGINAL USER GOAL has been fully satisfied.

You do NOT care whether:
- an API call succeeded
- a step executed without error
- the current execution plan has no remaining steps

You ONLY care about:
→ whether the user's original intent is fulfilled in the current world state.

────────────────────────────────────────
CORE PRINCIPLE (NON-NEGOTIABLE)
────────────────────────────────────────

A successful API call ≠ task completion.

An empty execution plan ≠ task completion.

Only the satisfaction of the ORIGINAL USER GOAL
determines completion.

────────────────────────────────────────
INPUTS YOU WILL RECEIVE
────────────────────────────────────────

You are given:

1. original_user_query (immutable)
2. canonical_user_goal (normalized form, if available)
3. execution_history (all executed API calls + responses)
4. world_state (accumulated facts inferred from execution)
5. last_execution_plan (may be incomplete or incorrect)

You MUST evaluate completion ONLY against (1) or (2).

────────────────────────────────────────
ABSOLUTE RULES
────────────────────────────────────────

1. You MUST NOT infer or invent a new goal.
2. You MUST NOT replace the user goal with a planner step description.
3. You MUST NOT assume the planner plan was complete or correct.
4. You MUST NOT conclude completion solely because:
   - an API returned success
   - data was retrieved
   - no remaining steps exist

If the user goal implies a state change,
you MUST verify that the state change has occurred.

────────────────────────────────────────
GOAL SATISFACTION CHECK (MANDATORY)
────────────────────────────────────────

You MUST answer the following questions IN ORDER:

1. What is the user's original intent?
2. What observable state change or final answer would satisfy it?
3. Does the current world_state conclusively show that state?

If the answer to (3) is NO or UNCERTAIN:
→ the task is NOT complete.

Uncertainty MUST be treated as NOT COMPLETE.

────────────────────────────────────────
COMMON GOAL PATTERNS (GUIDELINES)
────────────────────────────────────────

A) Information retrieval goals
   (e.g. "Which Pokémon has the highest Attack?")
   → Completion requires:
     - a final answer derived from data
     - not just raw data retrieval

B) State-changing goals
   (e.g. "Add Aggron to my watchlist")
   → Completion requires:
     - confirmation that the state changed
     - e.g. POST success AND/OR watchlist contains the ID

C) Multi-step goals
   → Completion requires:
     - ALL required sub-actions completed
     - Partial progress is NOT sufficient

────────────────────────────────────────
CRITICAL: NO RESULTS / NOT FOUND DETECTION
────────────────────────────────────────

If a search/query API call returns:
- Empty array/list (length = 0)
- null result
- "not found" message
- 404 status code
- Error indicating item doesn't exist

AND the user is searching for a specific item by name/identifier:

FIRST, check if there is ANY related data in Accumulated Results:
- If related data exists (e.g., moves for "zygarde" when searching "zygarde-mega")
- If useful information was found with similar identifiers
- If the conversation context referenced a variant that exists

→ DO NOT trigger "item_not_found"
→ USE the related/variant data that was found
→ Conclude: needsMoreActions = false (but with reason explaining the variant was used)

ONLY IF no related data exists at all:
→ The item DOES NOT EXIST in the system
→ DO NOT request more searches with different variations
→ DO NOT say "try a different search endpoint"
→ Conclude: needsMoreActions = false
→ Reason: "The requested item '[name]' was not found in the system after searching"
→ Set "item_not_found": true

Example 1 (related data exists):
- User asks about "Zygarde-Mega strongest move"
- Search for "zygarde-mega" returns empty
- BUT search for "zygarde" returned moves
→ needsMoreActions = false (use zygarde data, NOT item_not_found)
→ Reason: "Found moves for Zygarde (the requested Pokémon variant doesn't have a separate entry)"

Example 2 (no related data):
- User: "Find Pikachu2000"
- API response: [] (empty array) or {result: null}
- No data found for any variant
→ needsMoreActions = false, item_not_found = true

HOWEVER, if the empty result is due to filters/conditions (not a direct search):
- Continue if there are other valid approaches
- Only stop if ALL reasonable search methods have been exhausted

────────────────────────────────────────
FORBIDDEN HEURISTICS
────────────────────────────────────────

❌ "The API call succeeded, so we're done"
❌ "There are no remaining steps"
❌ "The planner didn't include more actions"
❌ "The data exists, so the goal must be satisfied"
❌ "Keep searching with different variations" (when item clearly doesn't exist)

────────────────────────────────────────
CRITICAL: COUNT DERIVATION RULE
────────────────────────────────────────

If the goal asks for "count", "how many", "number of", etc.,
and an API endpoint returns a full list/array:

→ Counts MUST be derived by array.length
→ DO NOT request a dedicated count endpoint
→ DO NOT say "we need a count API"

Example:
- Goal: "How many members in each team?"
- Available: GET /teams/{id}/members returns array
→ Count = members.length (NO separate count API needed)

If the last execution plan included fetching lists for multiple IDs
(e.g., for_each team, get members), check coverage:
- Did we fetch ALL required IDs?
- Or are there missing IDs that still need fetching?

────────────────────────────────────────
OUTPUT FORMAT (JSON ONLY)
────────────────────────────────────────

If the goal IS satisfied:

{
  "needsMoreActions": false,
  "reason": "Clear explanation of how the original user goal has been fully satisfied based on world state"
}

If the goal is NOT satisfied:

{
  "needsMoreActions": true,
  "reason": "What part of the original user goal is still unmet",
  "missing_requirements": [
    "Explicit unmet condition 1",
    "Explicit unmet condition 2"
  ],
  "suggested_next_action": "High-level description of what must happen next (NOT a full plan)"
}

If the requested item/entity DOES NOT EXIST (after search returned empty/null/404):

{
  "needsMoreActions": false,
  "reason": "The requested item '[name]' does not exist in the system. Search returned no results.",
  "item_not_found": true
}

────────────────────────────────────────
FINAL OVERRIDE RULE
────────────────────────────────────────

If you are unsure whether the user goal has been met,
you MUST respond with needsMoreActions = true.

False negatives are acceptable.
False positives are NOT.`,
          },
          {
            role: 'user',
            content: `Original Query: ${originalQuery}

Last Execution Plan: ${lastExecutionPlan ? JSON.stringify(lastExecutionPlan.execution_plan || lastExecutionPlan, null, 2) : 'No plan available'}

${lastExecutionPlan?.selected_tools_spec ? `
Available Tools (used in plan):
${JSON.stringify(lastExecutionPlan.selected_tools_spec, null, 2)}

These tools show what capabilities are available. If a tool returns an array,
counts can be derived via array.length. DO NOT request count endpoints.
` : ''}

Executed Steps (with responses): ${JSON.stringify(executedSteps, null, 2)}

Accumulated Results: ${JSON.stringify(accumulatedResults, null, 2)}

IMPORTANT:
1. Check if the last execution plan had multiple steps (e.g., fetching data for multiple IDs)
2. Verify if ALL required IDs/entities have been fetched
3. Review the "Available Tools" to see what derivations are possible (e.g., counts from array.length)
4. Only request more actions if there are genuinely missing IDs or the goal is incomplete
5. DO NOT request count/aggregation endpoints if arrays are already available

Can we answer the original query with the information we have? Or do we need more API calls?`,
          },
        ],
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      console.error('Validator API request failed:', await response.text());
      return { needsMoreActions: false, reason: 'Validation failed, proceeding with available data' };
    }

    const data = await response.json();
    console.log('Validator Response 1:', data);
    const content = data.choices[0]?.message?.content || '';

    // Sanitize and parse the response
    const sanitized = content.replace(/```json|```/g, '').trim();
    const jsonMatch = sanitized.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      // TODO: The validator needs to extract the needed information from the 
      // API responses if any. So that it can be re-used in later re-run of 
      // the planner/executor
      console.log('Validator Decision:', result);
      return result;
    }

    return { needsMoreActions: false, reason: 'Unable to parse validator response' };
  } catch (error) {
    console.error('Error in validator:', error);
    return { needsMoreActions: false, reason: 'Validator error, proceeding with available data' };
  }
}

async function extractUsefulDataFromApiResponses(
  refinedQuery: string,
  finalDeliverable: string,
  existingUsefulData: string,
  apiResponse: string,
  apiSchema?: any,
  availableApis?: any[]
): Promise<string> {
  try {
    // Build context about the API schema and available APIs
    let schemaContext = '';
    if (apiSchema) {
      schemaContext = `\n\nAPI Schema Context (endpoint that was just called):
Path: ${apiSchema.path}
Method: ${apiSchema.method}
Request Body: ${JSON.stringify(apiSchema.requestBody || {}, null, 2)}
Parameters: ${JSON.stringify(apiSchema.parameters || {}, null, 2)}`;
    }

    let availableApisContext = '';
    if (availableApis && availableApis.length > 0) {
      // Extract key information from available APIs to help understand data dependencies
      const apiSummaries = availableApis.slice(0, 10).map((api: any) => {
        try {
          // Parse the API content to extract parameter information
          const content = typeof api.content === 'string' ? api.content : JSON.stringify(api.content);
          return `- ${api.id}: ${api.summary || 'No summary'}\n  ${content.slice(0, 200)}...`;
        } catch {
          return `- ${api.id}: ${api.summary || 'No summary'}`;
        }
      }).join('\n');

      availableApisContext = `\n\nAvailable APIs (for understanding data dependencies):
${apiSummaries}

CRITICAL: Check if any downstream APIs might need fields from the current response.
For example, if a "delete watchlist" API requires "pokemon_id", then pokemon_id must be preserved from the "get watchlist" response.`;
    }

    const prompt = `You are an expert at extracting useful information from API responses to help answer user queries.

Given the original user query, the refined query, and the final deliverable generated so far,
extract any useful data points, facts, or details from the API responses that could aid in answering the user's question.

CRITICAL RULES:
1. If the new API response contains UPDATED or MORE ACCURATE information, REPLACE the old data
2. Only keep UNIQUE and NON-REDUNDANT information
3. Remove any duplicate or outdated facts
4. Keep the output CONCISE but COMPLETE - include ALL fields that might be needed for downstream operations
5. If it contains things like ID, deleted, or other important data, make sure to include those

FIELD PRESERVATION RULES (CRITICAL):
- ALWAYS preserve ALL ID fields (id, pokemon_id, user_id, team_id, etc.) - these are often required for subsequent API calls
- ALWAYS preserve foreign key relationships (e.g., if an item has both "id" and "pokemon_id", keep BOTH)
- ALWAYS preserve status fields (deleted, active, success, etc.)
- ALWAYS preserve timestamps (created_at, updated_at, etc.) if they might be relevant
- When in doubt, KEEP the field rather than removing it
- Check the available APIs context to see if any downstream operations might need specific fields

FACTUAL REPORTING ONLY:
- Report ONLY what the API response explicitly states (e.g., "3 items were deleted", "ID 123 was created")
- DO NOT infer or state goal completion (e.g., NEVER say "watchlist has been cleared", "task completed", "goal achieved")
- DO NOT interpret the action's success in terms of user goals
- State facts like: "deletedCount: 3", "success: true", "ID: 456", "pokemon_id: 789"
- Let the validator and final answer generator determine if the goal is met

FORMAT:
Structure the extracted data to preserve relationships. For list responses, maintain the structure:
- If response contains an array of objects, preserve key fields from each object
- For single objects, preserve all important fields
- Use clear labels to indicate what each piece of data represents

If no new useful data is found, return the existing useful data as is.

Refined User Query: ${refinedQuery}
Final Deliverable: ${finalDeliverable}
Existing Useful Data: ${existingUsefulData}
API Response: ${apiResponse}${schemaContext}${availableApisContext}

Extracted Useful Data: `;

/*
🚀 Planner 自主工作流程启动
📌 忽略传入的 apis 参数，使用自主 RAG 检索
usefulData:  {
  "post /general/sql/query::{\"_body\":{\"query\":SELECT id, pokemon_id FROM UserPokemonWatchlist WHERE user_id = CURRENT_USER_ID AND deleted = FALSE ORDER BY created_at DESC;}}": "API Response: {\"success\":true,\"deletedCount\":3}\n\nExtracted Useful Data:\n- The watchlist has been successfully cleared.\n- A total of 3 items were deleted from the watchlist."
}
📊 Step 0: 验证目标完成情况...
✅ 目标完成验证响应: GOAL_COMPLETED
🎯 目标已完成，返回结果
*/

    const apiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: prompt,
          },
        ],
        temperature: 0.5,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      console.error('Useful data extraction API request failed:', await response.text());
      return existingUsefulData;
    }

    const data = await response.json();
    const extractedData = data.choices[0]?.message?.content?.trim() || existingUsefulData;
    return extractedData;
  } catch (error) {
    console.error('Error extracting useful data:', error);
    return existingUsefulData;
  }
}

// Generate final answer based on accumulated information
async function generateFinalAnswer(
  originalQuery: string,
  accumulatedResults: any[],
  apiKey: string,
  stoppedReason?: string,
  usefulData?: string
): Promise<string> {
  try {
    let systemPrompt = `You are a helpful assistant that synthesizes information from API responses to answer user questions.
Provide a clear, concise, and well-formatted answer based on the accumulated data.
Use the actual data from the API responses to provide specific, accurate information.`;

    let additionalContext = '';

    if (stoppedReason === 'max_iterations') {
      // additionalContext = `\n\nNOTE: The system reached its maximum iteration limit. If the data is incomplete, acknowledge what information is available and what is missing.`;
      return `Sorry, I was unable to gather enough information to provide a complete answer within the allowed steps.`;
    } else if (stoppedReason === 'stuck_state') {
      // additionalContext = `\n\nNOTE: The system detected that the required information may not be available through the current APIs. Provide the best answer possible with available data and acknowledge any limitations.`;
      return `It seems that the information you're looking for may not be available through the current APIs. If you have more specific details or another question, feel free to ask!`;
    } else if (stoppedReason === 'item_not_found') {
      // Check accumulated results for what was searched
      let searchedItem = '';
      try {
        for (const result of accumulatedResults) {
          if (result.response && (
            Array.isArray(result.response) && result.response.length === 0 ||
            result.response.result === null ||
            result.response.results?.length === 0 ||
            result.response.message?.toLowerCase().includes('not found')
          )) {
            // Try to extract what was being searched from the step
            const step = result.step || result.description || '';
            searchedItem = step.toString();
            break;
          }
        }
      } catch (e) {
        console.warn('Could not extract searched item:', e);
      }
      
      return `I couldn't find the item you're looking for${searchedItem ? ` (${searchedItem})` : ''} in the system. The search returned no results. Please check the spelling or try a different search term.`;
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: systemPrompt + additionalContext,
          },
          {
            role: 'user',
            content: `Original Question: ${originalQuery}

API Response Data:
${
  JSON.stringify(accumulatedResults, (key, value) => {
    // Custom replacer to handle large arrays without truncation
    if (Array.isArray(value) && value.length > 0) {
      // Return the full array, not truncated
      return value;
    }
    return value;
  }, 2) + 
  (usefulData || '')
}

IMPORTANT: The data above includes complete arrays. Pay careful attention to:
- Learning methods for moves (level-up, tutor, machine, egg, etc.)
- Type information for moves
- Power values for moves
- Any other detailed attributes

Only state facts that are explicitly present in the data. Do not make assumptions about learning methods or other attributes.`,
          },
        ],
        temperature: 0.7,
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      console.error('Answer generation API request failed:', await response.text());
      return 'Unable to generate answer from the gathered information.';
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || 'Unable to generate answer.';
  } catch (error) {
    console.error('Error generating final answer:', error);
    return 'Error generating answer from the gathered information.';
  }
}

// Improved iterative planner execution
async function executeIterativePlanner(
  refinedQuery: string,
  matchedApis: any[],
  initialPlanResponse: string,
  apiKey: string,
  userToken: string,
  finalDeliverable: string,
  usefulData: Map<string, any>,
  conversationContext: string,
  entities: any[] = [],
  requestContext: RequestContext,
  maxIterations: number = 50,
  referenceTask?: SavedTask | null
): Promise<any> {
  let currentPlanResponse = initialPlanResponse;
  let accumulatedResults: any[] = [];
  let executedSteps: any[] = [];
  let iteration = 0; // Track total API calls made
  let planIteration = 0; // Track planning cycles
  let intentType: 'FETCH' | 'MODIFY' = matchedApis[0]?.id.startsWith('semantic') ? 'FETCH' : 'MODIFY';
  let stuckCount = 0; // Track how many times we get the same validation reason
  let stoppedReason = '';

  const referenceTaskContext = referenceTask
    ? `\n\nReference task (reuse if similar):\n${JSON.stringify({ id: referenceTask.id, taskName: referenceTask.taskName, taskType: referenceTask.taskType, steps: referenceTask.steps }, null, 2)}\nPrefer adapting this task's steps if it aligns with the current goal.`
    : '';
  const conversationContextWithReference = referenceTaskContext ? `${conversationContext}${referenceTaskContext}` : conversationContext;

  if (referenceTask) {
    console.log(`🧭 Iterative executor using reference task ${referenceTask.id} (${referenceTask.taskName}) for replanning context.`);
  } else {
    console.log('🧭 Iterative executor running without reference task.');
  }

  console.log('\n' + '='.repeat(80));
  console.log('🔄 STARTING ITERATIVE PLANNER');
  console.log(`Max API calls allowed: ${maxIterations}`);
  console.log('='.repeat(80));

  // Sanitize and parse the current plan response
  let sanitizedPlanResponse = currentPlanResponse;
  console.log('sanitizedPlanResponse: ', sanitizedPlanResponse);
  let actionablePlan = JSON.parse(sanitizedPlanResponse);

  while (planIteration < 20) { // Max 20 planning cycles (separate from API call limit)
    planIteration++;
    console.log(`\n--- Planning Cycle ${planIteration} (API calls made: ${iteration}/${maxIterations}) ---`);

    try {

      console.log('Current Actionable Plan:', JSON.stringify(actionablePlan, null, 2));

      // Check if the plan requires clarification
      if (actionablePlan.needs_clarification) {
        console.warn('Planner requires clarification:', actionablePlan.reason);
        return {
          error: 'Clarification needed',
          clarification_question: actionablePlan.clarification_question,
          reason: actionablePlan.reason,
        };
      }

      // Check if there are no more steps to execute
      if (!actionablePlan.execution_plan || actionablePlan.execution_plan.length === 0) {
        console.log('No more steps in execution plan');
        break;
      }

      // Store progress before executing steps (for stuck detection)
      const progressBeforeExecution = accumulatedResults.length;

      // CRITICAL: Execute ALL steps in the current plan before validating
      // This prevents premature validation and ensures complete plan execution
      console.log(`\n📋 Executing complete plan with ${actionablePlan.execution_plan.length} steps`);
      console.log(`📌 Execution mode: ${intentType === 'MODIFY' ? 'MODIFY (execute all, validate once at end)' : 'FETCH (execute and validate)'}`);

      // Track if any API call resulted in an error for MODIFY flows
      let hasApiError = false;

      while (actionablePlan.execution_plan?.length > 0) {
        const step = actionablePlan.execution_plan.shift(); // Remove first step
        console.log(`\nExecuting step ${step.step_number || executedSteps.length + 1}:`, JSON.stringify(step, null, 2));

        // OPTIMIZATION: If from reference task and encountering MODIFY step, pause for approval
        if (actionablePlan._from_reference_task && referenceTask) {
          // Check stepType field (1=FETCH, 2=MODIFY) from reference task
          const isModifyStep = step.stepType === 2;
          const stepMethod = step.api?.method?.toLowerCase();
          const isModifyByMethod = ['post', 'put', 'patch', 'delete'].includes(stepMethod);
          
          if (isModifyStep || isModifyByMethod) {
            console.log(`\n⏸️  MODIFY step detected in reference task flow. Pausing for user approval.`);
            console.log(`   Step ${step.step_number}: ${step.description}`);
            console.log(`   API: ${step.api.method.toUpperCase()} ${step.api.path}`);
            
            // Return partial results with remaining steps
            return {
              message: `Reference task execution paused before MODIFY action. Review the gathered data and approve to proceed.`,
              reason: 'modify_step_reached',
              executedSteps,
              accumulatedResults,
              remainingPlan: {
                steps: [step, ...actionablePlan.execution_plan],
                description: 'Remaining steps to execute after user approval'
              },
              iterations: iteration,
            };
          }
        }

        // Check if this is a valid API call step (not a computation step)
        if (step.api && step.api.path && step.api.method) {
          // CRITICAL: Check if this step needs to be executed multiple times
          // This happens when:
          // 1. Step depends on a previous step
          // 2. Previous step returned multiple results
          // 3. Current step has path parameters (like {id})
          let stepsToExecute = [step];

          if ((step.depends_on_step || step.dependsOnStep) && accumulatedResults.length > 0) {
            const dependsOnStepNum = step.depends_on_step || step.dependsOnStep;
            const previousStepResult = accumulatedResults.find(r => r.step === dependsOnStepNum);

            if (previousStepResult && previousStepResult.response) {
              const results = previousStepResult.response.result?.results || previousStepResult.response.results;

              // Check if step has path parameters and previous step returned multiple results
              if (Array.isArray(results) && results.length > 1) {
                const pathParamMatches = step.api.path.match(/\{(\w+)\}/g);

                if (pathParamMatches && pathParamMatches.length > 0) {
                  console.log(`\n🔄 Step ${step.step_number} will be executed ${results.length} times (once for each result from step ${dependsOnStepNum})`);

                  // Create a separate step execution for each result
                  stepsToExecute = results.map((result: any, index: number) => {
                    const clonedStep = JSON.parse(JSON.stringify(step));
                    clonedStep._executionIndex = index;
                    clonedStep._sourceData = result;
                    return clonedStep;
                  });
                }
              }
            }
          }

          // Execute each step (could be 1 or multiple)
          for (const stepToExecute of stepsToExecute) {
            // Check iteration limit before each API call
            if (iteration >= maxIterations) {
              console.warn(`⚠️ Reached max iterations (${maxIterations}) during step execution`);
              return {
                error: 'Max iterations reached',
                message: `Sorry, I was unable to complete the task within the allowed ${maxIterations} API calls.`,
                executedSteps,
                accumulatedResults,
                iterations: iteration,
              };
            }
            
            // Increment iteration counter for each API call
            iteration++;
            console.log(`\n📌 Executing API call #${iteration}/${maxIterations} (step ${stepToExecute.step_number})...`);
            // If this step depends on a previous step, populate empty fields with data from that step
            let requestBodyToUse = stepToExecute.api.requestBody;
            let parametersToUse = stepToExecute.api.parameters || stepToExecute.input || {};

            if ((stepToExecute.depends_on_step || stepToExecute.dependsOnStep) && accumulatedResults.length > 0) {
              const dependsOnStepNum = stepToExecute.depends_on_step || stepToExecute.dependsOnStep;
              const previousStepResult = accumulatedResults.find(r => r.step === dependsOnStepNum);

              if (previousStepResult && previousStepResult.response) {
                console.log(`Step ${stepToExecute.step_number} depends on step ${dependsOnStepNum} - populating data from previous results`);

                // Deep clone the requestBody to avoid mutation
                requestBodyToUse = JSON.parse(JSON.stringify(stepToExecute.api.requestBody));

                // If this step is being executed for a specific source data item, use that
                // Otherwise, use all results from the previous step
                let results;
                if (stepToExecute._sourceData) {
                  results = [stepToExecute._sourceData]; // Single item execution
                  console.log(`  Using specific source data for execution index ${stepToExecute._executionIndex}`);
                } else if (previousStepResult.response.result?.results || previousStepResult.response.results) {
                  results = previousStepResult.response.result?.results || previousStepResult.response.results;
                }

                // If the previous step returned a results array, extract IDs
                if (results && Array.isArray(results)) {

                  // Look for empty arrays in requestBody and populate them with IDs
                  if (Array.isArray(results) && results.length > 0) {
                    // Helper function to recursively populate empty arrays
                    const populateEmptyArrays = (obj: any, path: string = '') => {
                      for (const key in obj) {
                        const fullPath = path ? `${path}.${key}` : key;

                        if (Array.isArray(obj[key]) && obj[key].length === 0) {
                          // Determine how many IDs to use based on the field name
                          let numIds = 1; // Default to 1 ID

                          // For team/collection fields, use multiple IDs (typically 3)
                          if (key.toLowerCase().includes('pokemon') && key.toLowerCase().includes('id')) {
                            numIds = 3;
                          }

                          // Extract the appropriate field from results
                          let extractedIds: any[];

                          // For type-related fields, extract type IDs
                          if (key.toLowerCase().includes('type')) {
                            extractedIds = results.slice(0, numIds).map((item: any) =>
                              item.type_id || item.id
                            );
                          } else {
                            // For other ID fields, extract the main ID
                            extractedIds = results.slice(0, numIds).map((item: any) =>
                              item.id || item.pokemon_id
                            );
                          }

                          obj[key] = extractedIds;
                          console.log(`Populated ${fullPath} with: ${JSON.stringify(extractedIds)}`);
                        } else if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
                          // Recursively process nested objects
                          populateEmptyArrays(obj[key], fullPath);
                        }
                      }
                    };

                    // Also handle single ID fields (not arrays)
                    const populateSingleIds = (obj: any, path: string = '') => {
                      for (const key in obj) {
                        const fullPath = path ? `${path}.${key}` : key;

                        // If field is null and key suggests it needs an ID
                        if (obj[key] === null && key.toLowerCase().includes('id')) {
                          obj[key] = results[0]?.id || results[0]?.pokemon_id;
                          console.log(`Populated ${fullPath} with single ID: ${obj[key]}`);
                        } else if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
                          populateSingleIds(obj[key], fullPath);
                        }
                      }
                    };

                    populateEmptyArrays(requestBodyToUse);
                    populateSingleIds(requestBodyToUse);

                    // CRITICAL: Also populate path parameters if the URL contains placeholders like {id}
                    const apiPath = stepToExecute.api.path;
                    const pathParamMatches = apiPath.match(/\{(\w+)\}/g);

                    if (pathParamMatches && pathParamMatches.length > 0) {
                      console.log(`Detected path parameters in URL: ${apiPath}`);
                      console.log(`Path parameter placeholders: ${JSON.stringify(pathParamMatches)}`);

                      // Clone parameters object if it exists, or create new one
                      parametersToUse = { ...(stepToExecute.api.parameters || stepToExecute.input || {}) };

                      // For each placeholder, check if we need to populate it
                      pathParamMatches.forEach((placeholder: string) => {
                        // Extract the parameter name (e.g., "{id}" -> "id")
                        const paramName = placeholder.replace(/[{}]/g, '');

                        // If this parameter is not already set or is empty
                        if (!parametersToUse[paramName] || parametersToUse[paramName] === '') {
                          // Extract the ID from the first result
                          const extractedId = results[0]?.id || results[0]?.pokemon_id || results[0]?.teamId;

                          if (extractedId) {
                            parametersToUse[paramName] = extractedId;
                            console.log(`✅ Auto-populated path parameter {${paramName}} with value: ${extractedId}`);
                          } else {
                            console.warn(`⚠️  Could not extract ID for path parameter {${paramName}} from previous step results`);
                          }
                        } else {
                          console.log(`Path parameter {${paramName}} already has value: ${parametersToUse[paramName]}`);
                        }
                      });
                    }
                  }
                }
              }
            }

            // ⚠️  CRITICAL: Check for placeholder references (resolved_from_step_X) BEFORE executing
            console.log(`\n🔎 Checking for placeholder references in step ${stepToExecute.step_number || executedSteps.length + 1}...`);
            
            // Create a temporary step object to check for placeholders
            const stepToCheck = {
              api: {
                path: stepToExecute.api.path,
                method: stepToExecute.api.method,
                parameters: parametersToUse,
                requestBody: requestBodyToUse,
              }
            };
            
            // Check if step contains any placeholder references
            if (containsPlaceholderReference(stepToCheck)) {
              console.log(`⚠️  Step contains placeholder reference(s), attempting resolution...`);
              
              const resolutionResult = await resolvePlaceholders(stepToCheck, executedSteps, apiKey);
              
              if (!resolutionResult.resolved) {
                console.error(`❌ CRITICAL: Failed to resolve placeholder - ${resolutionResult.reason}`);
                
                // Return error response for re-planning
                return NextResponse.json({
                  error: 'Placeholder resolution failed',
                  reason: resolutionResult.reason,
                  stepNumber: stepToExecute.step_number || executedSteps.length + 1,
                  step: stepToCheck,
                  executedSteps,
                  accumulatedResults,
                  message: `Cannot proceed: ${resolutionResult.reason}. Please review the plan and ensure all referenced steps have been executed.`,
                }, { status: 400 });
              }
              
              // Update the parameters and request body with resolved values
              parametersToUse = stepToCheck.api.parameters;
              requestBodyToUse = stepToCheck.api.requestBody;
              
              console.log(`✅ Placeholders resolved successfully`);
            } else {
              console.log(`✅ No placeholder references detected`);
            }

            // 从 OpenAPI schema 中查找 parameters 定义（用于参数映射）
            const parametersSchema = findApiParameters(stepToExecute.api.path, stepToExecute.api.method);

            // Merge step.input into step.api for path parameter replacement
            let apiSchema = {
              ...stepToExecute.api,
              requestBody: requestBodyToUse,
              // Merge input/parameters into the schema (planner might use either field)
              parameters: parametersToUse,
              // 附加 parametersSchema 用于参数映射
              parametersSchema: parametersSchema,
            };

            // Perform the API call for the current step
            let apiResponse;
            try {
              apiResponse = await dynamicApiRequest(
                process.env.NEXT_PUBLIC_ELASTICDASH_API || '',
                apiSchema,
                userToken // Pass user token for authentication
              );
            } catch (err: any) {
              // CRITICAL: Treat errors differently based on intent type
              console.warn(`⚠️  API call encountered an error (statusCode: ${err.statusCode}):`, err.message);
              
              // For MODIFY flows: Stop execution immediately on HTTP errors (403, 404, etc.)
              if (intentType === 'MODIFY' && err.statusCode && [400, 403, 404, 409, 422, 500].includes(err.statusCode)) {
                console.error(`❌ MODIFY flow encountered critical error (${err.statusCode}): ${err.message}`);
                hasApiError = true;
                
                // Stop executing remaining steps and return early for re-planning
                actionablePlan.execution_plan = []; // Clear remaining steps to exit loop
                
                // Construct error response for re-planning
                apiResponse = {
                  success: false,
                  error: true,
                  statusCode: err.statusCode,
                  message: err.message || 'API request failed',
                  details: err.response || err.data || null,
                  _originalError: {
                    name: err.name,
                    message: err.message,
                  }
                };
                
                // Store the failed step's response
                const sanitizedResponse = sanitizeForSerialization(apiResponse);
                executedSteps.push({
                  step: stepToExecute,
                  response: sanitizedResponse,
                  stepNumber: stepToExecute.step_number || executedSteps.length,
                  error: true,
                  errorMessage: err.message,
                });
                
                accumulatedResults.push({
                  step: stepToExecute.step_number || executedSteps.length,
                  description: stepToExecute.description || 'API call',
                  response: sanitizedResponse,
                  error: true,
                  errorMessage: err.message,
                });
                
                console.log(`📤 Error recorded. Exiting execution loop to re-plan.`);
                break; // Exit the step execution loop
              }
              
              // For FETCH flows or non-critical errors: Continue with error as response
              // 参数类型不匹配是特殊情况，需要重新规划
              if (typeof err?.message === 'string' && err.message.includes('参数类型不匹配')) {
                console.warn('参数类型不匹配，打回AI重写:', err.message);
                return {
                  error: '参数类型不匹配',
                  reason: err.message,
                  executedSteps,
                  accumulatedResults,
                  clarification_question: `参数类型不匹配：${err.message}。请根据API schema重写参数。`,
                };
              }
              
              // 其他HTTP错误（404, 409, 403等）作为响应内容继续处理
              // 构造一个包含错误信息的响应对象
              apiResponse = {
                success: false,
                error: true,
                statusCode: err.statusCode || err.status || 500,
                message: err.message || 'API request failed',
                details: err.response || err.data || null,
                // 保留原始错误信息供后续分析
                _originalError: {
                  name: err.name,
                  message: err.message,
                  stack: err.stack
                }
              };
              
              console.log(`📋 Treating error as response data:`, apiResponse);
            }

            // 检查是否需要 fan-out
            if (apiResponse && typeof apiResponse === 'object' && 'needsFanOut' in apiResponse) {
              const fanOutReq = apiResponse as FanOutRequest;
              console.log(`\n🔄 需要 fan-out: ${fanOutReq.fanOutParam} = [${fanOutReq.fanOutValues.join(', ')}]`);

              // 执行 fan-out：为每个值创建一个独立的 API 调用
              const fanOutResults: any[] = [];
              for (const value of fanOutReq.fanOutValues) {
                const singleValueSchema = {
                  ...fanOutReq.baseSchema,
                  parameters: {
                    ...fanOutReq.mappedParams,
                    [fanOutReq.fanOutParam]: value, // 用单个值替换数组
                  },
                  parametersSchema: parametersSchema,
                };

                console.log(`  📤 Fan-out 调用 ${fanOutReq.fanOutParam}=${value}`);
                let singleResult;
                try {
                  singleResult = await dynamicApiRequest(
                    process.env.NEXT_PUBLIC_ELASTICDASH_API || '',
                    singleValueSchema,
                    userToken
                  );
                } catch (err: any) {
                  // 参数类型不匹配是特殊情况，需要重新规划
                  if (typeof err?.message === 'string' && err.message.includes('参数类型不匹配')) {
                    console.warn('参数类型不匹配，打回AI重写:', err.message);
                    return {
                      error: '参数类型不匹配',
                      reason: err.message,
                      executedSteps,
                      accumulatedResults,
                      clarification_question: `参数类型不匹配：${err.message}。请根据API schema重写参数。`,
                    };
                  }
                  
                  // 其他HTTP错误作为响应内容继续处理
                  console.warn(`⚠️  Fan-out call for ${fanOutReq.fanOutParam}=${value} encountered an error:`, err.message);
                  singleResult = {
                    success: false,
                    error: true,
                    statusCode: err.statusCode || err.status || 500,
                    message: err.message || 'API request failed'
                  };
                }

                fanOutResults.push({
                  [fanOutReq.fanOutParam]: value,
                  result: singleResult,
                });
              }

              console.log(`✅ Fan-out 完成，共 ${fanOutResults.length} 个结果`);

              // 将 fan-out 结果合并为一个统一的响应
              const mergedResponse = {
                fanOutResults,
                summary: `Retrieved data for ${fanOutResults.length} ${fanOutReq.fanOutParam}(s)`,
              };

              // 更新 apiResponse 为合并后的结果
              Object.assign(apiResponse, mergedResponse);
            }

            console.log('(route) API Response:', apiResponse);
            
            // Helper: Sanitize response for JSON serialization (remove circular references)
            function sanitizeForSerialization(obj: any): any {
              const seen = new WeakSet();
              return JSON.parse(JSON.stringify(obj, (key, value) => {
                // Skip circular references and non-serializable objects
                if (typeof value === 'object' && value !== null) {
                  if (seen.has(value)) {
                    return '[Circular]';
                  }
                  seen.add(value);
                  
                  // Remove large/problematic objects from error details
                  if (key === 'request' || key === 'socket' || key === 'agent' || key === 'res') {
                    return '[Omitted]';
                  }
                  
                  // Simplify config object
                  if (key === 'config') {
                    return {
                      method: value.method,
                      url: value.url,
                      data: value.data
                    };
                  }
                  
                  // Simplify headers
                  if (key === 'headers' && value.constructor?.name === 'AxiosHeaders') {
                    return Object.fromEntries(Object.entries(value));
                  }
                }
                return value;
              }));
            }
            
            // Helper: Generate a unique key for each API call (method + path + input)
            // CRITICAL: Must include BOTH parameters and requestBody to avoid key collisions
            // (e.g., different SQL queries would have same key if we only use parameters)
            function getApiCallKey(path: string, method: string, params: any, body: any) {
              // Use JSON.stringify for input, but sort keys for stability
              const stableStringify: (obj: any) => string = (obj: any) => {
                if (!obj || typeof obj !== 'object') return String(obj);
                if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
                return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
              };
              // Merge params and body into a single input object for key generation
              const combinedInput = {
                ...(params && typeof params === 'object' ? params : {}),
                ...(body && typeof body === 'object' ? { _body: body } : {})
              };
              return `${method.toLowerCase()} ${path}::${stableStringify(combinedInput)}`;
            }
            
            // Use a flat usefulDataMap (replace the old Map logic)
            // Also maintain an ordered array for chronological serialization
            const flatUsefulDataMap: Map<string, any> = requestContext.flatUsefulDataMap;
            const usefulDataArray = requestContext.usefulDataArray;

            const apiCallKey = getApiCallKey(apiSchema.path, apiSchema.method, parametersToUse, requestBodyToUse);
            const prevUsefulData = flatUsefulDataMap.get(apiCallKey) || '';
            const isNewEntry = !flatUsefulDataMap.has(apiCallKey);

            // Sanitize the API response before stringifying to avoid circular reference errors
            const sanitizedResponse = sanitizeForSerialization(apiResponse);

            const newUsefulData = await extractUsefulDataFromApiResponses(
              refinedQuery,
              finalDeliverable,
              prevUsefulData,
              JSON.stringify(sanitizedResponse),
              apiSchema, // Pass the API schema for context
              matchedApis // Pass available APIs to understand dependencies
            );

            // Update the Map
            flatUsefulDataMap.set(apiCallKey, newUsefulData);

            // Update the array: add new entry or update existing one
            if (isNewEntry) {
              // New entry: append to array
              usefulDataArray.push({
                key: apiCallKey,
                data: newUsefulData,
                timestamp: Date.now()
              });
            } else {
              // Existing entry: update the data in the array
              const existingIndex = usefulDataArray.findIndex(item => item.key === apiCallKey);
              if (existingIndex !== -1) {
                usefulDataArray[existingIndex].data = newUsefulData;
                usefulDataArray[existingIndex].timestamp = Date.now();
              }
            }

            // For compatibility, also update the old usefulData Map
            usefulData = flatUsefulDataMap;
            console.log('Updated Useful Data (chronological order):', usefulDataArray.map(item => ({ key: item.key.slice(0, 50) + '...', timestamp: new Date(item.timestamp).toISOString() })));

            // Process the response to ensure arrays are properly included
            let processedResponse = apiResponse;
            try {
              // If response is a JSON string, parse it
              if (typeof apiResponse === 'string') {
                processedResponse = JSON.parse(apiResponse);
              }

              // For large arrays (like moves), ensure they're not truncated
              // Use sanitization to avoid circular reference errors
              if (processedResponse && typeof processedResponse === 'object') {
                // Deep clone to ensure all nested data is accessible
                processedResponse = sanitizeForSerialization(processedResponse);
              }
            } catch (e) {
              // If parsing fails, use original response
              console.warn('Could not process API response:', e);
            }

            // CRITICAL: Store both step and response together
            // This allows Validator to see the complete execution history
            // Sanitize the response before storing to avoid circular references
            const sanitizedProcessedResponse = sanitizeForSerialization(processedResponse);
            
            executedSteps.push({
              stepNumber: stepToExecute.step_number || executedSteps.length + 1,
              step: stepToExecute,
              response: sanitizedProcessedResponse,
            });

            accumulatedResults.push({
              step: stepToExecute.step_number || executedSteps.length,
              description: stepToExecute.description || 'API call',
              response: sanitizedProcessedResponse,
              executionIndex: stepToExecute._executionIndex, // Track which item this execution was for
            });

            console.log(`✅ Step ${stepToExecute.step_number || executedSteps.length} completed. Remaining steps in plan: ${actionablePlan.execution_plan.length}`);
          } // End of for loop (for each stepToExecute)
        } else {
          console.warn(`⚠️  Step ${step.step_number} is not a valid API call (path: ${step.api?.path}, method: ${step.api?.method})`);
          console.warn('This appears to be a computation/logic step. The planner should only generate API call steps.');
          console.warn('Skipping this step and will let validator determine if more API calls are needed.');

          // Don't add invalid steps to executedSteps since no API was actually called
          // The validator will detect that the goal is not met and request proper API steps
        }
      } // End of while loop - all steps in the plan have been executed

      console.log(`\n✅ Completed all planned steps. Total executed: ${executedSteps.length - progressBeforeExecution}`);

      // For MODIFY flows: Skip validation during step execution, only validate once after all steps complete
      // For FETCH flows: Validate after each step (via the original flow)
      if (intentType === 'MODIFY' && !hasApiError) {
        console.log('📌 MODIFY flow: All steps executed without errors. Validating goal completion...');
        
        // Get updated planner context with execution results
        const allMatchedApis = await getAllMatchedApis({ entities, intentType, apiKey, context: requestContext });
        let topKResults = await getTopKResults(allMatchedApis, 20);
        const str = serializeUsefulDataInOrder(requestContext);
        
        // Validate if goal is complete
        const sanitizeForValidation = (obj: any): any => {
          const seen = new WeakSet();
          return JSON.parse(JSON.stringify(obj, (key, value) => {
            if (typeof value === 'object' && value !== null) {
              if (seen.has(value)) return '[Circular]';
              seen.add(value);
              if (key === 'request' || key === 'socket' || key === 'agent' || key === 'res') return '[Omitted]';
              if (key === 'config') return { method: value.method, url: value.url, data: value.data };
              if (key === 'headers' && value.constructor?.name === 'AxiosHeaders') {
                return Object.fromEntries(Object.entries(value));
              }
            }
            return value;
          }));
        };
        
        const validationResult = await validateNeedMoreActions(
          refinedQuery,
          sanitizeForValidation(executedSteps),
          sanitizeForValidation(accumulatedResults),
          apiKey,
          actionablePlan
        );
        
        console.log('Post-execution validation result:', validationResult);
        
        if (!validationResult.needsMoreActions) {
          console.log('✅ MODIFY validation confirmed: goal is complete');
          if (validationResult.item_not_found) {
            stoppedReason = 'item_not_found';
          }
          // Break to generate final answer
          break;
        } else {
          // Goal not complete - need to re-plan
          console.log(`⚠️  MODIFY validation failed: ${validationResult.reason}`);
          console.log('Re-planning based on validation feedback...');
          if (referenceTask) {
            console.log(`🧭 Reference task still in context for re-plan: ${referenceTask.id} (${referenceTask.taskName})`);
          }
          
          const plannerContext = `
Original Query: ${refinedQuery}

Executed Actions:
${JSON.stringify(executedSteps, null, 2)}

Results from Execution:
${JSON.stringify(accumulatedResults, null, 2)}

Goal Completion Status:
The user's goal has NOT been fully completed. Here's why:
${validationResult.reason}

Missing Requirements:
${JSON.stringify(validationResult.missing_requirements, null, 2)}

Suggested Next Action:
${validationResult.suggested_next_action || 'Generate a new plan to complete the goal'}

Available APIs:
${JSON.stringify(topKResults.slice(0, 10), null, 2)}

Reference task (reuse if similar): ${referenceTask ? JSON.stringify({ id: referenceTask.id, taskName: referenceTask.taskName }) : 'N/A'}

Please generate a NEW PLAN to complete the user's goal. Explain:
1. Why the previous plan didn't fully complete the goal
2. What additional actions are needed
3. The full list of new steps to execute`;

          currentPlanResponse = await sendToPlanner(plannerContext, apiKey, str, conversationContextWithReference, intentType);
          if (referenceTask) {
            console.log(`🧭 Re-plan (error recovery) kept reference task ${referenceTask.id} (${referenceTask.taskName}).`);
          }
          actionablePlan = JSON.parse(sanitizePlannerResponse(currentPlanResponse));
          console.log('✅ Generated new plan from validation feedback (MODIFY re-plan)');
          console.log('New plan:', JSON.stringify(actionablePlan, null, 2));
          
          // Continue to next planning cycle with new plan
          continue;
        }
      } else if (intentType === 'MODIFY' && hasApiError) {
        // MODIFY flow encountered an error - trigger re-planning
        console.log('🔄 MODIFY flow error detected. Re-planning with error feedback...');
        
        const allMatchedApis = await getAllMatchedApis({ entities, intentType, apiKey, context: requestContext });
        let topKResults = await getTopKResults(allMatchedApis, 20);
        const str = serializeUsefulDataInOrder(requestContext);
        
        const lastExecutedStep = executedSteps[executedSteps.length - 1];
        const errorDetails = lastExecutedStep?.response?.message || 'Unknown error';
        
        const plannerContext = `
Original Query: ${refinedQuery}

Previous Plan Failed:
The following action encountered an error and was not completed:
Step ${lastExecutedStep?.step?.step_number}: ${lastExecutedStep?.step?.description}
API: ${lastExecutedStep?.step?.api?.method?.toUpperCase()} ${lastExecutedStep?.step?.api?.path}
Error: ${errorDetails} (Status: ${lastExecutedStep?.response?.statusCode})

Executed Steps Before Error:
${JSON.stringify(executedSteps.slice(0, -1), null, 2)}

Available APIs:
${JSON.stringify(topKResults.slice(0, 10), null, 2)}

Reference task (reuse if similar): ${referenceTask ? JSON.stringify({ id: referenceTask.id, taskName: referenceTask.taskName }) : 'N/A'}

Please generate a NEW PLAN that:
1. Avoids the failed action (${lastExecutedStep?.step?.api?.method?.toUpperCase()} ${lastExecutedStep?.step?.api?.path})
2. Finds an alternative approach to complete the user's goal
3. Lists all steps needed`;

        currentPlanResponse = await sendToPlanner(plannerContext, apiKey, str, conversationContextWithReference, intentType);
        if (referenceTask) {
          console.log(`🧭 Re-plan (validator feedback) kept reference task ${referenceTask.id} (${referenceTask.taskName}).`);
        }
        actionablePlan = JSON.parse(sanitizePlannerResponse(currentPlanResponse));
        console.log('✅ Generated new plan after error (MODIFY recovery)');
        
        // Continue to next planning cycle
        continue;
      }
      
      // For FETCH flows: Validate after each batch of steps
      if (intentType === 'FETCH') {
        // Check if we made progress (executed any new steps)
        const progressMade = accumulatedResults.length > progressBeforeExecution;

        if (!progressMade) {
          stuckCount++;
          console.warn(`⚠️  No progress made in this iteration (stuck count: ${stuckCount})`);

          // If we already have a reference task and still made no progress, short-circuit to avoid loops
          if (referenceTask && stuckCount >= 1) {
            console.warn('⏹️  Short-circuiting iterative loop: reference task provided but no progress made.');
            stoppedReason = 'stuck_state';
            break;
          }

          if (stuckCount >= 2) {
            console.warn('Detected stuck state: no new API calls in 2 consecutive iterations');
            break;
          }
        } else {
          stuckCount = 0; // Reset stuck count if we made progress
        }

        // Now validate if we have sufficient information
        console.log('\n🔍 FETCH flow: Validating if more actions are needed...');
        
        const sanitizeForValidation = (obj: any): any => {
          const seen = new WeakSet();
          return JSON.parse(JSON.stringify(obj, (key, value) => {
            if (typeof value === 'object' && value !== null) {
              if (seen.has(value)) return '[Circular]';
              seen.add(value);
              if (key === 'request' || key === 'socket' || key === 'agent' || key === 'res') return '[Omitted]';
              if (key === 'config') return { method: value.method, url: value.url, data: value.data };
              if (key === 'headers' && value.constructor?.name === 'AxiosHeaders') {
                return Object.fromEntries(Object.entries(value));
              }
            }
            return value;
          }));
        };
        
        const validationResult = await validateNeedMoreActions(
          refinedQuery,
          sanitizeForValidation(executedSteps),
          sanitizeForValidation(accumulatedResults),
          apiKey,
          actionablePlan
        );

        console.log('Validation result:', validationResult);

        if (!validationResult.needsMoreActions) {
          console.log('✅ Validator confirmed: sufficient information gathered');
          
          // Check if it's because the item was not found
          if (validationResult.item_not_found) {
            console.log('❌ Item not found - will generate answer explaining this');
            stoppedReason = 'item_not_found';
          }
          
          break;
        }

        console.log(`⚠️  Validator says more actions needed: ${validationResult.reason}`);

        // Send the accumulated context back to the planner for next step
        const allMatchedApis = await getAllMatchedApis({ entities, intentType, apiKey, context: requestContext });
        let topKResults = await getTopKResults(allMatchedApis, 20);
        const str = serializeUsefulDataInOrder(requestContext);
        
        const plannerContext = `
Original Query: ${refinedQuery}

Matched APIs Available: ${JSON.stringify(topKResults.slice(0, 10), null, 2)}

Executed Steps So Far: ${JSON.stringify(executedSteps, null, 2)}

Accumulated Results: ${JSON.stringify(accumulatedResults, null, 2)}

Previous Plan: ${JSON.stringify(actionablePlan, null, 2)}

The validator says more actions are needed: ${validationResult.suggested_next_action ? validationResult.suggested_next_action : validationResult.reason}

Useful data from execution history that could help: ${validationResult.useful_data ? validationResult.useful_data : 'N/A'}

Reference task (reuse if similar): ${referenceTask ? JSON.stringify({ id: referenceTask.id, taskName: referenceTask.taskName }) : 'N/A'}

IMPORTANT: If the available APIs do not include an endpoint that can provide the required information:
1. Check if any of the accumulated results contain the information in a different format
2. Consider if the data can be derived or inferred from existing results
3. If truly impossible with available APIs, set needs_clarification: true with reason explaining what API is missing

Please generate the next step in the plan, or indicate that no more steps are needed.`;

        currentPlanResponse = await sendToPlanner(plannerContext, apiKey, str, conversationContextWithReference, intentType);
        actionablePlan = JSON.parse(sanitizePlannerResponse(currentPlanResponse));
        console.log('\n🔄 Generated new plan from validator feedback (FETCH mode)');
      }
    } catch (error: any) {
      console.error('Error during iterative planner execution:', error);
      return {
        error: 'Failed during iterative execution',
        details: error.message,
        executedSteps,
        accumulatedResults,
        usefulData,
      };
    }
  }

  // Determine why we stopped
  if (iteration >= maxIterations) {
    console.warn(`Reached max API call limit (${maxIterations})`);
    stoppedReason = 'max_iterations';
  } else if (planIteration >= 20) {
    console.warn('Reached max planning cycles (20)');
    stoppedReason = 'max_planning_cycles';
  } else if (stuckCount >= 2) {
    console.warn('Stopped due to stuck state (repeated validation reasons)');
    stoppedReason = 'stuck_state';
  }

  console.log(`\n📊 Execution Summary:`);
  console.log(`  - Total API calls made: ${iteration}/${maxIterations}`);
  console.log(`  - Planning cycles: ${planIteration}`);
  console.log(`  - Stopped reason: ${stoppedReason || 'goal_completed'}`);

  // Generate final answer based on accumulated results
  console.log('\n' + '='.repeat(80));
  console.log('📝 GENERATING FINAL ANSWER');
  console.log('='.repeat(80));

  // Sanitize accumulated results before preparing for final answer
  const sanitizeForFinalAnswer = (obj: any): any => {
    const seen = new WeakSet();
    return JSON.parse(JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        if (key === 'request' || key === 'socket' || key === 'agent' || key === 'res') return '[Omitted]';
        if (key === 'config') return { method: value.method, url: value.url, data: value.data };
        if (key === 'headers' && value.constructor?.name === 'AxiosHeaders') {
          return Object.fromEntries(Object.entries(value));
        }
      }
      return value;
    }));
  };
  
  const sanitizedAccumulatedResults = sanitizeForFinalAnswer(accumulatedResults);
  
  // Prepare data for final answer - handle large arrays intelligently
  const preparedResults = sanitizedAccumulatedResults.map((result: any) => {
    const response = result.response;

    // If response has large arrays (like moves), filter to relevant data
    if (response && response.result) {
      const resultData = response.result;

      // Handle moves array specifically - filter based on query context
      if (resultData.moves && Array.isArray(resultData.moves) && resultData.moves.length > 10) {
        console.log(`Processing ${resultData.moves.length} moves for final answer`);

        // Try to identify relevant type/category from query
        const queryLower = refinedQuery.toLowerCase();
        let filteredMoves = resultData.moves;

        // If query mentions a specific type, filter moves by that type
        const typeKeywords = ['steel', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'fairy', 'normal'];
        const mentionedType = typeKeywords.find(type => queryLower.includes(type));

        if (mentionedType) {
          const relevantMoves = resultData.moves.filter((move: any) =>
            move.type_name?.toLowerCase() === mentionedType ||
            move.typeName?.toLowerCase() === mentionedType
          );

          console.log(`Filtered to ${relevantMoves.length} ${mentionedType}-type moves`);

          if (relevantMoves.length > 0) {
            filteredMoves = relevantMoves;
          }
        }

        return {
          ...result,
          response: {
            ...response,
            result: {
              ...resultData,
              moves: filteredMoves,
              movesCount: resultData.moves.length,
              filteredMovesCount: filteredMoves.length,
              movesNote: mentionedType
                ? `Filtered to ${filteredMoves.length} ${mentionedType}-type moves out of ${resultData.moves.length} total`
                : `All ${filteredMoves.length} moves included`,
            },
          },
        };
      }
    }

    return result;
  });

  // Serialize useful data in chronological order (earliest first)
  const str = serializeUsefulDataInOrder(requestContext);

  const finalAnswer = await generateFinalAnswer(
    refinedQuery,
    preparedResults,
    apiKey,
    stoppedReason,
    str
  );

  console.log('\n' + '='.repeat(80));
  console.log('✅ ITERATIVE PLANNER COMPLETED');
  console.log('='.repeat(80));

  return {
    message: finalAnswer,
    executedSteps,
    accumulatedResults,
    usefulData,
    iterations: iteration,
  };
}
