import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { cosineSimilarity } from '@/src/utils/cosineSimilarity';
import { dynamicApiRequest } from '@/services/apiService';
import { clarifyAndRefineUserInput, handleQueryConceptsAndNeeds } from '@/utils/queryRefinement';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ToolCall {
  tool_name: string;
  arguments?: Record<string, any>;
  method?: string; // HTTP方法: GET, POST, PUT, DELETE等
  roles?: string[]; // 适用的角色列表
}

// 读取配置文件
function loadSystemPrompt(): string {
  const promptPath = path.join(process.cwd(), 'src/doc/prompt.txt');
  return fs.readFileSync(promptPath, 'utf-8');
}

function loadApiIndex(): string {
  const indexPath = path.join(process.cwd(), 'src/doc/api-index.json');
  return fs.readFileSync(indexPath, 'utf-8');
}

function loadFileList(): string {
  const fileListPath = path.join(process.cwd(), 'src/doc/openapi-doc/openapi.json');
  return fs.readFileSync(fileListPath, 'utf-8');
}

function loadApiModule(moduleId: string): string | null {
  try {
    const indexPath = path.join(process.cwd(), 'src/doc/api-index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));

    const module = index.modules.find((m: any) => m.id === moduleId);
    if (!module) {
      console.warn(`Module "${moduleId}" not found in index`);
      return null;
    }

    const modulePath = path.join(process.cwd(), 'src/doc', module.file);
    return fs.readFileSync(modulePath, 'utf-8');
  } catch (error: any) {
    console.warn(`Error loading module "${moduleId}":`, error);
    return null;
  }
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

// 检测响应是否为文档加载请求
function isDocLoadRequest(content: string): boolean {
  try {
    const extracted = extractJSON(content);
    if (!extracted) return false;

    const parsed = JSON.parse(extracted.json);
    return parsed.load_docs && Array.isArray(parsed.load_docs);
  } catch {
    return false;
  }
}

// 检测响应是否为clarification请求
function isClarificationRequest(content: string): boolean {
  try {
    const extracted = extractJSON(content);
    if (!extracted) return false;

    const parsed = JSON.parse(extracted.json);
    return parsed.clarification && typeof parsed.clarification === 'string';
  } catch {
    return false;
  }
}

// 检测响应是否为单个工具调用JSON
function isSingleToolCall(content: string): boolean {
  try {
    const extracted = extractJSON(content);
    if (!extracted) return false;

    const parsed = JSON.parse(extracted.json);
    return parsed.tool_name && typeof parsed.tool_name === 'string';
  } catch {
    return false;
  }
}

// 检测响应是否为工具调用数组JSON
function isToolCallResponse(content: string): boolean {
  try {
    const extracted = extractJSON(content);
    if (!extracted) return false;

    const parsed = JSON.parse(extracted.json);
    return Array.isArray(parsed) && parsed.length > 0 &&
           parsed.every(item => item.tool_name);
  } catch {
    return false;
  }
}

// 估算JSON的token数量（粗略估计：1 token ≈ 4 字符）
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// 智能压缩大型JSON响应
function compressLargeJson(jsonString: string, maxTokens: number = 1500): string {
  const tokens = estimateTokens(jsonString);

  if (tokens <= maxTokens) {
    return jsonString;
  }

  try {
    const data = JSON.parse(jsonString);

    // 如果是数组，截取前几项
    if (Array.isArray(data)) {
      const itemCount = Math.min(5, data.length);
      const compressed = {
        total_count: data.length,
        showing: itemCount,
        items: data.slice(0, itemCount),
        note: `显示前${itemCount}项，共${data.length}项`
      };
      return JSON.stringify(compressed, null, 2);
    }

    // 如果是对象，提取关键字段
    if (typeof data === 'object' && data !== null) {
      const keyFields = [
        'id', 'name', 'url',
        'height', 'weight', 'base_experience',
        'types', 'abilities', 'stats',
        'description', 'title', 'content',
        'path', 'method', 'summary', 'requestBody', 'responses'
      ];

      const compressed: any = {};
      let currentTokens = 0;

      // 优先保留关键字段
      for (const key of keyFields) {
        if (key in data) {
          const fieldString = JSON.stringify(data[key]);
          const fieldTokens = estimateTokens(fieldString);

          if (currentTokens + fieldTokens > maxTokens) {
            compressed['_truncated'] = true;
            compressed['_message'] = '响应过大，已截断部分字段';
            break;
          }

          compressed[key] = data[key];
          currentTokens += fieldTokens;
        }
      }

      // 如果还有空间，添加其他字段（截断值）
      if (currentTokens < maxTokens * 0.8) {
        for (const [key, value] of Object.entries(data)) {
          if (!(key in compressed) && currentTokens < maxTokens * 0.8) {
            if (typeof value === 'string' && value.length > 100) {
              compressed[key] = value.substring(0, 100) + '...';
            } else if (Array.isArray(value) && value.length > 3) {
              compressed[key] = [...value.slice(0, 3), `...(${value.length - 3} more)`];
            } else {
              compressed[key] = value;
            }
            currentTokens = estimateTokens(JSON.stringify(compressed));
          }
        }
      }

      return JSON.stringify(compressed, null, 2);
    }

    // 如果是其他类型，直接截断
    return jsonString.substring(0, maxTokens * 4) + '\n...(响应已截断)';
  } catch {
    // 如果JSON解析失败，直接截断字符串
    return jsonString.substring(0, maxTokens * 4) + '\n...(响应已截断)';
  }
}

// Enhanced executeToolCall function to log roles and ensure at least one role is applied
async function executeToolCall(
  toolCall: ToolCall,
  index: number,
  total: number
): Promise<{ result: string; log: any }> {
  try {
    // Ensure at least one role is applied
    const roles = toolCall.roles || [];
    if (roles.length === 0) {
      throw new Error(`ToolCall must have at least one role applied. Received: ${JSON.stringify(toolCall)}`);
    }

    // Log roles being used
    console.log(`Roles applied: ${roles.join(', ')}`);

    // Determine base URL
    const isElasticDashApi = !toolCall.tool_name.startsWith('/api/v2/');
    const baseUrl = isElasticDashApi
      ? (
          process.env.NEXT_PUBLIC_ELASTICDASH_API ||
          (process.env.NODE_ENV === 'development'
            ? 'https://devserver.elasticdash.com/api'
            : 'https://api.elasticdash.com')
        )
      : (process.env.NEXT_PUBLIC_POKEMON_API || 'https://pokeapi.co');

    // Extract module prefix and path
    const [modulePrefix, ...pathParts] = toolCall.tool_name.split('/').filter(Boolean);
    const path = pathParts.join('/');

    // Validate module prefix and path
    if (!modulePrefix || !path) {
      throw new Error(`Invalid tool_name: "${toolCall.tool_name}" must include a module prefix and path.`);
    }

    // Get HTTP method (default: GET)
    const method = (toolCall.arguments?.method || 'GET').toUpperCase();

    // Remove method field from arguments
    const actualArguments = { ...toolCall.arguments };
    delete actualArguments.method;

    // Construct URL
    let url = `${baseUrl}/${modulePrefix}/${path}`;
    if (method === 'GET' && Object.keys(actualArguments).length > 0) {
      const queryParams = new URLSearchParams();
      Object.entries(actualArguments).forEach(([key, value]) => {
        queryParams.append(key, String(value));
      });
      url += `?${queryParams.toString()}`;
    }

    console.log('\n' + '='.repeat(80));
    console.log(`🔧 [${index + 1}/${total}] TOOL CALL`);
    console.log('='.repeat(80));
    console.log('Tool Name:', toolCall.tool_name);
    console.log('HTTP Method:', method);
    console.log('Arguments:', JSON.stringify(actualArguments, null, 2));
    console.log('API Type:', isElasticDashApi ? 'ElasticDash' : 'Pokemon');
    console.log('Constructed URL:', url);
    console.log('Roles:', roles.join(', '));
    console.log('-'.repeat(80));

    // Construct headers
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    // Add Bearer token for ElasticDash API
    if (isElasticDashApi) {
      const token = process.env.NEXT_PUBLIC_ELASTICDASH_TOKEN;
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    // Construct fetch options
    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    // 对于POST、PUT、PATCH等需要body的请求，添加请求体
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      fetchOptions.body = JSON.stringify(actualArguments);
    }

    // Execute the API call
    const response = await fetch(url, fetchOptions);
    const result = await response.text();

    // Log the result
    console.log('Response:', result);

    // Return the result and log
    return {
      result,
      log: {
        tool_name: toolCall.tool_name,
        arguments: actualArguments,
        roles,
        response: result,
      },
    };
  } catch (error: any) {
    console.error('Error executing ToolCall:', error);
    throw error;
  }
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

interface ToolCallLog {
  tool_name: string;
  arguments: Record<string, any>;
  url: string;
  roles: string[];
  response: string;
  response_size: number;
  compressed: boolean;
  response_preview: string;
  response_data: any; // 完整的JSON响应对象
}

interface IterationLog {
  iteration: number;
  type: 'doc_load' | 'tool_call' | 'clarification' | 'text_response';
  llm_output: string;
  details?: any;
}

// Load vectorized data
const vectorizedDataPath = path.join(process.cwd(), 'src/doc/vectorized-data/vectorized-data.json');
const vectorizedData = JSON.parse(fs.readFileSync(vectorizedDataPath, 'utf-8'));

// Function to find the top-k most similar vectors
function findTopKSimilar(queryEmbedding: number[], topK: number = 3) {
  return vectorizedData
    .map((item: any) => ({
      ...item,
      similarity: cosineSimilarity(queryEmbedding, item.embedding),
    }))
    .sort((a: any, b: any) => b.similarity - a.similarity)
    .slice(0, topK);
}

// Load prompt file content
async function fetchPromptFile(fileName: string): Promise<string> {
  try {
    const response = fs.readFileSync(path.join(process.cwd(), 'src', 'doc', fileName), 'utf-8');
    return response;
  } catch (error: any) {
    throw new Error(`Error fetching prompt file: ${error.message}`);
  }
};

async function sendToPlanner(apis: any[], refinedQuery: string, apiKey: string): Promise<string> {
  console.log('apis:', apis);

  const apiDescription = apis.length > 0 ? JSON.stringify(apis, null, 2) : String(apis);

  console.log('API Description for Planner:', apis.map((api: any) => api.id).join(', '));

  let userMessage = `Refined Query: ${refinedQuery}\nMatched APIs: ${apiDescription}`;
  let plannerResponse = '';
  let containsAssumption = true;
  let retryCount = 0;
  const maxRetries = 3;

  while (containsAssumption && retryCount < maxRetries) {
    retryCount++;
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
            { role: 'system', content: await fetchPromptFile('prompt-planner.txt') },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.5,
          max_tokens: 4096,
        }),
      });

      if (!response.ok) {
        console.error('Planner API request failed:', await response.text());
        throw new Error('Failed to get a response from the planner.');
      }

      const data = await response.json();
      plannerResponse = data.choices[0]?.message?.content || '';

      // Log the raw response for debugging
      console.log('Raw Planner Response:', plannerResponse);

      // Sanitize the response by removing code block markers
      plannerResponse = plannerResponse.replace(/```json|```/g, '').trim();

      // Detect if the response is truncated
      if (!plannerResponse.endsWith('}')) {
        console.warn('Planner response appears to be truncated:', plannerResponse);
        plannerResponse += '...'; // Append ellipsis to indicate truncation
      }

      // Attempt to extract JSON content
      const jsonMatch = plannerResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        plannerResponse = jsonMatch[0];
      } else {
        console.error('Failed to extract JSON from planner response.');
        throw new Error('Invalid planner response format.');
      }

      // Check if the response contains "assume" or "assuming" (case-insensitive)
      containsAssumption = /\bassume\b|\bassuming\b/i.test(plannerResponse);

      // Also check if planner is asking for clarification about IDs that can be looked up
      let needsIdClarification = false;
      let hasRedundantRangeFilter = false;
      let hasPlaceholderValues = false;

      try {
        const parsed = JSON.parse(plannerResponse);

        if (parsed.needs_clarification === true) {
          const reason = (parsed.reason || '').toLowerCase();
          const question = (parsed.clarification_question || '').toLowerCase();

          // Check if it's asking about IDs, identifiers, or values that should be looked up via API
          const shouldLookupKeywords = [
            'id', 'identifier', 'type id', 'category id', 'status id',
            'stat id', 'ability id', 'move id', 'enum', 'code',
            'look it up', 'look up', 'using an api', 'use an api',
            'does not provide', 'necessary id', 'required id', 'internal id'
          ];

          needsIdClarification = shouldLookupKeywords.some(keyword =>
            reason.includes(keyword) || question.includes(keyword)
          );
        }

        // Check if execution plan has redundant range filter with sort parameter
        if (parsed.execution_plan && Array.isArray(parsed.execution_plan)) {
          hasRedundantRangeFilter = parsed.execution_plan.some((step: any) => {
            if (step.api && step.api.requestBody) {
              const requestBody = step.api.requestBody;

              // Check for common sorting parameters (sortby, sort, orderBy, order_by, etc.)
              const hasSortParam = ['sortby', 'sort', 'orderBy', 'order_by', 'sortBy'].some(key => key in requestBody);

              // Check for range filters in common filter structures
              let hasRangeFilter = false;
              if (requestBody.filter) {
                // Check for stats array (Pokemon-style)
                if (requestBody.filter.stats && Array.isArray(requestBody.filter.stats)) {
                  hasRangeFilter = true;
                }
                // Check for other min/max patterns in filters
                Object.values(requestBody.filter).forEach((value: any) => {
                  if (typeof value === 'object' && value !== null && ('min' in value || 'max' in value)) {
                    hasRangeFilter = true;
                  }
                });
              }

              if (hasSortParam && hasRangeFilter) {
                // Check if the query mentions "highest", "lowest", "most", "least"
                const queryLower = refinedQuery.toLowerCase();
                const isRankingQuery = /\b(highest|lowest|most|least|strongest|weakest|fastest|slowest|top|bottom|best|worst)\b/.test(queryLower);

                // Check if query mentions specific ranges
                const isRangeQuery = /\b(between|range|from.*to|greater than|less than|above|below|at least|at most)\b/.test(queryLower);

                // If it's a ranking query without range specification, range filter is redundant
                if (isRankingQuery && !isRangeQuery) {
                  console.warn('Detected redundant range filter in ranking query');
                  return true;
                }
              }
            }
            return false;
          });
        }

        // Check if execution plan has placeholder values (null, empty arrays, etc.)
        if (parsed.execution_plan && Array.isArray(parsed.execution_plan)) {
          // Check if the original response (before sanitization) had comments
          const hadComments = /\/\*[\s\S]*?\*\/|\/\//.test(plannerResponse);

          if (hadComments) {
            hasPlaceholderValues = true;
            console.warn('Planner response contains comments indicating placeholder values');
          }

          // Also check for null values or empty arrays in critical fields
          const hasNullOrEmpty = parsed.execution_plan.some((step: any) => {
            if (step.api && step.api.requestBody) {
              const bodyStr = JSON.stringify(step.api.requestBody);
              return /:\s*null|:\s*\[\s*\]/.test(bodyStr);
            }
            return false;
          });

          if (hasNullOrEmpty) {
            hasPlaceholderValues = true;
            console.warn('Planner response contains null or empty values in requestBody');
          }
        }
      } catch (e) {
        // If parsing fails, we'll catch it later
      }

      if (containsAssumption || needsIdClarification || hasRedundantRangeFilter || hasPlaceholderValues) {
        if (needsIdClarification) {
          console.warn('Planner is asking for ID clarification when it should use API lookup. Sending strong reinforcement.');
        } else if (hasRedundantRangeFilter) {
          console.warn('Planner added redundant range filter when only sorting is needed. Sending correction.');
        } else if (hasPlaceholderValues) {
          console.warn('Planner response contains placeholder values or comments. Sending correction.');
        } else {
          console.warn('Planner response contains assumptions. Sending clarification.');
        }

        // Append strong clarification message to userMessage
        let clarificationMessage = '';

        if (needsIdClarification) {
          clarificationMessage = `CRITICAL ERROR: You are asking the user for information that MUST be resolved via API.

You MUST NOT ask for clarification about IDs, identifiers, names, codes, or any information that can be looked up via the provided APIs.

MANDATORY RULES:
1. If you need to resolve a human-readable name to an ID, you MUST use the appropriate search/lookup API
2. If you need any category, type, status, or entity ID, you MUST use the appropriate lookup endpoint
3. If you need enum values or internal codes, you MUST use the appropriate API to retrieve them
4. ONLY ask for clarification if the user's INTENT is ambiguous, NOT if you need to look up data

The available APIs can resolve these lookups. CREATE AN EXECUTION PLAN that includes the lookup step as the FIRST step, then use that result in subsequent steps.

Return a proper execution_plan with "needs_clarification": false.`;
        } else if (hasRedundantRangeFilter) {
          clarificationMessage = `CRITICAL ERROR: You added a redundant range filter when only sorting is needed.

The user is asking for items with the HIGHEST/LOWEST value of an attribute, NOT for items within a specific range.

MANDATORY RULES:
1. When finding items with highest/lowest/most/least of an attribute → Use ONLY sorting, DO NOT use range filters
2. When filtering for a specific range → Use range filters with min/max values
3. NEVER combine range filters with sorting unless the user explicitly requests both a range AND ranking

Generic example pattern:
❌ WRONG: {filter: {category: [X], attribute: {max: 0}}, sort: "attribute_asc"}
✅ CORRECT: {filter: {category: [X]}, sort: "attribute_asc"}

The sort parameter already handles finding the lowest/highest value. The range filter is ONLY for constraining to a specific range.

Please regenerate the execution plan WITHOUT the redundant range filter.`;
        } else if (hasPlaceholderValues) {
          clarificationMessage = `CRITICAL ERROR: Your execution plan contains placeholder values, comments, null values, or empty arrays.

You MUST provide COMPLETE and VALID execution plans with actual values, NOT placeholders or comments.

FORBIDDEN patterns:
❌ Comments in JSON: "mustHaveTypes": [/* Flying type ID from previous step */]
❌ Placeholder comments: "statId": /* Attack stat ID */
❌ Null values in critical fields: "statId": null
❌ Empty arrays as placeholders: "mustHaveTypes": []

REQUIRED approach for multi-step plans:
If a later step needs a value from an earlier step:
1. DO NOT use comments or placeholders
2. DO NOT leave the value as null or empty
3. INSTEAD: Create a TWO-STEP plan where:
   - Step 1 fetches the required ID/value
   - Step 2 uses a description indicating it needs the result from Step 1
   - The EXECUTOR will handle passing values between steps

Example of CORRECT multi-step plan:
{
  "execution_plan": [
    {
      "step_number": 1,
      "description": "Fetch Flying type ID",
      "api": {
        "path": "/type/search",
        "method": "post",
        "requestBody": {"searchterm": "Flying"}
      }
    },
    {
      "step_number": 2,
      "description": "Search for Flying-type entities with lowest attack (using type ID from step 1)",
      "depends_on_step": 1,
      "api": {
        "path": "/entity/search",
        "method": "post",
        "requestBody": {
          "filter": {
            "mustHaveTypes": "{{step_1_result.id}}"
          },
          "sortby": 7
        }
      }
    }
  ]
}

Please regenerate the plan with proper step dependencies and NO placeholders, comments, or null values.`;
        } else {
          clarificationMessage = '不准给我assume任何东西，在规划里用API获取所有需要的信息';
        }

        userMessage += `\n\n${clarificationMessage}`;
        containsAssumption = true; // Keep the loop going
      }
    } catch (error) {
      console.error('Error in sendToPlanner:', error);
      throw error;
    }
  }

  if (retryCount >= maxRetries && containsAssumption) {
    console.warn(`Planner still has issues after ${maxRetries} retries. Proceeding with last response.`);
  }

  return plannerResponse;
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

    // Fix common issues after comment removal
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
  try {
    const { messages } = await request.json();

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

    // Clarify and refine user input
    const { refinedQuery, language, concepts, apiNeeds, entities } = await clarifyAndRefineUserInput(userMessage.content, apiKey);
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

    // Include the full conversation context until summarization is necessary
    const summarizedMessages = messages.length > 10 ? await summarizeMessages(messages, apiKey) : messages;

    // Multi-entity RAG: Generate embeddings for each entity and combine results
    console.log(`\n🔍 Performing multi-entity RAG search for ${entities.length} entities`);

    const allMatchedApis = new Map(); // Use Map to deduplicate by API id

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

      // Find top-10 for this entity (we'll filter after)
      const entityResults = findTopKSimilar(entityEmbedding, 10);

      // Filter out obviously irrelevant APIs based on tags and paths
      const relevantResults = entityResults.filter((item: any) => {
        const content = JSON.parse(item.content);
        const path = content.path || '';
        const tags = content.tags || [];
        const summary = (content.summary || '').toLowerCase();

        // Exclude user-specific APIs that are rarely relevant to data queries
        const irrelevantPatterns = [
          /\/watchlist/i,
          /\/teams/i,
          /\/admin/i,
          /\/user\/profile/i,
          /\/auth/i,
          /\/login/i,
        ];

        const isIrrelevant = irrelevantPatterns.some(pattern => pattern.test(path));

        // Also check if tags suggest it's user management (not data retrieval)
        const hasIrrelevantTags = tags.some((tag: string) =>
          ['Watchlist', 'Teams', 'Admin', 'Auth', 'User'].includes(tag)
        );

        return !isIrrelevant && !hasIrrelevantTags;
      }).slice(0, 5); // Take top 5 after filtering

      console.log(`Found ${entityResults.length} APIs for entity "${entity}", ${relevantResults.length} after filtering:`,
        relevantResults.map((item: any) => ({ id: item.id, similarity: item.similarity.toFixed(3) }))
      );

      // Add filtered results to combined results (Map handles deduplication)
      relevantResults.forEach((result: any) => {
        const existing = allMatchedApis.get(result.id);
        // Keep the result with higher similarity if duplicate
        if (!existing || result.similarity > existing.similarity) {
          allMatchedApis.set(result.id, result);
        }
      });
    }

    // Convert Map to array and sort by similarity
    let topKResults = Array.from(allMatchedApis.values())
      .sort((a: any, b: any) => b.similarity - a.similarity)
      .slice(0, 15); // Take top 15 from combined results

    console.log(`\n✅ Combined Results: Found ${allMatchedApis.size} unique APIs across all entities`);
    console.log(`📋 Top ${topKResults.length} APIs selected:`,
      topKResults.map((item: any) => ({
        id: item.id,
        similarity: item.similarity.toFixed(3)
      }))
    );

    if (topKResults.length === 0) {
      return NextResponse.json(
        { error: 'No matching APIs found' },
        { status: 404 }
      );
    }

    topKResults = topKResults.map((item: any) => {
      const content = JSON.parse(item.content);
      return content;
    });

    // Send the top API match and refined query to the planner
    const planResponse = await sendToPlanner(topKResults, refinedQuery, apiKey);
    console.log('Generated Plan:', planResponse);

    let actionablePlan;
    try {
      // Remove comments and sanitize the JSON string
      const sanitizedPlanResponse = sanitizePlannerResponse(planResponse);
      actionablePlan = JSON.parse(sanitizedPlanResponse);
    } catch (error) {
      console.warn('Failed to parse planner response as JSON:', error);
      console.warn('Original Planner Response:', planResponse);

      return NextResponse.json(
        { error: 'Failed to parse planner response', planResponse },
        { status: 500 }
      );
    }

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
        5 // max iterations
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
  apiKey: string
): Promise<{ needsMoreActions: boolean; reason: string }> {
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
            content: `You are a validator that determines if enough information has been gathered to answer the user's question.

Analyze the original query, the steps executed, and the results accumulated.

CRITICAL LOGICAL CHECKS - Verify ALL prerequisites are met:

For queries about "X that Y can do/learn/has":
1. Do we have a list of ALL items that Y can do/learn/has? (Not just items matching X)
2. Have we filtered that list to find items matching X?
3. Can we definitively say these are the ONLY items Y can do/learn/has?

For example: "most powerful steel move that Magnemite can learn"
- ❌ WRONG: Found steel moves → assume Magnemite can learn them
- ✅ CORRECT: Get Magnemite's move list → filter for steel type → find most powerful

EVALUATION CRITERIA:
1. Have we verified ALL prerequisites/constraints in the query?
2. Are we making assumptions about relationships without verification?
3. Does the data explicitly contain what the query asks for?

Respond with a JSON object: { "needsMoreActions": boolean, "reason": string }

Return needsMoreActions: false ONLY if:
- ALL required data is present and verified
- NO assumptions are being made about unverified relationships
- The answer can be definitively stated from the data

Return needsMoreActions: true if:
- We're missing prerequisite data (e.g., entity's attribute list)
- We're making assumptions without verification
- There's a clear next API call to get the missing data`,
          },
          {
            role: 'user',
            content: `Original Query: ${originalQuery}
Executed Steps: ${JSON.stringify(executedSteps, null, 2)}
Accumulated Results: ${JSON.stringify(accumulatedResults, null, 2)}

Can we answer the original query with the information we have? Or do we need more API calls?`,
          },
        ],
        temperature: 0.3,
        max_tokens: 500,
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
      console.log('Validator Decision:', result);
      return result;
    }

    return { needsMoreActions: false, reason: 'Unable to parse validator response' };
  } catch (error) {
    console.error('Error in validator:', error);
    return { needsMoreActions: false, reason: 'Validator error, proceeding with available data' };
  }
}

