import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const openApiDir = path.join(__dirname, '../doc/openapi-doc');
const sqlDir = path.join(__dirname, '../doc/sql');
const outputApiDir = path.join(__dirname, '../doc/vectorized-data/api');
const outputTableDir = path.join(__dirname, '../doc/vectorized-data/table');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.NEXT_PUBLIC_OPENAI_API_KEY || '';
const EMBEDDING_MODEL = 'text-embedding-ada-002';

// Ensure output directories exist
if (!fs.existsSync(outputApiDir)) {
  fs.mkdirSync(outputApiDir, { recursive: true });
}
if (!fs.existsSync(outputTableDir)) {
  fs.mkdirSync(outputTableDir, { recursive: true });
}

// Read OpenAPI JSON files and slice by path+method
const readOpenApiDocs = () => {
  const files = fs.readdirSync(openApiDir).filter((file) => file.endsWith('.json'));
  const apiChunks: { id: string; summary: string; tags: string[]; content: string }[] = [];

  files.forEach((file) => {
    const filePath = path.join(openApiDir, file);
    const openapi = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const paths = openapi.paths || {};
    Object.entries(paths).forEach(([apiPath, methods]) => {
      Object.entries(methods as any).forEach(([method, op]: [string, any]) => {
        // Compose a structured string for embedding
        const id = `api-${apiPath}-${method.toUpperCase()}`;
        const summary = op.summary || '';
        const tags = Array.isArray(op.tags) ? op.tags : [];
        const description = op.description || '';
        // Parameters
        let params = '';
        if (Array.isArray(op.parameters)) {
          params = op.parameters.map((p: any) => `${p.name} (${p.in}): ${p.schema ? p.schema.type : ''}`).join('; ');
        }
        // Request body
        let requestBody = '';
        if (op.requestBody && op.requestBody.content) {
          const contentTypes = Object.keys(op.requestBody.content);
          requestBody = contentTypes.map(ct => {
            const schema = op.requestBody.content[ct].schema;
            return `${ct}: ${schema ? JSON.stringify(schema) : ''}`;
          }).join('; ');
        }
        // Responses
        let responses = '';
        if (op.responses) {
          responses = Object.entries(op.responses).map(([code, resp]: [string, any]) => {
            let desc = resp.description || '';
            let schema = '';
            if (resp.content && resp.content['application/json'] && resp.content['application/json'].schema) {
              schema = JSON.stringify(resp.content['application/json'].schema);
            }
            return `${code}: ${desc}${schema ? ' ' + schema : ''}`;
          }).join('; ');
        }
        // Compose content for embedding
        const content = `path: ${apiPath}\nmethod: ${method.toUpperCase()}\ntags: ${tags.join(', ')}\nsummary: ${summary}\ndescription: ${description}\nparameters: ${params}\nrequestBody: ${requestBody}\nresponses: ${responses}`;
        apiChunks.push({ id, summary, tags, content });
      });
    });
  });
  return apiChunks;
};

// Read SQL semantic .txt files and split by semantic chunk headers
const readSqlStructures = () => {
  const files = fs.readdirSync(sqlDir).filter((file) => file.endsWith('.txt'));
  const sqlChunks: { id: string; content: string }[] = [];

  files.forEach((file) => {
    const filePath = path.join(sqlDir, file);
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    // Split by semantic chunk header: -- Table: <table_name>
    const chunks = fileContent.split(/(?=^-- Table: )/m).filter(Boolean);
    chunks.forEach((chunk, idx) => {
      // Clean up chunk: trim, ensure not empty
      const trimmed = chunk.trim();
      if (trimmed) {
        const firstLine = trimmed.split('\n')[0];
        const tableName = firstLine.replace('-- Table: ', '');
        sqlChunks.push({
          id: `semantic-${tableName}-${idx}`,
          content: trimmed,
        });
      }
    });
  });
  return sqlChunks;
};

// Generate embeddings using OpenAI API
const generateEmbeddings = async (text: string) => {
  const response = await axios.post(
    'https://api.openai.com/v1/embeddings',
    {
      model: EMBEDDING_MODEL,
      input: text,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data.data[0].embedding;
};


// Save all input data to unvectorized-data.json before vectorization (for backup)
const saveInitialUnvectorizedData = async (apiChunks: any[], sqlChunks: any[]) => {
  const allChunks = [...apiChunks, ...sqlChunks];
  const unvectorizedPath = path.join(__dirname, '../doc/vectorized-data/unvectorized-data.json');
  await fs.promises.writeFile(unvectorizedPath, JSON.stringify(allChunks, null, 2));
  const backupPath = path.join(__dirname, '../doc/vectorized-data/unvectorized-data-backup.json');
  await fs.promises.writeFile(backupPath, JSON.stringify(allChunks, null, 2));
  console.log(`Initial unvectorized data saved to ${unvectorizedPath}`);
};


// Vectorize and save API and SQL/table chunks to separate folders
const processVectorization = async (apiChunks: any[], sqlChunks: any[]) => {
  const apiVectorizedPath = path.join(outputApiDir, 'vectorized-data.json');
  const tableVectorizedPath = path.join(outputTableDir, 'vectorized-data.json');
  const unvectorizedPath = path.join(__dirname, '../doc/vectorized-data/unvectorized-data.json');

  let apiVectorizedData: any[] = [];
  let tableVectorizedData: any[] = [];
  let unvectorizedData = [...apiChunks, ...sqlChunks];

  // Vectorize API chunks
  for (const item of apiChunks) {
    try {
      const embedding = await generateEmbeddings(item.content);
      apiVectorizedData.push({ ...item, embedding });
      unvectorizedData = unvectorizedData.filter((d) => d !== item);
      await fs.promises.writeFile(apiVectorizedPath, JSON.stringify(apiVectorizedData, null, 2));
      await fs.promises.writeFile(unvectorizedPath, JSON.stringify(unvectorizedData, null, 2));
    } catch (error) {
      console.error(`Failed to vectorize API item: ${item.id}`, error);
    }
  }

  // Vectorize SQL/table chunks
  for (const item of sqlChunks) {
    try {
      const embedding = await generateEmbeddings(item.content);
      tableVectorizedData.push({ ...item, embedding });
      unvectorizedData = unvectorizedData.filter((d) => d !== item);
      await fs.promises.writeFile(tableVectorizedPath, JSON.stringify(tableVectorizedData, null, 2));
      await fs.promises.writeFile(unvectorizedPath, JSON.stringify(unvectorizedData, null, 2));
    } catch (error) {
      console.error(`Failed to vectorize table item: ${item.id}`, error);
    }
  }

  console.log(`API vectorized data saved to ${apiVectorizedPath}`);
  console.log(`Table vectorized data saved to ${tableVectorizedPath}`);
  console.log(`Remaining unvectorized data saved to ${unvectorizedPath}`);
};

// Main execution


(async () => {
  try {
    const apiChunks = readOpenApiDocs();
    const sqlChunks = readSqlStructures();
    console.log(`Extracted ${apiChunks.length} API chunks and ${sqlChunks.length} SQL structure chunks.`);

    await saveInitialUnvectorizedData(apiChunks, sqlChunks);
    await processVectorization(apiChunks, sqlChunks);
  } catch (error) {
    console.error('Error during vectorization:', error);
  }
})();