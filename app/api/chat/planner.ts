import { clarifyAndRefineUserInput } from "@/utils/queryRefinement";
import { getAllMatchedApis, getTopKResults, locateKeyEntityInIntention } from "./embeddingSearch";
import { fetchPromptFile } from "./promptUtils";
import { createTempFile } from "./utils";

/**
 * classifyIntent: Classifies a one-sentence intent string as 'fetch' (read) or 'mutate' (write)
 * @param intent - The intent string output by the LLM
 * @returns 'fetch' | 'mutate' | 'unknown'
 */
export async function classifyIntent(intent: string): Promise<'fetch' | 'mutate' | 'unknown'> {
    if (!intent) return 'unknown';
    console.log('intent:', intent);
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.NEXT_PUBLIC_OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an expert at classifying user intents for API actions into two categories: "fetch" (read) or "mutate" (write). Given a one-sentence intent description, determine whether the intent is to retrieve data (fetch) or to modify data (mutate). A single noun is considered "fetch". If the intent is unclear or does not fit either category, classify it as "unknown".',
          },
          {
            role: 'user',
            content: `User's intention: ${intent}`,
          },
        ],
        temperature: 0
      }),
    });
    if (!response.ok) {
      return 'unknown';
    }
    const data = await response.json();
    const classification = data.choices?.[0]?.message?.content?.trim().toLowerCase();
    if (classification === 'fetch' || classification === 'mutate' || classification === 'unknown') {
      return classification;
    }
    return 'unknown';
}

/**
 * sendToPlanner: 自主工作流程 - 始终使用 LLM 意图分析 + RAG API 检索 + 单步计划生成
 * @param apis - 当前可用API schema数组 (已忽略，保留参数以保持向后兼容)
 * @param refinedQuery - 用户精炼后的目标
 * @param apiKey - OpenAI Key
 * @param usefulData - 已有useful data（字符串）
 * @param conversationContext - 对话上下文
 * @returns plannerResponse（JSON字符串，单步执行计划）
 */
