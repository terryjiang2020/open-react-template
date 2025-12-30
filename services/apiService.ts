import axios, { AxiosRequestConfig } from 'axios';

/**
 * Dynamically constructs and sends an API request based on the provided schema.
 * @param {string} baseUrl - The base URL of the API.
 * @param {object} schema - The API schema containing path, method, and requestBody details.
 * @param {string} userToken - Optional user authentication token (Bearer token).
 * @returns {Promise<any>} - The API response.
 */
export async function dynamicApiRequest(baseUrl: string, schema: any, userToken?: string): Promise<any> {
  try {
    console.log('Dynamic API Request Schema:', schema);
    const { path, method, requestBody, parameters, input } = schema;

    // Use user token if provided, otherwise fall back to environment token
    let token = userToken || (process.env.NEXT_PUBLIC_ELASTICDASH_TOKEN ? `Bearer ${process.env.NEXT_PUBLIC_ELASTICDASH_TOKEN}` : '');

    if (userToken) {
      console.log('Using user token from localStorage for API authentication');
    } else if (token) {
      console.log('Using environment token for API authentication (no user token provided)');
    } else {
      console.log('No authentication token available');
    }

    // Replace path parameters like {id} with actual values
    // Check both 'parameters' and 'input' fields (planner might use either)
    const pathParams = parameters || input || {};
    let finalPath = path;

    if (pathParams && typeof pathParams === 'object') {
      Object.entries(pathParams).forEach(([key, value]) => {
        const placeholder = `{${key}}`;
        if (finalPath.includes(placeholder)) {
          finalPath = finalPath.replace(placeholder, String(value));
          console.log(`Replaced ${placeholder} with ${value} in path`);
        }
      });
    }

    // Configure the request
    const config: AxiosRequestConfig = {
      method: method.toLowerCase(),
      url: `${baseUrl}${finalPath}`,
      data: requestBody ? requestBody : undefined,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token
      },
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