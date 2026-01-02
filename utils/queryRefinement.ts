export async function clarifyAndRefineUserInput(userInput: string, apiKey: string): Promise<{ refinedQuery: string; language: string; concepts: string[]; apiNeeds: string[]; entities: string[], intentType: "FETCH" | "MODIFY" }> {
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
          content: `You are an assistant that refines user queries and identifies what needs to be investigated to answer them.

For each user query:
1. Refine it into a clearer format
2. Identify the language
3. Extract key concepts
4. Determine what API functionalities are needed
5. **MOST IMPORTANT**: Identify what entities/data sources require investigation to answer this query

When identifying investigatory entities, ask yourself: "In this sentence, what entities are important that require investigation?"

Focus on:
- Specific subjects mentioned (e.g., "Magnemite", "Pikachu")
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
IntentType: ["FETCH"/"MODIFY"]`,
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

  console.log('✅ Query Refinement Result:', { refinedQuery, language, concepts, apiNeeds, entities, intentType });

  return { refinedQuery, language, concepts, apiNeeds, entities, intentType };
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