export async function sendToPlanner(
  refinedQuery: string,
  apiKey: string,
  usefulData: string,
  conversationContext?: string
): Promise<string> {
  console.log('🚀 Planner 自主工作流程启动');
  console.log('📌 忽略传入的 apis 参数，使用自主 RAG 检索');

  let retryCount = 0;
  const maxRetries = 3;
  let lastPlannerResponse = '';

  while (retryCount < maxRetries) {
    retryCount++;
    try {
      // ==================== STEP 1: LLM 分析下一步意图 ====================
      const contextInfo = conversationContext
        ? `Conversation Context:\n${conversationContext}\n\n`
        : '';


      const intentPrompt = `You are the intelligent decision module of an API automation system. Based on the current state, decide the single most reasonable next action.

    ${contextInfo}User goal: ${refinedQuery}

    Existing data: ${usefulData || 'None'}

    Requirements:
    1. Analyze the user goal and existing data, and determine what is still missing to achieve the goal.
    2. Decide the single most critical next action (do NOT plan multiple steps).
    3. Describe this action intent in one clear sentence, using an explicit action verb from the following list: get, fetch, find, search, list, show, retrieve, read, view, display, count, details, lookup, describe, query, create, add, update, edit, delete, remove, set, change, insert, modify, post, put, patch, write. Do not use ambiguous or project-specific verbs.
    4. If the existing data is sufficient to complete the goal, return "GOAL_COMPLETED".

    Examples:
    - "Get all users"
    - "Fetch details for the specified item"
    - "Create a new record"
    - "Update the user email"
    - "Delete the entry by ID"

    Output only one sentence describing the intent, starting with the action verb. Do not explain.`;

      console.log('📊 Step 1: 分析下一步意图...');
      const intentRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.NEXT_PUBLIC_OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: intentPrompt }],
            temperature: 0,
            max_tokens: 256,
        }),
      });

      if (!intentRes.ok) {
        console.error('Intent analysis failed:', await intentRes.text());
        throw new Error('Failed to analyze next step intent.');
      }

      const intentData = await intentRes.json();
      const nextIntent = intentData.choices[0]?.message?.content?.trim() || '';
      console.log('✅ 下一步意图:', nextIntent);

      // 如果目标已完成
      if (nextIntent === 'GOAL_COMPLETED' || nextIntent.includes('GOAL_COMPLETED')) {
        return JSON.stringify({
          needs_clarification: false,
          execution_plan: [],
          message: 'Goal completed with existing data'
        });
      }

      // ==================== STEP 2: RAG 检索相关 API ====================
      console.log('🔍 Step 2: RAG 检索相关 API...');

      let ragApis = await fetchRagApisForIntent(nextIntent);

      if (ragApis.length === 0) {
        console.warn('⚠️ 未找到相关API，无法生成执行计划');
        return JSON.stringify({
          needs_clarification: true,
          reason: 'No relevant APIs found for the next step',
          clarification_question: `Cannot find APIs to: ${nextIntent}. Please check if the API database is properly configured.`
        });
      }

      const ragApiDesc = JSON.stringify(ragApis, null, 2);

      // ==================== STEP 3: LLM 生成单步执行计划 ====================
      console.log('📝 Step 3: 生成单步执行计划...');

      const plannerSystemPrompt = ragApis.length > 0 && ragApis[0].id.startsWith('semantic') ? await fetchPromptFile('prompt-planner-table.txt') : await fetchPromptFile('prompt-planner.txt');

      const plannerUserMessage = `${contextInfo}Refined Query: ${refinedQuery}

Next Step Intent: ${nextIntent}

Available APIs: ${ragApiDesc}

Useful Data: ${usefulData || 'None'}`;

      createTempFile('planner_input_', plannerUserMessage);

      console.log('📨 发送给 Planner 的用户消息:', plannerUserMessage);

      const plannerRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.NEXT_PUBLIC_OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: plannerSystemPrompt },
                { role: 'user', content: plannerUserMessage },
            ],
            temperature: 0,
            max_tokens: 2048,
        }),
      });

      if (!plannerRes.ok) {
        console.error('Planner API request failed:', await plannerRes.text());
        throw new Error('Failed to get a response from the planner.');
      }

      const plannerData = await plannerRes.json();
      let plannerResponse = plannerData.choices[0]?.message?.content || '';
      plannerResponse = plannerResponse.replace(/```json|```/g, '').trim();

      createTempFile('planner_raw_response_', plannerResponse);

      // 提取JSON
      const jsonMatch = plannerResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        plannerResponse = jsonMatch[0];
      } else {
        throw new Error('Invalid planner response format.');
      }

      console.log('✅ 原始 Planner 响应:', plannerResponse);

      // ==================== 验证和修正 ====================
      let containsAssumption = /\bassume\b|\bassuming\b/i.test(plannerResponse);
      let needsIdClarification = false;
      let needsClarification = false;
      let newIntent = '';

      try {
        const parsed = JSON.parse(plannerResponse);
        needsClarification = parsed.needs_clarification === true;
        newIntent = parsed.reason || '';

        // 验证是否只有单步
        if (parsed.execution_plan && Array.isArray(parsed.execution_plan)) {
          if (parsed.execution_plan.length > 1) {
            console.warn(`⚠️ Planner 生成了 ${parsed.execution_plan.length} 步，需要修正为单步`);
            containsAssumption = true; // 触发重试
          }
        }

        if (needsClarification) {
          const reason = (parsed.reason || '').toLowerCase();
          const question = (parsed.clarification_question || '').toLowerCase();
          // Generalize: Use LLM to detect if clarification is about missing resolvable data (e.g., IDs, codes, enums, metadata)
          const genericClarificationPatterns = [
            /id/i, /identifier/i, /code/i, /enum/i, /metadata/i, /internal/i, /lookup/i, /look up/i, /resolve/i, /missing.*(value|data|info|information)/i, /required.*(value|data|info|information)/i, /does not provide/i, /use an api/i, /using an api/i
          ];
          needsIdClarification = genericClarificationPatterns.some(pattern =>
            pattern.test(reason) || pattern.test(question)
          );
        }
      } catch (e) {
        console.error('Failed to parse planner response:', e);
        throw new Error('Invalid JSON in planner response');
      }

      // 如果需要重新生成（有assumption或需要ID clarification）
      if (containsAssumption || needsIdClarification) {
        const correctionMessage = needsIdClarification
          ? `CRITICAL ERROR: You are asking the user for information that MUST be resolved via API.

You MUST NOT ask for clarification about IDs, identifiers, names, codes, or any information that can be looked up via the provided APIs.

MANDATORY RULES:
1. If you need to resolve a human-readable name to an ID, you MUST use the appropriate search/lookup API.
2. If you need any category, type, status, or entity ID, you MUST use the appropriate lookup endpoint.
3. If you need enum values or internal codes, you MUST use the appropriate API to retrieve them.
4. ONLY ask for clarification if the user's INTENT is ambiguous, NOT if you need to look up data.

The available APIs can resolve these lookups. CREATE AN EXECUTION PLAN with ONLY THE FIRST STEP (step_number: 1) that starts the lookup process.

Return a proper single-step execution_plan with "needs_clarification": false.`
            : `Do NOT assume anything. You MUST only generate a single-step plan (step_number: 1), do NOT generate multi-step plans. Subsequent steps will be decided dynamically after the current step is completed based on the actual result. Regenerate a single-step execution plan.`;

        console.warn(`⚠️ 需要重新生成计划 (retry ${retryCount}/${maxRetries})`);

        // Convert Map to array and sort by similarity
        let topKResults = await fetchRagApisForIntent(newIntent || nextIntent);

        const ragApiDesc = JSON.stringify(topKResults, null, 2);

        const plannerUserMessageRerun = `${contextInfo}Refined Query: ${refinedQuery}

Next Step Intent: ${newIntent || nextIntent}

Available APIs: ${ragApiDesc}

Useful Data: ${usefulData || 'None'}`;

        // 重试时带上correction message
        const retryPlannerRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.NEXT_PUBLIC_OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: plannerSystemPrompt },
              { role: 'user', content: plannerUserMessageRerun },
              { role: 'assistant', content: plannerResponse },
              { role: 'user', content: correctionMessage },
            ],
            temperature: 0,
            max_tokens: 2048,
          }),
        });

        if (!retryPlannerRes.ok) {
          console.error('Retry planner request failed');
          throw new Error('Failed to get retry response from planner');
        }

        const retryData = await retryPlannerRes.json();
        plannerResponse = retryData.choices[0]?.message?.content || '';
        plannerResponse = plannerResponse.replace(/```json|```/g, '').trim();
        const retryJsonMatch = plannerResponse.match(/\{[\s\S]*\}/);
        if (retryJsonMatch) {
          plannerResponse = retryJsonMatch[0];
        }

        console.log('✅ 重试后的 Planner 响应:', plannerResponse);

        // 验证重试后的响应
        try {
          const retryParsed = JSON.parse(plannerResponse);
          if (retryParsed.execution_plan && retryParsed.execution_plan.length > 1) {
            console.warn('⚠️ 重试后仍有多步，截取第一步');
            retryParsed.execution_plan = [retryParsed.execution_plan[0]];
            plannerResponse = JSON.stringify(retryParsed);
          }
        } catch (e) {
          console.error('Failed to parse retry response:', e);
        }
      }

      // 最终验证：确保只有单步
      try {
        const finalParsed = JSON.parse(plannerResponse);
        if (finalParsed.execution_plan && finalParsed.execution_plan.length > 1) {
          console.warn('⚠️ 最终响应仍有多步，强制截取第一步');
          finalParsed.execution_plan = [finalParsed.execution_plan[0]];
          plannerResponse = JSON.stringify(finalParsed);
        }
      } catch (e) {
        console.error('Failed to validate final response:', e);
      }

      // 最终返回
      console.log('🎯 最终单步执行计划已生成');
      lastPlannerResponse = plannerResponse;
      return plannerResponse;

    } catch (error) {
      console.error(`❌ Error in sendToPlanner (attempt ${retryCount}/${maxRetries}):`, error);
      if (retryCount >= maxRetries) {
        // 如果有最后一次的响应，返回它
        if (lastPlannerResponse) {
          console.warn('⚠️ 返回最后一次有效响应');
          return lastPlannerResponse;
        }
        throw error;
      }
      // 继续重试
    }
  }

  throw new Error('Failed to generate plan after maximum retries');
}

