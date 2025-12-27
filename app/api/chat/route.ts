import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ToolCall {
  tool_name: string;
  arguments?: Record<string, any>;
  method?: string; // HTTP方法: GET, POST, PUT, DELETE等
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

function loadApiModule(moduleId: string): string | null {
  try {
    const indexPath = path.join(process.cwd(), 'src/doc/api-index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));

    const module = index.modules.find((m: any) => m.id === moduleId);
    if (!module) {
      console.error(`Module "${moduleId}" not found in index`);
      return null;
    }

    const modulePath = path.join(process.cwd(), 'src/doc', module.file);
    return fs.readFileSync(modulePath, 'utf-8');
  } catch (error) {
    console.error(`Error loading module "${moduleId}":`, error);
    return null;
  }
}

// 检测响应是否为文档加载请求
function isDocLoadRequest(content: string): boolean {
  try {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) return false;

    const parsed = JSON.parse(trimmed);
    return parsed.load_docs && Array.isArray(parsed.load_docs);
  } catch {
    return false;
  }
}

// 检测响应是否为clarification请求
function isClarificationRequest(content: string): boolean {
  try {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) return false;

    const parsed = JSON.parse(trimmed);
    return parsed.clarification && typeof parsed.clarification === 'string';
  } catch {
    return false;
  }
}

// 检测响应是否为单个工具调用JSON
function isSingleToolCall(content: string): boolean {
  try {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) return false;

    const parsed = JSON.parse(trimmed);
    return parsed.tool_name && typeof parsed.tool_name === 'string';
  } catch {
    return false;
  }
}

