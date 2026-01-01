import { NextRequest, NextResponse } from 'next/server';
import { clarifyAndRefineUserInput, handleQueryConceptsAndNeeds } from '@/utils/queryRefinement';
import { summarizeMessages, Message } from './messageUtils';
import { runPlannerWithInputs, sanitizePlannerResponse } from './plannerExecution';
import { validateNeedMoreActions } from './validationUtils';
import { extractUsefulDataFromApiResponses } from './dataExtraction';
import { generateFinalAnswer } from './answerSynthesis';
import { fetchRagApisForIntent, sendToPlanner } from './planner';
import { dynamicApiRequest, FanOutRequest } from '@/services/apiService';
import { findApiParameters } from '@/services/apiSchemaLoader';

declare global {
  // Augment the globalThis type to include __rag_entity
  var __rag_entity: string | undefined;
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

    const { refinedQuery, language, concepts, apiNeeds, entities } = await clarifyAndRefineUserInput(queryWithContext);
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

    // Convert Map to array and sort by similarity
    let topKResults: any[] = [];
    
    for (const entity of entities) {
      const results = await fetchRagApisForIntent(entity);
      for (const res of results) {
        if (!topKResults.find(r => r.id === res.id)) {
          topKResults.push(res);
        }
      }
    }

    // Check if RAG search returned no results
    if (topKResults.length === 0) {
      console.warn('⚠️  RAG search returned 0 results - no relevant APIs found');
      return NextResponse.json({
        message: 'Sorry, I am not allowed to do that.',
        refinedQuery,
        topKResults: [],
      });
    }

    const obj = Object.fromEntries(usefulData);
    const str = JSON.stringify(obj, null, 2);

    // 调用独立planner函数
    const { actionablePlan, planResponse: plannerRawResponse } = await runPlannerWithInputs({
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
  let completed = false;


  while (iteration < maxIterations && !completed) {
    iteration++;
    console.log(`\n--- Iteration ${iteration} ---`);

    try {

      console.log('Current Actionable Plan:', JSON.stringify(actionablePlan, null, 2));

      // --- Parameter Type Validation Layer ---
      // If any step uses a parameter with the wrong type (e.g., string for integer), re-invoke the planner with explicit feedback.
      let typeMismatchFound = false;
      let typeMismatchMessage = '';
      if (actionablePlan.execution_plan && actionablePlan.execution_plan.length > 0) {
        for (const step of actionablePlan.execution_plan) {
          if (step.api) {
            // Get parameter schema to check required types
            const parametersSchema = findApiParameters(step.api.path, step.api.method);

            // Check all locations where parameters might be: parameters, input, and requestBody
            const allParams = {
              ...(step.api.parameters || {}),
              ...(step.api.input || {}),
              ...(step.api.requestBody || {})
            };

            // Validate each parameter against its schema
            if (parametersSchema && parametersSchema.length > 0) {
              for (const paramDef of parametersSchema) {
                const paramName = paramDef.name;
                const paramValue = allParams[paramName];

                if (paramValue !== undefined && paramValue !== null) {
                  const expectedType = paramDef.schema?.type;

                  // Type validation for integer/number parameters
                  if ((expectedType === 'integer' || expectedType === 'number') && paramDef.in === 'path') {
                    if (typeof paramValue === 'string' && isNaN(Number(paramValue))) {
                      typeMismatchFound = true;
                      typeMismatchMessage = `ERROR: The API path parameter '${paramName}' requires type '${expectedType}', but a non-numeric string ('${paramValue}') was provided.

CRITICAL RULES:
1. Path parameters like {${paramName}} in '${step.api.path}' MUST be placed in "parameters" or "input", NOT in "requestBody"
2. If you have a name/identifier (like '${paramValue}'), you MUST first call a search/lookup API to find its numeric ID
3. NEVER pass string names directly to ID parameters that expect integers

Required fix: Plan a lookup step BEFORE this step to convert '${paramValue}' to its integer ID.`;
                      break;
                    }
                  }
                }
              }

              if (typeMismatchFound) break;
            }
          }
        }
      }
      if (typeMismatchFound) {
        // Compose a new planner context with explicit error feedback
        const plannerContext = `SYSTEM MESSAGE: ${typeMismatchMessage}\n\nOriginal Query: ${refinedQuery}\n\nPrevious Plan: ${JSON.stringify(actionablePlan, null, 2)}\n\nExecuted Steps So Far: ${JSON.stringify(executedSteps, null, 2)}\n\nAccumulated Results: ${JSON.stringify(accumulatedResults, null, 2)}\n`;
        const obj = Object.fromEntries(usefulData);
        const str = JSON.stringify(obj, null, 2);
        // Re-invoke the planner with the error context
        currentPlanResponse = await sendToPlanner(plannerContext, apiKey, str);
        // Re-parse the new plan
        sanitizedPlanResponse = sanitizePlannerResponse(currentPlanResponse);
        actionablePlan = JSON.parse(sanitizedPlanResponse);
        // Continue to next iteration with the new plan
        continue;
      }

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
            let apiResponse;
            try {
              apiResponse = await dynamicApiRequest(
                process.env.NEXT_PUBLIC_ELASTICDASH_API || '',
                apiSchema,
                userToken // Pass user token for authentication
              );
            } catch (apiError: any) {
              // Check if this is a parameter validation error
              if (apiError.message && apiError.message.includes('Parameter validation failed')) {
                console.error('❌ Parameter validation error during API call:', apiError.message);

                // Extract the detailed error message
                const validationError = apiError.message.replace('Parameter validation failed: ', '');

                // Re-invoke planner with validation error feedback
                const plannerContext = `SYSTEM ERROR: API call failed due to parameter type mismatch.

${validationError}

CRITICAL RULES:
1. Path parameters MUST be placed in "parameters" or "input", NOT in "requestBody"
2. If a parameter expects an integer ID but you have a name/string, you MUST first call a search/lookup API
3. NEVER pass string names directly to integer ID parameters

Original Query: ${refinedQuery}

Previous Plan: ${JSON.stringify(actionablePlan, null, 2)}

Executed Steps So Far: ${JSON.stringify(executedSteps, null, 2)}

Accumulated Results: ${JSON.stringify(accumulatedResults, null, 2)}

Please generate a corrected plan that includes a lookup step FIRST to resolve the name to its integer ID.`;

                const obj = Object.fromEntries(usefulData);
                const str = JSON.stringify(obj, null, 2);

                // Re-invoke the planner (using the OpenAI API key from parent scope)
                currentPlanResponse = await sendToPlanner(plannerContext, process.env.NEXT_PUBLIC_OPENAI_API_KEY!, str);
                sanitizedPlanResponse = sanitizePlannerResponse(currentPlanResponse);
                actionablePlan = JSON.parse(sanitizedPlanResponse);

                // Skip this step and continue to next iteration with new plan
                continue;
              }

              // If it's not a validation error, rethrow
              throw apiError;
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

            // Compose a unique key for API call: method + path + input hash
            const apiKeyBase = apiSchema.method + ' ' + apiSchema.path;
            let inputKey = '';
            try {
              // Use a stable stringification for input
              inputKey = JSON.stringify({ parameters: parametersToUse, requestBody: requestBodyToUse });
            } catch {
              inputKey = '';
            }
            const apiKey = inputKey ? `${apiKeyBase} | ${inputKey}` : apiKeyBase;

            // Extract and clean useful data (no recursive nesting)
            const obj = Object.fromEntries(usefulData);
            const str = JSON.stringify(obj, null, 2);
            const extracted = await extractUsefulDataFromApiResponses(
              refinedQuery,
              finalDeliverable,
              str,
              JSON.stringify(apiResponse)
            );

            // If the same API and input, override; else add new entry
            if (extracted) {
              console.log('Extracted Useful Data:', extracted);
              usefulData.set(apiKey, extracted);
            }

            // Remove any old entries for the same API with different input if needed (optional, for deduplication)
            // [...usefulData.keys()].forEach(key => {
            //   if (key.startsWith(apiKeyBase) && key !== apiKey) usefulData.delete(key);
            // });

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

            // Now validate if we have sufficient information
            console.log('\n🔍 Validating if more actions are needed 1...');
            const validationResult = await validateNeedMoreActions(
              refinedQuery,
              executedSteps,
              accumulatedResults,
              usefulData,
              actionablePlan // Pass the last execution plan
            );

            console.log('Validation result:', validationResult);

            if (!validationResult.needsMoreActions) {
              console.log('✅ Validator confirmed: sufficient information gathered');
              actionablePlan.execution_plan = []; // Clear remaining steps
              completed = true;
              break;
            }
          } // End of for loop (for each stepToExecute)
        } else {
          console.warn(`⚠️  Step ${step.step_number} is not a valid API call (path: ${step.api?.path}, method: ${step.api?.method})`);
          console.warn('This appears to be a computation/logic step. The planner should only generate API call steps.');
          console.warn('Skipping this step and will let validator determine if more API calls are needed.');

          // Don't add invalid steps to executedSteps since no API was actually called
          // The validator will detect that the goal is not met and request proper API steps
        }
        
        if (completed) break; // <-- Add this line

        const obj = Object.fromEntries(usefulData);
        const str = JSON.stringify(obj, null, 2);
        
        // 调用独立planner函数
        let { actionablePlan: actionablePlanNeo, planResponse: plannerRawResponse } = await runPlannerWithInputs({
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
      console.log('\n🔍 Validating if more actions are needed 2...');
      const validationResult = await validateNeedMoreActions(
        refinedQuery,
        executedSteps,
        accumulatedResults,
        usefulData,
        actionablePlan // Pass the last execution plan
      );

      console.log('Validation result:', validationResult);

      if (!validationResult.needsMoreActions) {
        console.log('✅ Validator confirmed: sufficient information gathered');
        completed = true;
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

      if (!completed) {
        currentPlanResponse = await sendToPlanner(plannerContext, apiKey, str);
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

  const usefulDataObj = Object.fromEntries(usefulData);
  const usefulDataStr = JSON.stringify(usefulDataObj, null, 2);

  const finalAnswer = await generateFinalAnswer(
    refinedQuery,
    preparedResults,
    apiKey,
    stoppedReason,
    usefulDataStr
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