export async function fetchRagApisForIntent(
    intent: string
): Promise<any[]> {
    console.log(`🔍 RAG 检索 APIs for intent: ${intent}`);
    try {
        let ragApis: any[] = [];
        try {
            // const keyEntity = await locateKeyEntityInIntention(intent);
            // console.log('🔑 定位到的关键实体:', keyEntity);
            // const allMatchedApis = await getAllMatchedApis(keyEntity || intent);
            // ragApis = await getTopKResults(allMatchedApis, 8);
            const { entities } = await clarifyAndRefineUserInput(intent);
            ragApis = [];
            for (const entity of entities) {
                const allMatchedApis = await getAllMatchedApis(entity);
                const topApis = await getTopKResults(allMatchedApis, 5);
                ragApis.push(...topApis);
            }
            // 去重
            const uniqueApisMap = new Map<string, any>();
            for (const api of ragApis) {
                if (!uniqueApisMap.has(api.id)) {
                    uniqueApisMap.set(api.id, api);
                }
            }
            ragApis = Array.from(uniqueApisMap.values());
            console.log(`✅ 检索到 ${ragApis.length} 个相关 API`);
        } catch (e) {
            console.warn('⚠️ RAG API检索失败:', e);
            ragApis = [];
        }
        return ragApis;
    } catch (error) {
        console.error('❌ Error in fetchRagApisForIntent:', error);
        return [];
    }
}
