import axios, { AxiosRequestConfig } from 'axios';

/**
 * Dynamically constructs and sends an API request based on the provided schema.
 * @param {string} baseUrl - The base URL of the API.
 * @param {object} schema - The API schema containing path, method, and requestBody details.
 * @param {object} query - The user query to dynamically populate the request body.
 * @returns {Promise<any>} - The API response.
 */
export async function dynamicApiRequest(baseUrl: string, schema: any, query: any): Promise<any> {
  try {
    const { path, method, requestBody } = schema;

    // Construct the request body dynamically based on the schema
    const body: any = {};
    if (requestBody && requestBody.content) {
      const contentSchema = requestBody.content['application/json'].schema;
      if (contentSchema && contentSchema.properties) {
        for (const [key, value] of Object.entries(contentSchema.properties)) {
          if (query[key] !== undefined) {
            body[key] = query[key];
          } else if (value.default !== undefined) {
            body[key] = value.default;
          }
        }
      }
    }

    // Configure the request
    const config: AxiosRequestConfig = {
      method: method.toLowerCase(),
      url: `${baseUrl}${path}`,
      data: body,
    };

    // Send the request
    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error('Error in dynamicApiRequest:', error);
    throw error;
  }
}