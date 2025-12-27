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
    scrollToBottom();
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { role: 'user', content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages: [...messages, userMessage] }),
      });

      if (!response.ok) {
        throw new Error('Failed to get response');
      }

      const data = await response.json();
      const assistantMessage: Message = {
        role: 'assistant',
        content: data.message,
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // 详细的日志记录 - 显示所有迭代
      console.log('\n' + '╔' + '═'.repeat(78) + '╗');
      console.log('║' + ' '.repeat(25) + '🤖 AI响应详情' + ' '.repeat(36) + '║');
      console.log('╚' + '═'.repeat(78) + '╝');
      console.log(`\n📊 总览:`);
      console.log(`   迭代次数: ${data.iterations}`);
      console.log(`   工具调用次数: ${data.tool_calls?.length || 0}`);
      console.log(`   上下文已摘要: ${data.summarized ? '是' : '否'}`);

      // 显示每次迭代的详细内容
      if (data.iteration_logs && data.iteration_logs.length > 0) {
        console.log('\n' + '▼'.repeat(80));
        console.log('📝 迭代详情 (按顺序):');
        console.log('▼'.repeat(80));

        data.iteration_logs.forEach((log: any) => {
          console.log(`\n${'═'.repeat(80)}`);
          console.log(`🔄 迭代 ${log.iteration}/${data.iterations}`);
          console.log(`${'═'.repeat(80)}`);

          // 根据类型显示不同的信息
          switch (log.type) {
            case 'doc_load':
              console.log(`📚 类型: 文档加载请求`);
              console.log(`\n📋 LLM 输出:`);
              console.log(log.llm_output);
              console.log(`\n📦 详情:`);
              console.log(`   请求的模块:`, log.details.requested);
              console.log(`   已加载的模块:`, log.details.loaded);
              console.log(`   总共加载模块数: ${log.details.total_loaded || 0}`);
              if (log.details.already_loaded) {
                console.log(`   ⚠️  请求的模块已经加载过`);
              }
              break;

            case 'tool_call':
              console.log(`🔧 类型: API调用`);
              console.log(`\n📋 LLM 输出:`);
              console.log(log.llm_output);
              console.log(`\n🛠️  工具调用详情:`);
              log.details.tool_calls.forEach((call: any, idx: number) => {
                console.log(`\n   [${idx + 1}/${log.details.tool_calls.length}] ${call.tool_name}`);
                console.log(`   URL: ${call.url}`);
                console.log(`   参数:`, call.arguments);
                console.log(`   响应大小: ~${call.response_size} tokens`);
                console.log(`   已压缩: ${call.compressed ? '是' : '否'}`);
                if (call.response_data) {
                  console.log(`   完整响应 (可展开):`);
                  console.log(call.response_data);
                }
              });
              break;

            case 'clarification':
              console.log(`❓ 类型: 需要澄清`);
              console.log(`\n📋 LLM 输出:`);
              console.log(log.llm_output);
              console.log(`\n💬 问题:`, log.details.question);
              break;

            case 'text_response':
              console.log(`✨ 类型: 最终文本响应`);
              console.log(`\n📋 LLM 输出:`);
              console.log(log.llm_output);
              console.log(`\n📏 响应信息:`);
              console.log(`   字符数: ${log.details.length}`);
              console.log(`   Token估算: ~${log.details.tokens}`);
              break;
          }
        });

        console.log('\n' + '▲'.repeat(80));
      }

      console.log('\n╔' + '═'.repeat(78) + '╗');
      console.log('║' + ' '.repeat(28) + '💬 最终回复' + ' '.repeat(36) + '║');
      console.log('╚' + '═'.repeat(78) + '╝');
      console.log(data.message);
      console.log('═'.repeat(80) + '\n');
    } catch (error) {
      console.error('Error sending message:', error);
      const errorMessage: Message = {
        role: 'assistant',
        content: '抱歉，发生了错误。请稍后再试。',
      };
      setMessages((prev) => [...prev, errorMessage]);
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

  return (
    <>
      {/* 漂浮按钮 */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-r from-purple-500 to-indigo-600 text-white shadow-lg transition-all hover:scale-110 hover:shadow-xl"
          aria-label="打开聊天"
        >
          <svg
            className="h-6 w-6"
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
                  <p className="whitespace-pre-wrap text-sm">{message.content}</p>
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
