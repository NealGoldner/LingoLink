
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
      text: "Yo! Ready to vibe with some English? 🚀 I'm here to talk about anything. What's on your mind today?"
    }
  ]);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [globalBilingual, setGlobalBilingual] = useState(false);
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [statusText, setStatusText] = useState('等待开始');
  const [errorText, setErrorText] = useState<React.ReactNode | null>(null);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<any>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  const currentInputText = useRef('');
  const currentOutputText = useRef('');
  const audioBufferQueue = useRef<Blob[]>([]);
  const userManuallyStopped = useRef(false);

  // 初始化网络环境
  useEffect(() => {
    const handleOnline = () => { setIsOnline(true); setErrorText(null); };
    const handleOffline = () => { setIsOnline(false); setErrorText('网络已断开'); if (isSessionActive) stopSession(); };
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

  const checkApiKey = async () => {
    if (process.env.API_KEY) return true;
    if (window.aistudio) {
      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) {
        await window.aistudio.openSelectKey();
        return true; // 假定用户完成操作
      }
      return true;
    }
    return false;
  };

  const handleTranslate = async (id: string, text: string) => {
    if (!process.env.API_KEY) {
      setErrorText(<span>请点击右上角钥匙图标设置 API 密钥。</span>);
      window.aistudio?.openSelectKey();
      return;
    }
    setMessages(prev => prev.map(m => m.id === id ? { ...m, isTranslating: true } : m));
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: TRANSLATION_MODEL_NAME,
        contents: `Translate to natural casual Chinese: "${text}"`,
        config: { systemInstruction: "Direct translation only.", temperature: 0.1 }
      });
      setMessages(prev => prev.map(m => m.id === id ? { ...m, translation: response.text?.trim(), isTranslating: false } : m));
    } catch (err: any) {
      if (err.message?.includes('API_KEY')) window.aistudio?.openSelectKey();
      setMessages(prev => prev.map(m => m.id === id ? { ...m, isTranslating: false } : m));
    }
  };

  const generateSuggestions = async () => {
    if (!process.env.API_KEY || !isSessionActive) return;
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: SUGGESTION_MODEL_NAME,
        contents: `Recent messages:\n${messages.slice(-3).map(m=>m.text).join('\n')}\nSuggest 3 casual next steps.`,
        config: { 
          systemInstruction: "Expert English coach. JSON only.",
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
      setSuggestions(JSON.parse(response.text || "[]"));
    } catch (e) { console.error(e); }
  };

  const startSession = async () => {
    if (isSessionActive || isConnecting) return;

    // 关键：在点击瞬间初始化并恢复 AudioContext，否则移动端会无声/无法录音
    if (!inputAudioCtxRef.current) inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    if (!outputAudioCtxRef.current) outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    
    await inputAudioCtxRef.current.resume();
    await outputAudioCtxRef.current.resume();

    setIsConnecting(true);
    setErrorText(null);
    setStatusText('正在初始化...');

    try {
      const keyReady = await checkApiKey();
      if (!keyReady) throw new Error("请设置 API 密钥以继续");

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const sessionPromise = ai.live.connect({
        model: LIVE_MODEL_NAME,
        callbacks: {
          onopen: () => {
            setIsSessionActive(true);
            setIsConnecting(false);
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
            sessionRef.current = { stop: () => { stream.getTracks().forEach(t => t.stop()); scriptProcessor.disconnect(); source.disconnect(); } };
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              const ctx = outputAudioCtxRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
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
                if (globalBilingual) setTimeout(() => handleTranslate(id, aText), 100);
              }
              currentInputText.current = ''; currentOutputText.current = '';
              generateSuggestions();
            }
          },
          onerror: (err: any) => {
            console.error(err);
            if (err.message?.includes('entity was not found') || err.message?.includes('API_KEY')) {
              setErrorText(<span>API 密钥无效或未开启计费。 <button onClick={() => window.aistudio?.openSelectKey()} className="font-bold underline">点此重选</button></span>);
              window.aistudio?.openSelectKey();
            }
            stopSession();
          },
          onclose: () => stopSession()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: "You are 'Vibe', a charismatic English coach. Keep it fun.",
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
    } catch (err: any) {
      setIsConnecting(false);
      setErrorText(err.message || '麦克风权限被拒绝');
    }
  };

  const stopSession = () => {
    userManuallyStopped.current = true;
    if (sessionRef.current) sessionRef.current.stop();
    setIsSessionActive(false);
    setIsConnecting(false);
    setStatusText('通话已结束');
  };

  return (
    <div className="flex flex-col h-screen max-w-[1200px] mx-auto bg-[#F2F7F2] text-[#1A2E1A] relative overflow-hidden font-sans border-x border-[#E1E8E1] shadow-2xl">
      <header className="glass-header px-4 sm:px-10 py-4 sm:py-6 flex flex-col gap-4 sticky top-0 z-50 border-b border-[#E1E8E1]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 sm:gap-5">
            <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-2xl flex items-center justify-center text-white shadow-lg transition-all ${isSessionActive ? 'bg-[#2D5A27] scale-110' : 'bg-stone-400'}`}>
              <i className="fas fa-bolt"></i>
            </div>
            <div className="flex flex-col">
              <h1 className="font-black text-lg sm:text-xl text-[#2D5A27]">LingoLink</h1>
              <p className="text-[9px] text-[#5E7A5E] uppercase tracking-widest font-black">{statusText}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-4">
            <button 
              onClick={() => window.aistudio?.openSelectKey()} 
              className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${!process.env.API_KEY ? 'bg-rose-100 text-rose-600 animate-pulse border-2 border-rose-300' : 'bg-white text-[#2D5A27] border border-[#E1E8E1]'}`}
              title="设置 API Key"
            >
              <i className="fas fa-key"></i>
            </button>
            <label className="flex items-center gap-2 bg-white px-2 sm:px-3 py-1.5 rounded-xl border border-[#E1E8E1] shadow-sm cursor-pointer">
              <span className="text-[9px] font-black uppercase">双语</span>
              <div onClick={() => setGlobalBilingual(!globalBilingual)} className={`w-8 h-5 sm:w-10 sm:h-6 rounded-full p-1 transition-colors ${globalBilingual ? 'bg-[#2D5A27]' : 'bg-[#D1DDD1]'}`}>
                <div className={`w-3 h-3 sm:w-4 sm:h-4 bg-white rounded-full shadow transform transition-transform ${globalBilingual ? 'translate-x-3 sm:translate-x-4' : 'translate-x-0'}`}></div>
              </div>
            </label>
          </div>
        </div>
        {errorText && (
          <div className="bg-rose-50 border border-rose-100 text-rose-800 px-4 py-3 rounded-xl flex items-start gap-3 animate-fadeIn text-xs font-bold">
            <i className="fas fa-exclamation-circle mt-0.5"></i>
            <div className="flex-1">{errorText}</div>
            <button onClick={() => setErrorText(null)} className="text-rose-400"><i className="fas fa-times"></i></button>
          </div>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        <main ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-12 py-6 space-y-6 chat-area no-scrollbar pb-36">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start animate-fadeIn'}`}>
              <div className={`message-bubble p-4 sm:p-7 rounded-[1.5rem] sm:rounded-[2rem] shadow-sm ${msg.role === 'user' ? 'user-bubble' : 'ai-bubble'}`}>
                <p className="font-semibold text-sm sm:text-base leading-relaxed">{msg.text}</p>
                {msg.role === 'ai' && !msg.translation && !msg.isTranslating && !globalBilingual && (
                  <button onClick={() => handleTranslate(msg.id, msg.text)} className="mt-2 text-[10px] font-black uppercase text-[#2D5A27] opacity-60"><i className="fas fa-language"></i> 翻译</button>
                )}
                {(msg.translation || msg.isTranslating) && (
                   <div className="mt-3 pt-3 border-t border-[#D1DDD1] text-[13px] sm:text-base text-[#5E7A5E] italic">
                     {msg.isTranslating ? <span className="animate-pulse">翻译中...</span> : msg.translation}
                   </div>
                )}
              </div>
            </div>
          ))}
          {isAISpeaking && <div className="ml-6 flex gap-1 p-2 bg-white rounded-xl shadow-sm border border-[#E1E8E1] w-fit"><span className="w-1.5 h-1.5 bg-[#2D5A27] rounded-full animate-bounce"></span><span className="w-1.5 h-1.5 bg-[#2D5A27] rounded-full animate-bounce [animation-delay:0.2s]"></span></div>}
        </main>

        <aside className="w-[280px] hidden lg:flex flex-col bg-[#EBF2EB] border-l border-[#E1E8E1] p-6">
          <h2 className="text-[10px] font-black text-[#2D5A27] uppercase tracking-widest mb-6">推荐回复</h2>
          <div className="space-y-4 overflow-y-auto no-scrollbar">
            {suggestions.length === 0 ? (
              <div className="text-center opacity-30 mt-10"><i className="fas fa-lightbulb text-3xl mb-3"></i><p className="text-[9px] font-black uppercase">对话开始后显示灵感</p></div>
            ) : suggestions.map((s, idx) => (
              <button key={idx} onClick={() => setMessages(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', text: s.en }])} className="w-full bg-white border border-[#E1E8E1] p-4 rounded-[1.2rem] text-left shadow-sm hover:shadow-md transition-all active:scale-95">
                <p className="text-sm font-bold mb-1">{s.en}</p>
                <p className="text-[10px] text-[#5E7A5E]">{s.cn}</p>
              </button>
            ))}
          </div>
        </aside>
      </div>

      <footer className="absolute bottom-4 left-0 right-0 flex items-center justify-center pointer-events-none z-50">
        <button 
          onClick={isSessionActive ? stopSession : startSession} 
          disabled={isConnecting || !isOnline}
          className={`pointer-events-auto w-20 h-20 sm:w-24 sm:h-24 rounded-full flex items-center justify-center text-2xl sm:text-3xl shadow-2xl transition-all relative z-10 active:scale-90 ${
            isSessionActive ? 'bg-[#2D5A27] text-white ring-8 ring-[#2D5A27]/10' : 'bg-white text-[#2D5A27] border-4 border-[#2D5A27]'
          }`}
        >
          {isConnecting ? <div className="loader"></div> : <i className={`fas ${isSessionActive ? 'fa-microphone' : 'fa-microphone-slash opacity-40'}`}></i>}
        </button>
      </footer>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
