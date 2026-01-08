import { selectReferenceTask } from "@/services/taskSelectorService";
import { fetchTaskList, SavedTask } from "@/services/taskService";
import path from 'path';
import fs from 'fs';

export async function clarifyAndRefineUserInput(
  userInput: string,
  apiKey: string,
  userToken?: string
): Promise<{ 
  refinedQuery: string,
  language: string,
  concepts: string[],
  apiNeeds: string[],
  entities: string[],
  intentType: "FETCH" | "MODIFY",
  referenceTask?: SavedTask
}> {
  // Extract current query from context if present
  let currentQuery = userInput;
  let contextHistory = '';
  
  const contextMatch = userInput.match(/^Previous context:\n([\s\S]*?)\n\nCurrent query: (.+)$/);
  if (contextMatch) {
    contextHistory = contextMatch[1];
    currentQuery = contextMatch[2];
  }
  
  // Build the prompt with CURRENT query emphasized as PRIMARY
  const systemPrompt = `You are an assistant that refines user queries and identifies what needs to be investigated to answer them.

CRITICAL - DATABASE RULES:
==========================
1. ALL identifiers in the database are LOWERCASE with HYPHENS (not spaces)
   - "Pikachu" → stored as "pikachu" 
   - "Primal Groudon" → stored as "primal-groudon"
   - "Thunder Shock" → stored as "thunder-shock"
   - "Nidoran♂" → stored as "nidoran-m"

2. When the user mentions an entity name, convert it to the database format (lowercase, hyphens)
   - This is important for query refinement and entity extraction
   - Keep track of the original user term AND the database identifier format

3. Many entities have separate name tables for localization:
   - pokemon ← pokemon_species_names (local_language_id=9 for English)
   - moves ← move_names (local_language_id=9 for English)
   - abilities ← ability_names (local_language_id=9 for English)
   - When generating queries, may need to JOIN these tables

IMPORTANT: The user input may contain conversation history. When present:
- Pay attention to previous context to resolve references like "it", "them", "that", "this", "its", "their"
- Look for previously mentioned entities or subjects
- The format will be "Previous context:\n[previous messages]\n\nCurrent query: [actual query]"
- Resolve references in the current query by connecting them to entities in previous context
- Example: If previous message mentioned "Pikachu" and current query is "show me its moves", resolve to "show me Pikachu's moves"

CRITICAL - FOLLOW-UP QUERIES WITH "AMONG THEM" (DEFAULT RULE):
**Use previous result set UNLESS explicitly told not to.**

When the conversation context contains a numbered/bulleted list of entities from a previous query:
- Treat ALL follow-up queries as scoped to that result set by default
- Look for these trigger phrases (they indicate follow-up queries):
  * "among them", "among those", "of them", "of those"
  * "which one", "which", "who", "what about" 
  * "the highest", "the lowest", "the one with"
  * Any superlative question after a list: "Who has the...", "Which has the...", "What about the..."

When to NOT use previous list (explicit exceptions):
- User says: "from all pokemon", "overall", "in the entire database"
- User says: "not from that list", "besides them", "excluding them"
- Only if explicitly stated should you ignore the previous result set

Action steps:
1. EXTRACT the list of entities from the PREVIOUS ASSISTANT RESPONSE
2. Look for numbered lists (1. Name, 2. Name, 3. Name) or bullet points
3. Convert each name to lowercase identifier format (e.g., "Abra" → "abra")
4. Include this extracted list in the "Entities" field as "among [extracted list]"
5. Example: If previous response was "1. Abra\n2. Azurill\n3. Blipbug\n...", and current query is "Which one has highest attack?"
   - Refined Query: "Identify which pokemon has the highest attack among [Abra, Azurill, Blipbug, ...]"
   - Entities: ["among-abra-azurill-blipbug-blissey-bounsweet-bronzor-budew-bunnelby-burmy-cascoon"]
   - This signals to the planner to search within this specific list, not re-apply original filters

For each user query:
1. Refine it into a clearer format
2. Identify the language
3. Extract key concepts
4. Determine what API functionalities are needed
5. **MOST IMPORTANT**: Identify what entities/data sources require investigation to answer this query

CRITICAL - FINAL ANSWER REQUIREMENT:
The final answer MUST ALWAYS include human-readable names/identifiers, not just IDs.
- Example ✅: "Pikachu (ID: 25), Charizard (ID: 6), Mewtwo (ID: 150)"
- Example ❌: "IDs: 25, 6, 150"
This means queries MUST retrieve names alongside IDs via JOINs.

When identifying investigatory entities, ask yourself: "In this sentence, what entities are important that require investigation?"

Focus on:
- Specific subjects mentioned (e.g., "Magnemite", "Pikachu") - REMEMBER TO CONVERT TO LOWERCASE
- Data categories needed (e.g., "steel moves", "fire pokemon")
- Relationships/capabilities (e.g., "moves a pokemon can learn", "pokemon in a region")
- Detail/attribute queries (e.g., "pokemon details", "move power", "ability effects")

CRITICAL: Counting/Aggregation Queries
When the query asks "how many", "count", "number of", etc., you MUST identify the data retrieval needed:
- "How many members in team X" → Need to GET/RETRIEVE team members (not just count)
- "How many fire pokemon" → Need to GET/RETRIEVE fire pokemon list
- "Count of X" → Need to GET/RETRIEVE all X

The investigatory entity should describe the data retrieval, not the counting operation.

CRITICAL: IntentType Determination
Analyze the user's PRIMARY intent (what they want to achieve ultimately):

Use "FETCH" when:
- Query is purely about READING/VIEWING/SEARCHING data
- Examples: "show me", "what is", "list", "find", "search", "get details"
- Counting queries: "how many X", "count of X" (retrieve data to count)
- Checking state: "is my watchlist empty?", "do I have any items?"

Use "MODIFY" when:
- Query involves CREATE/UPDATE/DELETE operations as the PRIMARY goal
- Examples: "add to", "remove from", "clear", "delete", "update", "create", "rename"
- Imperative commands: "clear my watchlist", "add Pikachu", "delete team X"

Edge cases:
- "clear" as adjective/question → FETCH: "is my watchlist clear?", "show me clear items"
- "clear" as action verb → MODIFY: "clear my watchlist", "clear all items"
- Hypothetical questions → FETCH: "what if I clear?", "can I add?"
- Post-action verification → MODIFY: "add X and show result" (primary intent is adding)

Special case: Complex queries like "clear all fire pokemon" should be MODIFY (primary intent is deletion, even if retrieval is needed first).

Examples:

Query: "most powerful steel move that Magnemite can learn"
Investigatory Entities: ["Magnemite details and moves", "steel type moves", "pokemon move learnset"]

Query: "fire pokemon in Kanto"
Investigatory Entities: ["fire type pokemon", "Kanto region pokemon", "pokemon by region and type"]

Query: "abilities of Pikachu"
Investigatory Entities: ["Pikachu details", "pokemon abilities"]

Query: "How many members are in New teams?"
Investigatory Entities: ["team members for New teams", "team details and member list", "get all team members"]
IntentType: FETCH

Query: "Clear my watchlist"
Investigatory Entities: ["watchlist items", "user watchlist"]
IntentType: MODIFY

Query: "Is my watchlist clear?"
Investigatory Entities: ["watchlist items", "watchlist status"]
IntentType: FETCH

Query: "Add Pikachu to my watchlist"
Investigatory Entities: ["Pikachu details", "pokemon ID", "user watchlist"]
IntentType: MODIFY

Always respond in the following format:

Refined Query: [refined query]
Language: [language code]
Concepts: [list of concepts]
API Needs: [list of API functionalities needed]
Entities: [list of entities that require investigation to answer the query]
IntentType: ["FETCH"/"MODIFY"]`;

  const userMessage = contextHistory 
    ? `HISTORICAL CONTEXT (for reference only):\n${contextHistory}\n\n========================================\nCURRENT QUERY (PRIMARY FOCUS):\n${currentQuery}`
    : currentQuery;

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
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userMessage,
        },
      ],
      temperature: 0.5,
      max_tokens: 4096,
    }),
  });

  const data = await response.json();
  console.log('Validator Response 2:', data);
  const content = data.choices[0]?.message?.content || `Refined Query: ${userInput}\nLanguage: EN\nConcepts: []\nAPI Needs: []\nEntities: []`;

  const refinedQueryMatch = content.match(/Refined Query: (.+)\nLanguage:/);
  const languageMatch = content.match(/Language: (.+)\nConcepts:/);
  const conceptsMatch = content.match(/Concepts: \[(.+)\]\nAPI Needs:/);
  const apiNeedsMatch = content.match(/API Needs: \[(.+)\]\nEntities:/);
  const entitiesMatch = content.match(/Entities: \[(.+)\]\nIntentType:/);
  const intentTypeMatch = content.match(/IntentType: (.+)/);

  const refinedQuery = refinedQueryMatch ? refinedQueryMatch[1].trim() : userInput;
  const language = languageMatch ? languageMatch[1].trim() : 'EN';
  const concepts = conceptsMatch ? conceptsMatch[1].split(',').map((c: any) => c.trim()) : [];
  const apiNeeds = apiNeedsMatch ? apiNeedsMatch[1].split(',').map((a: any) => a.trim()) : [];
  const entities = entitiesMatch ? entitiesMatch[1].split(',').map((e: any) => e.trim().replace(/['"]/g, '')) : [userInput];
  const intentType = intentTypeMatch ? intentTypeMatch[1].trim() as "FETCH" | "MODIFY" : "FETCH";

  // Attempt to reuse a saved task as reference BEFORE first planner call
  // Use refined intentType as key indicator for LLM to locate best matching task
  let referenceTask: SavedTask | undefined;
  try {
    if (userToken) {
      console.log(`\n🔍 Fetching saved tasks for reference matching (intent: ${intentType})...`);
      const tasks = await fetchTaskList(userToken);
      console.log('Fetched tasks: ', tasks);
      // Log fetched tasks to file (server-side only)
      try {
        const logPath = path.join(process.cwd(), '.temp', 'tasks_fetched.txt');
        
        const timestamp = new Date().toISOString();
        const logContent = `\n=== Tasks Fetched at ${timestamp} ===\n` +
          `Total tasks: ${tasks.length}\n\n` +
          JSON.stringify(tasks, null, 2) + '\n';
        
        await fs.writeFileSync(logPath, logContent);
        console.log(`Logged fetched tasks to ${logPath}`);
      } catch (err) {
        console.error('Failed to log tasks to file:', err);
      }
      const match = await selectReferenceTask(refinedQuery, tasks, apiKey, intentType);
      console.log('Reference task matching result: ', match);
      if (match.task && typeof match.score === 'number') {
        referenceTask = match.task;
        console.log(`📎 Reference task selected (id=${match.task.id}, name=${match.task.taskName}) with score=${match.score} (intent-aligned)`);
      } else {
        console.log('📎 No suitable reference task found (below threshold or intent mismatch).');
      }
    }
  } catch (e) {
    console.warn('Task reuse flow skipped due to error:', e instanceof Error ? e.message : e);
  }

  console.log('✅ Query Refinement Result:', { refinedQuery, language, concepts, apiNeeds, entities, intentType, referenceTask });

  return { refinedQuery, language, concepts, apiNeeds, entities, intentType, referenceTask };
}

export function handleQueryConceptsAndNeeds(concepts: string[], apiNeeds: string[]): { requiredApis: string[]; skippedApis: string[] } {
  const requiredApis: string[] = [];
  const skippedApis: string[] = [];

  for (const need of apiNeeds) {
    if (concepts.includes('ATK') && need === 'sortByATK') {
      skippedApis.push(need); // Skip as sortByATK is handled by pokemon/search
    } else {
      requiredApis.push(need);
    }
  }

  return { requiredApis, skippedApis };
}