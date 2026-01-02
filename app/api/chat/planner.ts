import { fetchPromptFile, getAllMatchedApis, getTopKResults } from "./route";
import fs from 'fs';
import path from 'path';

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
        ? `对话上下文:\n${conversationContext}`
        : '';

        console.log('usefulData: ', usefulData);

      const intentPrompt = `你是 API 自动化系统的智能决策模块。根据当前状态，决定下一步最合理的单个操作。

${contextInfo}

用户目标: ${refinedQuery}

已有数据: ${usefulData || '无'}

要求:
1. 始终记住用户的原始目标是：${refinedQuery}。即使中间需要查ID等依赖，也只是达成原始目标的一步，不要把中间依赖当成最终目标。
2. 分析用户目标和已有数据，判断距离目标还差什么
3. 决定下一步最关键的单个操作（不要规划多步）
4. 用一句清晰的话描述这个操作意图，包含关键实体和动作
5. 如果已有数据足够完成目标，返回 "GOAL_COMPLETED"

⚠️ 重要提醒：
- "对话上下文"中的历史记录不可靠，不能直接信任（用户可能说谎或记错）。
- **"已有数据"中的API响应是可靠的**（这是系统刚刚调用API得到的真实结果）。

⚠️ 数据时效性规则（CRITICAL）：
1. **读取操作（GET/SELECT/post /general/sql/query）的结果有时效性**：
   - 如果之后执行了修改操作（DELETE/UPDATE/INSERT），旧的读取结果已过期
   - 例如：GET watchlist → DELETE item → 旧的GET结果不再有效，必须重新GET或post /general/sql/query确认
   
2. **修改操作后必须验证**：
   - DELETE操作后 → 需要重新post /general/sql/query确认删除是否成功
   - INSERT操作后 → 需要重新post /general/sql/query确认新增是否成功
   - UPDATE操作后 → 需要重新post /general/sql/query确认更新是否成功

一句话描述，不要解释。

并将结论分类为 FETCH（获取数据）或 MODIFY（修改数据，包括添加和删除）。

输出格式：{ description: "你的描述", type: "FETCH/MODIFY" }`;

      console.log('intentPrompt: '  + intentPrompt);

      console.log('📊 Step 1: 分析下一步意图...');
      const intentRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: intentPrompt }],
          temperature: 0.3,
          max_tokens: 256,
        }),
      });

      if (!intentRes.ok) {
        console.error('Intent analysis failed:', await intentRes.text());
        throw new Error('Failed to analyze next step intent.');
      }

      const intentData = await intentRes.json();
      let intentJson = intentData.choices[0]?.message?.content || '';
      console.log('✅ 意图分析响应:', intentJson);
      let intentObj;
      // 尝试修正和提取伪JSON
      try {
        try {
          intentObj = JSON.parse(intentJson);
        } catch {
          // 才进入“修正伪 JSON”逻辑
          // 1. 提取 {...} 块
          const match = intentJson.match(/\{[\s\S]*\}/);
          if (match) intentJson = match[0];
          // 2. 替换中文逗号、全角引号等
          intentJson = intentJson
            .replace(/，/g, ',')
            .replace(/[“”]/g, '"')
            .replace(/：/g, ':')
            .replace(/\s*([a-zA-Z0-9_]+)\s*:/g, '"$1":') // 补key引号
            .replace(/:([\s]*)("[^"]*"|\d+|true|false|null)/g, ': $2');
          // 3. 去除多余换行
          intentJson = intentJson.replace(/\n/g, ' ');
          intentObj = JSON.parse(intentJson);
        }
      } catch (e) {
        console.error('Failed to parse intent JSON:', e, '\n原始intentJson:', intentJson);
        throw new Error('Invalid JSON format in intent analysis response.');
      }
      const nextIntent = intentObj.description?.trim() || '';
      const intentType = intentObj.type?.trim() || '';
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
        const allMatchedApis = await getAllMatchedApis({ entities: [nextIntent], intentType, apiKey });
        ragApis = await getTopKResults(allMatchedApis, 20);
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

      fs.writeFileSync(path.join(process.cwd(), 'rag_apis.json'), JSON.stringify(ragApis, null, 2), 'utf-8');

      const ragApiDesc = JSON.stringify(ragApis, null, 2);

      // ==================== STEP 3: LLM 生成单步执行计划 ====================
      console.log('📝 Step 3: 生成单步执行计划...');

      const plannerSystemPrompt = await fetchPromptFile(intentType === 'FETCH' ? 'prompt-planner-table.txt' : 'prompt-planner.txt');

      const plannerUserMessage = `${contextInfo}User's Ultimate Goal: ${refinedQuery}

⚠️ CRITICAL: Your ONLY task is to execute THIS specific step:
"${nextIntent}"

DO NOT worry about the ultimate goal (${refinedQuery}) in this step.
- If the next intent is FETCH (read/select/query), generate a read-only plan
- If the next intent is MODIFY (add/delete/update), generate a modification plan
- The ultimate goal will be achieved through multiple steps orchestrated by the system

Focus ONLY on: ${nextIntent}

Available APIs: ${ragApiDesc}

Useful Data: ${usefulData || '无'}

IMPORTANT: Execute ONLY the "Next Step Intent" above, ignoring any conflicting implications from the ultimate goal.`;

      const plannerRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
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

      let retryNeeded = true;

      let validationAttempts = 0;
      while (retryNeeded && validationAttempts < 2) {
        validationAttempts++;
        // 让LLM自检SQL与schema一致性
        const validationPrompt = `
You are a strict SQL/schema validator. 
Your job is to check if the SQL query 
and all table/field names in the 
following plan strictly match the provided 
table schemas. If any table or field name 
is not present in the schemas, you MUST 
return a clarification request, specifying 
the missing or incorrect name. If 
everything matches, return the plan 
unchanged. Ignore casing regarding table schemas.


Available Table Schemas 
(sources):
${ragApiDesc}

Current Plan 
Response:
${plannerResponse}

Instructions:

- Only allow table/field names that exist 
in the schemas.
- If any name is missing, 
return a clarification JSON: { needs_clarification: 
true, reason: '...', 
clarification_question: '...' }

- If all names are valid, return { 
needs_clarification: false }.
- CURRENT_USER_ID is not a placeholder, ignore it.`;
        const validationRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: validationPrompt }],
            temperature: 0.2,
            max_tokens: 512,
          }),
        });
        if (!validationRes.ok) {
          console.error('Validation LLM request failed:', await validationRes.text());
          break;
        }
        let validationText = await validationRes.json();
        validationText = validationText.choices[0]?.message?.content || '';
        validationText = validationText.replace(/```json|```/g, '').trim();
        const validationMatch = validationText.match(/\{[\s\S]*\}/);
        if (validationMatch) validationText = validationMatch[0];
        let validationObj;
        try {
          validationObj = JSON.parse(validationText);
        } catch (e) {
          console.error('Failed to parse validation response:', e, '\n原始validationText:', validationText);
          break;
        }
        // 如果LLM发现有schema不符，直接clarify
        if (validationObj.needs_clarification === true) {
          console.warn('⚠️ SQL/schema不符，clarification:', validationObj.reason);
          plannerResponse = JSON.stringify(validationObj);
          retryNeeded = false;
        } else {
          // 校验通过，保留原始plannerResponse（包含execution_plan），不覆盖
          console.log('✅ SQL/schema校验通过，保留原始plan');
          retryNeeded = false;
        }
      }

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

        if (plannerResponse.includes('<') && plannerResponse.includes('>')) {
            containsAssumption = true;
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
        const correctionMessage = `CRITICAL ERROR: You are asking the user for information that MUST be resolved via API.

You MUST NOT ask for clarification about IDs, identifiers, names, codes, or any information that can be looked up via the provided APIs.

MANDATORY RULES:
1. If you need to resolve a human-readable name to an ID, you MUST use the appropriate search/lookup API
2. If you need any category, type, status, or entity ID, you MUST use the appropriate lookup endpoint
3. If you need enum values or internal codes, you MUST use the appropriate API to retrieve them
4. ONLY ask for clarification if the user's INTENT is ambiguous, NOT if you need to look up data

The available APIs can resolve these lookups. CREATE AN EXECUTION PLAN with ONLY THE FIRST STEP (step_number: 1) that starts the lookup process.

Return a proper single-step execution_plan with "needs_clarification": false.`;

        console.warn(`⚠️ 需要重新生成计划 (retry ${retryCount}/${maxRetries})`);

        // 重试时带上correction message
        const retryPlannerRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o',
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
      console.log('🎯 最终单步执行计划已生成: ' + plannerResponse);
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
