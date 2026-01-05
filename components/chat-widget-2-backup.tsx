'use client'

import React, { useState } from 'react'
import '../app/css/additional-styles/chat-widget.css'

export default function ChatWidget2() {
  const [isExpanded, setIsExpanded] = useState(false)
  const [message, setMessage] = useState('')
  const [messages, setMessages] = useState([
    {
      id: 1,
      text: 'Hello! How can I help you today?',
      sender: 'agent',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ])

  const toggleWidget = () => {
    setIsExpanded(!isExpanded)
  }

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault()
    if (message.trim()) {
      setMessages([
        ...messages,
        {
          id: messages.length + 1,
          text: message,
          sender: 'user',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ])
      setMessage('')
    }
  }

  return (
    <>
      <div className="chat-widget-container">
        <div className={`chat-panel ${isExpanded ? 'expanded' : 'collapsed'}`}>
          <div className="chat-header">
            <div className="chat-header-content">
              <div className="chat-avatar">
                <span>💬</span>
              </div>
              <div className="chat-header-text">
                <h3>Chat Support</h3>
                <p>We're here to help</p>
              </div>
            </div>
            <button className="close-button" onClick={toggleWidget} aria-label="Close chat">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path
                  d="M15 5L5 15M5 5L15 15"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          <div className="chat-messages">
            {messages.map((msg) => (
              <div key={msg.id} className={`message ${msg.sender}`}>
                <div>
                  <div className="message-content">{msg.text}</div>
                  <div className="message-time">{msg.timestamp}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="chat-input-container">
            <form className="chat-input-form" onSubmit={handleSendMessage}>
              <input
                type="text"
                className="chat-input"
                placeholder="Type your message..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <button
                type="submit"
                className="send-button"
                disabled={!message.trim()}
                aria-label="Send message"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M18 2L9 11M18 2L12 18L9 11M18 2L2 8L9 11"
                    stroke="white"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </form>
          </div>
        </div>

        <button
          className={`chat-toggle-button ${isExpanded ? 'expanded' : ''}`}
          onClick={toggleWidget}
          aria-label="Toggle chat"
        >
          {isExpanded ? (
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <path
                d="M19 9L12 16L5 9"
                stroke="white"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <path
                d="M21 15C21 15.5304 20.7893 16.0391 20.4142 16.4142C20.0391 16.7893 19.5304 17 19 17H7L3 21V5C3 4.46957 3.21071 3.96086 3.58579 3.58579C3.96086 3.21071 4.46957 3 5 3H19C19.5304 3 20.0391 3.21071 20.4142 3.58579C20.7893 3.96086 21 4.46957 21 5V15Z"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      </div>
    </>
  )
}
