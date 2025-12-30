'use client';

import { useState, useRef, useEffect } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export default function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
      // Step 1: Planner
      const plannerResponse = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': localStorage.getItem('token') ? `Bearer ${localStorage.getItem('token')}` : '',
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: await fetchPromptFile('prompt-planner.txt') },
            ...updatedMessages,
          ],
        }),
      });

      if (!plannerResponse.ok) {
        const errorText = await plannerResponse.text();
        console.warn('Planner Error:', errorText);
        throw new Error('Planner failed to process the request');
      }

      const plannerData = await plannerResponse.json();
      console.log('Planner Data:', plannerData);
      // Ensure only the LLM response is added to the messages
      if (!plannerData.message.includes('{')) {
        setMessages((prev) => [...prev, { role: 'assistant', content: plannerData.message }]);
        setIsLoading(false);
        return;
      }
      
      let plannerMessage;
      try {
        plannerMessage = JSON.parse(plannerData.message);
      } catch (error) {
        console.error('Failed to parse plannerData.message:', error);
        setMessages((prev) => [...prev, { role: 'assistant', content: 'An error occurred while processing the planner response.' }]);
        setIsLoading(false);
        return;
      }

      if (plannerMessage.plan_summary) {
        setMessages((prev) => [...prev, { role: 'assistant', content: plannerMessage.plan_summary }]);
      } else {
        console.warn('Planner response does not contain a plan summary.');
      }

      // Step 2: Executor
      const executorResponse = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': localStorage.getItem('token') ? `Bearer ${localStorage.getItem('token')}` : '',
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: await fetchPromptFile('prompt-executor.txt') },
            ...updatedMessages,
          ],
        }),
      });

      if (!executorResponse.ok) {
        const errorText = await executorResponse.text();
        console.warn('Executor Error:', errorText);
        throw new Error('Executor failed to process the request');
      }

      const executorData = await executorResponse.json();
      if (executorData.blocked) {
        const blockedMessage: Message = {
          role: 'assistant',
          content: executorData.block_reason || 'The Executor is blocked and cannot proceed.',
        };
        setMessages((prev) => [...prev, blockedMessage]);
        console.warn('Executor Blocked:', executorData.block_reason);
        setIsLoading(false);
        return;
      }

      const executorMessage: Message = {
        role: 'assistant',
        content: executorData.content,
      };
      setMessages((prev) => [...prev, executorMessage]);
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

  const fetchPromptFile = async (fileName: string): Promise<string> => {
    try {
      const response = await fetch(`/api/fetch-prompt?fileName=${fileName}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch prompt file: ${fileName}`);
      }
      return await response.text();
    } catch (error: any) {
      throw new Error(`Error fetching prompt file: ${error.message}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
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
                  <p className="whitespace-pre-wrap text-sm">
                    {typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}
                  </p>
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
