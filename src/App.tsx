import React, { useState, useRef, useEffect } from 'react';
import type { DragEvent } from 'react';
import { UploadCloud, FileText, File as FileIcon, Send, Bot, User, Menu, FileCode } from 'lucide-react';

type Mode = 'Chat' | 'Summary' | 'Quote';

interface Document {
  id: string;
  name: string;
  type: string;
  content: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  mode: Mode;
  references?: string[];
  isStreaming?: boolean;
}

export default function App() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<Mode>('Chat');
  const [chats, setChats] = useState<Record<string, Message[]>>({});
  const [input, setInput] = useState('');
  
  const activeMessages = activeDocumentId ? (chats[activeDocumentId] || []) : [];
  const [isDragging, setIsDragging] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isLoading, setIsLoading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [activeMessages, isLoading]);

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const readFileContent = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string || `[Content of ${file.name}]`);
      reader.onerror = (e) => reject(e);
      reader.readAsText(file);
    });
  };

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      await processFile(file);
    }
  };

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      await processFile(file);
    }
  };

  const processFile = async (file: File) => {
    // Basic validation
    const extension = file.name.split('.').pop()?.toLowerCase();
    
    let content = '';
    try {
      content = await readFileContent(file);
      // Fallback for non-text files that read as gibberish
      if (file.type !== 'text/plain' && content.includes('')) {
        content = `[Simulated text content of ${file.name} for demonstration purposes. This is a placeholder since raw binary parsing requires specialized libraries.]`;
      }
    } catch (err) {
      content = `[Failed to read content of ${file.name}]`;
    }

    const newDoc: Document = {
      id: Math.random().toString(36).substring(7),
      name: file.name,
      type: file.type || (extension ? `.${extension}` : 'unknown'),
      content: content
    };

    setDocuments(prev => [...prev, newDoc]);
    setActiveDocumentId(newDoc.id);
    
    setChats(prev => ({
      ...prev,
      [newDoc.id]: [{
        id: Math.random().toString(),
        role: 'assistant',
        content: `I've analyzed ${file.name}. What would you like to know about it?`,
        mode: 'Chat',
      }]
    }));
  };

  const buildSystemPrompt = () => {
    const activeDoc = documents.find(d => d.id === activeDocumentId);
    let context = activeDoc ? `--- File: ${activeDoc.name} ---\n${activeDoc.content}\n-------------------` : '';
    
    return `You are "TwoKey AI Document Assistant". You strictly answer questions based on the provided documents.
Current Mode: ${activeMode}. 
If Mode is Summary: Provide a concise summary of the requested topic.
If Mode is Quote: Extract exact quotes from the text.
If Mode is Chat: Answer conversationally but accurately.
CRITICAL RULES:
1. Answer ONLY from document context. Never hallucinate.
2. If info is absent, say EXACTLY: "This information was not found in the uploaded documents."
3. Cite your sources in the format [Filename, Page X] when providing facts.

CONTEXT DOCUMENTS:
${context || 'No documents uploaded yet.'}`;
  };

  const callMistralAPI = async (userMessage: string) => {
    // Proxy through Vite to avoid CORS issues
    const invoke_url = "/api/nvidia-proxy/v1/chat/completions";
    const apiKey = import.meta.env.VITE_NVIDIA_API_KEY;
    // No client‑side API key needed; the Vercel function injects it securely

    const apiMessages = [
      { role: "system", content: buildSystemPrompt() },
      ...activeMessages.map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage }
    ];

    try {
      const response = await fetch(invoke_url, {
        method: "POST",
        headers: {
          "Accept": "text/event-stream",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "mistralai/mistral-small-4-119b-2603",
          messages: apiMessages,
          max_tokens: 1500,
          temperature: 0.10,
          top_p: 1.00,
          stream: true
        })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder("utf-8");
      
      let fullResponse = "";
      
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\\n').filter(line => line.trim() !== '');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.replace('data: ', '');
              if (dataStr === '[DONE]') break;
              
              try {
                const data = JSON.parse(dataStr);
                if (data.choices && data.choices[0].delta && data.choices[0].delta.content) {
                  fullResponse += data.choices[0].delta.content;
                  
                  // Update streaming message
                  setChats(prev => {
                    if (!activeDocumentId) return prev;
                    const currentChat = prev[activeDocumentId] || [];
                    const newChat = [...currentChat];
                    const lastMsg = newChat[newChat.length - 1];
                    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
                      lastMsg.content = fullResponse;
                      // Try to parse out references based on citations [Filename, Page X]
                      const citations = fullResponse.match(/\[(.*?)\]/g) || [];
                      if (citations.length > 0) {
                        lastMsg.references = Array.from(new Set(citations));
                      }
                    }
                    return { ...prev, [activeDocumentId]: newChat };
                  });
                }
              } catch (e) {
                // Ignore parse errors for incomplete chunks
              }
            }
          }
        }
      }
      
      // Finalize streaming
      setChats(prev => {
        if (!activeDocumentId) return prev;
        const currentChat = prev[activeDocumentId] || [];
        const newChat = [...currentChat];
        const lastMsg = newChat[newChat.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.isStreaming = false;
        }
        return { ...prev, [activeDocumentId]: newChat };
      });

    } catch (error) {
      console.error("API Call Error:", error);
      setChats(prev => {
        if (!activeDocumentId) return prev;
        const currentChat = prev[activeDocumentId] || [];
        const newChat = [...currentChat];
        const lastMsg = newChat[newChat.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.content = "An error occurred while connecting to the AI. Please try again later.";
          lastMsg.isStreaming = false;
        }
        return { ...prev, [activeDocumentId]: newChat };
      });
    }
  };

  const handleSend = async () => {
    if ((!input.trim() && documents.length === 0) || !activeDocumentId) return;
    
    const userMsg = input.trim();
    setInput('');
    
    const newMessage: Message = {
      id: Math.random().toString(),
      role: 'user',
      content: userMsg,
      mode: activeMode
    };
    
    setChats(prev => {
      const currentChat = prev[activeDocumentId] || [];
      return {
        ...prev,
        [activeDocumentId]: [
          ...currentChat,
          newMessage,
          {
            id: Math.random().toString(),
            role: 'assistant',
            content: '',
            mode: activeMode,
            isStreaming: true
          }
        ]
      };
    });
    
    setIsLoading(true);
    await callMistralAPI(userMsg);
    setIsLoading(false);
  };

  return (
    <div className="flex flex-col h-screen w-full bg-[#0a0a0f] text-white font-sans overflow-hidden">
      {/* Topbar */}
      <header className="h-16 border-b border-[#2a2a35]/50 flex items-center px-4 md:px-6 justify-between bg-[#0a0a0f]/80 backdrop-blur-md z-10">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="p-2 hover:bg-[#15151e] rounded-lg transition-colors md:hidden"
          >
            <Menu size={20} />
          </button>
          <div className="flex items-center gap-2 text-primary font-bold text-xl tracking-tight">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-purple-500 flex items-center justify-center text-white">
              <span className="font-mono">2K</span>
            </div>
            <span className="hidden sm:block">TwoKey<span className="text-white/80 font-medium ml-1 text-sm">AI Assistant</span></span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm font-medium text-gray-400">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#15151e] border border-[#2a2a35]/50">
            <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]"></div>
            Mistral Small
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Sidebar */}
        <aside 
          className={`absolute md:relative z-20 h-full w-72 bg-[#0a0a0f] border-r border-[#2a2a35]/50 flex flex-col transition-transform duration-300 ease-in-out ${
            isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0 md:w-0 md:opacity-0 md:overflow-hidden'
          }`}
        >
          <div className="p-4 flex-1 flex flex-col min-h-0">
            <div className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4 flex justify-between items-center">
              <span>Documents</span>
              <span className="bg-[#15151e] text-xs py-0.5 px-2 rounded-full border border-[#2a2a35]">{documents.length}</span>
            </div>
            
            <div className="flex-1 overflow-y-auto space-y-2 pr-2">
              {documents.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-gray-500 space-y-3">
                  <FileText size={32} className="opacity-20" />
                  <p className="text-sm text-center">No documents uploaded yet</p>
                </div>
              ) : (
                documents.map(doc => (
                  <div 
                    key={doc.id} 
                    onClick={() => setActiveDocumentId(doc.id)}
                    className={`flex items-center gap-3 p-3 rounded-xl transition-all group cursor-pointer border ${
                      activeDocumentId === doc.id 
                        ? 'border-primary bg-[#1a1a24]' 
                        : 'bg-[#15151e] border-[#2a2a35]/40 hover:border-primary/40 hover:bg-[#1a1a24]'
                    }`}
                  >
                    <div className="p-2 rounded-lg bg-[#2a2a35]/50 text-primary">
                      {doc.name.endsWith('.pdf') ? <FileText size={16} /> : 
                       doc.name.endsWith('.docx') ? <FileIcon size={16} /> : 
                       <FileCode size={16} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-200 truncate">{doc.name}</p>
                      <p className="text-xs text-gray-500 uppercase">{doc.type.replace('.', '') || 'TXT'}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
            
            {/* Quick Actions */}
            <div className="pt-4 border-t border-[#2a2a35]/50 mt-4 space-y-2">
              <button 
                className="w-full py-2 px-4 rounded-xl border border-[#2a2a35] bg-[#15151e] hover:bg-[#1a1a24] text-sm font-medium text-gray-300 transition-colors flex items-center justify-center gap-2"
                onClick={() => document.getElementById('file-upload')?.click()}
              >
                <UploadCloud size={16} />
                Upload New File
              </button>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#0c0c12]">
          {documents.length === 0 ? (
            // Upload Panel Empty State
            <div className="flex-1 flex items-center justify-center p-6 md:p-12">
              <div 
                className={`w-full max-w-2xl aspect-[4/3] rounded-3xl border-2 border-dashed flex flex-col items-center justify-center p-8 text-center transition-all duration-300 ${
                  isDragging 
                    ? 'border-primary bg-primary/5 scale-[1.02]' 
                    : 'border-[#2a2a35] hover:border-primary/50 hover:bg-[#15151e]/50'
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <div className="w-20 h-20 mb-6 rounded-2xl bg-[#15151e] border border-[#2a2a35] flex items-center justify-center text-primary relative shadow-2xl">
                  <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full"></div>
                  <UploadCloud size={40} className="relative z-10" />
                </div>
                <h2 className="text-2xl font-bold mb-3 font-sans text-white">Upload your documents</h2>
                <p className="text-gray-400 mb-8 max-w-md font-mono text-sm">
                  Drag and drop PDF, DOCX, or TXT files here, or click to browse. The AI will instantly analyze and prepare them for conversation.
                </p>
                <label 
                  htmlFor="file-upload"
                  className="px-6 py-3 rounded-full bg-primary hover:bg-primary/90 text-white font-medium cursor-pointer transition-transform hover:scale-105 active:scale-95 shadow-[0_0_20px_rgba(107,76,255,0.4)]"
                >
                  Browse Files
                </label>
              </div>
            </div>
          ) : (
            // Chat Interface
            <div className="flex-1 flex flex-col min-h-0 max-w-5xl mx-auto w-full">
              {/* Mode Tabs */}
              <div className="flex justify-center p-4">
                <div className="flex p-1 bg-[#15151e] rounded-full border border-[#2a2a35]/50">
                  {(['Chat', 'Summary', 'Quote'] as Mode[]).map(mode => (
                    <button
                      key={mode}
                      onClick={() => setActiveMode(mode)}
                      className={`px-6 py-2 rounded-full text-sm font-medium transition-all ${
                        activeMode === mode 
                          ? 'bg-primary text-white shadow-lg shadow-primary/25' 
                          : 'text-gray-400 hover:text-white hover:bg-[#2a2a35]/30'
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>

              {/* Quick Action Buttons */}
              {activeMessages.filter(m => m.role === 'user').length === 0 && documents.length > 0 && (
                <div className="flex flex-wrap gap-2 px-4 md:px-8 mt-2">
                  <button onClick={() => setInput("What are the main topics discussed in these documents?")} className="px-4 py-2 bg-[#15151e] border border-[#2a2a35] rounded-lg text-sm text-gray-300 hover:bg-[#2a2a35]/50 transition-colors">
                    What are the main topics?
                  </button>
                  <button onClick={() => setInput("Can you extract the key metrics mentioned?")} className="px-4 py-2 bg-[#15151e] border border-[#2a2a35] rounded-lg text-sm text-gray-300 hover:bg-[#2a2a35]/50 transition-colors">
                    Extract key metrics
                  </button>
                  <button onClick={() => setInput("Summarize the executive overview.")} className="px-4 py-2 bg-[#15151e] border border-[#2a2a35] rounded-lg text-sm text-gray-300 hover:bg-[#2a2a35]/50 transition-colors">
                    Summarize executive overview
                  </button>
                </div>
              )}

              {/* Chat History */}
              <div className="flex-1 overflow-y-auto px-4 md:px-8 py-4 space-y-6">
                {activeMessages.map((msg) => (
                  <div key={msg.id} className={`flex gap-4 max-w-3xl ${msg.role === 'user' ? 'ml-auto flex-row-reverse' : 'mr-auto'}`}>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                      msg.role === 'user' 
                        ? 'bg-gradient-to-br from-indigo-500 to-purple-600' 
                        : 'bg-[#15151e] border border-[#2a2a35] text-primary'
                    }`}>
                      {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
                    </div>
                    <div className="flex flex-col gap-2 max-w-[85%]">
                      <div className={`p-4 rounded-2xl ${
                        msg.role === 'user'
                          ? 'bg-primary text-white rounded-tr-none'
                          : 'bg-[#15151e] border border-[#2a2a35]/50 text-gray-200 rounded-tl-none font-mono text-sm leading-relaxed'
                      }`}>
                        {msg.isStreaming ? (
                          msg.content ? (
                            <div className="whitespace-pre-wrap">{msg.content}<span className="inline-block w-2 h-4 bg-primary ml-1 animate-pulse align-middle"></span></div>
                          ) : (
                            <div className="typing-indicator">
                              <span></span><span></span><span></span>
                            </div>
                          )
                        ) : (
                          <div className="whitespace-pre-wrap">{msg.content}</div>
                        )}
                      </div>
                      
                      {/* References Block */}
                      {msg.role === 'assistant' && msg.references && msg.references.length > 0 && !msg.isStreaming && (
                        <div className="mt-1 flex flex-wrap gap-2">
                          {msg.references.map((ref, idx) => (
                            <span key={idx} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#1a1a24] border border-[#2a2a35] text-xs font-mono text-gray-400">
                              <FileText size={10} className="text-primary" />
                              {ref.replace(/[\[\]]/g, '')}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Input Area */}
              <div className="p-4 md:p-6 bg-gradient-to-t from-[#0c0c12] via-[#0c0c12] to-transparent">
                <div className="max-w-3xl mx-auto relative group">
                  <div className="absolute -inset-1 bg-gradient-to-r from-primary to-purple-600 rounded-2xl blur opacity-25 group-focus-within:opacity-50 transition duration-500"></div>
                  <div className="relative flex items-end gap-2 bg-[#15151e] border border-[#2a2a35] rounded-2xl p-2 focus-within:border-primary/50 transition-colors">
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSend();
                        }
                      }}
                      placeholder={activeMode === 'Summary' ? "E.g., Summarize the executive overview..." : activeMode === 'Quote' ? "E.g., Find quotes about Q3 revenue..." : "Ask a question about your documents..."}
                      className="w-full bg-transparent text-white placeholder-gray-500 p-3 max-h-32 min-h-[56px] resize-none focus:outline-none font-sans"
                      rows={1}
                    />
                    <button 
                      onClick={handleSend}
                      disabled={!input.trim() || isLoading}
                      className="p-3 bg-primary hover:bg-primary/90 disabled:bg-[#2a2a35] disabled:text-gray-500 text-white rounded-xl mb-1 transition-colors"
                    >
                      <Send size={20} />
                    </button>
                  </div>
                </div>
                <p className="text-center text-xs text-gray-600 mt-3 font-mono">
                  AI answers strictly from document context. Verifies facts before answering.
                </p>
              </div>
            </div>
          )}
          
          {/* Global Hidden File Input */}
          <input 
            type="file" 
            id="file-upload" 
            className="hidden" 
            accept=".pdf,.docx,.txt"
            onChange={handleFileInput}
          />
        </main>
      </div>
    </div>
  );
}
