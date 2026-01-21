
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, LiveServerMessage, Modality, Blob, Type } from '@google/genai';

// --- 类型定义 ---
interface Message {
  id: string;
  role: 'user' | 'ai';
  text: string;
  translation?: string;
  isTranslating?: boolean;
}

interface Suggestion {
  en: string;
  cn: string;
  tag: 'Flow' | 'Dive' | 'Safety';
  label: string;
}

type Difficulty = '入门' | '进阶' | '挑战';

declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }
  var aistudio: AIStudio;
}

// --- 常量配置 ---
const LIVE_MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
const TRANSLATION_MODEL_NAME = 'gemini-3-flash-preview'; 
const SUGGESTION_MODEL_NAME = 'gemini-3-flash-preview';
const MAX_RECONNECT_ATTEMPTS = 3;

// --- 辅助函数 ---
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'ai',
      text: "Yo! Ready to vibe with some English? 🚀 I'm here to talk about anything—from crazy weekend plans to your favorite snacks. What's on your mind today?"
    }
  ]);
  const [difficulty, setDifficulty] = useState<Difficulty>('进阶');
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [globalBilingual, setGlobalBilingual] = useState(false);
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isGeneratingSuggestions, setIsGeneratingSuggestions] = useState(false);
  const [statusText, setStatusText] = useState('等待开始');
  const [errorText, setErrorText] = useState<React.ReactNode | null>(null);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<any>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const reconnectCountRef = useRef(0);
  
  const currentInputText = useRef('');
  const currentOutputText = useRef('');
  const audioBufferQueue = useRef<Blob[]>([]);
  const hasTriggeredSuggestionsRef = useRef(false);
  const userManuallyStopped = useRef(false);

  // 网络状态监控
  useEffect(() => {
    const handleOnline = () => { setIsOnline(true); setErrorText(null); };
    const handleOffline = () => { 
      setIsOnline(false); 
      setErrorText('网络连接已断开，请检查网络或代理。');
      if (isSessionActive) {
        setIsSessionActive(false);
        setIsReconnecting(true);
      }
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [isSessionActive]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  useEffect(() => {
    const checkStatus = setInterval(() => {
      const active = sourcesRef.current.size > 0;
      if (active !== isAISpeaking) {
        setIsAISpeaking(active);
        if (!active && audioBufferQueue.current.length > 0 && sessionRef.current) {
          audioBufferQueue.current.forEach(blob => {
            sessionRef.current.sendRealtimeInput({ media: blob });
          });
          audioBufferQueue.current = [];
        }
      }
    }, 100);
    return () => clearInterval(checkStatus);
  }, [isAISpeaking]);

  // 当双语模式开启时，仅翻译当前未翻译的消息
  useEffect(() => {
    if (globalBilingual) {
      messages.forEach(msg => {
        if (msg.role === 'ai' && !msg.translation && !msg.isTranslating) {
          handleTranslate(msg.id, msg.text);
        }
      });
    }
  }, [globalBilingual]);

  const handleTranslate = async (id: string, text: string) => {
    if (!process.env.API_KEY) {
      setErrorText('请先点击右上角的“API 设置”按钮选择有效的 API Key。');
      return;
    }
    
    let shouldSkip = false;
    setMessages(prev => {
      const msg = prev.find(m => m.id === id);
      if (msg?.translation || msg?.isTranslating) {
        shouldSkip = true;
        return prev;
      }
      return prev.map(m => m.id === id ? { ...m, isTranslating: true } : m);
    });

    if (shouldSkip) return;
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: TRANSLATION_MODEL_NAME,
        contents: `Translate to casual spoken Chinese: "${text}"`,
        config: {
            systemInstruction: "You are a professional casual translator. Translate English slang and idioms into natural, modern Chinese spoken language. Output ONLY the translation.",
            temperature: 0.1,
        }
      });
      const translation = response.text?.trim() || "翻译暂时不可用。";
      setMessages(prev => prev.map(m => m.id === id ? { ...m, translation, isTranslating: false } : m));
    } catch (err) {
      console.error("Translation Error:", err);
      setMessages(prev => prev.map(m => m.id === id ? { ...m, isTranslating: false } : m));
    }
  };

  const generateSuggestions = async () => {
    if (isGeneratingSuggestions || !process.env.API_KEY) return;
    setIsGeneratingSuggestions(true);
    
    try {
      // 提取更丰富的上下文以确保相关性
      const lastContext = [
        ...messages.slice(-4), // 包含更多轮次
        { role: 'user', text: currentInputText.current }
      ].map(m => `${m.role.toUpperCase()}: ${m.text}`).join('\n');

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: SUGGESTION_MODEL_NAME,
        contents: `Recent conversation:\n${lastContext}\n\nBased on this, generate 3 highly relevant and natural next steps for the user.`,
        config: { 
          systemInstruction: `You are an expert English conversation coach. 
          Task: Analyze the context and provide 3 response suggestions that feel natural and keep the vibe alive.
          - 'Flow': A natural continuation or direct answer.
          - 'Dive': A deeper follow-up question or thought-provoking comment.
          - 'Safety': A way to ask for clarification if something was unclear.
          JSON ONLY. Values must be contextually unique to the current conversation.`,
          temperature: 0.3, // 稍微提高一点以增加回复的生命力
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                tag: { type: Type.STRING },
                label: { type: Type.STRING },
                en: { type: Type.STRING },
                cn: { type: Type.STRING }
              },
              required: ["tag", "label", "en", "cn"]
            }
          }
        }
      });
      
      const text = response.text?.trim() || "[]";
      setSuggestions(JSON.parse(text));
    } catch (e) {
      console.error("Suggestion failed", e);
    } finally {
      setIsGeneratingSuggestions(false);
    }
  };

  const ensureApiKey = async () => {
    if (process.env.API_KEY && process.env.API_KEY !== '') return true;
    if (window.aistudio) {
      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) {
        setStatusText('等待密钥选择...');
        await window.aistudio.openSelectKey();
      }
      return true;
    }
    return false;
  };

  const startSession = async (autoRetry = false) => {
    if (isSessionActive || isConnecting) return;
    if (!navigator.onLine) {
      setErrorText('您当前处于离线状态，无法启动连接。');
      return;
    }

    if (!autoRetry) {
      setErrorText(null);
      userManuallyStopped.current = false;
      reconnectCountRef.current = 0;
    }

    setIsConnecting(true);
    setIsReconnecting(autoRetry);
    setStatusText(autoRetry ? '尝试重连...' : '准备中...');

    try {
      await ensureApiKey();
      
      if (!process.env.API_KEY) {
        setErrorText('启动失败：未检测到 API Key。');
        setIsConnecting(false);
        setIsReconnecting(false);
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      if (!inputAudioCtxRef.current) inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      if (!outputAudioCtxRef.current) outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      const sessionPromise = ai.live.connect({
        model: LIVE_MODEL_NAME,
        callbacks: {
          onopen: () => {
            setIsSessionActive(true);
            setIsConnecting(false);
            setIsReconnecting(false);
            reconnectCountRef.current = 0;
            setStatusText('通话中');
            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              const pcmBlob: Blob = { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
              sessionPromise.then(session => {
                if (sourcesRef.current.size > 0) audioBufferQueue.current.push(pcmBlob);
                else session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current!.destination);
            sessionRef.current = { stopStream: () => { stream.getTracks().forEach(t => t.stop()); scriptProcessor.disconnect(); source.disconnect(); } };
          },
          onmessage: async (message: LiveServerMessage) => {
            if ((message.serverContent?.modelTurn || message.serverContent?.outputTranscription) && !hasTriggeredSuggestionsRef.current) {
              hasTriggeredSuggestionsRef.current = true;
              generateSuggestions();
            }

            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outputAudioCtxRef.current) {
              const ctx = outputAudioCtxRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              sourcesRef.current.add(source);
              source.addEventListener('ended', () => sourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
            }

            if (message.serverContent?.inputTranscription) currentInputText.current += message.serverContent.inputTranscription.text || '';
            if (message.serverContent?.outputTranscription) currentOutputText.current += message.serverContent.outputTranscription.text || '';

            if (message.serverContent?.turnComplete) {
              const uText = currentInputText.current.trim();
              const aText = currentOutputText.current.trim();
              if (uText) setMessages(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', text: uText }]);
              if (aText) {
                const id = `a-${Date.now()}`;
                setMessages(prev => {
                  const newMsgs = [...prev, { id, role: 'ai', text: aText }];
                  // 双语开启时，自动开启翻译
                  if (globalBilingual) {
                    setTimeout(() => handleTranslate(id, aText), 50);
                  }
                  return newMsgs;
                });
              }
              currentInputText.current = ''; currentOutputText.current = '';
              hasTriggeredSuggestionsRef.current = false;
            }
          },
          onerror: (err: any) => {
            console.error("Live API Error:", err);
            setIsSessionActive(false); 
            setIsConnecting(false);
            if (reconnectCountRef.current < MAX_RECONNECT_ATTEMPTS && !userManuallyStopped.current) {
              reconnectCountRef.current++;
              setTimeout(() => startSession(true), 2000);
            } else {
              setErrorText('连接异常断开。');
              setStatusText('连接失败');
            }
          },
          onclose: () => { 
            setIsSessionActive(false); 
            if (!userManuallyStopped.current && reconnectCountRef.current < MAX_RECONNECT_ATTEMPTS) {
              setIsReconnecting(true);
              reconnectCountRef.current++;
              setTimeout(() => startSession(true), 2000);
            } else {
              setStatusText('会话已结束');
            }
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: "You are 'Vibe' - a charismatic English tutor. Use slang and be energetic. If audio is unclear, politely ask the user to type or repeat.",
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
    } catch (err: any) {
      console.error("Startup Failure:", err);
      setErrorText('启动失败：' + (err.message || '未知错误'));
      setIsConnecting(false);
      setIsReconnecting(false);
    }
  };

  const toggleSession = () => {
    if (isSessionActive) {
      userManuallyStopped.current = true;
      if (sessionRef.current?.stopStream) sessionRef.current.stopStream();
      setIsSessionActive(false);
      setStatusText('通话已结束');
    } else {
      startSession();
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-[1200px] mx-auto bg-[#F2F7F2] text-[#1A2E1A] relative overflow-hidden font-sans border-x border-[#E1E8E1] shadow-2xl">
      {/* Header */}
      <header className="glass-header px-4 sm:px-10 py-4 sm:py-6 flex flex-col gap-4 sticky top-0 z-50 shadow-sm border-b border-[#E1E8E1]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 sm:gap-5 overflow-hidden">
            <div className="flex-shrink-0 relative">
              <div className={`w-11 h-11 sm:w-16 sm:h-16 rounded-2xl sm:rounded-3xl flex items-center justify-center text-white shadow-xl transition-all duration-500 ${!isOnline ? 'bg-stone-400' : (isSessionActive ? 'bg-[#2D5A27] rotate-12 scale-110' : 'bg-[#2D5A27]')}`}>
                <i className={`fas ${!isOnline ? 'fa-wifi-slash' : 'fa-bolt'} text-xl sm:text-3xl`}></i>
              </div>
              {isSessionActive && <span className="absolute -top-1 -right-1 w-4 h-4 sm:w-6 sm:h-6 bg-emerald-500 border-4 border-[#F2F7F2] rounded-full animate-ping"></span>}
            </div>
            <div className="flex flex-col min-w-0">
              <h1 className="font-black text-xl sm:text-3xl tracking-tight leading-none text-[#2D5A27] truncate">
                LingoLink <span className="text-[10px] sm:text-xs bg-[#2D5A27] text-white px-2 py-0.5 rounded-md ml-1 align-middle">LIVE</span>
              </h1>
              <div className="flex items-center gap-2 mt-1 sm:mt-2">
                <span className={`w-2 sm:w-2.5 h-2 sm:h-2.5 rounded-full ${isSessionActive ? 'bg-emerald-500 animate-pulse' : (isConnecting ? 'bg-amber-400 animate-bounce' : 'bg-rose-400')}`}></span>
                <p className="text-[10px] sm:text-xs text-[#5E7A5E] uppercase tracking-widest font-black truncate">
                  {isReconnecting ? `重连中 (${reconnectCountRef.current}/3)` : statusText}
                </p>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-3 sm:gap-5 flex-shrink-0">
            <button 
              onClick={() => window.aistudio?.openSelectKey()} 
              className={`group relative flex items-center justify-center w-10 h-10 sm:w-12 sm:h-12 rounded-xl sm:rounded-2xl transition-all shadow-md active:scale-95 ${window.aistudio ? 'bg-white text-[#2D5A27] hover:bg-[#2D5A27] hover:text-white' : 'bg-stone-200 text-stone-400 cursor-not-allowed'}`}
              title="API 设置"
            >
              <i className="fas fa-key text-lg sm:text-xl"></i>
              {!process.env.API_KEY && isOnline && (
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-rose-500 rounded-full border-2 border-white animate-pulse"></span>
              )}
            </button>
            
            <label className="flex items-center gap-2 sm:gap-4 cursor-pointer bg-white px-3 sm:px-5 py-2 sm:py-3 rounded-xl sm:rounded-2xl border border-[#E1E8E1] shadow-sm hover:shadow-md transition-all">
              <span className="text-[10px] sm:text-xs font-black text-[#5E7A5E] uppercase tracking-wider">双语</span>
              <div onClick={() => setGlobalBilingual(!globalBilingual)} className={`w-10 sm:w-12 h-6 sm:h-7 rounded-full p-1 transition-colors duration-300 ${globalBilingual ? 'bg-[#2D5A27]' : 'bg-[#D1DDD1]'}`}>
                <div className={`w-4 sm:w-5 h-4 sm:h-5 bg-white rounded-full shadow-md transform transition-transform duration-300 ${globalBilingual ? 'translate-x-4 sm:translate-x-5' : 'translate-x-0'}`}></div>
              </div>
            </label>
          </div>
        </div>
        
        {errorText && (
          <div className="bg-rose-50 border-2 border-rose-100 text-rose-800 px-5 sm:px-8 py-4 sm:py-5 rounded-2xl sm:rounded-3xl flex items-start gap-4 animate-fadeIn shadow-xl ring-4 ring-rose-500/5">
            <div className="bg-rose-500 text-white w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
              <i className="fas fa-exclamation text-sm"></i>
            </div>
            <div className="flex-1 text-xs sm:text-sm font-bold leading-relaxed">{errorText}</div>
            <button onClick={() => setErrorText(null)} className="text-rose-300 hover:text-rose-500 transition-colors p-1">
              <i className="fas fa-times text-lg"></i>
            </button>
          </div>
        )}
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden relative">
        <main ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-12 py-8 sm:py-12 space-y-8 sm:space-y-12 chat-area no-scrollbar">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start animate-fadeIn'}`}>
              <div className={`message-bubble p-5 sm:p-8 rounded-[2rem] sm:rounded-[2.5rem] shadow-sm group relative ${msg.role === 'user' ? 'user-bubble' : 'ai-bubble'}`}>
                <p className="font-semibold text-sm sm:text-lg leading-relaxed">{msg.text}</p>
                {/* 仅在关闭双语模式且未翻译时显示按钮 */}
                {msg.role === 'ai' && !msg.translation && !msg.isTranslating && !globalBilingual && (
                  <button onClick={() => handleTranslate(msg.id, msg.text)} className="mt-3 text-[10px] font-black uppercase tracking-widest opacity-60 hover:opacity-100 transition-opacity flex items-center gap-1.5 text-[#2D5A27]">
                    <i className="fas fa-language text-xs"></i> 显示翻译
                  </button>
                )}
                {/* 翻译显示区域：双语模式或已手动点击翻译 */}
                {(msg.translation || msg.isTranslating) && (
                   <div className="mt-4 pt-4 border-t border-[#D1DDD1] text-xs sm:text-base text-[#5E7A5E] italic animate-fadeIn font-medium">
                     {msg.isTranslating ? (
                       <span className="flex items-center gap-2 opacity-50">
                         <i className="fas fa-circle-notch animate-spin"></i> 正在翻译...
                       </span>
                     ) : msg.translation}
                   </div>
                )}
              </div>
            </div>
          ))}
          {isAISpeaking && (
            <div className="flex items-center gap-3 ml-4">
              <div className="flex gap-1.5 p-4 bg-white rounded-2xl border border-[#E1E8E1] shadow-sm">
                <span className="w-2 h-2 bg-[#2D5A27] rounded-full animate-bounce"></span>
                <span className="w-2 h-2 bg-[#2D5A27] rounded-full animate-bounce [animation-delay:0.2s]"></span>
                <span className="w-2 h-2 bg-[#2D5A27] rounded-full animate-bounce [animation-delay:0.4s]"></span>
              </div>
            </div>
          )}
        </main>

        {/* Suggestions Sidebar */}
        <aside className="w-[380px] hidden xl:flex flex-col bg-[#EBF2EB] border-l border-[#E1E8E1] overflow-hidden shadow-2xl z-20">
          <div className="p-8 border-b border-[#D1DDD1] bg-[#D1DDD1]/20 flex items-center justify-between">
            <div>
              <h2 className="text-xs font-black text-[#2D5A27] uppercase tracking-widest flex items-center gap-3">
                实时灵感 
                {isGeneratingSuggestions && <span className="w-2 h-2 bg-emerald-500 rounded-full animate-ping"></span>}
              </h2>
            </div>
            <button 
              onClick={generateSuggestions}
              disabled={isGeneratingSuggestions || !isSessionActive}
              className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${isSessionActive ? 'bg-white shadow-sm hover:rotate-180 text-[#2D5A27]' : 'bg-[#D1DDD1] text-stone-400'}`}
            >
              <i className={`fas fa-sync-alt text-sm ${isGeneratingSuggestions ? 'animate-spin' : ''}`}></i>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-8 space-y-5 no-scrollbar">
            {!isSessionActive ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-8 opacity-25">
                <i className={`fas ${!isOnline ? 'fa-wifi-slash' : 'fa-microphone-slash'} text-5xl mb-6`}></i>
                <p className="text-[10px] font-black uppercase tracking-widest">{!isOnline ? '离线模式' : '点击底部按钮开始'}</p>
              </div>
            ) : isGeneratingSuggestions ? (
              <div className="space-y-6">
                {[1, 2, 3].map(i => (
                  <div key={i} className="bg-white/50 border border-[#E1E8E1] p-6 rounded-[2.5rem] space-y-4">
                    <div className="h-3 bg-[#D1DDD1] rounded w-1/4 animate-pulse"></div>
                    <div className="h-6 bg-[#D1DDD1] rounded w-full animate-pulse"></div>
                    <div className="h-4 bg-[#D1DDD1] rounded w-3/4 animate-pulse"></div>
                  </div>
                ))}
              </div>
            ) : suggestions.length > 0 ? (
              suggestions.map((s, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setMessages(prev => [...prev, { id: `u-hint-${Date.now()}`, role: 'user', text: s.en }]);
                    // 选择建议后立即重新生成，保持灵感流动
                    setTimeout(() => generateSuggestions(), 100);
                  }}
                  className="w-full bg-white border border-[#E1E8E1] hover:border-[#2D5A27]/40 p-7 rounded-[2.5rem] text-left shadow-sm hover:shadow-lg transition-all group active:scale-[0.97]"
                >
                  <div className={`inline-block px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-tighter mb-3 ${
                    s.tag === 'Flow' ? 'bg-emerald-600 text-white' : s.tag === 'Dive' ? 'bg-teal-700 text-white' : 'bg-stone-600 text-white'
                  }`}>
                    {s.label}
                  </div>
                  <p className="text-base font-extrabold text-[#1A2E1A] leading-tight mb-3 group-hover:text-[#2D5A27]">{s.en}</p>
                  <p className="text-xs text-[#5E7A5E] font-bold border-t border-[#F2F7F2] pt-3">{s.cn}</p>
                </button>
              ))
            ) : (
              <p className="text-center text-[10px] text-[#5E7A5E] font-black mt-12 uppercase tracking-widest">正在根据对话生成新建议... ✨</p>
            )}
          </div>
        </aside>
      </div>

      {/* Control Area */}
      <footer className="h-32 sm:h-44 flex items-center justify-center pointer-events-none z-50 px-8">
        <div className="pointer-events-auto flex items-center gap-10">
          <button 
            onClick={toggleSession}
            disabled={isConnecting || !isOnline}
            className={`w-24 h-24 sm:w-32 sm:h-32 rounded-full sm:rounded-[3.5rem] flex items-center justify-center text-3xl sm:text-4xl shadow-2xl transition-all relative border-4 border-[#F2F7F2] z-10 active:scale-90 hover:scale-110 ${
              !isOnline ? 'bg-stone-300 text-stone-500 cursor-not-allowed shadow-none' :
              isSessionActive ? 'bg-[#2D5A27] text-white animate-softPulse ring-8 ring-[#2D5A27]/10' : 'bg-white text-[#2D5A27] border-[#E1E8E1]'
            }`}
          >
            {isConnecting ? (
              <div className="loader scale-75 sm:scale-100"></div>
            ) : (
              <i className={`fas ${!isOnline ? 'fa-wifi-slash' : isSessionActive ? 'fa-microphone' : 'fa-microphone-slash opacity-30'}`}></i>
            )}
            
            {isAISpeaking && (
              <div className="absolute -top-12 sm:-top-16 left-1/2 -translate-x-1/2 bg-[#2D5A27] text-white text-[10px] sm:text-xs px-6 sm:px-8 py-2 sm:py-3 rounded-2xl font-black shadow-2xl animate-bounce whitespace-nowrap">
                VIBE 正在回应...
              </div>
            )}
            {isReconnecting && (
              <div className="absolute -bottom-8 sm:-bottom-10 left-1/2 -translate-x-1/2 text-[10px] font-black text-amber-600 animate-pulse uppercase tracking-widest whitespace-nowrap">
                正在自动重连...
              </div>
            )}
          </button>
        </div>
      </footer>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
