
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
      setErrorText('网络连接已断开，请检查网络。');
      if (isSessionActive) stopSession();
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
      if (active !== isAISpeaking) setIsAISpeaking(active);
    }, 100);
    return () => clearInterval(checkStatus);
  }, [isAISpeaking]);

  // 双语自动翻译
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
      setErrorText(<span>请点击右上角 <i className="fas fa-key"></i> 按钮选择 API Key（需开启计费项目）。</span>);
      return;
    }
    
    setMessages(prev => prev.map(m => m.id === id ? { ...m, isTranslating: true } : m));
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: TRANSLATION_MODEL_NAME,
        contents: `Translate to casual spoken Chinese: "${text}"`,
        config: {
            systemInstruction: "Direct translation only. Natural Chinese.",
            temperature: 0.1,
        }
      });
      const translation = response.text?.trim() || "翻译暂时不可用。";
      setMessages(prev => prev.map(m => m.id === id ? { ...m, translation, isTranslating: false } : m));
    } catch (err: any) {
      if (err.message?.includes('Requested entity was not found')) {
        setErrorText('API 密钥已失效或来自非计费项目，请重新选择。');
        window.aistudio?.openSelectKey();
      }
      setMessages(prev => prev.map(m => m.id === id ? { ...m, isTranslating: false } : m));
    }
  };

  const generateSuggestions = async () => {
    if (isGeneratingSuggestions || !process.env.API_KEY) return;
    setIsGeneratingSuggestions(true);
    try {
      const lastContext = [
        ...messages.slice(-3),
        { role: 'user', text: currentInputText.current }
      ].map(m => `${m.role.toUpperCase()}: ${m.text}`).join('\n');

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: SUGGESTION_MODEL_NAME,
        contents: `Based on this conversation, give 3 next steps:\n${lastContext}`,
        config: { 
          systemInstruction: "Expert English coach. Provide 3 response suggestions. JSON format only.",
          temperature: 0.3,
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
      console.error("Suggestions failed", e);
    } finally {
      setIsGeneratingSuggestions(false);
    }
  };

  const ensureApiKey = async () => {
    if (process.env.API_KEY && process.env.API_KEY !== '') return true;
    if (window.aistudio) {
      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) {
        await window.aistudio.openSelectKey();
        // 根据竞态条件规则，假定用户在对话框中会完成选择
        return true; 
      }
      return true;
    }
    return false;
  };

  const startSession = async (autoRetry = false) => {
    if (isSessionActive || isConnecting) return;
    if (!navigator.onLine) {
      setErrorText('网络连接不可用。');
      return;
    }

    setIsConnecting(true);
    setIsReconnecting(autoRetry);
    setStatusText(autoRetry ? '尝试重连...' : '正在启动...');

    try {
      const hasKey = await ensureApiKey();
      if (!hasKey) {
        setErrorText('请先设置 API 密钥。');
        setIsConnecting(false);
        return;
      }

      // 移动端 AudioContext 激活：必须在用户手势回调中 resume
      if (inputAudioCtxRef.current) await inputAudioCtxRef.current.resume();
      if (outputAudioCtxRef.current) await outputAudioCtxRef.current.resume();

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
                setMessages(prev => [...prev, { id, role: 'ai', text: aText }]);
                if (globalBilingual) setTimeout(() => handleTranslate(id, aText), 50);
              }
              currentInputText.current = ''; currentOutputText.current = '';
              hasTriggeredSuggestionsRef.current = false;
            }
          },
          onerror: (err: any) => {
            console.error("Live Error:", err);
            setIsSessionActive(false); 
            setIsConnecting(false);
            if (err.message?.includes('Requested entity was not found')) {
                setErrorText('API 密钥已失效或来自非计费项目。');
                window.aistudio?.openSelectKey();
            } else if (reconnectCountRef.current < MAX_RECONNECT_ATTEMPTS && !userManuallyStopped.current) {
              reconnectCountRef.current++;
              setTimeout(() => startSession(true), 2000);
            }
          },
          onclose: () => {
            setIsSessionActive(false);
            if (!userManuallyStopped.current && reconnectCountRef.current < MAX_RECONNECT_ATTEMPTS) {
                reconnectCountRef.current++;
                setTimeout(() => startSession(true), 2000);
            }
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: "You are 'Vibe' - a charismatic English tutor. Use slang and be energetic.",
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
    } catch (err: any) {
      console.error("Start Error:", err);
      setErrorText('启动失败：' + (err.message || '未知错误'));
      setIsConnecting(false);
      setIsReconnecting(false);
    }
  };

  const stopSession = () => {
    userManuallyStopped.current = true;
    if (sessionRef.current?.stopStream) sessionRef.current.stopStream();
    setIsSessionActive(false);
    setIsConnecting(false);
    setStatusText('通话已结束');
  };

  return (
    <div className="flex flex-col h-screen max-w-[1200px] mx-auto bg-[#F2F7F2] text-[#1A2E1A] relative overflow-hidden font-sans border-x border-[#E1E8E1] shadow-2xl">
      <header className="glass-header px-4 sm:px-10 py-4 sm:py-6 flex flex-col gap-4 sticky top-0 z-50 shadow-sm border-b border-[#E1E8E1]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 sm:gap-5 overflow-hidden">
            <div className={`w-11 h-11 sm:w-16 sm:h-16 rounded-2xl sm:rounded-3xl flex items-center justify-center text-white shadow-xl transition-all duration-500 ${isSessionActive ? 'bg-[#2D5A27] rotate-12 scale-110' : 'bg-[#2D5A27]'}`}>
              <i className="fas fa-bolt text-xl sm:text-3xl"></i>
            </div>
            <div className="flex flex-col min-w-0">
              <h1 className="font-black text-xl sm:text-3xl text-[#2D5A27] truncate">LingoLink <span className="text-[10px] bg-[#2D5A27] text-white px-2 py-0.5 rounded ml-1">LIVE</span></h1>
              <div className="flex items-center gap-2 mt-1">
                <span className={`w-2 h-2 rounded-full ${isSessionActive ? 'bg-emerald-500 animate-pulse' : 'bg-rose-400'}`}></span>
                <p className="text-[10px] text-[#5E7A5E] uppercase tracking-widest font-black">{statusText}</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-4">
            <button onClick={() => window.aistudio?.openSelectKey()} className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-white text-[#2D5A27] border border-[#E1E8E1] shadow-sm hover:bg-[#2D5A27] hover:text-white transition-all flex items-center justify-center">
              <i className="fas fa-key"></i>
            </button>
            <label className="flex items-center gap-2 bg-white px-3 py-2 rounded-xl border border-[#E1E8E1] shadow-sm cursor-pointer">
              <span className="text-[10px] font-black text-[#5E7A5E]">双语</span>
              <div onClick={() => setGlobalBilingual(!globalBilingual)} className={`w-10 h-6 rounded-full p-1 transition-colors ${globalBilingual ? 'bg-[#2D5A27]' : 'bg-[#D1DDD1]'}`}>
                <div className={`w-4 h-4 bg-white rounded-full shadow transform transition-transform ${globalBilingual ? 'translate-x-4' : 'translate-x-0'}`}></div>
              </div>
            </label>
          </div>
        </div>
        {errorText && (
          <div className="bg-rose-50 border-2 border-rose-100 text-rose-800 px-4 py-3 rounded-2xl flex items-start gap-3 animate-fadeIn">
            <i className="fas fa-exclamation-circle mt-1"></i>
            <div className="flex-1 text-xs font-bold leading-relaxed">{errorText}</div>
            <button onClick={() => setErrorText(null)} className="text-rose-300 hover:text-rose-600"><i className="fas fa-times"></i></button>
          </div>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden">
        <main ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-12 py-8 space-y-8 chat-area no-scrollbar">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start animate-fadeIn'}`}>
              <div className={`message-bubble p-5 sm:p-8 rounded-[2rem] shadow-sm ${msg.role === 'user' ? 'user-bubble' : 'ai-bubble'}`}>
                <p className="font-semibold text-sm sm:text-lg leading-relaxed">{msg.text}</p>
                {msg.role === 'ai' && !msg.translation && !msg.isTranslating && !globalBilingual && (
                  <button onClick={() => handleTranslate(msg.id, msg.text)} className="mt-3 text-[10px] font-black uppercase text-[#2D5A27] opacity-60 hover:opacity-100"><i className="fas fa-language"></i> 显示翻译</button>
                )}
                {(msg.translation || msg.isTranslating) && (
                   <div className="mt-4 pt-4 border-t border-[#D1DDD1] text-xs sm:text-base text-[#5E7A5E] italic">
                     {msg.isTranslating ? <span className="animate-pulse">翻译中...</span> : msg.translation}
                   </div>
                )}
              </div>
            </div>
          ))}
        </main>

        <aside className="w-[320px] hidden lg:flex flex-col bg-[#EBF2EB] border-l border-[#E1E8E1] p-6 space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-[10px] font-black text-[#2D5A27] uppercase tracking-widest">实时灵感</h2>
            <button onClick={generateSuggestions} disabled={!isSessionActive} className="text-[#2D5A27] opacity-50 hover:opacity-100"><i className={`fas fa-sync ${isGeneratingSuggestions ? 'animate-spin' : ''}`}></i></button>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto no-scrollbar">
            {!isSessionActive ? (
                <div className="text-center opacity-30 mt-20"><i className="fas fa-microphone-slash text-4xl mb-4"></i><p className="text-[10px] font-black uppercase">尚未开始对话</p></div>
            ) : suggestions.map((s, idx) => (
              <button key={idx} onClick={() => setMessages(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', text: s.en }])} className="w-full bg-white border border-[#E1E8E1] p-5 rounded-3xl text-left shadow-sm hover:shadow-md transition-all">
                <div className="text-[8px] font-black uppercase mb-1 opacity-50">{s.label}</div>
                <p className="text-sm font-bold mb-1">{s.en}</p>
                <p className="text-[10px] text-[#5E7A5E]">{s.cn}</p>
              </button>
            ))}
          </div>
          <div className="text-[8px] text-[#5E7A5E] opacity-50 bg-white/50 p-3 rounded-xl border border-[#E1E8E1]">
            * 使用此应用需要具有付费项目的 API Key。<a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" className="underline font-black text-[#2D5A27]">查看计费说明</a>
          </div>
        </aside>
      </div>

      <footer className="h-32 sm:h-44 flex items-center justify-center px-8 z-50">
        <button onClick={isSessionActive ? stopSession : () => startSession()} disabled={isConnecting} className={`w-20 h-20 sm:w-28 sm:h-28 rounded-full flex items-center justify-center text-2xl sm:text-3xl shadow-2xl transition-all ${isSessionActive ? 'bg-[#2D5A27] text-white' : 'bg-white text-[#2D5A27] border-4 border-white'}`}>
          {isConnecting ? <div className="loader"></div> : <i className={`fas ${isSessionActive ? 'fa-microphone' : 'fa-microphone-slash'}`}></i>}
        </button>
      </footer>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
