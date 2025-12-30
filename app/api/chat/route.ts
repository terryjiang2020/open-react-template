import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { cosineSimilarity } from '@/src/utils/cosineSimilarity';
import { dynamicApiRequest } from '@/services/apiService';

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

async function clarifyAndRefineUserInput(userInput: string, apiKey: string): Promise<{ refinedQuery: string; language: string }> {
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
          content: `You are an assistant that refines user queries into a clearer and more structured format. The queries are under the context of Pokémon, and you should ensure the refined query aligns with Pokémon-related concepts and wordings. Regardless of the original language of the user's input, the refined query must always be in English. Additionally, detect the language of the user's input and include it in your response. Always respond in the following format: "Refined Query: [refined query]\nLanguage: [language code]".`,
        },
        {
          role: 'user',
          content: userInput,
        },
      ],
      temperature: 0.5,
      max_tokens: 4096,
    }),
  });

  const data = await response.json();
  const content = data.choices[0]?.message?.content || `Refined Query: ${userInput}\nLanguage: EN`;
  const refinedQueryMatch = content.match(/Refined Query: (.+)\nLanguage:/);
  const languageMatch = content.match(/Language: (.+)/);

  const refinedQuery = refinedQueryMatch ? refinedQueryMatch[1].trim() : userInput;
  const language = languageMatch ? languageMatch[1].trim() : 'EN';

  // Store the detected language in local storage (or update if new language is found)
  if (typeof localStorage !== 'undefined') {
    const storedLanguage = localStorage.getItem('userLanguage');
    if (!storedLanguage || storedLanguage !== language) {
      localStorage.setItem('userLanguage', language);
    }
  }

  return { refinedQuery, language };
}

async function sendToPlanner(apis: any[], refinedQuery: string, apiKey: string): Promise<string> {
  // Serialize the matched API object into a readable string
  const apiDescription = apis.length > 0 ? JSON.stringify(apis, null, 2) : String(apis);

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
            content: `You are a planner that takes a refined query and a matched API endpoint, and generates a detailed plan for how to use the API to fulfill the query. Your response must be a valid JSON object with the following structure:
{
  api: {
    path: '/some/api/path',
    method: 'post' | 'get' | 'put' | 'delete',
    requestBody: { ... },
  },
  input: { 
    searchterm: 'highest attack power'
  },
}
If the matched API is not suitable, explain why it is not suitable in the "reason" field of the JSON object. Always respond in JSON format.`,
          },
          {
            role: 'user',
            content: `Refined Query: ${refinedQuery}\nMatched APIs: ${apiDescription}`,
          },
        ],
        temperature: 0.5,
        max_tokens: 4096, // Increased max_tokens to allow for larger responses
      }),
    });

    if (!response.ok) {
      console.error('Planner API request failed:', await response.text());
      throw new Error('Failed to get a response from the planner.');
    }

    const data = await response.json();
    let content = data.choices[0]?.message?.content || '';

    // Log the raw response for debugging
    console.log('Raw Planner Response:', content);

    // Sanitize the response by removing code block markers
    content = content.replace(/```json|```/g, '').trim();

    // Detect if the response is truncated
    if (!content.endsWith('}')) {
      console.warn('Planner response appears to be truncated:', content);
      content += '...'; // Append ellipsis to indicate truncation
    }

    // Attempt to extract JSON content
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      content = jsonMatch[0];
    } else {
      console.error('Failed to extract JSON from planner response.');
      throw new Error('Invalid planner response format.');
    }

    return content;
  } catch (error) {
    console.error('Error in sendToPlanner:', error);
    throw error;
  }
}