// 检测响应是否为工具调用数组JSON
function isToolCallResponse(content: string): boolean {
  try {
    const trimmed = content.trim();
    if (!trimmed.startsWith('[')) return false;

    const parsed = JSON.parse(trimmed);
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
        'description', 'title', 'content'
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

// 执行API调用
async function executeToolCall(
  toolCall: ToolCall,
  index: number,
  total: number
): Promise<{ result: string; log: ToolCallLog }> {
  try {
    // 确定使用哪个基础URL
    const isElasticDashApi = !toolCall.tool_name.startsWith('/api/v2/');
    const baseUrl = isElasticDashApi
      ? (process.env.ELASTICDASH_API || 'https://api.elasticdash.com')
      : (process.env.POKEMON_API || 'https://pokeapi.co');

    let url = `${baseUrl}${toolCall.tool_name}`;

    // 处理路径参数（替换{id}等占位符）
    if (toolCall.arguments) {
      for (const [key, value] of Object.entries(toolCall.arguments)) {
        const placeholder = `{${key}}`;
        if (url.includes(placeholder)) {
          url = url.replace(placeholder, String(value));
        }
      }

      // 处理查询参数（如果URL中没有占位符，则作为查询参数）
      const unusedParams = Object.entries(toolCall.arguments).filter(
        ([key]) => !toolCall.tool_name.includes(`{${key}}`)
      );

      if (unusedParams.length > 0) {
        const queryString = new URLSearchParams(
          unusedParams.map(([k, v]) => [k, String(v)])
        ).toString();
        url += `?${queryString}`;
      }
    }

    // 获取HTTP方法（从arguments中提取，默认为GET）
    const method = (toolCall.arguments?.method || 'GET').toUpperCase();

    // 从arguments中移除method字段，剩余的作为实际参数
    const actualArguments = { ...toolCall.arguments };
    delete actualArguments.method;

    console.log('\n' + '='.repeat(80));
    console.log(`🔧 [${index + 1}/${total}] TOOL CALL`);
    console.log('='.repeat(80));
    console.log('Tool Name:', toolCall.tool_name);
    console.log('HTTP Method:', method);
    console.log('Arguments:', JSON.stringify(actualArguments, null, 2));
    console.log('API Type:', isElasticDashApi ? 'ElasticDash' : 'Pokemon');
    console.log('Full URL:', url);
    console.log('-'.repeat(80));

    // 构建请求头
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    // 如果是ElasticDash API，添加Bearer token
    if (isElasticDashApi) {
      const token = process.env.ELASTICDASH_TOKEN;
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
        console.log('🔐 Authentication: Bearer token added');
      } else {
        console.log('⚠️  Warning: ELASTICDASH_TOKEN not found in environment');
      }
    }

    // 构建请求配置
    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    // 对于POST、PUT、PATCH等需要body的请求，添加请求体
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      // 如果URL没有查询参数，将actualArguments作为body
      if (!url.includes('?') && Object.keys(actualArguments).length > 0) {
        fetchOptions.body = JSON.stringify(actualArguments);
        console.log('📤 Request body:', JSON.stringify(actualArguments, null, 2));
      }
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorMsg = `API调用失败: ${response.status} ${response.statusText}`;
      console.log('❌ Error:', errorMsg);
      console.log('='.repeat(80) + '\n');

      const log: ToolCallLog = {
        tool_name: toolCall.tool_name,
        arguments: toolCall.arguments || {},
        url,
        response_size: 0,
        compressed: false,
        response_preview: errorMsg,
        response_data: null
      };

      return { result: errorMsg, log };
    }

    const data = await response.json();
    const jsonString = JSON.stringify(data, null, 2);

    // 检查响应大小并智能压缩
    const tokens = estimateTokens(jsonString);
    console.log(`📦 Response size: ~${tokens} tokens (${jsonString.length} chars)`);

    console.log('\n📥 API RESPONSE (Original):');
    console.log('-'.repeat(80));
    // 显示前500个字符的响应预览
    if (jsonString.length > 500) {
      console.log(jsonString.substring(0, 500) + '\n... (truncated for display)');
    } else {
      console.log(jsonString);
    }
    console.log('-'.repeat(80));

    let finalResult: string;
    let wasCompressed = false;

    if (tokens > 1500) {
      console.log(`⚠️  Large response detected, compressing...`);
      const compressed = compressLargeJson(jsonString);
      console.log(`✅ Compressed to: ~${estimateTokens(compressed)} tokens`);
      console.log('\n📤 COMPRESSED RESPONSE:');
      console.log('-'.repeat(80));
      console.log(compressed);
      console.log('-'.repeat(80));
      console.log('='.repeat(80) + '\n');
      finalResult = compressed;
      wasCompressed = true;
    } else {
      console.log('✅ Response within size limit, no compression needed');
      console.log('='.repeat(80) + '\n');
      finalResult = jsonString;
    }

    const log: ToolCallLog = {
      tool_name: toolCall.tool_name,
      arguments: toolCall.arguments || {},
      url,
      response_size: tokens,
      compressed: wasCompressed,
      response_preview: jsonString.substring(0, 200) + (jsonString.length > 200 ? '...' : ''),
      response_data: data // 保存完整的JSON对象
    };

    return { result: finalResult, log };
  } catch (error) {
    console.error('❌ Error executing tool call:', error);
    console.log('='.repeat(80) + '\n');

    const errorMsg = `执行API调用时发生错误: ${error instanceof Error ? error.message : String(error)}`;
    const log: ToolCallLog = {
      tool_name: toolCall.tool_name,
      arguments: toolCall.arguments || {},
      url: '',
      response_size: 0,
      compressed: false,
      response_preview: errorMsg,
      response_data: null
    };

    return { result: errorMsg, log };
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
        max_tokens: 300,
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
  } catch (error) {
    console.error('Error summarizing messages:', error);
  }

  // 如果摘要失败，返回最近的消息
  return recentMessages;
}

