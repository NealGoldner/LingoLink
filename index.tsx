
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from '@google/genai';

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

// --- 常量配置 ---
const LIVE_MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
const TRANSLATION_MODEL_NAME = 'gemini-3-flash-preview';
const NUDGE_DELAY = 5000; 

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
      text: "Yo! Ready to kill it? 🚀 Forget the boring textbook stuff, let's talk like real friends! What's the wildest thing that happened to you lately?"
    }
  ]);
  const [difficulty, setDifficulty] = useState<Difficulty>('进阶');
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [globalBilingual, setGlobalBilingual] = useState(false);
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isGeneratingSuggestions, setIsGeneratingSuggestions] = useState(false);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<any>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  const currentInputText = useRef('');
  const currentOutputText = useRef('');
  const audioBufferQueue = useRef<Blob[]>([]);

  // 自动滚动到最新消息
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  // 监听 AI 是否在说话状态
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

  const handleTranslate = async (id: string, text: string) => {
    const msg = messages.find(m => m.id === id);
    if (msg?.translation || msg?.isTranslating) return;

    setMessages(prev => prev.map(m => m.id === id ? { ...m, isTranslating: true } : m));
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: TRANSLATION_MODEL_NAME,
        contents: `Translate this naturally to Chinese (informal/casual): "${text}". Keep the slang vibes if present.`,
      });
      const translation = response.text?.trim() || "哎呀，翻译失败了。";
      setMessages(prev => prev.map(m => m.id === id ? { ...m, translation, isTranslating: false } : m));
    } catch (err) {
      console.error("Translation error:", err);
      setMessages(prev => prev.map(m => m.id === id ? { ...m, isTranslating: false } : m));
    }
  };

  const generateSuggestions = async () => {
    if (!isSessionActive || isGeneratingSuggestions) return;
    setIsGeneratingSuggestions(true);
    
    try {
      const context = messages.slice(-4).map(m => `${m.role.toUpperCase()}: ${m.text}`).join('\n');
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: TRANSLATION_MODEL_NAME,
        contents: `Conversation Context:\n${context}\n\nDifficulty: ${difficulty}\n
        Generate 3 high-quality response suggestions for an English learner in this EXACT JSON structure:
        [
          {"tag": "Flow", "label": "顺向接话", "en": "...", "cn": "..."},
          {"tag": "Dive", "label": "深度追问", "en": "...", "cn": "..."},
          {"tag": "Safety", "label": "紧急救场", "en": "...", "cn": "..."}
        ]
        RULES: Match the ${difficulty} level, use modern idiomatic English.`,
        config: { responseMimeType: "application/json" }
      });
      
      const text = response.text?.trim() || "[]";
      setSuggestions(JSON.parse(text));
    } catch (e) {
      console.error("Suggestion generation failed", e);
    } finally {
      setIsGeneratingSuggestions(false);
    }
  };

  const startSession = async () => {
    if (isSessionActive || isConnecting) return;
    setIsConnecting(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      if (!inputAudioCtxRef.current) inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      if (!outputAudioCtxRef.current) outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      await inputAudioCtxRef.current.resume();
      await outputAudioCtxRef.current.resume();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const sessionPromise = ai.live.connect({
        model: LIVE_MODEL_NAME,
        callbacks: {
          onopen: () => {
            setIsSessionActive(true);
            setIsConnecting(false);
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
            sessionRef.current = { 
              stopStream: () => { 
                stream.getTracks().forEach(t => t.stop()); 
                scriptProcessor.disconnect(); 
                source.disconnect(); 
              } 
            };
            
            generateSuggestions();
          },
          onmessage: async (message: LiveServerMessage) => {
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
                if (globalBilingual) handleTranslate(id, aText);
                setTimeout(() => generateSuggestions(), 500);
              }
              currentInputText.current = ''; currentOutputText.current = '';
            }
          },
          onerror: (err) => {
            console.error("Session Error:", err);
            setIsSessionActive(false);
          },
          onclose: () => setIsSessionActive(false)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: "You are 'Vibe' - the world's most charismatic English tutor. Use modern slang and keep the energy high. Be supportive but fun.",
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
    } catch (err) {
      console.error("Start Session Error:", err);
      setIsConnecting(false);
    }
  };

  const toggleSession = () => {
    if (isSessionActive) {
      if (sessionRef.current?.stopStream) sessionRef.current.stopStream();
      setIsSessionActive(false);
    } else {
      startSession();
    }
  };

  const getTagStyle = (tag: string) => {
    switch(tag) {
      case 'Flow': return 'bg-emerald-600 text-white';
      case 'Dive': return 'bg-teal-700 text-white';
      case 'Safety': return 'bg-stone-600 text-white';
      default: return 'bg-stone-400 text-white';
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-[1200px] mx-auto bg-[#F2F7F2] text-[#1A2E1A] relative overflow-hidden font-sans border-x border-[#E1E8E1] shadow-2xl">
      {/* Header */}
      <header className="glass-header px-8 py-5 flex flex-col gap-4 sticky top-0 z-50 shadow-sm border-b border-[#E1E8E1]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="w-14 h-14 bg-[#2D5A27] rounded-2xl flex items-center justify-center text-white shadow-xl">
                <i className="fas fa-bolt text-2xl"></i>
              </div>
              {isSessionActive && <span className="absolute -top-1 -right-1 w-5 h-5 bg-emerald-500 border-4 border-[#F2F7F2] rounded-full animate-ping"></span>}
            </div>
            <div>
              <h1 className="font-black text-2xl tracking-tight leading-none text-[#2D5A27]">LingoLink <span className="text-xs bg-[#2D5A27] text-white px-2 py-0.5 rounded-md ml-2 font-bold uppercase tracking-widest">LIVE</span></h1>
              <div className="flex items-center gap-2 mt-2">
                <span className={`w-2.5 h-2.5 rounded-full ${isSessionActive ? 'bg-emerald-500 animate-pulse' : 'bg-rose-400'}`}></span>
                <p className="text-xs text-[#5E7A5E] uppercase tracking-widest font-black">{isSessionActive ? '通话中' : '等待开始'}</p>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-6">
            <div className="hidden sm:flex gap-2">
              {(['入门', '进阶', '挑战'] as Difficulty[]).map(lvl => (
                <button
                  key={lvl}
                  onClick={() => { setDifficulty(lvl); if(isSessionActive) generateSuggestions(); }}
                  className={`text-[10px] font-black px-4 py-2 rounded-xl border-2 transition-all ${
                    difficulty === lvl ? 'bg-[#2D5A27] text-white border-[#2D5A27]' : 'bg-[#F8FBF8] text-[#5E7A5E] border-[#E1E8E1]'
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-3 cursor-pointer bg-[#F8FBF8] px-4 py-2 rounded-2xl border border-[#E1E8E1] shadow-sm">
              <span className="text-xs font-black text-[#5E7A5E] uppercase tracking-tighter">双语</span>
              <div 
                onClick={() => setGlobalBilingual(!globalBilingual)}
                className={`w-12 h-7 rounded-full p-1 transition-colors duration-300 ${globalBilingual ? 'bg-[#2D5A27]' : 'bg-[#D1DDD1]'}`}
              >
                <div className={`w-5 h-5 bg-white rounded-full shadow-md transform transition-transform duration-300 ${globalBilingual ? 'translate-x-5' : 'translate-x-0'}`}></div>
              </div>
            </label>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden relative">
        <main ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-10 space-y-8 chat-area no-scrollbar">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start animate-fadeIn'}`}>
              <div className={`message-bubble p-6 rounded-3xl shadow-sm transition-all group relative ${msg.role === 'user' ? 'user-bubble' : 'ai-bubble'}`}>
                <p className="font-semibold text-base leading-relaxed">{msg.text}</p>
                {msg.role === 'ai' && !msg.translation && (
                  <button onClick={() => handleTranslate(msg.id, msg.text)} className="mt-3 text-[10px] font-black uppercase tracking-widest opacity-40 hover:opacity-100 transition-opacity flex items-center gap-1.5 text-[#2D5A27]">
                    <i className="fas fa-language text-xs"></i> {msg.isTranslating ? '正在思考...' : '点此翻译'}
                  </button>
                )}
                {msg.translation && (
                  <div className="mt-4 pt-4 border-t border-[#D1DDD1] text-sm text-[#5E7A5E] font-medium italic animate-fadeIn">
                    {msg.translation}
                  </div>
                )}
              </div>
            </div>
          ))}
          {isAISpeaking && (
            <div className="flex items-center gap-3 ml-2">
              <div className="flex gap-1.5 p-4 bg-[#F8FBF8] rounded-2xl shadow-sm border border-[#E1E8E1]">
                <span className="w-2 h-2 bg-[#2D5A27] rounded-full animate-bounce"></span>
                <span className="w-2 h-2 bg-[#2D5A27] rounded-full animate-bounce [animation-delay:0.2s]"></span>
                <span className="w-2 h-2 bg-[#2D5A27] rounded-full animate-bounce [animation-delay:0.4s]"></span>
              </div>
            </div>
          )}
        </main>

        <aside className="w-[380px] hidden lg:flex flex-col bg-[#EBF2EB] border-l border-[#E1E8E1] overflow-hidden shadow-xl z-20">
          <div className="p-6 border-b border-[#D1DDD1] bg-[#D1DDD1]/30 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-black text-[#2D5A27] uppercase tracking-widest">实时灵感</h2>
              <p className="text-[10px] text-[#5E7A5E] font-bold mt-1">AI 正在根据对话为你准备助攻</p>
            </div>
            <button 
              onClick={generateSuggestions}
              disabled={isGeneratingSuggestions || !isSessionActive}
              className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${isSessionActive ? 'bg-[#F8FBF8] shadow-sm border border-[#E1E8E1] hover:rotate-180 text-[#2D5A27]' : 'bg-[#D1DDD1] text-stone-400'}`}
            >
              <i className={`fas fa-sync-alt ${isGeneratingSuggestions ? 'animate-spin' : ''}`}></i>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-6 no-scrollbar">
            {!isSessionActive ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-6 opacity-30">
                <i className="fas fa-microphone-slash text-4xl mb-4 text-[#A1B3A1]"></i>
                <p className="text-xs font-black uppercase tracking-widest text-[#5E7A5E]">尚未连接</p>
              </div>
            ) : suggestions.length > 0 ? (
              suggestions.map((s, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setMessages(prev => [...prev, { id: `u-hint-${Date.now()}`, role: 'user', text: s.en }]);
                  }}
                  className="w-full bg-[#F8FBF8] border border-[#E1E8E1] hover:border-[#2D5A27]/40 p-6 rounded-[2rem] text-left shadow-sm hover:shadow-md transition-all group active:scale-[0.98]"
                >
                  <div className={`inline-block px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-tighter mb-2 ${getTagStyle(s.tag)}`}>
                    {s.label}
                  </div>
                  <p className="text-[15px] font-extrabold text-[#1A2E1A] leading-tight mb-3 group-hover:text-[#2D5A27]">{s.en}</p>
                  <p className="text-[11px] text-[#5E7A5E] font-bold border-t border-[#F2F7F2] pt-2">{s.cn}</p>
                </button>
              ))
            ) : (
              <div className="space-y-4 animate-pulse">
                {[1,2,3].map(i => <div key={i} className="h-32 bg-[#D1DDD1]/40 rounded-[2rem]"></div>)}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Control Area */}
      <footer className="relative h-40 flex items-center justify-center pointer-events-none z-50 px-8">
        <div className="pointer-events-auto flex items-center gap-10">
          <button 
            onClick={toggleSession}
            disabled={isConnecting}
            className={`w-28 h-28 rounded-[3.5rem] flex items-center justify-center text-4xl shadow-2xl transition-all relative border-4 border-[#F2F7F2] z-10 active:scale-90 hover:scale-105 ${
              isSessionActive ? 'bg-[#2D5A27] text-white' : 'bg-[#F8FBF8] text-[#2D5A27] border-[#E1E8E1]'
            }`}
          >
            {isConnecting ? <span className="loader"></span> : <i className={`fas ${isSessionActive ? 'fa-microphone' : 'fa-microphone-slash opacity-20'}`}></i>}
            
            {isAISpeaking && (
              <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-[#2D5A27] text-white text-[10px] px-6 py-2.5 rounded-2xl font-black shadow-2xl animate-bounce">
                AI 说话中
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
