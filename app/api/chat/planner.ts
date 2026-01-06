import { getAllMatchedApis, getTopKResults, fetchPromptFile } from '@/services/chatPlannerService';
import fs from 'fs';
import path from 'path';

/**
 * sendToPlanner: 自主工作流程 - 始终使用 LLM 意图分析 + RAG API 检索 + 单步计划生成
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
  conversationContext?: string,
  planIntentType?: 'FETCH' | 'MODIFY',
  forceFullPlan?: boolean
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
        ? `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nCONVERSATION HISTORY (for context):\n${conversationContext}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`
        : '';

        console.log('conversationContext: ', conversationContext);
        console.log('usefulData: ', usefulData);

      const validatorPrompt = `你是一个【目标完成校验器】。

你的唯一职责:  
**根据「用户目标」和「已有数据」，判断目标是否已经完成。**

你不关心下一步要做什么，也不规划操作。
${contextInfo}
--------------------------------

用户目标:
${refinedQuery}

已有数据（最高优先级，真实 API 返回）:
${usefulData || '无'}

--------------------------------

判定规则（必须严格遵守）：

1. "已有数据" 是可信的唯一事实来源
2. DELETE / INSERT / UPDATE 本身不代表完成
3. 只有以下情况才可判定目标完成：
   - 最近一次【读取语义】结果表明目标已达成
   - 读取语义包括：
     - GET
     - SELECT
     - post /general/sql/query（等效 GET）
4. 如果最后一次读取语义结果明确满足用户目标 → 目标完成
5. 如果不存在满足目标的读取语义结果 → 目标未完成

--------------------------------

输出要求（必须严格匹配）：

- 如果目标已完成，仅输出：
GOAL_COMPLETED

- 如果目标未完成，仅输出：
GOAL_NOT_COMPLETED

不允许输出任何解释或多余文字。

请开始判断：`;

      console.log('📊 Step 0: 验证目标完成情况...');

      const validatorRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: validatorPrompt }],
          temperature: 0.0,
          max_tokens: 256,
        }),
      });

      if (!validatorRes.ok) {
        console.error('Validator LLM request failed:', await validatorRes.text());
        throw new Error('Failed to validate goal completion.');
      }

      const validatorData = await validatorRes.json();
      const validatorText = validatorData.choices[0]?.message?.content.trim() || '';
      console.log('✅ 目标完成验证响应:', validatorText);

      if (validatorText === 'GOAL_COMPLETED') {
        console.log('🎯 目标已完成，返回结果');
        return JSON.stringify({
          needs_clarification: false,
          execution_plan: [],
          message: 'Goal completed with existing data'
        });
      }

      // ==================== Intent 分析 Prompt ====================

      let nextIntent = refinedQuery;
      let intentType = planIntentType || 'FETCH';

      if (!planIntentType) {
        const nextActionPrompt = `你是 API 自动化系统的【下一步操作规划器】。

你的前提条件是:  
**用户目标尚未完成。**
${contextInfo}
--------------------------------

用户目标:
${refinedQuery}

已有数据（真实 API 返回）:
${usefulData || '无'}

--------------------------------

你的任务：

1. 始终以【完成用户原始目标】为唯一终点
2. 分析已有数据，判断距离目标还缺少什么
3. 决定【最关键的单个操作】（不要规划多步）
4. 用一句话描述该操作，包含关键实体和动作
5. 不要判断目标是否完成（这已经在上一步完成）

--------------------------------

输出格式（必须严格匹配）：

{ 
  "description": "一句话描述操作意图", 
  "type": "FETCH" | "MODIFY" 
}

不允许输出任何解释或多余文字。
请开始规划：`;

        // ==================== STEP 1: LLM 分析下一步意图 ====================
        console.log('📊 Step 1: 分析下一步意图...');
        const intentRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: nextActionPrompt }],
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
        nextIntent = intentObj.description?.trim() || '';
        intentType = intentObj.type?.trim() || '';
        console.log('✅ 下一步意图:', nextIntent);

        // 如果目标已完成
        if (nextIntent === 'GOAL_COMPLETED' || nextIntent.includes('GOAL_COMPLETED')) {
          return JSON.stringify({
            needs_clarification: false,
            execution_plan: [],
            message: 'Goal completed with existing data'
          });
        }
      } else {
        console.log(`📊 Intent provided by caller: type=${planIntentType}, intent="${nextIntent}"`);
      }

      // ==================== STEP 2: RAG 检索相关 API 和 Table ====================
      console.log('🔍 Step 2: RAG 检索相关 API 和 Table...');
      let ragApis: any[] = [];
      try {
        // For MODIFY intents: retrieve both tables and APIs
        // For FETCH intents: retrieve only tables
        if (intentType === 'MODIFY') {
          console.log('📊 MODIFY intent: retrieving both TABLE and API resources...');
          const allMatchedApis = await getAllMatchedApis({ entities: [nextIntent], intentType: 'MODIFY', apiKey });
          ragApis = await getTopKResults(allMatchedApis, 20);
          console.log(`✅ 检索到 ${ragApis.length} 个相关资源 (tables + APIs)`);
        } else {
          console.log('📊 FETCH intent: retrieving only TABLE resources...');
          const allMatchedApis = await getAllMatchedApis({ entities: [nextIntent], intentType: 'FETCH', apiKey });
          // Filter to only include table schemas (not REST APIs)
          const allResults = await getTopKResults(allMatchedApis, 20);
          ragApis = allResults.filter((item: any) => 
            item.id && typeof item.id === 'string' && (item.id.startsWith('table-') || item.id === 'sql-query')
          );
          console.log(`✅ 检索到 ${ragApis.length} 个相关表结构 (tables only)`);
        }
      } catch (e) {
        console.warn('⚠️ RAG 检索失败:', e);
        ragApis = [];
      }

      if (ragApis.length === 0) {
        console.warn('⚠️ 未找到相关资源，无法生成执行计划');
        const sorryMessage = `I'm sorry, but there are no relevant ${intentType === 'MODIFY' ? 'APIs, tables, or columns' : 'tables or columns'} in the database schema that can provide information about "${refinedQuery}". Therefore, I am unable to generate a ${intentType === 'MODIFY' ? 'plan or API call' : 'SQL query'} for this request.`;
        return JSON.stringify({
          impossible: true,
          needs_clarification: false,
          message: sorryMessage,
          reason: 'No relevant database resources found',
          execution_plan: []
        });
      }

      fs.writeFileSync(path.join(process.cwd(), 'rag_apis.json'), JSON.stringify(ragApis, null, 2), 'utf-8');

      const ragApiDesc = JSON.stringify(ragApis, null, 2);

      // ==================== STEP 3: LLM 生成执行计划 ====================
      console.log('📝 Step 3: 生成执行计划...');

      const plannerSystemPrompt = await fetchPromptFile(intentType === 'FETCH' ? 'prompt-planner-table.txt' : 'prompt-planner.txt');

      const plannerUserMessage = intentType === 'MODIFY'
        ? `${contextInfo}User's Ultimate Goal: ${refinedQuery}

    You must produce the COMPLETE remaining execution plan (all steps) required to fulfill the goal, including any prerequisite data fetch/resolution steps followed by the modification step(s).

    Rules:
    - IMPORTANT: Consider the conversation history above to understand context and references (e.g., "it", "that item", "the pokemon")
    - Include every remaining step in order; do not stop after the first step.
    - Use TABLE/SQL (POST /general/sql/query) for any lookups/resolution before mutation; keep REST APIs for the actual mutations.
    - You have access to BOTH table schemas AND REST API specifications in the available resources below.
    - Zero placeholders: all parameters must be concrete or omitted.
    - Do not ask the user for info; rely on lookups instead.

    ${forceFullPlan ? '- PRIOR RESPONSE WAS RESOLUTION-ONLY. DO NOT STOP AT RESOLUTION. RETURN THE ENTIRE EXECUTION_PLAN WITH MODIFICATION STEPS INCLUDED.' : ''}

    Available Resources (Tables + APIs): ${ragApiDesc}

    Useful Data: ${usefulData || '无'}

    Output the full execution_plan array covering resolution (SQL queries) + mutation (REST APIs) + validation (SQL queries) steps.`
        : `${contextInfo}User's Ultimate Goal: ${refinedQuery}

    CRITICAL: Your ONLY task is to execute THIS specific step:
    "${nextIntent}"

    DO NOT worry about the ultimate goal (${refinedQuery}) in this step.
    - IMPORTANT: Consider the conversation history above to understand context and references
    - This is a FETCH intent - generate a read-only plan using SQL queries
    - Use TABLE/SQL (POST /general/sql/query) for all data retrieval
    - You have access ONLY to table schemas (no REST APIs for FETCH)

    Focus ONLY on: ${nextIntent}

    Available Resources (Tables only): ${ragApiDesc}

    Useful Data: ${usefulData || '无'}

    IMPORTANT: Execute ONLY the "Next Step Intent" above using SQL queries.`;

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
You are a SQL/schema validator. 
Your job is to check if the SQL query references tables and columns that exist in the provided table schemas.

CRITICAL RULES:
1. The schemas may be in different formats (table metadata, DDL, or field lists in "content")
2. Look CAREFULLY at the "content" field of each schema entry - it often contains the full column definitions
3. Extract table names and column lists from patterns like "table_name(col1, col2, col3)"
4. Common columns like "id", "identifier", "user_id", "pokemon_id" are standard and likely valid
5. CURRENT_USER_ID is a special placeholder, NOT a schema issue - IGNORE IT
6. Only flag OBVIOUS missing tables or clearly wrong column names

Available Table Schemas:
${ragApiDesc}

Current Plan Response:
${plannerResponse}

VALIDATION APPROACH:
- Parse the "content" field carefully - it contains column definitions like "pokemon(id, identifier, ...)"
- If a table is referenced and appears in the schemas, assume standard columns (id, identifier, etc.) exist
- ONLY return needs_clarification: true if a TABLE is completely missing or a column is clearly wrong

Output:
{ "needs_clarification": false } if the query looks reasonable
{ "needs_clarification": true, "reason": "...", "clarification_question": "..." } ONLY for obvious errors`;
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

If intent is MODIFY, return the full remaining execution_plan (all steps, ordered) with "needs_clarification": false.`;

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
          JSON.parse(plannerResponse);
        } catch (e) {
          console.error('Failed to parse retry response:', e);
        }
      }

      // 最终返回
      console.log('🎯 最终执行计划已生成: ' + plannerResponse);
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