interface ToolCallLog {
  tool_name: string;
  arguments: Record<string, any>;
  url: string;
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

export async function POST(request: NextRequest) {
  try {
    const { messages } = await request.json();

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: 'Invalid messages format' },
        { status: 400 }
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'OpenAI API key not configured' },
        { status: 500 }
      );
    }

    // 加载系统配置
    const systemPrompt = loadSystemPrompt();
    const apiIndex = loadApiIndex();

    // 处理消息上下文（摘要如果需要）
    const processedMessages = await summarizeMessages(messages, apiKey);

    // 构建完整的消息数组，确保系统提示和API索引始终在最前面
    let conversationMessages = [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'system',
        content: `以下是可用的API模块索引（api-index.json）：\n\n${apiIndex}\n\n如果你需要某个模块的详细文档，使用 {"load_docs": ["module_id"]} 格式请求加载。`,
      },
      ...processedMessages,
    ];

    // 跟踪已加载的模块，避免重复加载
    const loadedModules = new Set<string>();

    // 工具调用循环：重复直到获得文本响应
    const MAX_ITERATIONS = 10; // 防止无限循环
    let iteration = 0;
    let finalResponse = '';
    const toolCallLogs: ToolCallLog[] = []; // 记录所有工具调用
    const iterationLogs: IterationLog[] = []; // 记录所有迭代

    console.log('\n' + '╔' + '═'.repeat(78) + '╗');
    console.log('║' + ' '.repeat(20) + '🚀 STARTING CHAT PROCESSING' + ' '.repeat(29) + '║');
    console.log('╚' + '═'.repeat(78) + '╝\n');

    while (iteration < MAX_ITERATIONS) {
      iteration++;
      console.log(`\n▶️  Starting iteration ${iteration}/${MAX_ITERATIONS}...`);

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: conversationMessages,
          temperature: 0.7,
          max_tokens: 2000,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error('OpenAI API error:', error);
        return NextResponse.json(
          { error: 'Failed to get response from OpenAI' },
          { status: response.status }
        );
      }

      const data = await response.json();
      const assistantMessage = data.choices[0]?.message?.content || '';

      // 检测是否为clarification请求
      if (isClarificationRequest(assistantMessage)) {
        console.log('\n' + '█'.repeat(80));
        console.log(`❓ ITERATION ${iteration}: CLARIFICATION REQUEST`);
        console.log('█'.repeat(80));

        const clarification = JSON.parse(assistantMessage.trim());
        console.log('\n💬 Clarification needed:', clarification.clarification);
        console.log('█'.repeat(80) + '\n');

        // 记录迭代
        iterationLogs.push({
          iteration,
          type: 'clarification',
          llm_output: assistantMessage,
          details: { question: clarification.clarification }
        });

        // 将clarification作为最终响应返回给用户
        finalResponse = clarification.clarification;
        break;
      }

      // 检测是否为文档加载请求
      if (isDocLoadRequest(assistantMessage)) {
        console.log('\n' + '█'.repeat(80));
        console.log(`📚 ITERATION ${iteration}: DOCUMENTATION LOAD REQUEST`);
        console.log('█'.repeat(80));

        const loadRequest = JSON.parse(assistantMessage.trim());
        const moduleIds: string[] = loadRequest.load_docs;

        console.log('\n📋 Requested modules:', moduleIds);
        console.log('-'.repeat(80));

        const loadedDocs: string[] = [];
        const newModules: string[] = [];

        for (const moduleId of moduleIds) {
          if (loadedModules.has(moduleId)) {
            console.log(`⏭️  Module "${moduleId}" already loaded, skipping...`);
            continue;
          }

          console.log(`📥 Loading module: ${moduleId}`);
          const doc = loadApiModule(moduleId);

          if (doc) {
            loadedDocs.push(`Module: ${moduleId}\n${doc}`);
            loadedModules.add(moduleId);
            newModules.push(moduleId);
            console.log(`✅ Module "${moduleId}" loaded successfully`);
          } else {
            console.log(`❌ Failed to load module "${moduleId}"`);
            loadedDocs.push(`Module: ${moduleId}\nError: Module not found or failed to load`);
          }
        }

        if (newModules.length > 0) {
          // 添加加载的文档到对话
          conversationMessages.push({
            role: 'assistant',
            content: assistantMessage,
          });

          conversationMessages.push({
            role: 'system',
            content: `已加载以下模块的详细文档：\n\n${loadedDocs.join('\n\n---\n\n')}`,
          });

          console.log(`\n📊 Loaded ${newModules.length} new module(s)`);
          console.log(`📝 Total modules loaded: ${loadedModules.size}`);

          // 记录迭代
          iterationLogs.push({
            iteration,
            type: 'doc_load',
            llm_output: assistantMessage,
            details: {
              requested: moduleIds,
              loaded: newModules,
              total_loaded: loadedModules.size
            }
          });
        } else {
          console.log('\n⚠️  No new modules were loaded');

          // 记录迭代（即使没有加载新模块）
          iterationLogs.push({
            iteration,
            type: 'doc_load',
            llm_output: assistantMessage,
            details: {
              requested: moduleIds,
              loaded: [],
              already_loaded: true
            }
          });
        }

        console.log('\n🔄 Continuing to next iteration...\n');

        // 继续循环，让LLM处理加载的文档
        continue;
      }

      // 检测是否为单个工具调用
      if (isSingleToolCall(assistantMessage)) {
        console.log('\n' + '█'.repeat(80));
        console.log(`🤖 ITERATION ${iteration}: SINGLE TOOL CALL DETECTED`);
        console.log('█'.repeat(80));

        // 解析单个工具调用，转换为数组格式处理
        const singleCall: ToolCall = JSON.parse(assistantMessage.trim());
        const toolCalls: ToolCall[] = [singleCall];

        console.log('\n📋 LLM OUTPUT (Single Tool Call):');
        console.log('-'.repeat(80));
        console.log(JSON.stringify(singleCall, null, 2));
        console.log('-'.repeat(80));
        console.log(`\n🚀 Executing tool call...`);

        // 执行工具调用（复用数组处理逻辑）
        const toolResults: string[] = [];

        for (let i = 0; i < toolCalls.length; i++) {
          const toolCall = toolCalls[i];
          console.log(`Processing tool ${i + 1}/${toolCalls.length}: ${toolCall.tool_name}`);

          const { result, log } = await executeToolCall(toolCall, i, toolCalls.length);
          toolCallLogs.push(log);
          toolResults.push(`[工具 ${i + 1}/${toolCalls.length}]\n路由: ${toolCall.tool_name}\n结果:\n${result}`);
        }

        console.log('\n' + '▓'.repeat(80));
        console.log('✅ TOOL CALL COMPLETED');
        console.log('▓'.repeat(80));

        const toolResultMessage = `工具调用结果：\n\n${toolResults.join('\n\n---\n\n')}`;
        const resultTokens = estimateTokens(toolResultMessage);
        console.log(`\n📊 Tool result size: ~${resultTokens} tokens`);

        if (resultTokens > 3000) {
          console.log('\n⚠️  Large tool results detected (>3000 tokens), optimizing context...');
          console.log(`📝 Messages before optimization: ${conversationMessages.length}`);

          const systemMessages = conversationMessages.filter(m => m.role === 'system').slice(0, 2);
          const recentUserMessages = conversationMessages
            .filter(m => m.role === 'user')
            .slice(-2);

          conversationMessages = [
            ...systemMessages,
            { role: 'system', content: '(之前的对话已压缩以节省空间)' },
            ...recentUserMessages,
          ];

          console.log(`✅ Messages after optimization: ${conversationMessages.length}`);
          console.log('🔒 System prompts preserved: prompt.txt + api-index.json');
        }

        conversationMessages.push({
          role: 'assistant',
          content: assistantMessage,
        });

        conversationMessages.push({
          role: 'system',
          content: toolResultMessage,
        });

        iterationLogs.push({
          iteration,
          type: 'tool_call',
          llm_output: assistantMessage,
          details: {
            tool_calls: toolCalls.map((tc, i) => ({
              tool_name: tc.tool_name,
              arguments: tc.arguments,
              method: tc.method || 'GET',
              ...toolCallLogs[toolCallLogs.length - toolCalls.length + i]
            }))
          }
        });

        console.log('\n🔄 Sending tool results back to LLM for processing...\n');
        continue;
      }

      // 检测是否为工具调用数组
      if (isToolCallResponse(assistantMessage)) {
        console.log('\n' + '█'.repeat(80));
        console.log(`🤖 ITERATION ${iteration}: TOOL CALL ARRAY DETECTED`);
        console.log('█'.repeat(80));

        // 解析工具调用
        const toolCalls: ToolCall[] = JSON.parse(assistantMessage.trim());

        console.log('\n📋 LLM OUTPUT (Tool Call JSON):');
        console.log('-'.repeat(80));
        console.log(JSON.stringify(toolCalls, null, 2));
        console.log('-'.repeat(80));
        console.log(`\n🚀 Executing ${toolCalls.length} tool call(s) in sequence...`);

        // 执行所有工具调用（按顺序从上到下）
        const toolResults: string[] = [];

        for (let i = 0; i < toolCalls.length; i++) {
          const toolCall = toolCalls[i];
          console.log(`Processing tool ${i + 1}/${toolCalls.length}: ${toolCall.tool_name}`);

          const { result, log } = await executeToolCall(toolCall, i, toolCalls.length);
          toolCallLogs.push(log); // 记录日志
          toolResults.push(`[工具 ${i + 1}/${toolCalls.length}]\n路由: ${toolCall.tool_name}\n结果:\n${result}`);
        }

        console.log('\n' + '▓'.repeat(80));
        console.log('✅ ALL TOOL CALLS COMPLETED');
        console.log('▓'.repeat(80));

        // 将工具结果添加到对话中
        const toolResultMessage = `工具调用结果：\n\n${toolResults.join('\n\n---\n\n')}`;

        // 检查工具结果的token大小
        const resultTokens = estimateTokens(toolResultMessage);
        console.log(`\n📊 Combined tool results size: ~${resultTokens} tokens`);

        // 如果工具结果太大，可能需要清理旧消息以保留system prompt
        if (resultTokens > 3000) {
          console.log('\n⚠️  Large tool results detected (>3000 tokens), optimizing context...');
          console.log(`📝 Messages before optimization: ${conversationMessages.length}`);

          // 保留system prompts（前2条）和最近的关键消息
          const systemMessages = conversationMessages.filter(m => m.role === 'system').slice(0, 2);
          const recentUserMessages = conversationMessages
            .filter(m => m.role === 'user')
            .slice(-2);

          conversationMessages = [
            ...systemMessages,
            { role: 'system', content: '(之前的对话已压缩以节省空间)' },
            ...recentUserMessages,
          ];

          console.log(`✅ Messages after optimization: ${conversationMessages.length}`);
          console.log('🔒 System prompts preserved: prompt.txt + openapi-index.json');
        }

        // 添加工具调用和结果到对话
        conversationMessages.push({
          role: 'assistant',
          content: assistantMessage,
        });

        conversationMessages.push({
          role: 'system',
          content: toolResultMessage,
        });

        // 记录迭代
        iterationLogs.push({
          iteration,
          type: 'tool_call',
          llm_output: assistantMessage,
          details: {
            tool_calls: toolCalls.map((tc, i) => ({
              tool_name: tc.tool_name,
              arguments: tc.arguments,
              ...toolCallLogs[toolCallLogs.length - toolCalls.length + i]
            }))
          }
        });

        console.log('\n🔄 Sending tool results back to LLM for processing...\n');

        // 继续循环，让LLM处理工具结果
        continue;
      } else {
        // 获得文本响应，结束循环
        console.log('\n' + '█'.repeat(80));
        console.log(`✨ ITERATION ${iteration}: FINAL TEXT RESPONSE RECEIVED`);
        console.log('█'.repeat(80));
        console.log('\n💬 LLM FINAL OUTPUT:');
        console.log('-'.repeat(80));
        console.log(assistantMessage);
        console.log('-'.repeat(80));
        console.log(`\n📏 Response length: ${assistantMessage.length} chars (~${estimateTokens(assistantMessage)} tokens)`);
        console.log('█'.repeat(80) + '\n');

        // 记录迭代
        iterationLogs.push({
          iteration,
          type: 'text_response',
          llm_output: assistantMessage,
          details: {
            length: assistantMessage.length,
            tokens: estimateTokens(assistantMessage)
          }
        });

        finalResponse = assistantMessage;
        break;
      }
    }

    if (iteration >= MAX_ITERATIONS) {
      console.error('\n❌ Maximum iterations reached!');
      console.log('═'.repeat(80) + '\n');
      finalResponse = '抱歉，处理您的请求时遇到了问题。请尝试重新表述您的问题。';
    }

    console.log('\n' + '╔' + '═'.repeat(78) + '╗');
    console.log('║' + ' '.repeat(20) + '✅ CHAT PROCESSING COMPLETED' + ' '.repeat(28) + '║');
    console.log('╚' + '═'.repeat(78) + '╝');
    console.log(`\n📊 Summary:`);
    console.log(`   • Total iterations: ${iteration}`);
    console.log(`   • Tool calls made: ${toolCallLogs.length}`);
    console.log(`   • Context summarized: ${processedMessages.length < messages.length ? 'Yes' : 'No'}`);
    console.log(`   • Final response length: ${finalResponse.length} chars\n`);

    return NextResponse.json({
      message: finalResponse,
      summarized: processedMessages.length < messages.length,
      iterations: iteration,
      tool_calls: toolCallLogs,
      iteration_logs: iterationLogs
    });
  } catch (error) {
    console.error('Error in chat API:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
