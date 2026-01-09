/**
 * API Schema Loader
 *
 * 从 OpenAPI JSON 文件中加载和查找 API 的 parameters 定义
 */

import fs from 'fs';
import path from 'path';

// 缓存加载的 OpenAPI schemas
let cachedSchemas: Record<string, any> | null = null;

/**
 * 加载所有 OpenAPI schemas
 */
export function loadOpenApiSchemas(): Record<string, any> {
  if (cachedSchemas) {
    return cachedSchemas;
  }

  const schemasDir = path.join(process.cwd(), 'src/doc/openapi-doc');
  const schemas: Record<string, any> = {};

  try {
    const files = fs.readdirSync(schemasDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    for (const file of jsonFiles) {
      const filePath = path.join(schemasDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const schema = JSON.parse(content);

      if (schema.paths) {
        // 将所有 paths 合并到总 schema 中
        Object.assign(schemas, schema.paths);
      }
    }

    console.log(`✅ 加载了 ${Object.keys(schemas).length} 个 API endpoints from OpenAPI schemas`);
    cachedSchemas = schemas;
  } catch (error) {
    console.error('❌ 加载 OpenAPI schemas 失败:', error);
    cachedSchemas = {};
  }

  return cachedSchemas;
}

/**
 * 根据 API path 和 method 查找 parameters 定义
 *
 * @param apiPath - API 路径（如 "/pokemon/teams/{teamId}/members"）
 * @param method - HTTP 方法（如 "get", "post"）
 * @returns parameters 数组，如果未找到返回 undefined
 */
export function findApiParameters(apiPath: string, method: string): Array<{ name: string; in: string; required?: boolean; schema?: { type: string } }> | undefined {
  const schemas = loadOpenApiSchemas();

  // 标准化 method
  const normalizedMethod = method.toLowerCase();

  // 查找匹配的 path
  let matchedPath: string | undefined;

  // 1. 精确匹配
  if (schemas[apiPath]) {
    matchedPath = apiPath;
  }

  // 2. 模糊匹配（考虑路径参数的命名差异）
  if (!matchedPath) {
    const apiPathNorm = apiPath.replace(/\{[^}]+\}/g, '{PARAM}');

    for (const schemaPath of Object.keys(schemas)) {
      const schemaPathNorm = schemaPath.replace(/\{[^}]+\}/g, '{PARAM}');
      if (apiPathNorm === schemaPathNorm) {
        matchedPath = schemaPath;
        break;
      }
    }
  }

  if (!matchedPath) {
    console.warn(`⚠️  未找到匹配的 API schema: ${apiPath} ${method}`);
    return undefined;
  }

  const pathSchema = schemas[matchedPath];
  const methodSchema = pathSchema[normalizedMethod];

  if (!methodSchema) {
    console.warn(`⚠️  API ${matchedPath} 没有 ${normalizedMethod} 方法`);
    return undefined;
  }

  return methodSchema.parameters;
}

/**
 * 获取 API 的完整 schema（包括 parameters, requestBody, responses 等）
 */
export function findApiSchema(apiPath: string, method: string): any | undefined {
  const schemas = loadOpenApiSchemas();
  const normalizedMethod = method.toLowerCase();

  // 尝试精确匹配
  let matchedPath = apiPath;
  if (!schemas[matchedPath]) {
    // 模糊匹配
    const apiPathNorm = apiPath.replace(/\{[^}]+\}/g, '{PARAM}');
    for (const schemaPath of Object.keys(schemas)) {
      const schemaPathNorm = schemaPath.replace(/\{[^}]+\}/g, '{PARAM}');
      if (apiPathNorm === schemaPathNorm) {
        matchedPath = schemaPath;
        break;
      }
    }
  }

  return schemas[matchedPath]?.[normalizedMethod];
}
