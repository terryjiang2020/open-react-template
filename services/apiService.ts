import axios, { AxiosRequestConfig } from 'axios';

/**
 * Dynamically constructs and sends an API request based on the provided schema.
 * @param {string} baseUrl - The base URL of the API.
 * @param {object} schema - The API schema containing path, method, and requestBody details.
 * @param {object} query - The user query to dynamically populate the request body.
 * @returns {Promise<any>} - The API response.
 */
export async function dynamicApiRequest(baseUrl: string, schema: any): Promise<any> {
  try {
    console.log('Dynamic API Request Schema:', schema);
    const { path, method, requestBody } = schema;

    // Configure the request
    const config: AxiosRequestConfig = {
      method: method.toLowerCase(),
      url: `${baseUrl}${path}`,
      data: requestBody ? requestBody : undefined,
    };

    console.log('Dynamic API Request Config:', JSON.stringify(config, null, 2))

    // Send the request
    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error('Error in dynamicApiRequest:', error);
    throw error;
  }
}