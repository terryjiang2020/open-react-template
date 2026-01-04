'use client';

import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import en from '../locales/en.json';
import zh from '../locales/zh.json';
import { saveTask } from '@/services/taskService';

interface PlanStep {
  step_number?: number;
  description?: string;
  api?: string;
  parameters?: Record<string, any>;
  requestBody?: Record<string, any>;
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
}

const translations = { en, zh } as const;
const t = (key: string) => translations.en[key as keyof typeof translations.en] || key;

type TaskPayload = {
  taskName: string;
  taskType: number;
  taskContent: string;
  taskSteps: Array<{
    stepOrder: number;
    stepType: number;
    stepContent: string;
  }>;
};

export default function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingTask, setIsSavingTask] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  const convertPlanToTaskPayload = (message: Message): TaskPayload => {
    const plan = message.planSummary;
    const text = message.content || '';

    const taskName = (plan?.goal || text.split('\n')[0] || 'Untitled task').slice(0, 120).trim() || 'Untitled task';
    const steps = plan?.steps || [];
    const taskType = inferTaskTypeFromSteps(steps);

    const mappedSteps = (steps.length ? steps : [{ description: text, api: 'GET' }]).map((step, idx) => {
      const apiPart = step.api ? step.api.trim() : '';
      const stepType = stepTypeFromApi(apiPart);

      // Prefer logical description, avoid leaking raw SQL/placeholder details
      const logicalDesc = (step.description || '').split('(')[0].trim() || 'Step';
      const content = apiPart ? `${logicalDesc} — ${apiPart}` : logicalDesc;

      return {
        stepOrder: idx + 1,
        stepType,
        stepContent: sanitizeContent(content),
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
        alert(t('saveTask.errorMissingToken'));
        return;
      }

      const payload = convertPlanToTaskPayload(message);
      await saveTask(payload, token);
      alert(t('saveTask.success'));
    } catch (err) {
      console.warn('Error saving task', err);
      alert(t('saveTask.errorGeneric'));
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
      {/* 漂浮按钮 */}
      {!isOpen && (
        <button
          id="chat-widget-button"
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-r from-purple-500 to-indigo-600 text-white shadow-lg transition-all hover:scale-110 hover:shadow-xl"
          aria-label="打开聊天"
        >
          <svg
            className="h-6 w-6 inline"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
            />
          </svg>
        </button>
      )}

      {/* 聊天窗口 */}
      {isOpen && (
        <div className="fixed bottom-6 right-6 z-50 flex h-[600px] w-[380px] flex-col rounded-2xl bg-gray-900/95 shadow-2xl backdrop-blur-sm">
          {/* 头部 */}
          <div className="flex items-center justify-between rounded-t-2xl bg-gradient-to-r from-purple-500 to-indigo-600 px-4 py-3">
            <h3 className="font-semibold text-white">AI助手</h3>
            <button
              onClick={() => setIsOpen(false)}
              className="text-white/80 transition-colors hover:text-white"
              aria-label="关闭聊天"
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

          {/* 聊天记录区域 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && (
              <div className="flex h-full items-center justify-center">
                <p className="text-center text-gray-400">
                  你好！我是AI助手，有什么可以帮你的吗？
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
                  {message.role === 'assistant' && message.planSummary && (
                    <div className="mt-3 flex flex-col gap-2">
                      <button
                        onClick={() => handleSaveTask(message)}
                        disabled={isSavingTask}
                        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-blue-700 disabled:opacity-50"
                      >
                        {t('saveTask.cta')}
                      </button>
                    </div>
                  )}
                  {message.awaitingApproval && index === messages.length - 1 && (
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => handleApproval(true, message.sessionId)}
                        disabled={isLoading}
                        className="flex-1 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-green-700 disabled:opacity-50"
                      >
                        ✓ Approve
                      </button>
                      <button
                        onClick={() => handleApproval(false, message.sessionId)}
                        disabled={isLoading}
                        className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-red-700 disabled:opacity-50"
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

          {/* 输入区域 */}
          <div className="border-t border-gray-700 p-4">
            <div className="flex items-end space-x-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入消息..."
                rows={1}
                className="flex-1 resize-none rounded-lg bg-gray-800 px-4 py-2 text-sm text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
                disabled={isLoading}
              />
              <button
                onClick={sendMessage}
                disabled={isLoading || !input.trim()}
                className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-r from-purple-500 to-indigo-600 text-white transition-all hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="发送消息"
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
