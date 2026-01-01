/**
 * Parameter Mapper Utility
 *
 * 这个工具负责将模型生成的参数名映射到 API schema 要求的参数名。
 * 解决问题：模型可能写 team_ids 而 API 要求 id，导致参数不匹配。
 *
 * 核心原理：
 * 1. 从 API schema (path + parameters) 提取 required 参数
 * 2. 用规范化 + 打分匹配的方式映射参数
 * 3. 支持 fan-out 检测（标量参数收到数组值）
 */

export type ParamType = "number" | "string" | "boolean" | "object" | "array" | "unknown";

export interface RequiredParam {
  name: string;
  type?: ParamType;
  inPath: boolean; // 是否是路径参数
}

export interface MappingResult {
  mapped: Record<string, any>;
  mapping: Record<string, string>; // requiredKey -> providedKey
  fanOutDetected: boolean;
  fanOutParam?: string; // 触发 fan-out 的参数名
  fanOutValues?: any[]; // fan-out 的值数组
}

/**
 * 从 API path 中提取路径参数
 * 例如: "/pokemon/teams/{teamId}/members" -> ["teamId"]
 */
export function extractPathParams(path: string): string[] {
  const matches = path.match(/\{(\w+)\}/g) || [];
  return matches.map(m => m.replace(/[{}]/g, ""));
}

/**
 * 规范化 key，用于模糊匹配
 * 规则：
 * - 小写
 * - 去掉非字母数字
 * - 去掉常见复数后缀：ids, idlist, list, array, s
 * - 去掉常见领域前缀：team, pokemon, user, admin 等
 */
export function normKey(k: string): string {
  let s = k.toLowerCase().replace(/[^a-z0-9]/g, "");

  // 常见后缀（复数、列表）
  s = s.replace(/(ids|idlist|list|array)$/g, "");

  // 常见领域前缀（按业务可扩展）
  s = s.replace(/^(team|pokemon|user|admin|member|watch)/g, "");

  // 复数 s
  if (s.endsWith("s") && s.length > 1) {
    s = s.slice(0, -1);
  }

  return s;
}

/**
 * 推测值的类型
 */
export function guessValueType(v: any): ParamType {
  if (Array.isArray(v)) return "array";
  if (v === null || v === undefined) return "unknown";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "object") return "object";
  return "unknown";
}

/**
 * 从 API schema 提取 required 参数
 * @param apiPath - API 路径（如 "/pokemon/teams/{teamId}/members"）
 * @param parameters - OpenAPI parameters 数组
 */
export function extractRequiredParams(
  apiPath: string,
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: { type: string } }>
): RequiredParam[] {
  const required: RequiredParam[] = [];

  // 1. 从 path 中提取路径参数
  const pathParams = extractPathParams(apiPath);
  pathParams.forEach(paramName => {
    // 查找对应的 schema type
    const paramSchema = parameters?.find(p => p.name === paramName && p.in === "path");
    const type = paramSchema?.schema?.type as ParamType || "unknown";

    required.push({
      name: paramName,
      type,
      inPath: true,
    });
  });

  // 2. 从 parameters 中提取其他 required 参数（query, header 等）
  parameters?.forEach(param => {
    if (param.required && param.in !== "path") {
      required.push({
        name: param.name,
        type: (param.schema?.type as ParamType) || "unknown",
        inPath: false,
      });
    }
  });

  return required;
}

/**
 * 核心映射函数：将提供的参数映射到 required 参数
 *
 * @param required - 从 API schema 提取的 required 参数
 * @param provided - 模型提供的参数（可能 key 不匹配）
 * @returns 映射结果，包含映射后的参数、映射关系、是否需要 fan-out
 */
export function mapArgsToRequired(
  required: RequiredParam[],
  provided: Record<string, any>
): MappingResult {
  const mapped: Record<string, any> = {};
  const mapping: Record<string, string> = {};
  let fanOutDetected = false;
  let fanOutParam: string | undefined;
  let fanOutValues: any[] | undefined;

  const providedEntries = Object.entries(provided);

  for (const req of required) {
    // 1) 精确匹配（最优先）
    if (req.name in provided) {
      const value = provided[req.name];
      mapped[req.name] = value;
      mapping[req.name] = req.name;

      // 检测 fan-out：路径参数要求标量，但收到数组
      if (req.inPath && Array.isArray(value) && value.length > 1) {
        fanOutDetected = true;
        fanOutParam = req.name;
        fanOutValues = value;
      }

      continue;
    }

    // 2) 模糊匹配（规范化 + 打分）
    const reqNorm = normKey(req.name);
    let best: { key: string; score: number } | null = null;

    for (const [k, v] of providedEntries) {
      const kNorm = normKey(k);
      let score = 0;

      // 名称匹配
      if (kNorm === reqNorm) {
        score += 10; // 规范化后完全匹配
      } else if (kNorm.includes(reqNorm) || reqNorm.includes(kNorm)) {
        score += 4; // 部分包含
      }

      // 类型/结构匹配
      const vt = guessValueType(v);
      if (req.type === "number" || req.type === "integer") {
        if (vt === "number") score += 4;
        if (vt === "array" && (v.length === 0 || typeof v[0] === "number")) score += 3;
      } else if (req.type === "string") {
        if (vt === "string") score += 4;
        if (vt === "array" && (v.length === 0 || typeof v[0] === "string")) score += 3;
      }

      // 常见"id 列表"线索：key 包含 id(s)
      if (reqNorm === "id" && k.toLowerCase().includes("id")) {
        score += 2;
      }

      // 路径参数加权（更重要）
      if (req.inPath) {
        score += 1;
      }

      if (!best || score > best.score) {
        best = { key: k, score };
      }
    }

    // 3) 应用最佳匹配（阈值可调）
    if (best && best.score >= 6) {
      const value = provided[best.key];
      mapped[req.name] = value;
      mapping[req.name] = best.key;

      // 检测 fan-out
      if (req.inPath && Array.isArray(value) && value.length > 1) {
        fanOutDetected = true;
        fanOutParam = req.name;
        fanOutValues = value;
      }

      console.log(`✅ 参数映射: "${req.name}" <- "${best.key}" (score: ${best.score}${req.inPath ? ", path param" : ""})`);
    } else {
      console.warn(`⚠️  无法映射 required 参数 "${req.name}"${best ? ` (最高分: ${best.score}, key: ${best.key})` : ""}`);
    }
  }

  return {
    mapped,
    mapping,
    fanOutDetected,
    fanOutParam,
    fanOutValues,
  };
}

/**
 * 便捷函数：直接从 API schema 和 provided args 生成映射
 *
 * @param apiPath - API 路径
 * @param parameters - OpenAPI parameters 数组
 * @param providedArgs - 模型提供的参数
 */
export function prepareArgsForRequest(
  apiPath: string,
  parameters: Array<{ name: string; in: string; required?: boolean; schema?: { type: string } }> | undefined,
  providedArgs: Record<string, any>
): MappingResult {
  const required = extractRequiredParams(apiPath, parameters);
  console.log(`\n🔍 参数映射分析:`);
  console.log(`  API path: ${apiPath}`);
  console.log(`  Required params:`, required);
  console.log(`  Provided args:`, providedArgs);

  const result = mapArgsToRequired(required, providedArgs);

  console.log(`  映射结果:`, result.mapping);
  if (result.fanOutDetected) {
    console.log(`  🔄 检测到 fan-out: ${result.fanOutParam} = [${result.fanOutValues?.join(", ")}]`);
  }

  return result;
}
