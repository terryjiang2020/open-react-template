import { getAllMatchedApis, getTopKResults } from "./embeddingSearch";
import { fetchPromptFile } from "./promptUtils";

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
  apis: any[],
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
        ? `对话上下文:\n${conversationContext}\n\n`
        : '';

      const intentPrompt = `你是 API 自动化系统的智能决策模块。根据当前状态，决定下一步最合理的单个操作。

${contextInfo}用户目标: ${refinedQuery}

已有数据: ${usefulData || '无'}

要求:
1. 分析用户目标和已有数据，判断距离目标还差什么
2. 决定下一步最关键的单个操作（不要规划多步）
3. 用一句清晰的话描述这个操作意图，包含关键实体和动作
4. 如果已有数据足够完成目标，返回 "GOAL_COMPLETED"

示例:
- "搜索所有Flying类型的宝可梦"
- "根据已有的team id列表，获取第一个team的详细信息"
- "查找Attack属性ID"

只输出一句话描述，不要解释。`;

      console.log('📊 Step 1: 分析下一步意图...');
      const intentRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'system', content: intentPrompt }],
          temperature: 0.3,
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
      let ragApis: any[] = [];
      try {
        const allMatchedApis = await getAllMatchedApis({ entities: [nextIntent], apiKey });
        ragApis = await getTopKResults(allMatchedApis, 8);
        console.log(`✅ 检索到 ${ragApis.length} 个相关 API`);
      } catch (e) {
        console.warn('⚠️ RAG API检索失败:', e);
        ragApis = [];
      }

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

      const plannerSystemPrompt = await fetchPromptFile('prompt-planner.txt');
      const singleStepInstruction = `
CRITICAL: 你必须只生成单步执行计划（step_number: 1），不要生成多步计划。
原因: 后续步骤需要根据当前步骤的实际结果动态决定，无法提前规划。

生成格式:
{
  "needs_clarification": false,
  "execution_plan": [
    {
      "step_number": 1,
      "description": "具体操作描述",
      "api": {
        "path": "/api/path",
        "method": "get/post",
        "parameters": {...},
        "requestBody": {...}
      }
    }
  ]
}

如果传统上需要多步才能完成（比如先查ID再用ID查详情），也只生成第一步，后续步骤留给下次调用。`;

      const plannerUserMessage = `${contextInfo}Refined Query: ${refinedQuery}

Next Step Intent: ${nextIntent}

Available APIs: ${ragApiDesc}

Useful Data: ${usefulData || '无'}

${singleStepInstruction}`;

      const plannerRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: plannerSystemPrompt },
            { role: 'user', content: plannerUserMessage },
          ],
          temperature: 0.5,
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

      try {
        const parsed = JSON.parse(plannerResponse);
        needsClarification = parsed.needs_clarification === true;

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
1. If you need to resolve a human-readable name to an ID, you MUST use the appropriate search/lookup API
2. If you need any category, type, status, or entity ID, you MUST use the appropriate lookup endpoint
3. If you need enum values or internal codes, you MUST use the appropriate API to retrieve them
4. ONLY ask for clarification if the user's INTENT is ambiguous, NOT if you need to look up data

The available APIs can resolve these lookups. CREATE AN EXECUTION PLAN with ONLY THE FIRST STEP (step_number: 1) that starts the lookup process.

Return a proper single-step execution_plan with "needs_clarification": false.`
          : `不准给我assume任何东西。而且你必须只生成单步计划（step_number: 1），不要生成多步计划。后续步骤会在当前步骤完成后根据实际结果动态决定。重新生成单步执行计划。`;

        console.warn(`⚠️ 需要重新生成计划 (retry ${retryCount}/${maxRetries})`);

        // 重试时带上correction message
        const retryPlannerRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: plannerSystemPrompt },
              { role: 'user', content: plannerUserMessage },
              { role: 'assistant', content: plannerResponse },
              { role: 'user', content: correctionMessage },
            ],
            temperature: 0.5,
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