async function craftApiInputFromPlan(plan: string, apiKey: string): Promise<{ api: any; input: any } | null> {
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
            content: `You are an assistant that takes a textual plan and converts it into a valid JSON object with the following structure:
{
  api: {
    path: '/some/api/path',
    method: 'post' | 'get' | 'put' | 'delete',
    requestBody: { ... },
  },
  input: { ... },
}
Ensure the JSON object is well-formed and includes all necessary details for making an API call.`,
          },
          {
            role: 'user',
            content: `Plan: ${plan}`,
          },
        ],
        temperature: 0.5,
        max_tokens: 4096,
      }),
    });

    const data = await response.json();
    let content = data.choices[0]?.message?.content || '';

    // Sanitize the response by removing code block markers和提取JSON内容
    content = content.replace(/```json|```/g, '').trim();

    // 提取JSON内容，如果周围有其他文本
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      content = jsonMatch[0];
    }

    return JSON.parse(content);
  } catch (error) {
    console.error('Failed to craft API input from plan:', error);
    return null;
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
    const { refinedQuery, language } = await clarifyAndRefineUserInput(userMessage.content, apiKey);
    console.log('Refined Query:', refinedQuery);
    console.log('Detected Language:', language);

    // Generate embedding for the refined query
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-ada-002',
        input: refinedQuery,
      }),
    });

    if (!embeddingResponse.ok) {
      const error = await embeddingResponse.json();
      console.warn('OpenAI API error:', error);
      return NextResponse.json(
        { error: 'Failed to generate embedding' },
        { status: embeddingResponse.status }
      );
    }

    const embeddingData = await embeddingResponse.json();
    const queryEmbedding = embeddingData.data[0].embedding;

    // Find top-k similar items
    let topKResults = findTopKSimilar(queryEmbedding);

    console.log('Top-K Similar Results:', topKResults);

    if (topKResults.length === 0) {
      return NextResponse.json(
        { error: 'No matching APIs found' },
        { status: 404 }
      );
    }

    if (topKResults.length > 0) {
      topKResults = topKResults.map((item: any) => {
        const compressedContent = compressLargeJson(item.content, 1500);
        return {
          id: item.id,
          content: compressedContent,
        };
      });
    }

    console.log('Compressed Top-K Results:', topKResults);

    // Send the top API match and refined query to the planner
    let plan = await sendToPlanner(topKResults, refinedQuery, apiKey);
    console.log('Generated Plan:', plan);

    let actionablePlan;
    try {
      if (plan.startsWith('```')) {
        plan = plan.replace(/```json|```/g, '').trim();
        console.log('Sanitized Plan:', plan);
        fs.writeFileSync('temp/sanitized_plan.json', plan);
      }
      actionablePlan = JSON.parse(plan);
    } catch (error) {
      console.warn('Failed to parse planner response as JSON. Attempting to craft API input from plan.');
      actionablePlan = await craftApiInputFromPlan(plan, apiKey);
    }

    if (!actionablePlan || !actionablePlan.api || !actionablePlan.input) {
      return NextResponse.json(
        { error: 'Failed to generate actionable plan' },
        { status: 500 }
      );
    }

    console.log('Actionable Plan:', actionablePlan);
    
    fs.writeFileSync('temp/actionable_plan.json', plan);

    /*
    Actionable Plan: {
      api: {
        id: 'openapi-pokemon.json-post-/pokemon/ability/search',
        content: {
          path: '/pokemon/ability/search',
          method: 'post',
          summary: 'Retrieve Ability by ID or name',
          tags: [Array],
          requestBody: [Object],
          responses: [Object]
        }
      },
      input: { 
        searchterm: 'highest attack power' 
      },
    }
    */

    // Forward the extracted details to handleApiRequest
    const apiResponse = await dynamicApiRequest(
      process.env.NEXT_PUBLIC_ELASTICDASH_API || '', // Assuming baseUrl is part of the API object
      {
        path: actionablePlan.api.path || '/',
        method: actionablePlan.api.method || 'GET',
        requestBody: actionablePlan.api.requestBody || null,
      }
    );

    return NextResponse.json({
      message: 'Execution completed successfully.',
      refinedQuery,
      matchedAPIs: topKResults,
      plan,
      apiResponse,
    });
  } catch (error: any) {
    console.warn('Error in chat API:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