// Generate final answer based on accumulated information
async function generateFinalAnswer(
  originalQuery: string,
  accumulatedResults: any[],
  apiKey: string,
  stoppedReason?: string
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
${JSON.stringify(accumulatedResults, (key, value) => {
  // Custom replacer to handle large arrays without truncation
  if (Array.isArray(value) && value.length > 0) {
    // Return the full array, not truncated
    return value;
  }
  return value;
}, 2)}

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
  originalQuery: string,
  matchedApis: any[],
  initialPlanResponse: string,
  apiKey: string,
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

  while (iteration < maxIterations) {
    iteration++;
    console.log(`\n--- Iteration ${iteration} ---`);

    try {
      // Sanitize and parse the current plan response
      const sanitizedPlanResponse = sanitizePlannerResponse(currentPlanResponse);
      const actionablePlan = JSON.parse(sanitizedPlanResponse);

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

      // Execute the first step in the current plan
      const step = actionablePlan.execution_plan[0];
      console.log('Executing step:', JSON.stringify(step, null, 2));

      if (step.api) {
        // Perform the API call for the current step
        const apiResponse = await dynamicApiRequest(
          process.env.NEXT_PUBLIC_ELASTICDASH_API || '',
          step.api
        );

        console.log('API Response:', apiResponse);

        // Store the executed step and result
        executedSteps.push(step);

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

        accumulatedResults.push({
          step: step.step_number || executedSteps.length,
          description: step.description || 'API call',
          response: processedResponse,
        });

        // Validate if more actions are needed
        const validationResult = await validateNeedMoreActions(
          originalQuery,
          executedSteps,
          accumulatedResults,
          apiKey
        );

        console.log('Validation result:', validationResult);

        if (!validationResult.needsMoreActions) {
          console.log('Validator confirmed: sufficient information gathered');
          break;
        }

        // Check if we're stuck (same validation reason multiple times)
        if (validationResult.reason === previousValidationReason) {
          stuckCount++;
          console.warn(`Stuck count: ${stuckCount} (same validation reason repeated)`);

          if (stuckCount >= 2) {
            console.warn('Detected stuck state: validator requesting same information repeatedly');
            console.log('Available APIs may not support the required data. Generating answer with available information.');
            break;
          }
        } else {
          stuckCount = 0; // Reset if we get a different reason
          previousValidationReason = validationResult.reason;
        }

        // Send the accumulated context back to the planner for next step
        const plannerContext = `
Original Query: ${originalQuery}

Matched APIs Available: ${JSON.stringify(matchedApis, null, 2)}

Executed Steps So Far: ${JSON.stringify(executedSteps, null, 2)}

Accumulated Results: ${JSON.stringify(accumulatedResults, null, 2)}

Previous Plan: ${JSON.stringify(actionablePlan, null, 2)}

The validator says more actions are needed: ${validationResult.reason}

IMPORTANT: If the available APIs do not include an endpoint that can provide the required information:
1. Check if any of the accumulated results contain the information in a different format
2. Consider if the data can be derived or inferred from existing results
3. If truly impossible with available APIs, set needs_clarification: true with reason explaining what API is missing

Please generate the next step in the plan, or indicate that no more steps are needed.`;

        currentPlanResponse = await sendToPlanner(matchedApis, plannerContext, apiKey);
      } else {
        console.warn('Step does not contain an API call, skipping');
        break;
      }
    } catch (error: any) {
      console.error('Error during iterative planner execution:', error);
      return {
        error: 'Failed during iterative execution',
        details: error.message,
        executedSteps,
        accumulatedResults,
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
        const queryLower = originalQuery.toLowerCase();
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

  const finalAnswer = await generateFinalAnswer(
    originalQuery,
    preparedResults,
    apiKey,
    stoppedReason
  );

  console.log('\n' + '='.repeat(80));
  console.log('✅ ITERATIVE PLANNER COMPLETED');
  console.log('='.repeat(80));

  return {
    message: finalAnswer,
    executedSteps,
    accumulatedResults,
    iterations: iteration,
  };
}
