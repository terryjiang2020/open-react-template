'use client';

import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { saveTask } from '@/services/taskService';

interface PlanStep {
  step_number?: number;
  description?: string;
  api?: string;
  parameters?: Record<string, any>;
  requestBody?: Record<string, any>;
  depends_on_step?: number;
}

interface PlanSummary {
  goal?: string;
  phase?: string;
  steps?: PlanStep[];
  selected_apis?: any[];
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  awaitingApproval?: boolean;
  sessionId?: string;
  planSummary?: PlanSummary;
  planResponse?: string;
  refinedQuery?: string;
  planningDurationMs?: number;
  usedReferencePlan?: boolean;
}

type TaskPayload = {
  taskName: string;
  taskType: number;
  taskContent: string;
  taskSteps: Array<{
    stepOrder: number;
    stepType: number;
    stepContent: string;
    api?: {
      path: string;
      method: string;
      parameters?: Record<string, any>;
      requestBody?: Record<string, any>;
    };
    depends_on_step?: number;
  }>;
};

export default function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingTask, setIsSavingTask] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load chat history from localStorage on mount
  useEffect(() => {
    try {
      const savedMessages = localStorage.getItem('chatWidget_messages');
      if (savedMessages) {
        const parsed = JSON.parse(savedMessages);
        setMessages(parsed);
      }
    } catch (error) {
      console.warn('Failed to load chat history:', error);
    }
  }, []);

  // Save chat history to localStorage whenever messages change
  useEffect(() => {
    try {
      if (messages.length > 0) {
        localStorage.setItem('chatWidget_messages', JSON.stringify(messages));
      }
    } catch (error) {
      console.warn('Failed to save chat history:', error);
    }
  }, [messages]);

  const sanitizeContent = (text: string) => text.replace(/```/g, '').trim();

  const isReadOperation = (apiText: string) => {
    const lowered = apiText.toLowerCase();
    return lowered.includes('/general/sql/query') || lowered.startsWith('get');
  };

  const inferTaskTypeFromSteps = (steps: PlanStep[] = []) => {
    const hasWrite = steps.some((step) => {
      const apiText = step.api?.toLowerCase() || '';
      if (isReadOperation(apiText)) return false;
      return apiText.startsWith('post') || apiText.startsWith('put') || apiText.startsWith('patch') || apiText.startsWith('delete');
    });
    return hasWrite ? 2 : 1;
  };

  const extractMethod = (api?: string) => {
    if (!api) return '';
    const first = api.trim().split(' ')[0];
    return first.toUpperCase();
  };

  const stepTypeFromApi = (api?: string) => {
    const method = extractMethod(api);
    const normalized = api?.toLowerCase() || '';
    if (isReadOperation(normalized)) return 1;
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? 2 : 1;
  };

  const extractTaskTemplateName = (refinedQuery: string, goal: string): string => {
    // Remove specific values like names, IDs to create a generic template name
    // E.g., "Remove Abomasnow from my watchlist" → "Remove from watchlist"
    // E.g., "Add Pikachu to my team New" → "Add to team"
    // E.g., "Clear my watchlist" → "Clear watchlist"
    
    const text = (refinedQuery || goal || '').trim();
    
    // Remove possessive pronouns and articles
    let cleaned = text.replace(/\b(my|a|an|the)\s+/gi, '');
    
    // Remove quoted items and common naming patterns
    cleaned = cleaned.replace(/'[^']+'/g, '');
    cleaned = cleaned.replace(/"[^"]+"/g, '');
    cleaned = cleaned.replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g, (match) => {
      // Remove proper nouns (Pokemon names, team names) but keep verbs/prepositions
      return /^(add|remove|clear|delete|update|get|create|list)$/i.test(match) ? match : '';
    });
    
    // Clean up extra spaces
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    // Fallback: use first 50 chars if cleaning didn't work well
    return cleaned.length > 3 ? cleaned : text.slice(0, 50).trim();
  };

  const detectEntityFromQuery = (refinedQuery: string) => {
    const text = refinedQuery || '';
    const quoted = text.match(/['"]([^'"]+)['"]/);
    if (quoted) return quoted[1];
    const verbNoun = text.match(/\b(?:add|remove|delete|drop|clear)\s+([A-Za-z0-9_-]+)/i);
    if (verbNoun) return verbNoun[1];
    const lastToken = text.trim().split(/\s+/).pop();
    return lastToken && lastToken.length > 1 ? lastToken : undefined;
  };

  const parameterizeApiDetails = (step: PlanStep, refinedQuery: string): any => {
    if (!step.api) return undefined;

    const apiStr = step.api.trim();
    const parts = apiStr.split(' ');
    if (parts.length < 2) return undefined;

    const method = parts[0].toUpperCase();
    let path = parts.slice(1).join(' ');
    const parameters = step.parameters ? { ...step.parameters } : {};
    const requestBody = step.requestBody ? JSON.parse(JSON.stringify(step.requestBody)) : {};

    const primaryEntity = detectEntityFromQuery(refinedQuery);
    const namePlaceholder = path.includes('team') ? '{TEAM_NAME}' : '{POKEMON_NAME}';

    // Parameterize path IDs
    path = path.replace(/\/pokemon\/\d+/gi, '/pokemon/{POKEMON_ID}');
    path = path.replace(/\/teams\/\d+/gi, '/teams/{TEAM_ID}');
    path = path.replace(/\/\d+\b/g, '/{ID}');

    // Parameterize entity names in path
    if (primaryEntity) {
      path = path.replace(new RegExp(primaryEntity, 'gi'), namePlaceholder);
    }

    // Parameterize parameters object
    Object.keys(parameters || {}).forEach((key) => {
      if (typeof parameters[key] === 'string' && primaryEntity && parameters[key].toLowerCase() === primaryEntity.toLowerCase()) {
        parameters[key] = namePlaceholder;
      }
      if (typeof parameters[key] === 'number') {
        parameters[key] = key.toLowerCase().includes('pokemon') ? '{POKEMON_ID}' : '{ID}';
      }
    });

    // Parameterize requestBody recursively
    if (primaryEntity) {
      parameterizeValue(requestBody, primaryEntity, namePlaceholder);
    }
    parameterizeNumericIds(requestBody);

    // Parameterize SQL queries
    if (requestBody.query && typeof requestBody.query === 'string') {
      if (primaryEntity) {
        requestBody.query = requestBody.query.replace(new RegExp(primaryEntity, 'gi'), namePlaceholder);
      }
      requestBody.query = requestBody.query.replace(/=\s*\d+/g, (m: string) => m.replace(/\d+/, '{ID}'));
      requestBody.query = requestBody.query.replace(/IN\s*\([^)]+\)/gi, 'IN ({ID_LIST})');
    }

    return {
      path,
      method: method.toLowerCase(),
      parameters,
      requestBody,
    };
  };

  const parameterizeValue = (obj: any, searchValue: string, placeholder: string) => {
    if (typeof obj !== 'object' || obj === null) return;
    
    for (const key in obj) {
      if (typeof obj[key] === 'string') {
        obj[key] = obj[key].replace(new RegExp(searchValue, 'gi'), placeholder);
      } else if (typeof obj[key] === 'object') {
        parameterizeValue(obj[key], searchValue, placeholder);
      }
    }
  };

  const parameterizeNumericIds = (obj: any) => {
    if (typeof obj !== 'object' || obj === null) return;
    for (const key in obj) {
      if (typeof obj[key] === 'number') {
        obj[key] = key.toLowerCase().includes('pokemon') ? '{POKEMON_ID}' : '{ID}';
      } else if (typeof obj[key] === 'string' && /\b\d+\b/.test(obj[key])) {
        obj[key] = obj[key].replace(/\b\d+\b/g, '{ID}');
      } else if (typeof obj[key] === 'object') {
        parameterizeNumericIds(obj[key]);
      }
    }
  };

  const convertPlanToTaskPayload = (message: Message): TaskPayload => {
    const plan = message.planSummary;
    const text = message.content || '';
    const refinedQuery = message.refinedQuery || text;

    // Extract generic template name from refined query
    const taskName = extractTaskTemplateName(refinedQuery ?? '', plan?.goal ?? '');
    const steps = plan?.steps || [];
    const taskType = inferTaskTypeFromSteps(steps);

    const mappedSteps = (steps.length ? steps : [{ description: text, api: 'GET' }]).map((step, idx) => {
      const apiPart = step.api ? step.api.trim() : '';
      const stepType = stepTypeFromApi(apiPart);

      // Prefer logical description, avoid leaking raw SQL/placeholder details
      const logicalDesc = (step.description || '').split('(')[0].trim() || 'Step';
      const content = apiPart ? `${logicalDesc} — ${apiPart}` : logicalDesc;

      // Extract and parameterize API details
      const apiDetails = parameterizeApiDetails(step, refinedQuery);

      return {
        stepOrder: idx + 1,
        stepType,
        stepContent: sanitizeContent(content),
        api: apiDetails,
        depends_on_step: step.depends_on_step,
      };
    });

    const logicalSummary = mappedSteps.map((s) => `- ${s.stepContent}`).join('\n');
    const taskContent = sanitizeContent(`Goal: ${taskName}\nSteps:\n${logicalSummary}`);

    return {
      taskName,
      taskType,
      taskContent,
      taskSteps: mappedSteps,
    };
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    console.log('Messages updated:', messages);
    scrollToBottom();
  }, [messages]);

  // Update the sendMessage function to ensure the API accepts the correct body format
  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { role: 'user', content: input.trim() };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput('');
    setIsLoading(true);

    try {
      // Check if the input requires an API call
      const trivialResponses: { [key: string]: string } = {
        hello: 'Hi there! How can I assist you today?',
        hi: 'Hello! How can I help you?',
        thanks: 'You’re welcome!',
        bye: 'Goodbye! Have a great day!',
      };

      const lowerCaseInput = input.trim().toLowerCase();
      if (trivialResponses[lowerCaseInput]) {
        setMessages((prev) => [...prev, { role: 'assistant', content: trivialResponses[lowerCaseInput] }]);
        setIsLoading(false);
        return;
      }

      // Proceed with the API call if necessary
      // The backend handles planning and execution in one call
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': localStorage.getItem('token') ? `Bearer ${localStorage.getItem('token')}` : '',
        },
        body: JSON.stringify({
          messages: updatedMessages, // Send full conversation history
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn('API Error:', errorText);
        throw new Error('Failed to process the request');
      }

      const data = await response.json();
      console.log('(Chat) API Response:', data);

      // Add assistant response to messages
      const assistantMessage: Message = {
        role: 'assistant',
        content: data.message || 'I apologize, but I was unable to process your request.',
        awaitingApproval: data.awaitingApproval,
        sessionId: data.sessionId,
        planSummary: data.planSummary,
        planResponse: data.planResponse,
        refinedQuery: data.refinedQuery,
        planningDurationMs: data.planningDurationMs,
        usedReferencePlan: data.usedReferencePlan,
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error: any) {
      const errorMessage: Message = {
        role: 'assistant',
        content: 'An error occurred while processing your request. Please try again.',
      };
      setMessages((prev) => [...prev, errorMessage]);
      console.warn('Error in sendMessage:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleSaveTask = async (message: Message) => {
    if (!message.planSummary) return;
    setIsSavingTask(true);
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        alert('Please sign in before saving tasks.');
        return;
      }

      const payload = convertPlanToTaskPayload(message);
      await saveTask(payload, token);
      alert('Task saved successfully');
    } catch (err) {
      console.warn('Error saving task', err);
      alert('Could not save the task. Please try again.');
    } finally {
      setIsSavingTask(false);
    }
  };

  // Handle approval/rejection buttons
  const handleApproval = async (approved: boolean, sessionId?: string) => {
    setIsLoading(true);
    
    if (approved) {
      // For approval, send "approve" message
      const userMessage: Message = { role: 'user', content: 'approve' };
      const updatedMessages = [...messages, userMessage];
      setMessages(updatedMessages);

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': localStorage.getItem('token') ? `Bearer ${localStorage.getItem('token')}` : '',
          },
          body: JSON.stringify({
            messages: updatedMessages,
            sessionId: sessionId,
            isApproval: true,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to process the request');
        }

        const data = await response.json();
        console.log('(Chat) Approval Response:', data);

        const assistantMessage: Message = {
          role: 'assistant',
          content: data.message || 'I apologize, but I was unable to process your request.',
          awaitingApproval: data.awaitingApproval,
          sessionId: data.sessionId,
          planSummary: data.planSummary,
          planResponse: data.planResponse,
          refinedQuery: data.refinedQuery,
          planningDurationMs: data.planningDurationMs,
          usedReferencePlan: data.usedReferencePlan,
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } catch (error: any) {
        const errorMessage: Message = {
          role: 'assistant',
          content: 'An error occurred while processing your request. Please try again.',
        };
        setMessages((prev) => [...prev, errorMessage]);
        console.warn('Error in handleApproval:', error);
      } finally {
        setIsLoading(false);
      }
    } else {
      // For rejection, send rejection signal and prompt for modification
      const userMessage: Message = { role: 'user', content: 'reject' };
      const updatedMessages = [...messages, userMessage];
      setMessages(updatedMessages);

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': localStorage.getItem('token') ? `Bearer ${localStorage.getItem('token')}` : '',
          },
          body: JSON.stringify({
            messages: updatedMessages,
            sessionId: sessionId,
            isApproval: false,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to process the request');
        }

        const data = await response.json();
        console.log('(Chat) Rejection Response:', data);

        const assistantMessage: Message = {
          role: 'assistant',
          content: data.message || 'Plan rejected. Please tell me what you would like to change.',
          awaitingApproval: data.awaitingApproval,
          sessionId: data.sessionId,
          planSummary: data.planSummary,
          planResponse: data.planResponse,
          refinedQuery: data.refinedQuery,
          planningDurationMs: data.planningDurationMs,
          usedReferencePlan: data.usedReferencePlan,
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } catch (error: any) {
        const errorMessage: Message = {
          role: 'assistant',
          content: 'An error occurred while processing your request. Please try again.',
        };
        setMessages((prev) => [...prev, errorMessage]);
        console.warn('Error in handleRejection:', error);
      } finally {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    const chatButton = document.getElementById('chat-widget-button');
    if (chatButton) {
      chatButton.style.display = 'block'; // Ensure the button is always visible
    }
  }, []);

  return (
    <>
      {/* Input bar (collapsed state) */}
      {!isOpen && (
        <div
          id="chat-widget-button"
          className="fixed bottom-6 left-1/2 z-50 flex w-[600px] -translate-x-1/2 items-center space-x-2 rounded-full bg-gray-900/80 px-5 py-3 shadow-xl backdrop-blur-lg transition-all duration-300 ease-in-out animate-in fade-in slide-in-from-bottom-4"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onClick={() => setIsOpen(true)}
            onFocus={() => setIsOpen(true)}
            placeholder={messages.length > 0 ? 'Continue your conversation...' : 'Ask me anything...'}
            className="flex-1 bg-transparent text-sm text-white placeholder-gray-400 focus:outline-none"
            disabled={isLoading}
          />
          <button
            onClick={sendMessage}
            disabled={isLoading || !input.trim()}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-r from-purple-500 to-indigo-600 text-white transition-all hover:scale-105 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Send message"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
              />
            </svg>
          </button>
        </div>
      )}

      {/* Chat window (expanded state) */}
      {isOpen && (
        <div className="fixed bottom-6 left-1/2 z-50 flex max-h-[70vh] w-[600px] -translate-x-1/2 flex-col rounded-2xl bg-gray-900/95 shadow-2xl backdrop-blur-xl transition-all duration-300 ease-in-out animate-in fade-in slide-in-from-bottom-4 zoom-in-95">
          {/* Header */}
          <div className="flex items-center justify-between rounded-t-2xl bg-gradient-to-r from-purple-500 to-indigo-600 px-4 py-3">
            <h3 className="font-semibold text-white">AI Assistant</h3>
            <button
              onClick={() => setIsOpen(false)}
              className="text-white/80 transition-colors hover:text-white"
              aria-label="Close chat"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* Chat history area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && (
              <div className="flex h-full items-center justify-center">
                <p className="text-center text-gray-400">
                  Hi! I'm your AI Assistant. How can I help you?
                </p>
              </div>
            )}
            {messages.map((message, index) => (
              <div
                key={index}
                className={`flex ${
                  message.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2 ${
                    message.role === 'user'
                      ? 'bg-gradient-to-r from-purple-500 to-indigo-600 text-white'
                      : 'bg-gray-800 text-gray-100'
                  }`}
                >
                  <div className="prose-chat text-sm">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}
                    </ReactMarkdown>
                  </div>
                  {message.role === 'assistant' && (message.planningDurationMs !== undefined || message.usedReferencePlan) && (
                    <div className="mt-2 text-xs text-gray-400 border-t border-gray-700 pt-2">
                      {message.usedReferencePlan && <div>🪄 Used reference plan</div>}
                      {message.planningDurationMs !== undefined && <div>⏱️ Planning: {message.planningDurationMs}ms</div>}
                    </div>
                  )}
                  {/* {message.role === 'assistant' && message.planSummary && message.planSummary.steps && message.planSummary.steps.length > 0 && (
                    <div className="mt-3 flex flex-col gap-2">
                      <button
                        onClick={() => handleSaveTask(message)}
                        disabled={isSavingTask}
                        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-blue-700 disabled:opacity-50"
                      >
                        Save this task
                      </button>
                    </div>
                  )} */}
                  {message.awaitingApproval && index === messages.length - 1 && (
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => handleApproval(true, message.sessionId)}
                        disabled={isLoading}
                        className="flex-1 rounded-lg bg-green-100 px-4 py-2 text-sm font-medium text-green-700 transition-all hover:bg-green-200 disabled:opacity-50"
                      >
                        ✓ Approve
                      </button>
                      <button
                        onClick={() => handleApproval(false, message.sessionId)}
                        disabled={isLoading}
                        className="flex-1 rounded-lg bg-red-100 px-4 py-2 text-sm font-medium text-red-700 transition-all hover:bg-red-200 disabled:opacity-50"
                      >
                        ✗ Reject
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-2xl bg-gray-800 px-4 py-2">
                  <div className="flex space-x-2">
                    <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '0ms' }}></div>
                    <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '150ms' }}></div>
                    <div className="h-2 w-2 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: '300ms' }}></div>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input area */}
          <div className="border-t border-gray-700 p-4">
            <div className="flex items-end space-x-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type message..."
                rows={1}
                className="flex-1 resize-none rounded-lg bg-gray-800 px-4 py-2 text-sm text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
                disabled={isLoading}
              />
              <button
                onClick={sendMessage}
                disabled={isLoading || !input.trim()}
                className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-r from-purple-500 to-indigo-600 text-white transition-all hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Send message"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
