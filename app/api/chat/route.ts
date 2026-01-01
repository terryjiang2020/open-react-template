import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { cosineSimilarity } from '@/src/utils/cosineSimilarity';
import { dynamicApiRequest, FanOutRequest } from '@/services/apiService';
import { findApiParameters } from '@/services/apiSchemaLoader';
import { clarifyAndRefineUserInput, handleQueryConceptsAndNeeds } from '@/utils/queryRefinement';
import { sendToPlanner } from './planner';

declare global {
  // Augment the globalThis type to include __rag_entity
  var __rag_entity: string | undefined;
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
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
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: '请将以下对话历史总结成简洁的要点，保留关键信息和上下文。用中文回复。',
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
export async function getAllMatchedApis({ entities, apiKey }: { entities: string[], apiKey: string }): Promise<Map<string, any>> {
  const allMatchedApis = new Map();
  for (const entity of entities) {
    console.log(`\n--- Searching for entity: "${entity}" ---`);
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
    const entityResults = findTopKSimilar(entityEmbedding, 10);
    const entityTerms: string[] = entity.toLowerCase().match(/\b\w+\b/g) || [];
    const relevantResults = entityResults;
    console.log(`Found ${entityResults.length} APIs for entity "${entity}", ${relevantResults.length} after filtering:`,
      relevantResults.map((item: any) => ({ id: item.id, similarity: item.similarity.toFixed(3) }))
    );
    relevantResults.forEach((result: any) => {
      const existing = allMatchedApis.get(result.id);
      if (!existing || result.similarity > existing.similarity) {
        allMatchedApis.set(result.id, result);
      }
    });
  }
  return allMatchedApis;
}

export async function getTopKResults(allMatchedApis: Map<string, any>, topK: number): Promise<any[]> {

    // Convert Map to array and sort by similarity
    let topKResults = Array.from(allMatchedApis.values())
      .sort((a: any, b: any) => b.similarity - a.similarity)
      .slice(0, topK); // Take top topK from combined results

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

    topKResults = topKResults.map((item: any) => {
      // 拆分item.content，前面为tags，后面为json
      let tags: string[] = [];
      let jsonStr = item.content;
      const jsonStartIdx = item.content.indexOf('{');
      if (jsonStartIdx > 0) {
        const tagText = item.content.slice(0, jsonStartIdx).trim();
        tags = tagText.split(/\s+/).filter(Boolean);
        jsonStr = item.content.slice(jsonStartIdx);
      }
      const content = JSON.parse(jsonStr);
      content.tags = tags.length > 0 ? tags : (content.tags || []);
      return content;
    });

    return topKResults;
}

// Load vectorized data
const vectorizedDataPath = path.join(process.cwd(), 'src/doc/vectorized-data/vectorized-data.json');
const vectorizedData = JSON.parse(fs.readFileSync(vectorizedDataPath, 'utf-8'));

// Function to find the top-k most similar vectors
function findTopKSimilar(queryEmbedding: number[], topK: number = 3) {
  return vectorizedData
    .map((item: any) => {
      // 拆分item.content，前面为tags，后面为json
      let tags: string[] = [];
      let jsonStr = item.content;
      const jsonStartIdx = item.content.indexOf('{');
      if (jsonStartIdx > 0) {
        const tagText = item.content.slice(0, jsonStartIdx).trim();
        tags = tagText.split(/\s+/).filter(Boolean);
        jsonStr = item.content.slice(jsonStartIdx);
      }
      let summary = '';
      try {
        const content = JSON.parse(jsonStr);
        summary = (content.summary || '').toLowerCase();
      } catch {}

      // 计算embedding相似度
      let similarity = cosineSimilarity(queryEmbedding, item.embedding);

      // 加强tag和summary权重
      const entityText = (globalThis.__rag_entity || '').toLowerCase();
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

// 独立planner函数：负责准备输入、调用sendToPlanner、处理响应
async function runPlannerWithInputs({
  topKResults,
  refinedQuery,
  apiKey,
  usefulData,
  conversationContext,
  finalDeliverable
}: {
  topKResults: any[],
  refinedQuery: string,
  apiKey: string,
  usefulData: string,
  conversationContext?: string,
  finalDeliverable?: string
}): Promise<{ actionablePlan: any, planResponse: string }> {
  // 发送到planner
  const planResponse = await sendToPlanner(topKResults, refinedQuery, apiKey, usefulData, conversationContext);
  let actionablePlan;
  try {
    // Remove comments and sanitize the JSON string
    const sanitizedPlanResponse = sanitizePlannerResponse(planResponse);
    console.log('Sanitized Planner Response:', sanitizedPlanResponse);
    actionablePlan = JSON.parse(sanitizedPlanResponse);
    if (actionablePlan && finalDeliverable && !actionablePlan.final_deliverable) {
      actionablePlan.final_deliverable = finalDeliverable;
    }
  } catch (error) {
    console.warn('Failed to parse planner response as JSON:', error);
    console.warn('Original Planner Response:', planResponse);
    throw new Error('Failed to parse planner response');
  }
  return { actionablePlan, planResponse };
}

// Enhanced JSON sanitization to handle comments and invalid trailing characters
function sanitizePlannerResponse(response: string): string {
  try {
    // First, remove code block markers
    let cleaned = response.replace(/```json|```/g, '').trim();

    // Remove inline comments (// style)
    cleaned = cleaned.replace(/\/\/.*(?=[\n\r])/g, '');

    // Remove block comments (/* */ style) more carefully
    // Replace comments with null to maintain valid JSON structure
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, 'null');

    // Replace angle bracket placeholders (e.g., <WATER_TYPE_ID>, <resolved_id>) with null
    // These are not valid JSON and indicate the planner is using placeholders
    cleaned = cleaned.replace(/<[^>]+>/g, 'null');

    // Fix common issues after placeholder/comment removal
    // Fix multiple commas: ,, or , null,
    cleaned = cleaned.replace(/,\s*null\s*,/g, ',');
    cleaned = cleaned.replace(/,\s*,/g, ',');
    // Fix comma before closing bracket/brace
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
    // Fix missing values before comma (e.g., "key": ,)
    cleaned = cleaned.replace(/:\s*,/g, ': null,');

    // Extract the first valid JSON object or array
    const jsonMatch = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      return jsonMatch[0];
    }

    throw new Error('No valid JSON found in the response.');
  } catch (error) {
    console.error('Error sanitizing planner response:', error);
    throw error;
  }
}

export async function POST(request: NextRequest) {
  let usefulData = new Map();
  let finalDeliverable = '';

  try {
    // Extract user token from Authorization header (optional)
    const authHeader = request.headers.get('Authorization') || '';
    const userToken = authHeader.startsWith('Bearer ') ? authHeader : '';

    const { messages } = await request.json();

    console.log('\n💬 Received messages:', messages);

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

    // Extract the latest user message
    const userMessage = [...messages].reverse().find((msg: Message) => msg.role === 'user');
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

    const { refinedQuery, language, concepts, apiNeeds, entities } = await clarifyAndRefineUserInput(queryWithContext, apiKey);
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
    const allMatchedApis = await getAllMatchedApis({ entities, apiKey });

    // Convert Map to array and sort by similarity
    let topKResults = await getTopKResults(allMatchedApis, 10);

    const obj = Object.fromEntries(usefulData);
    const str = JSON.stringify(obj, null, 2);

    // 调用独立planner函数
    const { actionablePlan, planResponse: plannerRawResponse } = await runPlannerWithInputs({
      topKResults,
      refinedQuery,
      apiKey,
      usefulData: str,
      conversationContext,
      finalDeliverable
    });
    finalDeliverable = actionablePlan.final_deliverable || finalDeliverable;
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
      console.log('Starting iterative execution of the plan...');

      // Execute the plan using the iterative planner
      const result = await executeIterativePlanner(
        refinedQuery,
        topKResults,
        planResponse,
        apiKey,
        userToken, // Pass user token for API authentication
        finalDeliverable,
        usefulData,
        conversationContext,
        entities,
        20 // max iterations
      );

      // Check if there was an error during execution
      if (result.error) {
        return NextResponse.json({
          message: result.clarification_question || result.error,
          error: result.error,
          reason: result.reason,
          refinedQuery,
          topKResults,
          executedSteps: result.executedSteps || [],
          accumulatedResults: result.accumulatedResults || [],
        });
      }

      // Return the final answer
      return NextResponse.json({
        message: result.message,
        refinedQuery,
        topKResults,
        executedSteps: result.executedSteps,
        accumulatedResults: result.accumulatedResults,
        iterations: result.iterations,
      });
    }

    // If no execution plan, return a message
    return NextResponse.json({
      message: 'Plan does not include an execution plan.',
      refinedQuery,
      topKResults,
      planResponse,
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
}> {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
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
FORBIDDEN HEURISTICS
────────────────────────────────────────

❌ "The API call succeeded, so we're done"
❌ "There are no remaining steps"
❌ "The planner didn't include more actions"
❌ "The data exists, so the goal must be satisfied"

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
  apiResponse: string
): Promise<string> {
  try {
    const prompt = `You are an expert at extracting useful information from API responses to help answer user queries.

Given the original user query, the refined query, and the final deliverable generated so far,
extract any useful data points, facts, or details from the API responses that could aid in answering the user's question.

If there is already existing useful data, integrate the new findings with it.

Return the extracted useful data in a concise format. If no new useful data is found, return the existing useful data as is.

Refined User Query: ${refinedQuery}
Final Deliverable: ${finalDeliverable}
Existing Useful Data: ${existingUsefulData}
API Response: ${apiResponse}

Extracted Useful Data: `;

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
        model: 'gpt-4o-mini',
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
    const extractedData = (existingUsefulData + ' ' + data.choices[0]?.message?.content) || existingUsefulData;
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
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
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
  maxIterations: number = 20
): Promise<any> {
  let currentPlanResponse = initialPlanResponse;
  let accumulatedResults: any[] = [];
  let executedSteps: any[] = [];
  let iteration = 0;
  let previousValidationReason = '';
  let stuckCount = 0; // Track how many times we get the same validation reason

  console.log('\n' + '='.repeat(80));
  console.log('🔄 STARTING ITERATIVE PLANNER');
  console.log('='.repeat(80));

  // Sanitize and parse the current plan response
  let sanitizedPlanResponse = sanitizePlannerResponse(currentPlanResponse);
  let actionablePlan = JSON.parse(sanitizedPlanResponse);

  while (iteration < maxIterations) {
    iteration++;
    console.log(`\n--- Iteration ${iteration} ---`);

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

      while (actionablePlan.execution_plan.length > 0) {
        const step = actionablePlan.execution_plan.shift(); // Remove first step
        console.log(`\nExecuting step ${step.step_number || executedSteps.length + 1}:`, JSON.stringify(step, null, 2));

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
            const apiResponse = await dynamicApiRequest(
              process.env.NEXT_PUBLIC_ELASTICDASH_API || '',
              apiSchema,
              userToken // Pass user token for authentication
            );

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
                const singleResult = await dynamicApiRequest(
                  process.env.NEXT_PUBLIC_ELASTICDASH_API || '',
                  singleValueSchema,
                  userToken
                );

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


            console.log('API Response:', apiResponse);

            // 清理和精简 usefulData，去除多余转义和嵌套
            function cleanUsefulData(raw: string): string {
              let obj;
              try {
                obj = JSON.parse(raw);
              } catch {
                obj = raw;
              }
              if (typeof obj === 'object') {
                return JSON.stringify(flattenObject(obj), null, 2);
              }
              return raw.replace(/\\/g, '\\').replace(/\"/g, '"');
            }

            function flattenObject(obj: any): any {
              if (typeof obj !== 'object' || obj === null) return obj;
              const result: any = {};
              for (const key in obj) {
                if (typeof obj[key] === 'object') {
                  const flat = flattenObject(obj[key]);
                  if (typeof flat === 'object' && flat !== null) {
                    Object.assign(result, flat);
                  } else {
                    result[key] = flat;
                  }
                } else {
                  result[key] = obj[key];
                }
              }
              return result;
            }

            const obj = Object.fromEntries(usefulData);
            const str = JSON.stringify(obj, null, 2);

            const extracted = await extractUsefulDataFromApiResponses(
              refinedQuery,
              finalDeliverable,
              str,
              JSON.stringify(apiResponse)
            );
            const cleaned = cleanUsefulData(extracted);
            usefulData.set(apiSchema.method + ' ' + apiSchema.path, cleaned);

            console.log('Updated Useful Data:', usefulData);

            // Process the response to ensure arrays are properly included
            let processedResponse = apiResponse;
            try {
              // If response is a JSON string, parse it
              if (typeof apiResponse === 'string') {
                processedResponse = JSON.parse(apiResponse);
              }

              // For large arrays (like moves), ensure they're not truncated
              if (processedResponse && typeof processedResponse === 'object') {
                // Deep clone to ensure all nested data is accessible
                processedResponse = JSON.parse(JSON.stringify(processedResponse));
              }
            } catch (e) {
              // If parsing fails, use original response
              console.warn('Could not process API response:', e);
            }

            // CRITICAL: Store both step and response together
            // This allows Validator to see the complete execution history
            executedSteps.push({
              step: stepToExecute,
              response: processedResponse,
            });

            accumulatedResults.push({
              step: stepToExecute.step_number || executedSteps.length,
              description: stepToExecute.description || 'API call',
              response: processedResponse,
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

        // 获取所有实体的匹配API（embedding检索+过滤）
        const allMatchedApis = await getAllMatchedApis({ entities, apiKey });

        // Convert Map to array and sort by similarity
        let topKResults = await getTopKResults(allMatchedApis, 10);

        const obj = Object.fromEntries(usefulData);
        const str = JSON.stringify(obj, null, 2);
        
        // 调用独立planner函数
        let { actionablePlan: actionablePlanNeo, planResponse: plannerRawResponse } = await runPlannerWithInputs({
          topKResults,
          refinedQuery,
          apiKey,
          usefulData: str,
          conversationContext,
          finalDeliverable
        });
        actionablePlan = actionablePlanNeo;
        finalDeliverable = actionablePlan.final_deliverable || finalDeliverable;
        const planResponse = plannerRawResponse;
        console.log('Generated Plan:', planResponse);
      }

      // All steps in the current plan have been executed
      console.log(`\n✅ Completed all ${executedSteps.length - progressBeforeExecution} steps in current plan`);

      // Check if we made progress (executed any new steps)
      const progressMade = accumulatedResults.length > progressBeforeExecution;

      if (!progressMade) {
        stuckCount++;
        console.warn(`⚠️  No progress made in this iteration (stuck count: ${stuckCount})`);

        if (stuckCount >= 2) {
          console.warn('Detected stuck state: no new API calls in 2 consecutive iterations');
          console.log('Generating answer with available information.');
          break;
        }
      } else {
        stuckCount = 0; // Reset stuck count if we made progress
      }

      // Now validate if we have sufficient information
      console.log('\n🔍 Validating if more actions are needed...');
      const validationResult = await validateNeedMoreActions(
        refinedQuery,
        executedSteps,
        accumulatedResults,
        apiKey,
        actionablePlan // Pass the last execution plan
      );

      console.log('Validation result:', validationResult);

      if (!validationResult.needsMoreActions) {
        console.log('✅ Validator confirmed: sufficient information gathered');
        break;
      }

      console.log(`⚠️  Validator says more actions needed: ${validationResult.reason}`);

      // Send the accumulated context back to the planner for next step
      const plannerContext = `
Original Query: ${refinedQuery}

Matched APIs Available: ${JSON.stringify(matchedApis, null, 2)}

Executed Steps So Far: ${JSON.stringify(executedSteps, null, 2)}

Accumulated Results: ${JSON.stringify(accumulatedResults, null, 2)}

Previous Plan: ${JSON.stringify(actionablePlan, null, 2)}

The validator says more actions are needed: ${validationResult.suggested_next_action ? validationResult.suggested_next_action : validationResult.reason}

Useful data from execution history that could help: ${validationResult.useful_data ? validationResult.useful_data : 'N/A'}

IMPORTANT: If the available APIs do not include an endpoint that can provide the required information:
1. Check if any of the accumulated results contain the information in a different format
2. Consider if the data can be derived or inferred from existing results
3. If truly impossible with available APIs, set needs_clarification: true with reason explaining what API is missing

Please generate the next step in the plan, or indicate that no more steps are needed.`;

      const obj = Object.fromEntries(usefulData);
      const str = JSON.stringify(obj, null, 2);

      currentPlanResponse = await sendToPlanner(matchedApis, plannerContext, apiKey, str);
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
  let stoppedReason = '';
  if (iteration >= maxIterations) {
    console.warn(`Reached max iterations (${maxIterations})`);
    stoppedReason = 'max_iterations';
  } else if (stuckCount >= 2) {
    console.warn('Stopped due to stuck state (repeated validation reasons)');
    stoppedReason = 'stuck_state';
  }

  // Generate final answer based on accumulated results
  console.log('\n' + '='.repeat(80));
  console.log('📝 GENERATING FINAL ANSWER');
  console.log('='.repeat(80));

  // Prepare data for final answer - handle large arrays intelligently
  const preparedResults = accumulatedResults.map((result: any) => {
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

  const obj = Object.fromEntries(usefulData);
  const str = JSON.stringify(obj, null, 2);

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
