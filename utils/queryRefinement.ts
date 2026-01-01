import { fetchPromptFile } from "@/app/api/chat/promptUtils";

export async function clarifyAndRefineUserInput(userInput: string): Promise<{ refinedQuery: string; language: string; concepts: string[]; apiNeeds: string[]; entities: string[] }> {
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

When you need to look up something's ID, always do search API or check table.

Examples:

Query: "most powerful steel move that Magnemite can learn"
Investigatory Entities: ["Magnemite details and moves (GET)", "steel type moves (GET)", "pokemon move learnset (GET)"]

Query: "fire pokemon in Kanto"
Investigatory Entities: ["fire type pokemon (GET)", "Kanto region pokemon (GET)", "pokemon by region and type (GET)"]

Query: "Add metapod to my watchlist"
Investigatory Entities: ["metapod details (GET)", "add to watchlist (POST)"]

Query: "Rename Team Alpha to Team Omega"
Investigatory Entities: ["Team Alpha details (GET)", "rename team (PUT/PATCH)"]

Query: "Remove pikachu from my watchlist"
Investigatory Entities: ["pikachu details (GET)", "remove from watchlist (DELETE)"]

When refining, try to use the words from the following list if possible: ${
  await fetchPromptFile('prompt-dictionary.txt')
}

Also try to include the expected api method: POST (create), GET (retrieve), PUT/PATCH (update), DELETE (remove) where relevant.

Always respond in the following format:

Refined Query: [refined query]
Language: [language code]
Concepts: [list of concepts]
API Needs: [list of API functionalities needed]
Fetch vs Mutate: [should the API calls be fetch/retrieve or mutate/update]
Entities: [list of entities that require investigation to answer the query]`,
        },
        {
          role: 'user',
          content: userInput,
        },
      ],
      temperature: 0,
      max_tokens: 4096,
    }),
  });

  const data = await response.json();
  const content = data.choices[0]?.message?.content || `Refined Query: ${userInput}\nLanguage: EN\nConcepts: []\nAPI Needs: []\nEntities: []`;

  const refinedQueryMatch = content.match(/Refined Query: (.+)\nLanguage:/);
  const languageMatch = content.match(/Language: (.+)\nConcepts:/);
  const conceptsMatch = content.match(/Concepts: \[(.+)\]\nAPI Needs:/);
  const apiNeedsMatch = content.match(/API Needs: \[(.+)\]\nEntities:/);
  const entitiesMatch = content.match(/Entities: \[(.+)\]/);

  const refinedQuery = refinedQueryMatch ? refinedQueryMatch[1].trim() : userInput;
  const language = languageMatch ? languageMatch[1].trim() : 'EN';
  const concepts = conceptsMatch ? conceptsMatch[1].split(',').map((c: any) => c.trim()) : [];
  const apiNeeds = apiNeedsMatch ? apiNeedsMatch[1].split(',').map((a: any) => a.trim()) : [];
  const entities = entitiesMatch ? entitiesMatch[1].split(',').map((e: any) => e.trim().replace(/['"]/g, '')) : [userInput];

  return { refinedQuery, language, concepts, apiNeeds, entities };
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